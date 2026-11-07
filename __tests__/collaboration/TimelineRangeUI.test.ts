/** @jest-environment jsdom */
import type { App } from "obsidian";
import { TimelineRangeModal } from "../../src/collaboration/ui/TimelineRangeModal";
import { TimelineRangeWorkflow } from "../../src/collaboration/ui/TimelineRangeWorkflow";
import { readNativeTimelineAxis, rangeMatchesAxis } from "../../src/collaboration/NativeTimelineRanges";
import { renderTimelineRangeMarkers } from "../../src/collaboration/TimelineRangeMarkers";
import type { BaseCommentContext } from "../../src/collaboration/BaseCommentContext";
import type { TimelineAxisContext } from "../../src/collaboration/TimelineRangeProtocol";
import type { BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import type { NativeTimelineContext, NativeTimelineSelection } from "../../src/bases/NativeBasesSurface";
import type { AnchoredThread } from "../../src/collaboration/DiscussionSession";

jest.mock("obsidian", () => ({ TFile: class {}, Notice: jest.fn(), Modal: class {
	contentEl = document.createElement("div"); titleEl = document.createElement("h2");
	onOpen() {} onClose() {} setTitle(title: string) { this.titleEl.textContent = title; }
	open() { document.body.append(this.titleEl, this.contentEl); this.onOpen(); }
	close() { this.onClose(); this.titleEl.remove(); this.contentEl.remove(); }
} }));
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); } });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const id = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const calendar = { version: 1 as const, kind: "calendar" as const, start: "2026-11-01", end: "2026-11-02", time_zone: "America/Denver", start_inclusive: true, end_inclusive: true };
function fixture() {
	let valid = true, comment = true, stopCallback = () => {};
	let select: (value: NativeTimelineSelection) => void = () => {};
	const proof: TimelineAxisContext = { protocol_version: 1, entry_id: id(1), definition_id: id(2), view_id: id(3), generation: id(4), registry_revision: 1,
		axis: { id: id(5), kind: "axis", revision: 1, fingerprint: "a".repeat(64), axis: { version: 1, renderer: "sabidurian-timeline", start_property: { source: "note", name: "start" }, end_property: null, time_zone: "America/Denver" } } };
	const native: NativeTimelineContext = { axis: proof.axis.axis, effectiveTimeZone: "America/Denver", kinds: ["calendar", "instant", "historical"], current: () => valid };
	const geometry = { startX: 10, endX: 300, top: 40, bottom: 60, discontinuous: false, current: () => valid };
	const stop = jest.fn(() => stopCallback()), readAxis = jest.fn().mockResolvedValue(proof);
	const context = { current: () => valid, entryId: "scope", baseEntryId: id(1),
		binding: { name: "Planning", type: "sabidurian-timeline", viewId: id(3), snapshot: { definition_id: id(2), generation: id(4), revision: 1 } },
		session: { permission: () => ({ read: true, comment }), canAnchorBase: () => true, readTimelineAxis: readAxis },
		surface: { rangeContext: () => native, rangeGeometry: jest.fn(() => geometry),
			beginRange: jest.fn((_kind, _precision, selected, stopped) => { select = selected; stopCallback = stopped; return stop; }) },
	} as unknown as BaseCommentContext;
	const anchor: BaseAnchor = { version: 1, type: "base", definition_id: id(2), view_id: id(3), generation: id(4), registry_revision: 1,
		target: { type: "timeline_range", axis_definition_id: id(5), axis_definition_revision: 1, axis: proof.axis.axis, range: calendar } };
	return { context, proof, native, readAxis, anchor, geometry, stop,
		select: () => { stopCallback(); select({ context: native, draft: { ...calendar }, current: () => valid }); },
		cancel: () => stopCallback(), stale: () => { valid = false; }, revoke: () => { comment = false; } };
}
const button = (label: string) => [...document.querySelectorAll("button")].find(value => value.textContent === label)!;
function field(name: string, value: string | boolean) {
	const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${name}"]`)!;
	if (typeof value === "boolean") (input as HTMLInputElement).checked = value; else input.value = value;
	input.dispatchEvent(new Event("input")); input.dispatchEvent(new Event("change")); return input;
}
function form(f = fixture(), draft: Record<string, unknown> = { ...calendar }) {
	const save = jest.fn().mockResolvedValue(true), pick = jest.fn(), closed = jest.fn();
	const modal = new TimelineRangeModal({} as App, { viewName: "Planning", context: f.native, draft, current: f.context.current, save, pick, closed });
	modal.open(); return { ...f, modal, save, pick, closed };
}
afterEach(() => { document.body.replaceChildren(); jest.restoreAllMocks(); });

test("whole-date endpoints and inclusivity are confirmed before opening the comment composer", async () => {
	const f = form(); field("end-inclusive", false); button("Write comment").click(); await flush();
	expect(f.save).toHaveBeenCalledWith({ ...calendar, end_inclusive: false }); expect(f.closed).toHaveBeenCalledTimes(1);
});

test("invalid dates and offset-free exact times cannot save; explicit repeated-hour offsets are retained", async () => {
	const f = form(); field("start", "2026-02-30"); expect(button("Write comment").disabled).toBe(true);
	field("kind", "instant"); field("start", "2026-11-01T01:30:00"); field("end", "2026-11-01T01:30:00-07:00");
	expect(button("Write comment").disabled).toBe(true); field("start", "2026-11-01T01:30:00-06:00");
	expect(button("Write comment").disabled).toBe(false); button("Write comment").click(); await flush();
	expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ kind: "instant", start: "2026-11-01T01:30:00.000-06:00", end: "2026-11-01T01:30:00.000-07:00" }));
});

