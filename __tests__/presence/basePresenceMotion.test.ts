/** @jest-environment jsdom */
/* eslint-disable obsidianmd/no-static-styles-assignment -- Native geometry and transforms are simulated in the test fixture. */
import { TFile } from "obsidian";
import { StringValue, NumberValue } from "../mocks/nativeBaseValues";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { BasePresenceMotion } from "../../src/collaboration/presence/BasePresenceMotion";
import { NativeBasesSurface } from "../../src/bases/NativeBasesSurface";
import type { BasePresenceState, BaseRecordContext } from "../../src/collaboration/presence/BasePositionProtocol";
import { nativePresenceBase } from "../mocks/nativePresenceBase";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), ...jest.requireActual("../mocks/nativeBaseValues"), FileView: class {}, parseYaml: (source: string) => JSON.parse(source) }));
Object.assign(window, { TextEncoder });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function box(element: HTMLElement, width: number, height: number, left = 0, top = 0) {
	Object.defineProperties(element, { offsetWidth: { value: width, configurable: true }, offsetHeight: { value: height, configurable: true }, clientWidth: { value: width, configurable: true }, clientHeight: { value: height, configurable: true } });
	element.getBoundingClientRect = () => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) });
}
const state = (record = 40, x = 0.25): BasePresenceState => ({ version: 1, pointer: { target: { type: "cell", record_id: id(record), record_generation: id(record + 10), property: { source: "note", name: "status" } }, offset: { x, y: 0.5 } }, viewport: null });
function fixture(type: "table" | "cards" | "list" = "table", grouped = false) {
	const base = nativePresenceBase(type), files: TFile[] = [40, 41].map(n => Object.assign(Object.create(TFile.prototype), { path: `${n}.md`, extension: "md" }));
	const rows = base.setRecords(files)[0], renderer = base.renderers[0];
	box(base.root, 400, 300); box(base.content, 400, 300); box(renderer.containerEl, 400, 300); box(renderer.scrollEl, 400, 200, 0, 40);
	rows.forEach((row, i) => { box(row.el, 400, 50, 0, 50 + i * 100); row.cells.forEach((cell, col) => box(cell.el, 200, 50, col * 200, 50 + i * 100)); });
	for (const [index, header] of renderer.header.cells.entries()) box(header.el as HTMLElement, 200, 30, index * 200, 0);
	const values: unknown[] = [new StringValue("Done"), new StringValue("Done")];
	const heading = renderer.scrollEl.appendChild(document.createElement("div")); heading.className = "bases-group-heading"; heading.scrollIntoView = jest.fn(); box(heading, 400, 10, 0, 40);
	if (grouped) {
		Object.assign(base.serial.views[0], { groupBy: { property: "note.status" } }); Object.assign(renderer.config, { groupBy: { property: "note.status" } });
		base.host.data = base.host.lastSavedData = JSON.stringify(base.serial);
		const group = renderer.data.groupedData[0]; group.entries.forEach((entry, index) => Object.assign(entry, { getValue: () => values[index] }));
		Object.assign(renderer.groups[0], { view: renderer, group, groupHeadingEl: heading, tableEl: renderer.scrollEl });
	}
	let surface = NativeBasesSurface.inspect(base.host, "1.13.7")!, active = true, publishing = true, allowed = true;
	const read = jest.fn(async (entry: string): Promise<BaseRecordContext> => ({ protocol_version: 1, share_id: base.context.share_id, entry_id: entry, generation: id(Number(entry.slice(-12)) + 10), type: "markdown" }));
	const publish = jest.fn(), motion = new BasePresenceMotion(base.content, {
		current: () => active, publishing: () => publishing, location: () => base.location(), surface: () => surface,
		local: file => allowed && files.includes(file) ? { id: id(Number(file.path.split(".")[0])), type: "markdown" } : undefined,
		file: entry => allowed ? files.find(file => id(Number(file.path.split(".")[0])) === entry) : undefined, read, publish,
		groups: grouped ? { supported: () => true, resolve: () => null, fileAtPath: path => files.find(file => file.path === path) ?? null } : undefined,
	});
	const layer = base.content.querySelector<HTMLDivElement>(".relay-base-presence")!; box(layer, 400, 300);
	const peer = { key: "peer", userId: id(90), name: "<img src=x>", baseState: state() };
	return { ...base, files, rows, renderer, read, publish, motion, layer, peer, heading, values,
		active: (value: boolean) => { active = value; }, visible: (value: boolean) => { publishing = value; }, permit: (value: boolean) => { allowed = value; },
		rebind: () => { surface = NativeBasesSurface.inspect(base.host, "1.13.7")!; motion.refresh(); },
		close: () => { motion.close(); base.close(); } };
}
const settle = () => jest.advanceTimersByTimeAsync(300);
let oldSubtle: PropertyDescriptor | undefined;
beforeEach(() => { jest.useFakeTimers(); oldSubtle = Object.getOwnPropertyDescriptor(crypto, "subtle"); Object.defineProperty(crypto, "subtle", { value: webcrypto.subtle, configurable: true }); });
afterEach(() => { jest.useRealTimers(); if (oldSubtle) Object.defineProperty(crypto, "subtle", oldSubtle); else Reflect.deleteProperty(crypto, "subtle"); });

