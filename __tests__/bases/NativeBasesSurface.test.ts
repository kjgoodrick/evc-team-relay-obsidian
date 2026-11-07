/** @jest-environment jsdom */
import { TFile } from "obsidian";
import { StringValue, NumberValue, NullValue } from "../mocks/nativeBaseValues";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { sha256Hex } from "../../src/contentDigest";
import { NativeBasesSurface, baseConfigurationKey, nativeBaseProperty } from "../../src/bases/NativeBasesSurface";
import type { BaseRegistrySnapshot } from "../../src/bases/BaseRegistryProtocol";
import type { BasePresenceContext } from "../../src/collaboration/presence/BasePresenceProtocol";
import { TimelineBridgeClient } from "../../src/bases/TimelineBridgeClient";
import type { Workspace } from "obsidian";

jest.mock("obsidian", () => ({ ...jest.requireActual("../mocks/nativeBaseValues"), parseYaml: (source: string) => JSON.parse(source) }));
Object.assign(window, { TextEncoder });
Object.defineProperty(window.crypto, "subtle", { configurable: true, value: webcrypto.subtle });
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function node(parent = document.body) { const element = document.createElement("div"); parent.appendChild(element); element.scrollIntoView = jest.fn(); return element; }
const file = (name: string): TFile => Object.assign(Object.create(TFile.prototype), { path: "Team/" + name, extension: name.split(".").pop(), stat: { mtime: 1, ctime: 1, size: 1 } });
function fixture(type: "table" | "cards" | "list" | "sabidurian-timeline" | "sabidurian-sequence" = "table") {
	const root = node(), scroll = node(root), container = node(scroll), base = file("Plan.base"), a = file("a.md"), b = file("b.png");
	const serial = { filters: 'file.inFolder("Team")', views: [{ type, name: "Work", order: ["file.name", "note.status"] }] };
	const source = JSON.stringify(serial), entries = [{ file: a }, { file: b }];
	class Query { static parse(value: unknown) { return { getSerializable: () => value }; } }
	const query = { constructor: Query, file: base, views: [] as unknown[], getSerializable: () => serial };
	const config = { query, type, name: "Work" }; query.views = [config];
	const controller = { query, viewName: "Work", view: {} as Record<string, unknown>, initialScan: false };
	const renderer = { queryController: controller, type, config, containerEl: container, scrollEl: scroll,
		order: ["file.name", "note.status"],
		data: { groupedData: [{ entries }], properties: ["file.name", "note.status"] },
		rows: [] as Record<string, unknown>[], items: [] as Record<string, unknown>[], groups: [] as Record<string, unknown>[],
		header: { cells: [] as Record<string, unknown>[] },
		getCellRect: jest.fn(() => ({ top: 420, left: 150 })), updateVirtualDisplay: jest.fn(),
		measurements: { cardsPerRow: 1, cardHeight: 100, cardGap: 10, groupPad: { top: 8 } },
	};
	controller.view = renderer;
	function row(index: number) {
		const el = node(container), entry = entries[index];
		const cells = ["file.name", "note.status"].map(prop => ({ el: node(el), view: renderer, prop, propertyId: prop, entry }));
		return { view: renderer, entry, el, cells, props: cells, height: 100 };
	}
	const rows = [row(0), row(1)]; renderer.rows = rows; renderer.items = rows;
	renderer.groups = [{ rows, tbodyEl: node(container), containerEl: node(container), headerHeight: 30, height: 230 }];
	renderer.header.cells = ["file.name", "note.status"].map(prop => ({ view: renderer, el: node(root), prop }));
	const host = { file: base, contentEl: root, data: source, lastSavedData: source, dirty: false, controller, query, getViewType: () => "bases" };
	const inspect = () => NativeBasesSurface.inspect(host, "1.13.7");
	return { root, scroll, container, source, serial, host, renderer, query, controller, config, rows, a, b, entries, inspect };
}
async function registry(source: string): Promise<BaseRegistrySnapshot> {
	const view = JSON.parse(source).views[0];
	return { protocol_version: 1, definition_id: id(1), entry_id: id(2), generation: id(3), revision: 1,
		content_sha256: await sha256Hex(new TextEncoder().encode(source).buffer),
		views: [{ slot: 0, id: id(4), name: view.name, type: view.type, descriptor_sha256: "a".repeat(64) }],
		unmatched: { views: [], has_more: false, next_after: null } };
}
afterEach(() => { document.body.replaceChildren(); });

