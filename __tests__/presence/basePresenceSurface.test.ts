/** @jest-environment jsdom */
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { BasePresenceSurface } from "../../src/collaboration/presence/BasePresenceSurface";
import { NativeBasesSurface } from "../../src/bases/NativeBasesSurface";
import { nativePresenceBase } from "../mocks/nativePresenceBase";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), FileView: class {}, parseYaml: (source: string) => JSON.parse(source) }));
Object.assign(window, { TextEncoder }); Object.defineProperty(crypto, "subtle", { configurable: true, value: webcrypto.subtle });
const settle = () => new Promise(resolve => window.setTimeout(resolve, 0));
async function until(check: () => boolean) { for (let i = 0; i < 50 && !check(); i++) await settle(); expect(check()).toBe(true); }
function fixture() {
	const base = nativePresenceBase(), changed = jest.fn(), interacted = jest.fn(); let allowed = true, supported = true, busy = false;
	const read = jest.fn(async () => base.context), readSource = jest.fn(async () => base.source);
	const inspect = () => NativeBasesSurface.inspect(base.host, "1.13.7", true, { find: () => undefined, supports: () => false, canNavigate: () => !busy });
	const surface = new BasePresenceSurface(base.view, base.context.share_id, base.context.entry_id, {
		current: () => allowed, connected: () => true, supported: () => supported, hash: () => base.record.hash, read, readSource, inspect, changed, interacted,
	});
	return { ...base, read, readSource, surface, changed, interacted, permit: (value: boolean) => { allowed = value; }, support: (value: boolean) => { supported = value; }, busy: () => { busy = true; },
		close: () => { surface.close(); base.close(); } };
}

test("native saved-view binding reuses metadata and source across view changes and result replacement", async () => {
	const f = fixture();
	try {
		f.surface.refresh(); await until(() => f.surface.state === "ready"); expect(f.surface.location).toEqual(f.location());
		for (let i = 0; i < 100; i++) f.surface.refresh();
		f.renderers[0].data = { ...f.renderers[0].data }; f.surface.refresh(); await until(() => f.surface.state === "ready");
		expect(f.surface.activate(f.location(1), () => true)).toBe("waiting"); await until(() => f.surface.location?.view_id === f.location(1).view_id);
		expect(f.controller.selectView).toHaveBeenCalledTimes(1); expect(f.controller.selectView).toHaveBeenCalledWith("Cards");
		expect(f.read).toHaveBeenCalledTimes(1); expect(f.readSource).toHaveBeenCalledTimes(1);
		expect(f.surface.reveal(() => true)).toBe(true); expect(f.renderers[1].scrollEl.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(f.host.data).toBe(f.source); expect(f.host.lastSavedData).toBe(f.source); expect(f.host.dirty).toBe(false);
		f.busy(); expect(f.surface.reveal(() => true)).toBe(false); expect(f.surface.activate(f.location(), () => true)).toBe("unavailable");
	} finally { f.close(); }
});

test("pending native view selection is not repeated during result repainting and cancellation permits a new action", async () => {
	const f = fixture();
	try {
		f.surface.refresh(); await until(() => f.surface.state === "ready"); f.controller.selectView.mockImplementation(() => {});
		expect(f.surface.activate(f.location(1), () => true)).toBe("waiting");
		f.renderers[0].data = { ...f.renderers[0].data }; f.surface.refresh(); await until(() => f.surface.state === "ready");
		for (let i = 0; i < 10; i++) expect(f.surface.activate(f.location(1), () => true)).toBe("waiting");
		expect(f.controller.selectView).toHaveBeenCalledTimes(1); f.surface.cancelNavigation();
		expect(f.surface.activate(f.location(1), () => true)).toBe("waiting"); expect(f.controller.selectView).toHaveBeenCalledTimes(2);
	} finally { f.close(); }
});

test("a denied or rejected lookup does not poll on repaint and explicit retry obtains a fresh proof", async () => {
	const f = fixture();
	try {
		f.read.mockRejectedValueOnce(new Error("Denied")); f.surface.refresh(); await until(() => f.surface.state === "unavailable");
		for (let i = 0; i < 100; i++) f.surface.refresh(); await settle(); expect(f.read).toHaveBeenCalledTimes(1);
		f.surface.retry(); await until(() => f.surface.state === "ready"); expect(f.read).toHaveBeenCalledTimes(2);
		f.surface.deny(); f.surface.refresh(); await settle(); expect(f.surface.location).toBeUndefined(); expect(f.read).toHaveBeenCalledTimes(2);
		f.surface.retry(); await until(() => f.surface.state === "ready"); expect(f.read).toHaveBeenCalledTimes(3);
	} finally { f.close(); }
});

test.each(["access", "file", "hash", "close", "disconnect"])("late metadata/source verification cannot restore a stale %s context", async loss => {
	const f = fixture(); let finish!: (value: typeof f.context) => void;
	try {
		f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); f.surface.refresh(); await until(() => !!finish);
		if (loss === "access") f.permit(false); if (loss === "file") f.file.stat.mtime++;
		if (loss === "hash") f.record.hash = "a".repeat(64); if (loss === "close") f.surface.close(); if (loss === "disconnect") f.support(false);
		finish(f.context); await settle(); await settle(); expect(f.surface.location).toBeUndefined(); expect(f.surface.reveal(() => true)).toBe(false);
	} finally { f.close(); }
});

