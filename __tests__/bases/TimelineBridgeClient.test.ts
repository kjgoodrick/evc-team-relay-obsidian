/** @jest-environment jsdom */
import { TFile, type Workspace } from "obsidian";
import { TimelineBridgeClient } from "../../src/bases/TimelineBridgeClient";

jest.mock("obsidian", () => ({ TFile: class {}, parseYaml: JSON.parse }));
function fixture(early = true) {
	const root = document.createElement("div"), viewport = document.createElement("div"); root.append(viewport); document.body.append(root);
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), badge = document.createElementNS(svg.namespaceURI, "g"); svg.append(badge); viewport.append(svg);
	const file = Object.assign(new TFile(), { path: "Team/Note.md" });
	let alive = true, busy = false, available = true;
	const handle = { target: { type: "cell", file, property: "formula.total" }, element: badge, current: () => alive };
	let choose: (value: unknown) => void = () => {};
	const stops: jest.Mock[] = [], owner = { type: "sabidurian-timeline" };
	const surface = { protocolVersion: 1, owner, root, capabilities: ["item", "cell", "geometry", "reveal", "annotation"],
		current: () => alive, viewport: () => viewport, handles: () => [handle], hit: jest.fn(() => handle), reveal: jest.fn(() => "revealed"),
		beginAnnotation: jest.fn((select: (value: unknown) => void, stopped: () => void) => { choose = select; const stop = jest.fn(stopped); stops.push(stop); return stop; }) };
	let surfaces: unknown[] = [surface];
	const listeners = new Set<() => void>();
	const bridge = { protocolVersion: 1, get available() { return available; }, viewTypes: ["sabidurian-timeline", "sabidurian-sequence"],
		getSurfaces: () => surfaces, onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, canNavigate: () => !busy };
	const events = new Map<string, (value: unknown) => void>();
	const workspace = { on: jest.fn((name: string, callback: (value: unknown) => void) => { events.set(name, callback); return { name }; }),
		offref: jest.fn((ref: { name: string }) => events.delete(ref.name)), trigger: jest.fn((_name: string, receive: (value: unknown) => void) => { if (early) receive(bridge); }) };
	const changed = jest.fn(), client = new TimelineBridgeClient(workspace as unknown as Workspace, changed); client.start();
	const notify = () => { for (const listener of [...listeners]) listener(); };
	return { root, viewport, badge, file, handle, surface, bridge, workspace, client, owner, stops, changed,
		ready: (value: unknown = bridge) => events.get("time-and-line:collaboration-ready")?.(value), notify,
		select: () => choose(handle), busy: () => { busy = true; }, remove: () => { surfaces = []; notify(); },
		replace: (value: unknown[]) => { surfaces = value; notify(); }, stale: () => { alive = false; notify(); },
		unload: () => { available = false; notify(); }, close: () => { client.close(); root.remove(); } };
}
afterEach(() => { document.body.replaceChildren(); });

test.each([true, false])("discovery supports either plugin order (provider first: %s)", early => {
	const f = fixture(early);
	try {
		if (!early) { expect(f.client.find(f.owner)).toBeUndefined(); f.ready(); }
		const adapter = f.client.find(f.owner)!; expect(adapter).toBeDefined();
		expect(f.workspace.trigger).toHaveBeenCalledWith("time-and-line:collaboration-request", expect.any(Function));
		expect(adapter.handles()[0].target).toEqual({ type: "cell", file: f.file, property: { source: "formula", name: "total" } });
		const point = { clientX: 10, clientY: 20 };
		expect(adapter.hit(f.badge, point)?.target).toEqual(adapter.handles()[0].target);
		expect(f.surface.hit).toHaveBeenCalledWith(f.badge, point);
		f.notify(); expect(f.client.find(f.owner)).toBe(adapter);
		expect(adapter.reveal({ type: "cell", file: f.file, property: { source: "formula", name: "total" } })).toBe("revealed");
		expect(f.surface.reveal).toHaveBeenCalledWith({ type: "cell", file: f.file, property: "formula.total" });
	} finally { f.close(); }
});