describe("native Bases identity boundary", () => {
	test.each(["table", "cards", "list"] as const)("%s exposes file and property identities without consulting visible text", type => {
		const f = fixture(type), surface = f.inspect()!;
		expect(surface).toBeDefined();
		f.rows[0].el.setAttribute("aria-label", "b.png");
		const target = surface.hit(f.rows[0].cells[1].el)!;
		expect(target.target).toEqual({ type: "cell", file: f.a, property: { source: "note", name: "status" } });
		expect(target.current()).toBe(true);
		expect(surface.handles().filter(handle => handle.target.type === "property")).toHaveLength(type === "table" ? 2 : 0);
	});
	test("unknown versions, custom views and disabled adapter leave no private hooks", () => {
		const f = fixture();
		expect(NativeBasesSurface.inspect(f.host, "1.14.0")).toBeUndefined();
		expect(NativeBasesSurface.inspect(f.host, "1.13.7", false)).toBeUndefined();
		Object.assign(f.renderer, { type: "custom" }); expect(f.inspect()).toBeUndefined();
	});
	test("native query loading is unavailable rather than a filtered-out target", () => {
		const f = fixture(); f.controller.initialScan = true; expect(f.inspect()).toBeUndefined();
		f.controller.initialScan = false; Object.assign(f.renderer, { data: undefined }); expect(f.inspect()).toBeUndefined();
	});
	test.each(["dirty", "unsaved", "serialized", "view-object", "duplicate", "file", "query", "detached"])("rejects %s configuration mismatch", mismatch => {
		const f = fixture();
		if (mismatch === "dirty") f.host.dirty = true;
		if (mismatch === "unsaved") f.host.lastSavedData = "different";
		if (mismatch === "serialized") f.serial.filters = "true";
		if (mismatch === "view-object") f.query.views = [{ ...f.config }];
		if (mismatch === "duplicate") f.query.views.push({ ...f.config });
		if (mismatch === "file") f.query.file = file("Other.base");
		if (mismatch === "query") f.controller.query = { ...f.query };
		if (mismatch === "detached") f.root.remove();
		expect(f.inspect()).toBeUndefined();
	});
	test("runtime edits and layout replacement invalidate an already captured surface", () => {
		const f = fixture(), surface = f.inspect()!;
		f.serial.views[0].order.reverse(); expect(surface.current()).toBe(false);
		f.serial.views[0].order.reverse(); expect(surface.current()).toBe(true);
		f.controller.view = { ...f.renderer }; expect(surface.handles()).toEqual([]);
	});
	test("native normalization accepts equivalent property syntax without hiding runtime changes", () => {
		const f = fixture();
		f.query.constructor.parse = value => ({ getSerializable: () => JSON.parse(JSON.stringify(value).split("note.status").join("status")) });
		f.serial.views[0].order[1] = "status";
		expect(f.inspect()).toBeDefined();
		f.serial.views[0].order[1] = "other"; expect(f.inspect()).toBeUndefined();
	});
	test.each(["table", "cards", "list"] as const)("%s rejects recycled or detached record/property handles", type => {
		const f = fixture(type), surface = f.inspect()!, handle = surface.hit(f.rows[0].cells[0].el)!;
		f.rows[0].entry = f.entries[1]; expect(handle.current()).toBe(false);
		f.rows[0].entry = f.entries[0]; f.rows[0].cells[0].prop = "file.size"; f.rows[0].cells[0].propertyId = "file.size";
		expect(handle.current()).toBe(false);
		const fresh = surface.hit(f.rows[1].cells[0].el)!; f.rows[1].el.remove(); expect(fresh.current()).toBe(false);
	});
	test("old rows removed from the renderer cannot be used even if their DOM remains", () => {
		const f = fixture(), handle = f.inspect()!.hit(f.rows[0].el)!;
		f.renderer.rows = [f.rows[1]]; expect(handle.current()).toBe(false);
	});
	test("query result replacement invalidates handles before the old rows are repainted", () => {
		const f = fixture(), handle = f.inspect()!.hit(f.rows[0].el)!;
		f.renderer.data = { ...f.renderer.data }; expect(handle.current()).toBe(false);
	});
	test("removed query entries invalidate still-mounted rows even when results mutate in place", () => {
		const f = fixture(), surface = f.inspect()!, handle = surface.hit(f.rows[0].el)!;
		f.renderer.data.groupedData[0].entries = [f.entries[1]];
		expect(handle.current()).toBe(false);
		expect(surface.handles().some(item => "file" in item.target && item.target.file === f.a)).toBe(false);
	});
	test("formula cells preserve their namespace and unknown properties remain unavailable", () => {
		const f = fixture(); f.rows[0].cells[0].prop = "formula.total";
		expect(f.inspect()!.hit(f.rows[0].cells[0].el)?.target).toMatchObject({ type: "cell", file: f.a, property: { source: "formula", name: "total" } });
		f.rows[0].cells[0].prop = "unknown.total";
		expect(f.inspect()!.hit(f.rows[0].cells[0].el)).toBeUndefined();
		expect(nativeBaseProperty("note.with.dots")).toEqual({ source: "note", name: "with.dots" });
		expect(nativeBaseProperty("status")).toBeUndefined();
	});
	test("configuration comparison ignores key order but preserves array order and bounds work", () => {
		expect(baseConfigurationKey({ b: 2, a: [1, false] })).toBe(baseConfigurationKey({ a: [1, false], b: 2 }));
		expect(baseConfigurationKey([1, 2])).not.toBe(baseConfigurationKey([2, 1]));
		const cyclic: unknown[] = []; cyclic.push(cyclic);
		for (const value of [cyclic, new Date(), { a: undefined }, Array(16_001).fill(0), "x".repeat(262_145)]) expect(baseConfigurationKey(value)).toBeUndefined();
	});
});