test("stale revision, unknown view and unsupported capabilities cannot select or read a view", async () => {
	const f = fixture();
	try {
		f.support(false); f.surface.refresh(); await settle(); expect(f.read).not.toHaveBeenCalled();
		f.support(true); f.surface.refresh(); await until(() => f.surface.state === "ready");
		expect(f.surface.activate({ ...f.location(1), registry_revision: 2 }, () => true)).toBe("waiting"); await until(() => f.surface.state === "ready");
		expect(f.surface.activate({ ...f.location(1), registry_revision: 2 }, () => true)).toBe("unavailable"); expect(f.read).toHaveBeenCalledTimes(2);
		expect(f.surface.activate({ ...f.location(1), view_id: "00000000-0000-4000-8000-000000000099" }, () => true)).toBe("unavailable");
		expect(f.controller.selectView).not.toHaveBeenCalled();
		f.file.stat.size = 262_145; f.surface.refresh(); expect(f.surface.state).toBe("unavailable"); expect(f.surface.location).toBeUndefined();
	} finally { f.close(); }
});

test("a new registry revision refreshes once and reuses verified file bytes before selecting its saved view", async () => {
	const f = fixture();
	try {
		f.surface.refresh(); await until(() => f.surface.state === "ready");
		f.read.mockResolvedValueOnce({ ...f.context, registry_revision: 2 }); const destination = { ...f.location(1), registry_revision: 2 };
		expect(f.surface.activate(destination, () => true)).toBe("waiting"); await until(() => f.surface.state === "ready");
		expect(f.surface.activate(destination, () => true)).toBe("waiting"); await until(() => f.surface.location?.view_id === destination.view_id);
		expect(f.surface.activate(destination, () => true)).toBe("ready"); expect(f.read).toHaveBeenCalledTimes(2); expect(f.readSource).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});

test("owned overlays do not rebind, and shutdown cancels scheduled DOM work and input listeners", async () => {
	const f = fixture();
	try {
		f.surface.refresh(); await until(() => f.surface.state === "ready"); f.changed.mockClear();
		const own = f.content.appendChild(document.createElement("div")); own.className = "relay-bases-comments"; own.appendChild(document.createElement("span"));
		await settle(); expect(f.changed).not.toHaveBeenCalled();
		f.content.dispatchEvent(new WheelEvent("wheel")); expect(f.interacted).toHaveBeenCalledTimes(1);
		f.content.appendChild(document.createElement("div")); await settle(); f.surface.close(); f.changed.mockClear();
		f.content.dispatchEvent(new WheelEvent("wheel")); await new Promise(resolve => window.setTimeout(resolve, 60));
		expect(f.changed).not.toHaveBeenCalled(); expect(f.interacted).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});