test.each(["file", "namespace", "detached", "replaced", "stale"])("malformed or stale %s handles cannot be used", kind => {
	const f = fixture();
	try {
		const adapter = f.client.find(f.owner)!, captured = adapter.handles()[0];
		if (kind === "file") f.handle.target.file = { path: "Team/Other.md" } as TFile;
		if (kind === "namespace") f.handle.target.property = "unknown.total";
		if (kind === "detached") f.badge.remove();
		if (kind === "replaced") f.handle.target = { ...f.handle.target, property: "note.other" };
		if (kind === "stale") f.stale();
		expect(captured.current()).toBe(false);
		if (kind !== "replaced") expect(adapter.handles()).toEqual([]);
	} finally { f.close(); }
});

test("duplicate owners and unknown protocols fail closed without scanning DOM labels", () => {
	const f = fixture(false);
	try {
		f.ready({ ...f.bridge, protocolVersion: 9 }); expect(f.client.find(f.owner)).toBeUndefined();
		f.ready(); const captured = f.client.find(f.owner)!;
		f.replace([f.surface, { ...f.surface }]); expect(f.client.find(f.owner)).toBeUndefined(); expect(captured.current()).toBe(false);
		f.replace([{ ...f.surface, protocolVersion: 9 }]); expect(f.client.find(f.owner)).toBeUndefined();
		f.replace([f.surface]); expect(f.client.find(f.owner)).toBeDefined();
	} finally { f.close(); }
});

test("dirty inspector guards run before native reveal and annotation entry", () => {
	const f = fixture();
	try {
		const adapter = f.client.find(f.owner)!; f.busy();
		expect(f.client.canNavigate(document)).toBe(false);
		expect(adapter.reveal({ type: "item", file: f.file })).toBe("busy");
		expect(adapter.beginAnnotation(jest.fn(), jest.fn())).toBeUndefined();
		expect(f.surface.reveal).not.toHaveBeenCalled(); expect(f.surface.beginAnnotation).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test.each(["remove", "unload", "close"] as const)("annotation hooks and captured handles are retired on %s", action => {
	const f = fixture();
	try {
		const adapter = f.client.find(f.owner)!, handle = adapter.handles()[0], select = jest.fn(), stopped = jest.fn();
		adapter.beginAnnotation(select, stopped);
		f[action](); expect(f.stops[0]).toHaveBeenCalledTimes(1); expect(stopped).toHaveBeenCalledTimes(1);
		f.select(); expect(select).not.toHaveBeenCalled(); expect(handle.current()).toBe(false); expect(f.client.find(f.owner)).toBeUndefined();
	} finally { f.close(); }
});

test("unloading then reloading the provider requires a fresh API and cleans old listeners", () => {
	const f = fixture();
	try {
		const prior = f.client.find(f.owner)!; f.unload();
		expect(f.client.supports("sabidurian-timeline")).toBe(false); expect(prior.current()).toBe(false);
		f.ready({ ...f.bridge, available: true }); expect(f.client.find(f.owner)).toBeDefined();
		f.client.close(); expect(f.workspace.offref).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});

test("explicit cancellation ignores late selection while the same surface remains current", () => {
	const f = fixture();
	try {
		const adapter = f.client.find(f.owner)!, select = jest.fn(), stopped = jest.fn();
		const stop = adapter.beginAnnotation(select, stopped)!; stop(); stop(); f.select();
		expect(select).not.toHaveBeenCalled(); expect(stopped).toHaveBeenCalledTimes(1); expect(adapter.current()).toBe(true);
		expect(f.stops[0]).toHaveBeenCalledTimes(1);
		adapter.beginAnnotation(select, stopped); f.select(); f.select();
		expect(select).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});