describe("Time & Line saved-view integration", () => {
	function timeline(type: "sabidurian-timeline" | "sabidurian-sequence" = "sabidurian-timeline") {
		const f = fixture(type), badge = document.createElementNS("http://www.w3.org/2000/svg", "g"); f.container.append(badge);
		let alive = true, busy = false;
		const target = { type: "cell", file: f.a, property: "formula.total" }, handle = { target, element: badge, current: () => alive && badge.isConnected };
		const remote = { protocolVersion: 1, owner: f.renderer, root: f.scroll, capabilities: ["item", "cell", "geometry", "reveal", "annotation"],
			current: () => alive, handles: () => [handle], viewport: () => f.scroll, hit: jest.fn(() => handle), reveal: jest.fn(() => "revealed"),
			beginAnnotation: jest.fn((_select: (value: unknown) => void, _stopped: () => void) => () => {}) };
		const listeners = new Set<() => void>(), bridge = { protocolVersion: 1, available: true, viewTypes: ["sabidurian-timeline", "sabidurian-sequence"],
			getSurfaces: () => [remote], canNavigate: () => !busy, onChange: (callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); } };
		const workspace = { on: () => ({}), offref() {}, trigger: (_name: string, receive: (value: unknown) => void) => receive(bridge) };
		const client = new TimelineBridgeClient(workspace as unknown as Workspace, () => {}); client.start();
		// Community Bases views expose ownership through their bridge, not the
		// built-in renderer's private container/queryController properties.
		Object.assign(f.renderer, { containerEl: undefined, queryController: undefined });
		return { ...f, badge, remote, handle, client, bridge,
			inspect: () => NativeBasesSurface.inspect(f.host, "1.13.7", true, client),
			busy: () => { busy = true; }, stale: () => { alive = false; },
			unload: () => { bridge.available = false; for (const listener of [...listeners]) listener(); },
			close: () => { client.close(); f.root.remove(); } };
	}
	function lane() {
		const f = timeline(), values = [new StringValue("1"), new NumberValue(1)], group = f.renderer.data.groupedData[0];
		Object.assign(f.config, { groupBy: { property: "note.status" } });
		Object.assign(f.serial.views[0], { groupBy: { property: "note.status" } });
		f.host.data = f.host.lastSavedData = JSON.stringify(f.serial);
		f.entries.forEach((entry, index) => Object.assign(entry, { getValue: () => values[index] }));
		const handle = { target: { type: "group", group }, element: f.badge, current: () => true };
		const groups = jest.fn(() => [handle]), reveal = jest.fn(() => "revealed");
		f.remote.capabilities.push("groups"); Object.assign(f.remote, { groups, revealGroup: reveal });
		return { ...f, group, values, groupHandle: handle, remoteGroups: groups, revealGroup: reveal };
	}
	test("lane values use source entries, preserve mixed typed values and authorize exact group navigation", () => {
		const f = lane();
		try {
			const surface = f.inspect()!, handles = surface.groupHit(f.badge, () => null);
			expect(handles.map(handle => handle.target.value)).toEqual([{ type: "number", value: 1 }, { type: "text", value: "1" }]);
			expect(handles.every(handle => handle.ambiguous && handle.element === f.badge && handle.current())).toBe(true);
			expect(handles.map(handle => handle.members())).toEqual([[f.b], [f.a]]);
			expect(surface.revealGroup(handles[0].target, () => null, () => false)).toBe("unavailable"); expect(f.revealGroup).not.toHaveBeenCalled();
			expect(surface.revealGroup(handles[1].target, () => null, () => true)).toBe("revealed"); expect(f.revealGroup).toHaveBeenCalledWith(f.group);
			f.busy(); expect(surface.revealGroup(handles[0].target, () => null, () => true)).toBe("busy"); expect(f.revealGroup).toHaveBeenCalledTimes(1);
		} finally { f.close(); }
	});
	test.each(["source", "duplicate", "duplicate-element", "too-many", "stale", "unsupported-value"])("lane %s mismatch cannot become a comment target", kind => {
		const f = lane();
		try {
			const surface = f.inspect()!;
			if (kind === "source") f.groupHandle.target.group = { ...f.group };
			if (kind === "duplicate") f.remoteGroups.mockReturnValue([f.groupHandle, f.groupHandle]);
			if (kind === "duplicate-element") {
				const second = { entries: [f.entries[0]] }; f.renderer.data.groupedData.push(second);
				f.remoteGroups.mockReturnValue([f.groupHandle, { ...f.groupHandle, target: { type: "group", group: second } }]);
			}
			if (kind === "too-many") f.remoteGroups.mockReturnValue(Array(257).fill(f.groupHandle));
			if (kind === "stale") f.groupHandle.current = () => false;
			if (kind === "unsupported-value") Object.assign(f.entries[0], { getValue: () => ({ toString: () => "1" }) });
			expect(surface.groupHandles(() => null)).toEqual([]);
		} finally { f.close(); }
	});
	test("lane values, membership, capability and detach changes retire previously selected handles", () => {
		const f = lane();
		try {
			const surface = f.inspect()!, handle = surface.groupHandles(() => null)[0];
			f.values[1] = new NumberValue(2); expect(handle.current()).toBe(false); expect(handle.members()).toEqual([]);
			const fresh = surface.groupHandles(() => null)[0]; f.renderer.data.groupedData.splice(0);
			expect(fresh.current()).toBe(false); expect(fresh.members()).toEqual([]);
			f.renderer.data.groupedData.push(f.group); const disabled = surface.groupHandles(() => null)[0];
			f.remote.capabilities = f.remote.capabilities.filter(value => value !== "groups"); expect(disabled.current()).toBe(false);
			f.remote.capabilities.push("groups"); const latest = surface.groupHandles(() => null)[0]; f.badge.remove();
			expect(latest.current()).toBe(false); expect(surface.groupHandles(() => null)).toEqual([]);
		} finally { f.close(); }
	});
	test("equal typed values in different lanes refuse ambiguous navigation", () => {
		const f = lane();
		try {
			const second = { entries: [f.entries[0]] }, element = document.createElementNS("http://www.w3.org/2000/svg", "g"); f.container.append(element);
			f.renderer.data.groupedData.push(second);
			f.remoteGroups.mockReturnValue([f.groupHandle, { ...f.groupHandle, target: { type: "group", group: second }, element }]);
			const surface = f.inspect()!, handle = surface.groupHandles(() => null).find(value => value.target.value.type === "text")!;
			expect(surface.revealGroup(handle.target, () => null, () => true)).toBe("unavailable"); expect(f.revealGroup).not.toHaveBeenCalled();
		} finally { f.close(); }
	});
	test("lane annotation preserves its location through the client without becoming an item or whole view", () => {
		const f = lane(); let deliver: (value: unknown) => void = () => {};
		f.remote.beginAnnotation.mockImplementation(select => { deliver = select; return () => {}; });
		try {
			const surface = f.inspect()!, item = jest.fn(), group = jest.fn();
			surface.beginAnnotation(item, jest.fn(), group); deliver(f.groupHandle);
			expect(item).not.toHaveBeenCalled(); expect(group).toHaveBeenCalledTimes(1);
			expect(group.mock.calls[0][0].group).toBe(f.group); expect(group.mock.calls[0][0].current()).toBe(true);
		} finally { f.close(); }
	});
	test.each(["sabidurian-timeline", "sabidurian-sequence"] as const)("%s binds exact saved bytes before mapping SVG property targets", async type => {
		const f = timeline(type);
		try {
			const surface = f.inspect()!; expect(surface).toBeDefined(); expect(surface.annotationSupported).toBe(true);
			const binding = await surface.bind(await registry(f.source), id(2), async () => f.source, () => true);
			expect(binding?.viewId).toBe(id(4)); expect(binding?.current()).toBe(true);
			const handle = surface.hit(f.badge, { clientX: 20, clientY: 30 })!;
			expect(handle.target).toEqual({ type: "cell", file: f.a, property: { source: "formula", name: "total" } });
			expect(handle.element).toBe(f.badge); expect(surface.viewport()).toBe(f.scroll);
			expect(await surface.reveal(handle.target, () => true)).toBe("revealed");
			expect(f.remote.reveal).toHaveBeenCalledWith(f.handle.target); expect(f.host.data).toBe(f.source);
			f.unload(); expect(handle.current()).toBe(false); expect(binding?.current()).toBe(false); expect(surface.handles()).toEqual([]);
		} finally { f.close(); }
	});
	test.each(["owner", "root", "dirty", "bytes", "config", "query"])("bridge discovery cannot bypass %s source ownership checks", kind => {
		const f = timeline();
		try {
			if (kind === "owner") f.controller.view = { ...f.renderer };
			if (kind === "root") document.body.append(f.scroll);
			if (kind === "dirty") f.host.dirty = true;
			if (kind === "bytes") f.host.lastSavedData += "\n";
			if (kind === "config") f.serial.views[0].order.reverse();
			if (kind === "query") f.config.query = { ...f.query };
			expect(f.inspect()).toBeUndefined();
		} finally { f.close(); }
	});
	test("a registered bridge does not expand the verified Obsidian version boundary", () => {
		const f = timeline();
		try { expect(NativeBasesSurface.inspect(f.host, "1.15.0", true, f.client)).toBeUndefined(); expect(f.inspect()).toBeDefined(); }
		finally { f.close(); }
	});
	test("saved source, permission and result replacement invalidate selected targets and annotation callbacks", async () => {
		const f = timeline(); let deliver: ((value: unknown) => void) | undefined;
		f.remote.beginAnnotation.mockImplementation((select) => { deliver = select; return () => {}; });
		try {
			const surface = f.inspect()!, handle = surface.handles()[1], selected = jest.fn();
			expect(await surface.bind(await registry(f.source), id(2), async () => f.source + "\n", () => true)).toBeUndefined();
			expect(await surface.reveal(handle.target, () => false)).toBe("unavailable"); expect(f.remote.reveal).not.toHaveBeenCalled();
			surface.beginAnnotation(selected, jest.fn());
			f.renderer.data = { ...f.renderer.data }; deliver?.(f.handle);
			expect(selected).not.toHaveBeenCalled(); expect(handle.current()).toBe(false);
		} finally { f.close(); }
	});
	test("dirty inspectors prevent activation from built-in views and timeline annotation or reveal", async () => {
		const f = timeline(), table = fixture();
		try {
			const surface = f.inspect()!, selectView = jest.fn(); Object.assign(table.controller, { selectView });
			const builtIn = NativeBasesSurface.inspect(table.host, "1.13.7", true, f.client)!;
			const binding = (await builtIn.bind(await registry(table.source), id(2), async () => table.source, () => true))!;
			f.busy(); expect(builtIn.activateView(id(4), binding)).toBe(false); expect(selectView).not.toHaveBeenCalled();
			expect(await surface.reveal({ type: "item", file: f.a }, () => true)).toBe("busy");
			expect(surface.beginAnnotation(jest.fn(), jest.fn())).toBeUndefined();
			expect(f.remote.reveal).not.toHaveBeenCalled(); expect(f.remote.beginAnnotation).not.toHaveBeenCalled();
		} finally { f.close(); table.root.remove(); }
	});
});

