/** @jest-environment jsdom */
import type { App } from "obsidian";
import { TimelineRangeModal } from "../../src/collaboration/ui/TimelineRangeModal";
import { TimelineRangeWorkflow } from "../../src/collaboration/ui/TimelineRangeWorkflow";
import { readNativeTimelineAxis, timelineTargetMatchesAxis } from "../../src/collaboration/NativeTimelineRanges";
import { renderTimelineDiscussionMarkers } from "../../src/collaboration/TimelineRangeMarkers";
import type { BaseCommentContext } from "../../src/collaboration/BaseCommentContext";
import type { TimelineAxisContext } from "../../src/collaboration/TimelineRangeProtocol";
import type { BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import type { NativeTimelineContext, NativeTimelineSelection } from "../../src/bases/NativeBasesSurface";
import type { AnchoredThread } from "../../src/collaboration/DiscussionSession";
import type { NativeBaseGroupComments } from "../../src/collaboration/NativeBaseGroupComments";
import { TimelineMarkerPicker } from "../../src/collaboration/ui/TimelineMarkerPicker";
import { parseTimelineMarkerCatalog, timelineMarkerAnchor } from "../../src/collaboration/TimelineMarkerProtocol";

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
	expect(f.save).toHaveBeenCalledWith({ ...calendar, end_inclusive: false }, ""); expect(f.closed).toHaveBeenCalledTimes(1);
});

test("invalid dates and offset-free exact times cannot save; explicit repeated-hour offsets are retained", async () => {
	const f = form(); field("start", "2026-02-30"); expect(button("Write comment").disabled).toBe(true);
	field("kind", "instant"); field("start", "2026-11-01T01:30:00"); field("end", "2026-11-01T01:30:00-07:00");
	expect(button("Write comment").disabled).toBe(true); field("start", "2026-11-01T01:30:00-06:00");
	expect(button("Write comment").disabled).toBe(false); button("Write comment").click(); await flush();
	expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ kind: "instant", start: "2026-11-01T01:30:00.000-06:00", end: "2026-11-01T01:30:00.000-07:00" }), "");
});

test("historical endpoints expose CE/BCE and independent precision without a visible year zero", async () => {
	const f = form(); field("kind", "historical"); field("start-era", "bce"); field("start-year", "2");
	field("end-era", "bce"); field("end-year", "1"); field("end-precision", "day"); field("end-month", "2"); field("end-day", "29");
	button("Write comment").click(); await flush();
	expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ kind: "historical", start: { precision: "year", year: -1 }, end: { precision: "day", year: 0, month: 2, day: 29 } }), "");
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
	button("Write comment").click(); await flush(); expect(save).toHaveBeenCalledWith(f.proof, calendar, expect.any(Function), undefined);
	workflow.close();
});

test("closing the workflow cancels gestures and ignores late selection", async () => {
	const f = fixture(), workflow = new TimelineRangeWorkflow({} as App, f.context, () => true, jest.fn());
	await workflow.open(); button("Select endpoints on timeline").click(); workflow.close(); f.select(); await flush();
	expect(f.stop).toHaveBeenCalledTimes(1); expect(document.querySelector(".relay-timeline-range-dialog")).toBeNull();
});

test.each([false, true])("selected lanes survive endpoint picking and stale lanes cannot become view-wide ranges (stale=%s)", async stale => {
	const f = fixture(), save = jest.fn().mockResolvedValue(true); let laneCurrent = true;
	const handle = { target: { type: "group" as const, property: { source: "note" as const, name: "status" }, value: { type: "text" as const, value: "Ready" } },
		element: document.createElement("div"), ambiguous: false, members: () => [], current: () => laneCurrent };
	f.context.groups = { handles: () => [handle], canCapture: () => laneCurrent } as unknown as NativeBaseGroupComments;
	const workflow = new TimelineRangeWorkflow({} as App, f.context, () => true, save); await workflow.open();
	const scope = document.querySelector<HTMLSelectElement>('[data-field="lane"]')!, key = scope.options[1].value; field("lane", key);
	button("Select endpoints on timeline").click(); f.select(); await flush();
	expect(document.querySelector<HTMLSelectElement>('[data-field="lane"]')!.value).toBe(key);
	laneCurrent = !stale; button("Write comment").click(); await flush();
	if (stale) { expect(save).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("lane changed"); }
	else expect(save).toHaveBeenCalledWith(f.proof, calendar, expect.any(Function), handle);
	workflow.close();
});

test("duplicate typed lanes are omitted from capture choices instead of choosing a header", async () => {
	const f = fixture(), handle = { target: { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "Ready" } }, current: () => true };
	f.context.groups = { handles: () => [handle, { ...handle }], canCapture: () => true } as unknown as NativeBaseGroupComments;
	const workflow = new TimelineRangeWorkflow({} as App, f.context, () => true, jest.fn()); await workflow.open();
	expect(document.querySelector<HTMLSelectElement>('[data-field="lane"]')!.options).toHaveLength(1); workflow.close();
});