test("captures exact native cell/record/header handles, coalesces input and reuses lineage across repaint", async () => {
	const f = fixture();
	try {
		await settle(); f.publish.mockClear();
		for (let x = 0; x <= 1000; x++) f.rows[0].cells[1].el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 250, clientY: 75 }));
		expect(f.publish).not.toHaveBeenCalled(); await settle();
		expect(f.publish.mock.calls.at(-1)![0].pointer).toEqual(state().pointer);
		const reads = f.read.mock.calls.length; for (let n = 0; n < 20; n++) { f.motion.refresh(); await settle(); } expect(f.read).toHaveBeenCalledTimes(reads);
		f.rows[0].el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 75 })); await settle();
		expect(f.publish.mock.calls.at(-1)![0].pointer.target.type).toBe("item");
		(f.renderer.header.cells[1].el as HTMLElement).dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 250, clientY: 15 })); await settle();
		expect(f.publish.mock.calls.at(-1)![0].pointer.target).toEqual({ type: "property", property: { source: "note", name: "status" } });
		f.renderer.data = { ...f.renderer.data }; f.rebind(); await settle(); expect(f.read).toHaveBeenCalledTimes(reads);
	} finally { f.close(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("authenticated pointers use exact records, clipped geometry and text labels; hidden people still observe", async () => {
	const f = fixture();
	try {
		f.motion.setPeers([f.peer]); await settle();
		const marker = f.layer.querySelector<HTMLElement>(".relay-base-presence-pointer")!;
		expect(marker).not.toBeNull(); expect(marker.style.left).toBe("250px"); expect(marker.style.top).toBe("75px"); expect(marker.textContent).toBe("<img src=x>"); expect(f.layer.querySelector("img")).toBeNull();
		f.visible(false); f.motion.refresh(); await settle(); expect(f.publish).toHaveBeenLastCalledWith(null); expect(f.layer.contains(marker)).toBe(true);
		box(f.rows[0].cells[1].el, 200, 50, 800, 50); f.motion.layout(); await settle(); expect(f.layer.children).toHaveLength(0);
		f.motion.setPeers([]); await settle(); expect(f.layer.children).toHaveLength(0);
	} finally { f.close(); }
});

test("Jump targets the pointer and Follow targets the viewport without changing selection or saved view", async () => {
	const f = fixture();
	try {
		const current = () => true, value = { ...state(), viewport: state(41).pointer };
		expect(await f.motion.reveal(value, false, current)).toBe(true); expect(f.rows[0].cells[1].el.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(await f.motion.reveal(value, true, current)).toBe(true); expect(f.rows[1].cells[1].el.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(f.controller.selectView).not.toHaveBeenCalled(); expect(f.host.data).toBe(f.source); expect(f.host.dirty).toBe(false);
		f.motion.setPeers([f.peer]); await settle(); f.permit(false); f.motion.recordsChanged(); await settle(); expect(f.layer.children).toHaveLength(0);
		expect(await f.motion.reveal(value, false, current)).toBe(false);
	} finally { f.close(); }
});

test.each(["cancel", "logout", "record", "close"])("pending lineage cannot navigate after %s", async loss => {
	const f = fixture(); let finish!: (value: BaseRecordContext) => void;
	try {
		const original = f.read.getMockImplementation()!;
		f.read.mockImplementation(entry => entry === id(40) ? new Promise(resolve => { finish = resolve; }) : original(entry));
		const pending = f.motion.reveal(state(), false, () => true); await jest.advanceTimersByTimeAsync(0);
		expect(finish).toBeDefined();
		if (loss === "cancel") f.motion.cancelNavigation(); if (loss === "logout") f.active(false); if (loss === "record") f.permit(false); if (loss === "close") f.motion.close();
		if (loss === "cancel" || loss === "close") expect(await pending).toBe(false);
		finish({ protocol_version: 1, share_id: f.context.share_id, entry_id: id(40), generation: id(50), type: "markdown" });
		expect(await pending).toBe(false); expect(f.rows[0].cells[1].el.scrollIntoView).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("recycled cells, ambiguous duplicate records, hidden properties and unsupported transforms cannot acquire guessed positions", async () => {
	const f = fixture();
	try {
		f.motion.setPeers([f.peer]); await settle(); expect(f.layer.children).toHaveLength(1);
		f.rows[0].entry.file = f.files[1]; f.motion.layout(); await settle(); expect(f.layer.children).toHaveLength(0);
		f.rows[0].entry.file = f.files[0]; f.rows[1].entry.file = f.files[0]; f.motion.layout(); await settle(); expect(f.layer.children).toHaveLength(0);
		expect(await f.motion.reveal(state(), false, () => true)).toBe(false);
		f.rows[1].entry.file = f.files[1]; f.renderer.data.properties = ["file.name"];
		expect(await f.motion.reveal(state(), false, () => true)).toBe(false);
		f.renderer.data.properties = ["file.name", "note.status"]; f.content.style.rotate = "30deg"; await settle(); expect(f.layer.children).toHaveLength(0);
	} finally { f.close(); }
});

test("departure, scroll and touch release clear a pointer, and close cancels all work", async () => {
	const f = fixture();
	try {
		await settle(); const cell = f.rows[0].cells[1].el;
		cell.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 250, clientY: 75 })); await settle(); expect(f.publish.mock.calls.at(-1)![0].pointer).not.toBeNull();
		f.content.dispatchEvent(new Event("pointerleave")); expect(f.publish.mock.calls.at(-1)![0].pointer).toBeNull();
		cell.dispatchEvent(Object.assign(new MouseEvent("pointerdown", { bubbles: true, clientX: 250, clientY: 75 }), { pointerType: "touch" })); await settle();
		cell.dispatchEvent(Object.assign(new MouseEvent("pointerup", { bubbles: true }), { pointerType: "touch" })); expect(f.publish.mock.calls.at(-1)![0].pointer).toBeNull();
		cell.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 250, clientY: 75 })); await settle(); f.renderer.scrollEl.dispatchEvent(new Event("scroll")); await settle(); expect(f.publish.mock.calls.at(-1)![0].pointer).toBeNull();
		f.motion.setPeers([f.peer]); f.motion.close(); const count = f.publish.mock.calls.length; await settle(); expect(f.publish).toHaveBeenCalledTimes(count); expect(f.content.querySelector(".relay-base-presence")).toBeNull();
	} finally { f.close(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("virtualized targets materialize through the native adapter, with cancellation before delayed layout", async () => {
	const f = fixture();
	try {
		await settle(); const row = f.rows[0], scroll = f.renderer.scrollEl;
		f.renderer.rows = [f.rows[1]]; row.el.remove();
		f.renderer.updateVirtualDisplay.mockImplementation(() => { f.renderer.rows = f.rows; scroll.append(row.el); });
		const pending = f.motion.reveal(state(), false, () => true); await settle(); expect(await pending).toBe(true);
		expect(f.renderer.updateVirtualDisplay).toHaveBeenCalledWith(true); expect(row.cells[1].el.scrollIntoView).toHaveBeenCalled();
		jest.mocked(row.cells[1].el.scrollIntoView).mockClear(); f.renderer.rows = [f.rows[1]]; row.el.remove(); f.renderer.updateVirtualDisplay.mockImplementation(() => {});
		const cancelled = f.motion.reveal(state(), false, () => true); await jest.advanceTimersByTimeAsync(0); f.motion.cancelNavigation(); expect(await cancelled).toBe(false);
		expect(row.cells[1].el.scrollIntoView).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBeLessThanOrEqual(2);
	} finally { f.close(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("position navigation centers the actual point in nested horizontal and vertical scrollers", async () => {
	const f = fixture();
	try {
		const scroll = f.renderer.scrollEl, cell = f.rows[0].cells[1].el;
		scroll.style.overflowX = "auto"; scroll.style.overflowY = "auto";
		box(scroll, 200, 100); Object.defineProperties(scroll, { scrollWidth: { value: 800 }, scrollHeight: { value: 600 } });
		cell.getBoundingClientRect = () => ({ x: 300 - scroll.scrollLeft, y: 250 - scroll.scrollTop, left: 300 - scroll.scrollLeft, top: 250 - scroll.scrollTop, width: 200, height: 50, right: 500 - scroll.scrollLeft, bottom: 300 - scroll.scrollTop, toJSON: () => ({}) });
		scroll.scrollBy = jest.fn((value?: ScrollToOptions | number, y?: number) => { const amount = typeof value === "number" ? { left: value, top: y } : value ?? {}; scroll.scrollLeft += amount.left ?? 0; scroll.scrollTop += amount.top ?? 0; });
		expect(await f.motion.reveal(state(), false, () => true)).toBe(true);
		expect([scroll.scrollLeft, scroll.scrollTop]).toEqual([250, 225]);
		expect(scroll.scrollBy).toHaveBeenCalledTimes(1); expect(f.host.dirty).toBe(false);
	} finally { f.close(); }
});

test.each(["cards", "list"] as const)("%s uses native property handles for capture, overlays and navigation", async type => {
	const f = fixture(type);
	try {
		f.motion.setPeers([f.peer]); await settle(); expect(f.layer.children).toHaveLength(1);
		f.rows[0].cells[1].el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 250, clientY: 75 })); await settle();
		expect(f.publish.mock.calls.at(-1)![0].pointer).toEqual(state().pointer);
		expect(await f.motion.reveal(state(), false, () => true)).toBe(true); expect(f.rows[0].cells[1].el.scrollIntoView).toHaveBeenCalled();
		expect(f.host.dirty).toBe(false);
	} finally { f.close(); }
});

test.each(["table", "cards", "list"] as const)("%s group pointers project and navigate exact native headers with hidden observation", async type => {
	const f = fixture(type, true);
	try {
		await settle(); f.heading.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 45 }));
		for (let n = 0; n < 5 && f.publish.mock.calls.at(-1)?.[0]?.pointer?.target.type !== "group"; n++) await settle();
		const state = f.publish.mock.calls.at(-1)![0] as BasePresenceState;
		expect(state.version).toBe(2); expect(state.pointer?.target.type).toBe("group"); expect(state.pointer?.offset).toEqual({ x: 0.25, y: 0.5 });
		f.motion.setPeers([{ ...f.peer, baseState: { ...state, viewport: null } }]); await settle();
		let marker = f.layer.querySelector<HTMLElement>(".relay-base-presence-pointer")!;
		expect(marker?.style.left).toBe("100px"); expect(marker?.style.top).toBe("45px");
		expect(await f.motion.reveal({ ...state, viewport: null }, false, () => true)).toBe(true); expect(f.heading.scrollIntoView).toHaveBeenCalled();
		f.visible(false); f.motion.refresh(); await settle(); expect(f.publish).toHaveBeenLastCalledWith(null);
		marker = f.layer.querySelector<HTMLElement>(".relay-base-presence-pointer")!; expect(marker).not.toBeNull();
		f.permit(false); f.motion.recordsChanged(); await settle(); expect(f.layer.children).toHaveLength(0);
		expect(await f.motion.reveal(state, false, () => true)).toBe(false); expect(f.controller.selectView).not.toHaveBeenCalled(); expect(f.host.dirty).toBe(false);
	} finally { f.close(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("merged typed groups and recycled member values clear markers without publishing a guessed header", async () => {
	const f = fixture("table", true);
	try {
		await settle(); f.heading.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 45 })); await settle(); await settle();
		const state = f.publish.mock.calls.at(-1)![0] as BasePresenceState; expect(state.pointer?.target.type).toBe("group");
		f.motion.setPeers([{ ...f.peer, baseState: state }]); await settle(); expect(f.layer.children).toHaveLength(1);
		f.values[1] = new NumberValue(1); f.motion.layout(); await settle(); expect(f.layer.children).toHaveLength(0);
		f.heading.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 45 })); await settle(); expect(f.publish.mock.calls.at(-1)![0].pointer).toBeNull();
		expect(await f.motion.reveal(state, false, () => true)).toBe(false);
	} finally { f.close(); }
});

test("group-only viewports follow a visible header without expanding a collapsed group", async () => {
	const f = fixture("table", true);
	try {
		f.renderer.rows = []; f.rows.forEach(row => row.el.remove()); f.motion.refresh(); await settle(); await settle();
		const state = f.publish.mock.calls.at(-1)![0] as BasePresenceState;
		expect(state.viewport?.target.type).toBe("group"); expect(await f.motion.reveal(state, true, () => true)).toBe(true);
		expect(f.heading.scrollIntoView).toHaveBeenCalled(); expect(f.renderer.updateVirtualDisplay).not.toHaveBeenCalled(); expect(f.host.dirty).toBe(false);
	} finally { f.close(); }
});

test("cancelled group navigation returns before a delayed metadata request and never scrolls afterward", async () => {
	const f = fixture("table", true); let finish!: (value: BaseRecordContext) => void;
	try {
		await settle(); f.heading.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 45 })); await settle(); await settle();
		const state = f.publish.mock.calls.at(-1)![0] as BasePresenceState;
		expect(state.pointer?.target.type).toBe("group");
		const original = f.read.getMockImplementation()!;
		f.read.mockImplementation(entry => entry === "00000000-0000-4000-8000-000000000040" ? new Promise(resolve => { finish = resolve; }) : original(entry));
		f.motion.retry(); const navigation = f.motion.reveal(state, false, () => true); await jest.advanceTimersByTimeAsync(0);
		expect(finish).toBeDefined(); f.motion.cancelNavigation(); expect(await navigation).toBe(false);
		finish(await original("00000000-0000-4000-8000-000000000040")); await settle(); expect(f.heading.scrollIntoView).not.toHaveBeenCalled();
	} finally { f.close(); }
	expect(jest.getTimerCount()).toBe(0);
});