describe("verified saved-view binding", () => {
	test("view activation requires this surface's verified binding and leaves saved configuration unchanged", async () => {
		const f = fixture(), surface = f.inspect()!, snapshot = await registry(f.source), selectView = jest.fn();
		Object.assign(f.controller, { selectView });
		const binding = (await surface.bind(snapshot, id(2), async () => f.source, () => true))!;
		expect(surface.activateView(id(4), { ...binding })).toBe(false);
		expect(surface.activateView(id(4), binding)).toBe(true);
		expect(selectView).toHaveBeenCalledWith("Work");
		expect(f.host.data).toBe(f.source); expect(f.host.lastSavedData).toBe(f.source); expect(f.host.dirty).toBe(false);
		expect(surface.viewport()).toBe(f.scroll);
	});
	test.each(["unknown", "custom", "permission", "replaced"])("view activation refuses %s targets without invoking native controls", async change => {
		const f = fixture(), surface = f.inspect()!, snapshot = await registry(f.source), selectView = jest.fn(); let allowed = true;
		Object.assign(f.controller, { selectView });
		const binding = (await surface.bind(snapshot, id(2), async () => f.source, () => allowed))!;
		if (change === "custom") snapshot.views.push({ ...snapshot.views[0], id: id(5), type: "timeline", name: "Timeline", slot: 1 });
		if (change === "permission") allowed = false;
		if (change === "replaced") f.controller.view = { ...f.renderer };
		expect(surface.activateView(change === "unknown" || change === "custom" ? id(5) : id(4), binding)).toBe(false);
		expect(selectView).not.toHaveBeenCalled();
		if (change === "replaced") expect(surface.viewport()).toBeUndefined();
	});
	test("binds a slot only after exact disk, runtime and server digest verification", async () => {
		const f = fixture(), surface = f.inspect()!, snapshot = await registry(f.source);
		const binding = await surface.bind(snapshot, id(2), async () => f.source, () => true);
		expect(binding?.viewId).toBe(id(4)); expect(binding?.current()).toBe(true);
		f.host.dirty = true; expect(binding?.current()).toBe(false);
	});
	test("an external write invalidates a binding before Obsidian reloads the view", async () => {
		const f = fixture(), binding = await f.inspect()!.bind(await registry(f.source), id(2), async () => f.source, () => true);
		expect(binding?.current()).toBe(true); f.host.file.stat.mtime++; expect(binding?.current()).toBe(false);
	});
	test.each(["bytes", "digest", "entry", "unmatched", "slot", "permission", "runtime"])("rejects %s changes while binding", async change => {
		const f = fixture(), surface = f.inspect()!, snapshot = await registry(f.source); let allowed = true;
		if (change === "digest") snapshot.content_sha256 = "f".repeat(64);
		if (change === "entry") snapshot.entry_id = id(8);
		if (change === "unmatched") snapshot.views[0].id = null;
		if (change === "slot") snapshot.views[0].name = "Other";
		const read = async () => { if (change === "permission") allowed = false; if (change === "runtime") f.host.dirty = true; return f.source + (change === "bytes" ? "\n" : ""); };
		expect(await surface.bind(snapshot, id(2), read, () => allowed)).toBeUndefined();
	});
});