test("historical endpoints expose CE/BCE and independent precision without a visible year zero", async () => {
	const f = form(); field("kind", "historical"); field("start-era", "bce"); field("start-year", "2");
	field("end-era", "bce"); field("end-year", "1"); field("end-precision", "day"); field("end-month", "2"); field("end-day", "29");
	button("Write comment").click(); await flush();
	expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ kind: "historical", start: { precision: "year", year: -1 }, end: { precision: "day", year: 0, month: 2, day: 29 } }));
});

test("a rejected capture retains editable values, and in-flight capture cannot be edited or sent twice", async () => {
	const f = form(); let finish!: (value: boolean) => void;
	f.save.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
	button("Write comment").click(); button("Write comment").click(); expect(f.save).toHaveBeenCalledTimes(1);
	expect(document.querySelector<HTMLInputElement>('[data-field="start"]')!.disabled).toBe(true);
	finish(false); await flush(); expect(document.querySelector<HTMLInputElement>('[data-field="start"]')!.value).toBe(calendar.start);
	expect(button("Write comment").disabled).toBe(false); expect(document.body.textContent).toContain("values are retained");
	f.stale(); f.modal.validate(); expect(button("Write comment").disabled).toBe(true); f.modal.close();
});

test("workflow verifies the native/saved axis and preserves endpoints through cancelled selection", async () => {
	const f = fixture(), save = jest.fn().mockResolvedValue(true), workflow = new TimelineRangeWorkflow({} as App, f.context, () => true, save);
	await workflow.open(); field("start", calendar.start); field("end", calendar.end);
	button("Select endpoints on timeline").click(); expect(document.querySelector(".relay-timeline-range-dialog")).toBeNull();
	f.cancel(); await flush(); expect(document.querySelector<HTMLInputElement>('[data-field="start"]')!.value).toBe(calendar.start);
	field("kind", "historical"); field("start-year", "unfinished year"); button("Select endpoints on timeline").click();
	f.cancel(); await flush(); expect(document.querySelector<HTMLInputElement>('[data-field="start-year"]')!.value).toBe("unfinished year");
	field("kind", "calendar");
	button("Select endpoints on timeline").click(); f.select(); await flush();
	expect(document.querySelectorAll(".relay-timeline-range-dialog")).toHaveLength(1);
	button("Write comment").click(); await flush(); expect(save).toHaveBeenCalledWith(f.proof, calendar, expect.any(Function));
	workflow.close();
});

test("closing the workflow cancels gestures and ignores late selection", async () => {
	const f = fixture(), workflow = new TimelineRangeWorkflow({} as App, f.context, () => true, jest.fn());
	await workflow.open(); button("Select endpoints on timeline").click(); workflow.close(); f.select(); await flush();
	expect(f.stop).toHaveBeenCalledTimes(1); expect(document.querySelector(".relay-timeline-range-dialog")).toBeNull();
});

test.each(["axis", "view", "generation", "revision", "stale"])("%s mismatch refuses verified capture/placement", async reason => {
	const f = fixture();
	if (reason === "axis") f.native.axis = { ...f.native.axis, start_property: { source: "note", name: "other" } };
	if (reason === "view") f.proof.view_id = id(9);
	if (reason === "generation") f.proof.generation = id(9);
	if (reason === "revision") f.proof.registry_revision = 2;
	if (reason === "stale") f.stale();
	await expect(readNativeTimelineAxis(f.context)).rejects.toThrow(); expect(rangeMatchesAxis(f.context, f.anchor, f.proof)).toBe(false);
});

test("range markers clip geometry, aggregate exact targets and never reload the axis on scroll", () => {
	const f = fixture(), marks = document.createElement("div"), open = jest.fn(); document.body.append(marks);
	const thread = { id: id(10), anchor: f.anchor } as AnchoredThread;
	const options = { context: f.context, proof: f.proof, threads: [thread, { ...thread, id: id(11) }], lanes: new Map(),
		root: { left: 0, right: 500, top: 0, bottom: 400 } as DOMRect, viewport: { left: 50, right: 250, top: 0, bottom: 200 } as DOMRect, marks, limit: 128, open };
	expect(renderTimelineRangeMarkers(options)).toBe(1); expect(marks.querySelector("button")!.textContent).toBe("2");
	expect(marks.querySelector<HTMLElement>(".relay-timeline-range-mark")!.style.width).toBe("200px");
	marks.querySelector("button")!.click(); expect(open).toHaveBeenCalledTimes(1);
	marks.replaceChildren(); renderTimelineRangeMarkers(options); expect(f.readAxis).not.toHaveBeenCalled();
	f.stale(); marks.querySelector("button")!.click(); expect(open).toHaveBeenCalledTimes(1);
});

test("historical axes and unresolved lane targets retain discussions without misleading view-wide markers", () => {
	const f = fixture(), marks = document.createElement("div"), rect = { left: 0, right: 500, top: 0, bottom: 400 } as DOMRect;
	if (f.anchor.target.type !== "timeline_range") throw new Error("fixture");
	f.anchor.target.axis_definition_revision = 2;
	const options = { context: f.context, proof: f.proof, threads: [{ id: id(10), anchor: f.anchor } as AnchoredThread], lanes: new Map(), root: rect, viewport: rect, marks, limit: 128, open: jest.fn() };
	expect(renderTimelineRangeMarkers(options)).toBe(0);
	f.anchor.target.axis_definition_revision = 1;
	f.anchor.target.lane = { type: "group", definition_id: id(20), definition_revision: 1, property: { source: "note", name: "status" }, group_id: id(21), witness_id: id(22), value: { type: "text", value: "Ready" } };
	expect(renderTimelineRangeMarkers(options)).toBe(0); expect(f.context.surface.rangeGeometry).not.toHaveBeenCalled();
});