test.each(["axis", "view", "generation", "revision", "stale"])("%s mismatch refuses verified capture/placement", async reason => {
	const f = fixture();
	if (reason === "axis") f.native.axis = { ...f.native.axis, start_property: { source: "note", name: "other" } };
	if (reason === "view") f.proof.view_id = id(9);
	if (reason === "generation") f.proof.generation = id(9);
	if (reason === "revision") f.proof.registry_revision = 2;
	if (reason === "stale") f.stale();
	await expect(readNativeTimelineAxis(f.context)).rejects.toThrow(); expect(timelineTargetMatchesAxis(f.context, f.anchor, f.proof)).toBe(false);
});

test("range markers clip geometry, aggregate exact targets and never reload the axis on scroll", () => {
	const f = fixture(), marks = document.createElement("div"), open = jest.fn(); document.body.append(marks);
	const thread = { id: id(10), anchor: f.anchor } as AnchoredThread;
	const options = { context: f.context, proof: f.proof, threads: [thread, { ...thread, id: id(11) }], lanes: new Map(),
		root: { left: 0, right: 500, top: 0, bottom: 400 } as DOMRect, viewport: { left: 50, right: 250, top: 0, bottom: 200 } as DOMRect, marks, limit: 128, open };
	expect(renderTimelineDiscussionMarkers(options)).toBe(1); expect(marks.querySelector("button")!.textContent).toBe("2");
	expect(marks.querySelector<HTMLElement>(".relay-timeline-range-mark")!.style.width).toBe("200px");
	marks.querySelector("button")!.click(); expect(open).toHaveBeenCalledTimes(1);
	marks.replaceChildren(); renderTimelineDiscussionMarkers(options); expect(f.readAxis).not.toHaveBeenCalled();
	f.stale(); marks.querySelector("button")!.click(); expect(open).toHaveBeenCalledTimes(1);
});

test("historical axes and unresolved lane targets retain discussions without misleading view-wide markers", () => {
	const f = fixture(), marks = document.createElement("div"), rect = { left: 0, right: 500, top: 0, bottom: 400 } as DOMRect;
	if (f.anchor.target.type !== "timeline_range") throw new Error("fixture");
	f.anchor.target.axis_definition_revision = 2;
	const options = { context: f.context, proof: f.proof, threads: [{ id: id(10), anchor: f.anchor } as AnchoredThread], lanes: new Map(), root: rect, viewport: rect, marks, limit: 128, open: jest.fn() };
	expect(renderTimelineDiscussionMarkers(options)).toBe(0);
	f.anchor.target.axis_definition_revision = 1;
	f.anchor.target.lane = { type: "group", definition_id: id(20), definition_revision: 1, property: { source: "note", name: "status" }, group_id: id(21), witness_id: id(22), value: { type: "text", value: "Ready" } };
	expect(renderTimelineDiscussionMarkers(options)).toBe(0); expect(f.context.surface.rangeGeometry).not.toHaveBeenCalled();
});

function markerFixture() {
	const f = fixture(), { axis, ...context } = f.proof;
	const content = { kind: "range", label: "Launch", color: "#aabbcc", range: calendar };
	const catalog = parseTimelineMarkerCatalog({ ...context, catalog_revision: 1, markers: [{ id: id(60), revision: 1, active: true, content,
		placement: { view_id: id(3), active: true, axis_definition_id: axis.id, axis_definition_revision: axis.revision, axis: axis.axis },
		target: { type: "timeline_marker", marker_id: id(60), marker_revision: 1, content, axis_definition_id: axis.id, axis_definition_revision: axis.revision, axis: axis.axis } }] }, id(1), id(3));
	const read = jest.fn().mockResolvedValue(catalog), write = jest.fn().mockResolvedValue(true), show = jest.fn().mockResolvedValue(true);
	Object.assign(f.context.session, { readTimelineMarkers: read });
	const picker = new TimelineMarkerPicker({} as App, f.context, () => true, { write, show });
	return { ...f, catalog, read, write, show, picker, anchor: timelineMarkerAnchor(catalog, catalog.markers[0]) };
}
function selectMarker(id: string) { const field = document.querySelector<HTMLSelectElement>('[aria-label="Marker"]')!; field.value = id; field.dispatchEvent(new Event("change")); return field; }

test("marker picker saves an explicit marker identity/revision and allows read-only position inspection", async () => {
	const f = markerFixture(); f.picker.open(); await flush();
	expect(button("Write comment").disabled).toBe(true); selectMarker(id(60));
	button("Write comment").click(); await flush();
	expect(f.write).toHaveBeenCalledWith(f.catalog, id(60), expect.any(Function)); expect(document.querySelector(".relay-timeline-marker-dialog")).toBeNull();
	const reader = markerFixture(); reader.revoke(); reader.picker.open(); await flush(); selectMarker(id(60));
	expect(button("Write comment").disabled).toBe(true); expect(button("Show selected position").disabled).toBe(false);
	button("Show selected position").click(); await flush(); expect(reader.show).toHaveBeenCalledWith(reader.catalog, id(60), expect.any(Function));
});