describe("read-only Bases presence binding", () => {
	async function setup() {
		const f = fixture();
		f.serial.views.push({ type: "cards", name: "Cards", order: ["file.name"] });
		f.query.views.push({ query: f.query, type: "cards", name: "Cards" });
		const source = f.host.data = f.host.lastSavedData = JSON.stringify(f.serial), selectView = jest.fn();
		Object.assign(f.controller, { selectView });
		const context: BasePresenceContext = { protocol_version: 1, share_id: id(9), entry_id: id(2), generation: id(3), definition_id: id(1), registry_revision: 1,
			content_sha256: await sha256Hex(new TextEncoder().encode(source).buffer), views: [{ id: id(4), slot: 0, name: "Work", type: "table" }, { id: id(5), slot: 1, name: "Cards", type: "cards" }] };
		return { ...f, source, context, selectView, surface: f.inspect()! };
	}
	test("verifies exact saved bytes and switches only the transient saved-view selection", async () => {
		const f = await setup(), read = jest.fn(async () => f.source);
		const binding = (await f.surface.bindPresence(f.context, id(9), id(2), read, () => true))!;
		expect(binding?.current()).toBe(true); expect(read).toHaveBeenCalledTimes(1);
		expect(f.surface.activatePresenceView(id(5), { ...binding })).toBe(false);
		expect(f.surface.activatePresenceView(id(5), binding)).toBe(true); expect(f.selectView).toHaveBeenCalledWith("Cards");
		expect(f.host.data).toBe(f.source); expect(f.host.lastSavedData).toBe(f.source); expect(f.host.dirty).toBe(false);
		expect(f.surface.activatePresenceView(id(8), binding)).toBe(false);
		f.host.file.stat.mtime++; expect(binding.current()).toBe(false);
		expect(f.surface.activatePresenceView(id(5), binding)).toBe(false); expect(f.selectView).toHaveBeenCalledTimes(1);
	});
	test.each(["bytes", "hash", "share", "entry", "unmatched", "other-slot", "permission", "runtime", "stat"])("refuses %s mismatch without changing native state", async change => {
		const f = await setup(); let allowed = true;
		const context = { ...f.context, ...(change === "hash" ? { content_sha256: "f".repeat(64) } : change === "share" ? { share_id: id(8) } : change === "entry" ? { entry_id: id(8) } : {}),
			views: change === "unmatched" ? f.context.views.slice(1) : change === "other-slot" ? f.context.views.map(view => view.slot ? { ...view, name: "Other" } : view) : f.context.views };
		const read = async () => { if (change === "permission") allowed = false; if (change === "runtime") f.host.dirty = true; if (change === "stat") f.host.file.stat.mtime++; return f.source + (change === "bytes" ? "\n" : ""); };
		expect(await f.surface.bindPresence(context, id(9), id(2), read, () => allowed)).toBeUndefined();
		expect(f.selectView).not.toHaveBeenCalled();
	});
	test("late verification cannot restore a released foreground context", async () => {
		const f = await setup(); let allowed = true, finish!: (value: string) => void;
		const pending = f.surface.bindPresence(f.context, id(9), id(2), () => new Promise(resolve => { finish = resolve; }), () => allowed);
		allowed = false; finish(f.source); expect(await pending).toBeUndefined(); expect(f.selectView).not.toHaveBeenCalled();
	});
});

