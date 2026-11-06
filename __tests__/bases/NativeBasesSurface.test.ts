/** @jest-environment jsdom */
import { TFile } from "obsidian";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { sha256Hex } from "../../src/contentDigest";
import { NativeBasesSurface, baseConfigurationKey, nativeBaseProperty } from "../../src/bases/NativeBasesSurface";
import type { BaseRegistrySnapshot } from "../../src/bases/BaseRegistryProtocol";

jest.mock("obsidian", () => ({ TFile: class {}, parseYaml: (source: string) => JSON.parse(source) }));
Object.assign(window, { TextEncoder });
Object.defineProperty(window.crypto, "subtle", { configurable: true, value: webcrypto.subtle });
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function node(parent = document.body) { const element = document.createElement("div"); parent.appendChild(element); element.scrollIntoView = jest.fn(); return element; }
const file = (name: string): TFile => Object.assign(Object.create(TFile.prototype), { path: "Team/" + name, extension: name.split(".").pop(), stat: { mtime: 1, ctime: 1, size: 1 } });
function fixture(type: "table" | "cards" | "list" = "table") {
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