test.each(["edit", "archive", "detach"])("marker refresh clears a changed selection (%s) instead of adopting its replacement", async change => {
	const f = markerFixture(); f.picker.open(); await flush(); selectMarker(id(60));
	const newer = parseTimelineMarkerCatalog(f.catalog, id(1), id(3)); newer.catalog_revision = 2; newer.markers[0].revision = 2; newer.markers[0].target.marker_revision = 2;
	if (change === "edit") { newer.markers[0].content.label = "Moved"; newer.markers[0].target.content.label = "Moved"; }
	if (change === "archive") newer.markers[0].active = false;
	if (change === "detach") newer.markers[0].placement.active = false;
	f.read.mockResolvedValue(newer); button("Refresh markers").click(); await flush();
	expect(document.querySelector<HTMLSelectElement>('[aria-label="Marker"]')!.value).toBe("");
	expect(button("Write comment").disabled).toBe(true); expect(document.body.textContent).toContain("selected marker changed"); f.picker.close();
});

test("unchanged refresh preserves keyboard selection, and failed capture retains a visible recoverable choice", async () => {
	const f = markerFixture(); f.picker.open(); await flush(); selectMarker(id(60)); button("Refresh markers").click(); await flush();
	expect(document.querySelector<HTMLSelectElement>('[aria-label="Marker"]')!.value).toBe(id(60));
	f.write.mockRejectedValue(new Error("Marker changed. Refresh before continuing.")); button("Write comment").click(); await flush();
	expect(document.body.textContent).toContain("Marker changed"); expect(document.querySelector<HTMLSelectElement>('[aria-label="Marker"]')!.value).toBe(id(60));
	expect(button("Refresh markers").disabled).toBe(false); f.picker.close();
});

test("picker closes on authority loss and ignores catalog delivery after cancellation", async () => {
	const f = markerFixture(); let finish!: (value: typeof f.catalog) => void;
	f.read.mockImplementation(() => new Promise(resolve => { finish = resolve; })); f.picker.open(); await flush(); f.picker.close(); finish(f.catalog); await flush();
	expect(document.querySelector(".relay-timeline-marker-dialog")).toBeNull(); expect(f.write).not.toHaveBeenCalled();
	const second = markerFixture(); second.picker.open(); await flush(); selectMarker(id(60)); second.stale(); second.picker.validate();
	expect(document.querySelector(".relay-timeline-marker-dialog")).toBeNull(); expect(second.write).not.toHaveBeenCalled();
});

test("closing during axis verification prevents the later marker catalog request", async () => {
	const f = markerFixture(); let finish!: (value: TimelineAxisContext) => void;
	f.readAxis.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	f.picker.open(); f.picker.close(); finish(f.proof); await flush();
	expect(f.read).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
	expect(document.querySelector(".relay-timeline-marker-dialog")).toBeNull();
});

test("captured marker overlays retain identity, revision, label and coordinates without merging ordinary ranges", () => {
	const f = markerFixture(), marks = document.createElement("div"), open = jest.fn(), rect = { left: 0, right: 500, top: 0, bottom: 400 } as DOMRect;
	const marker = f.anchor; if (marker.target.type !== "timeline_marker") throw new Error("fixture");
	const other = { ...marker, target: { ...marker.target, marker_id: id(61) } }, edited = { ...marker, target: { ...marker.target, marker_revision: 2, content: { ...marker.target.content, label: "Later launch" } } };
	const ordinary = { ...marker, target: { type: "timeline_range", axis_definition_id: marker.target.axis_definition_id, axis_definition_revision: 1, axis: marker.target.axis, range: calendar } };
	const threads = [marker, marker, other, edited, ordinary].map((anchor, i) => ({ id: id(70 + i), anchor }) as AnchoredThread);
	const options = { context: f.context, proof: f.proof, threads, lanes: new Map(), root: rect, viewport: rect, marks, limit: 128, open };
	expect(renderTimelineDiscussionMarkers(options)).toBe(4);
	expect([...marks.querySelectorAll("button")].map(button => button.textContent)).toEqual(["2", "1", "1", "1"]);
	expect(marks.querySelector("button")!.getAttribute("aria-label")).toContain("Captured marker: Launch");
	expect(marks.querySelectorAll(".relay-timeline-captured-marker")).toHaveLength(3);
	marks.querySelector("button")!.click(); expect(open.mock.calls[0][0]).toEqual(threads.slice(0, 2));
	marks.replaceChildren(); renderTimelineDiscussionMarkers(options); expect(f.read).not.toHaveBeenCalled(); expect(f.readAxis).not.toHaveBeenCalled();
	f.stale(); marks.querySelector("button")!.click(); expect(open).toHaveBeenCalledTimes(1);
});