describe("semantic target navigation", () => {
	test.each(["table", "cards", "list"] as const)("%s formula-cell navigation uses the property namespace, including offscreen and hidden targets", async type => {
		const f = fixture(type);
		for (const row of f.rows) { row.cells[1].prop = "formula.total"; row.cells[1].propertyId = "formula.total"; }
		f.renderer.header.cells[1].prop = "formula.total";
		f.renderer.data.properties[1] = "formula.total"; f.renderer.order[1] = "formula.total";
		const surface = f.inspect()!, target = { type: "cell" as const, file: f.b, property: { source: "formula" as const, name: "total" } };
		f.rows[1].el.remove(); f.renderer.updateVirtualDisplay.mockImplementation(() => { f.container.appendChild(f.rows[1].el); });
		expect(await surface.reveal(target, () => true, async () => {})).toBe("revealed");
		expect(f.rows[1].cells[1].el.scrollIntoView).toHaveBeenCalled();
		if (type === "table") expect(await surface.reveal({ type: "property", property: target.property }, () => true)).toBe("revealed");
		f.renderer.data.properties[1] = "note.total"; f.renderer.order[1] = "note.total";
		expect(await surface.reveal(target, () => true)).toBe("property-hidden");
		expect(f.host.data).toBe(f.source);
	});
	test.each(["table", "cards", "list"] as const)("%s reveals the selected file/property without altering query, selection or files", async type => {
		const f = fixture(type), surface = f.inspect()!, before = JSON.stringify(f.serial);
		expect(await surface.reveal({ type: "cell", file: f.b, property: { source: "file", name: "name" } }, () => true)).toBe("revealed");
		expect(f.rows[1].cells[0].el.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
		expect(JSON.stringify(f.serial)).toBe(before); expect(f.host.data).toBe(f.source);
		expect(f.renderer).not.toHaveProperty("activeCell");
	});
	test("filtered records do not change filters or scroll to a similar visible row", async () => {
		const f = fixture(), surface = f.inspect()!; f.scroll.scrollTop = 30;
		expect(await surface.reveal({ type: "item", file: file("missing.md") }, () => true)).toBe("hidden");
		expect(f.scroll.scrollTop).toBe(30); expect(f.renderer.updateVirtualDisplay).not.toHaveBeenCalled();
	});
	test("hidden property leaves the target intact", async () => {
		const f = fixture(), surface = f.inspect()!;
		expect(await surface.reveal({ type: "cell", file: f.a, property: { source: "note", name: "missing" } }, () => true)).toBe("property-hidden");
		expect(f.rows[0].el.scrollIntoView).not.toHaveBeenCalled();
	});
	test.each(["table", "cards", "list"] as const)("%s virtualized target uses query identity and verifies the newly mounted handle", async type => {
		const f = fixture(type), surface = f.inspect()!;
		f.rows[1].el.remove(); f.scroll.scrollTop = 20;
		f.renderer.updateVirtualDisplay.mockImplementation(() => { f.container.appendChild(f.rows[1].el); });
		expect(await surface.reveal({ type: "cell", file: f.b, property: { source: "file", name: "name" } }, () => true, async () => {})).toBe("revealed");
		expect(f.renderer.updateVirtualDisplay).toHaveBeenCalledTimes(1);
		expect(f.rows[1].cells[0].el.scrollIntoView).toHaveBeenCalled();
		if (type === "table") expect(f.renderer.getCellRect).toHaveBeenCalledWith({ groupIdx: 0, row: 1, column: 0 });
	});
	test("navigation aborts when authority changes during a virtual render", async () => {
		const f = fixture(), surface = f.inspect()!; f.rows[1].el.remove(); let allowed = true;
		f.renderer.updateVirtualDisplay.mockImplementation(() => { f.container.appendChild(f.rows[1].el); });
		expect(await surface.reveal({ type: "item", file: f.b }, () => allowed, async () => { allowed = false; })).toBe("unavailable");
		expect(f.rows[1].el.scrollIntoView).not.toHaveBeenCalled();
	});
	test("bounded failed virtual navigation restores the prior scroll position", async () => {
		const f = fixture(), surface = f.inspect()!; f.rows[1].el.remove(); f.scroll.scrollTop = 35; f.scroll.scrollLeft = 45;
		expect(await surface.reveal({ type: "item", file: f.b }, () => true, async () => {})).toBe("unavailable");
		expect(f.renderer.updateVirtualDisplay).toHaveBeenCalledTimes(3);
		expect(f.scroll.scrollTop).toBe(35); expect(f.scroll.scrollLeft).toBe(45);
	});
	test("a native renderer exception restores scrolling without editing the selected cell", async () => {
		const f = fixture(), surface = f.inspect()!; f.rows[1].el.remove(); f.scroll.scrollTop = 35;
		f.renderer.updateVirtualDisplay.mockImplementation(() => { throw new Error("Native view was replaced"); });
		expect(await surface.reveal({ type: "item", file: f.b }, () => true, async () => {})).toBe("unavailable");
		expect(f.scroll.scrollTop).toBe(35); expect(f.renderer).not.toHaveProperty("activeCell");
	});
	test("suspended animation frames cannot retain navigation indefinitely", async () => {
		jest.useFakeTimers();
		const request = jest.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
		const cancel = jest.spyOn(window, "cancelAnimationFrame");
		try {
			const f = fixture(), surface = f.inspect()!; f.rows[1].el.remove();
			const result = surface.reveal({ type: "item", file: f.b }, () => true);
			await jest.advanceTimersByTimeAsync(350);
			expect(await result).toBe("unavailable"); expect(request).toHaveBeenCalledTimes(3); expect(cancel).toHaveBeenCalledTimes(3);
			expect(jest.getTimerCount()).toBe(0);
		} finally { request.mockRestore(); cancel.mockRestore(); jest.useRealTimers(); }
	});
});

function groupedFixture(type: "table" | "cards" | "list" = "table") {
 const f = fixture(type), property = { source: "note" as const, name: "status" };
 Object.assign(f.config, { groupBy: { property: "note.status", direction: "ASC" } });
 Object.assign(f.serial.views[0], { groupBy: { property: "note.status", direction: "ASC" } });
 f.host.data = f.host.lastSavedData = JSON.stringify(f.serial);
 const values: unknown[] = [new StringValue("1"), new NumberValue(1)];
 f.entries.forEach((entry, i) => Object.assign(entry, { getValue: () => values[i] }));
 const group = f.renderer.data.groupedData[0], model = f.renderer.groups[0];
 const heading = node(f.container), child = node(heading); heading.className = "bases-group-heading";
 Object.assign(model, { view: f.renderer, group, groupHeadingEl: heading, tableEl: node(f.container) });
 if (type === "table") (model.tableEl as HTMLElement).appendChild(heading);
 const surface = f.inspect()!;
 return { ...f, values, group, model, heading, child, surface, property };
}

describe("typed native groups", () => {
 test.each(["table", "cards", "list"] as const)("%s captures distinct typed values sharing a header, independently of representative/order", type => {
  const f = groupedFixture(type), before = f.host.data;
  const handles = f.surface.groupHit(f.child, () => null);
  expect(handles).toHaveLength(2); expect(handles.every(h => h.ambiguous && h.current())).toBe(true);
  expect(handles.map(h => h.target.value)).toEqual([{ type: "number", value: 1 }, { type: "text", value: "1" }]);
  expect(handles[0].members()).toEqual([f.b]); expect(handles[1].members()).toEqual([f.a]);
  f.group.entries.reverse(); Object.assign(f.group, { key: NullValue.value });
  expect(f.surface.groupHandles(() => null).map(h => h.target)).toEqual(handles.map(h => h.target));
  expect(handles.every(h => h.current())).toBe(true);
  expect(handles[0].members()).toEqual([f.b]); expect(handles[1].members()).toEqual([f.a]);
  expect(f.surface.hit(f.child)).toBeUndefined();
  expect(f.host.data).toBe(before);
 });
 test("membership changes preserve a typed target while removing its last matching member invalidates capture", () => {
  const f = groupedFixture(); f.values[1] = new StringValue("1");
  const handle = f.surface.groupHandles(() => null)[0];
  expect(handle.ambiguous).toBe(false);
  f.group.entries.splice(1, 1); expect(handle.current()).toBe(true);
  f.values[0] = new StringValue("Done"); expect(handle.current()).toBe(false);
  expect(f.surface.revealGroup(handle.target, () => null, () => true)).toBe("hidden");
 });
 test("new ambiguity, recycled headings and replaced results invalidate previously captured handles", () => {
  const f = groupedFixture(); f.values[1] = new StringValue("1");
  const handle = f.surface.groupHandles(() => null)[0];
  f.values[1] = new NumberValue(1); expect(handle.current()).toBe(false);
  f.values[1] = new StringValue("1"); expect(handle.current()).toBe(true);
  f.heading.remove(); expect(handle.current()).toBe(false);
  (f.model.tableEl as HTMLElement).appendChild(f.heading);
  f.renderer.data = { ...f.renderer.data }; expect(handle.current()).toBe(false);
 });
 test.each(["table", "cards", "list"] as const)("%s exact group navigation preserves filters, cells and source bytes", type => {
  const f = groupedFixture(type), handle = f.surface.groupHandles(() => null)[0], before = f.host.data;
  expect(f.surface.revealGroup(handle.target, () => null, () => true)).toBe("revealed");
  expect(f.heading.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  expect(f.surface.revealGroup(handle.target, () => null, () => false)).toBe("unavailable");
  expect(f.surface.revealGroup({ ...handle.target, property: { source: "note", name: "other" } }, () => null, () => true)).toBe("unavailable");
  expect(f.host.data).toBe(before); expect(f.renderer).not.toHaveProperty("activeCell");
 });
 test("unknown values, oversized memberships, mismatched model arrays and ungrouped views never invent a target", () => {
  const f = groupedFixture();
  f.values[0] = { toString: () => "Planned" }; expect(f.surface.groupHandles(() => null)).toEqual([]);
  f.values[0] = new StringValue("Planned");
  const old = f.group.entries; f.group.entries = Array(20001).fill(f.entries[0]);
  expect(f.surface.groupHandles(() => null)).toEqual([]); f.group.entries = old;
  f.renderer.groups = []; expect(f.surface.groupHandles(() => null)).toEqual([]);
  expect(fixture().inspect()!.groupHandles(() => null)).toEqual([]);
 });
 test("a list group must refer to the same query group, not merely have a matching label", () => {
  const f = groupedFixture("list"); f.model.group = { ...f.group };
  expect(f.surface.groupHandles(() => null)).toEqual([]);
 });
 test("one typed value under multiple native headers remains ambiguous to navigation", () => {
  const f = groupedFixture(), handle = f.surface.groupHandles(() => null)[0];
  const group = { entries: [f.entries[1]] }, tableEl = node(f.container), heading = node(tableEl);
  heading.className = "bases-group-heading";
  f.renderer.data.groupedData.push(group); f.renderer.groups.push({ view: f.renderer, tableEl });
  expect(f.surface.revealGroup(handle.target, () => null, () => true)).toBe("unavailable");
  expect(f.heading.scrollIntoView).not.toHaveBeenCalled(); expect(heading.scrollIntoView).not.toHaveBeenCalled();
 });
});
