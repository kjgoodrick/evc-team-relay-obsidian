/** @jest-environment jsdom */
import type { App } from "obsidian";
import { TimelineMarkerComparisonModal } from "../../src/collaboration/ui/TimelineMarkerComparison";
import type { AnchoredThread, DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { timelineMarkerAnchor, type TimelineMarkerCatalog } from "../../src/collaboration/TimelineMarkerProtocol";
import type { BaseAnchor, TimelineAxis } from "../../src/collaboration/DiscussionProtocol";
import type { TimelineRange } from "../../src/collaboration/TimelineRange";

jest.mock("obsidian", () => ({ Modal: class {
	contentEl = document.createElement("div"); titleEl = document.createElement("h2");
	onOpen() {} onClose() {} setTitle(title: string) { this.titleEl.textContent = title; }
	open() { document.body.append(this.titleEl, this.contentEl); this.onOpen(); }
	close() { this.onClose(); this.titleEl.remove(); this.contentEl.remove(); }
} }));
Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); },
	setText(this: HTMLElement, text: string) { this.textContent = text; },
	addClass(this: HTMLElement, name: string) { this.classList.add(name); },
});
const id = (n: number) => `72000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = baseDiscussionScope(id(1), id(3));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const buttons = (name: string) => [...document.querySelectorAll("button")].filter(button => button.textContent === name);
const click = (name: string) => { expect(buttons(name)).toHaveLength(1); buttons(name)[0].click(); };
function fixture(range: TimelineRange = { version: 1, kind: "calendar", start: "2026-11-07", end: "2026-11-07", time_zone: "America/Denver", start_inclusive: true, end_inclusive: true }) {
	const access = { read: true, live: true, generation: id(4), status: "ready", fresh: true };
	const axis: TimelineAxis = { version: 1, renderer: range.kind === "ordinal" ? "sabidurian-sequence" : "sabidurian-timeline",
		start_property: { source: "note", name: "start" }, end_property: null, time_zone: range.kind === "calendar" || range.kind === "instant" ? range.time_zone : null };
	const content = { kind: "point" as const, label: "Captured launch", color: "#aabbcc", range };
	const catalog: TimelineMarkerCatalog = { protocol_version: 1, entry_id: id(1), definition_id: id(2), view_id: id(3), generation: id(4), registry_revision: 2,
		catalog_revision: 1, markers: [{ id: id(20), revision: 1, active: true, content, placement: { view_id: id(3), active: true, axis_definition_id: id(5), axis_definition_revision: 2, axis },
			target: { type: "timeline_marker", marker_id: id(20), marker_revision: 1, content, axis_definition_id: id(5), axis_definition_revision: 2, axis } }] };
	const anchor = timelineMarkerAnchor(catalog, catalog.markers[0]);
	let thread = { id: id(30), anchor_revision: 1, anchor } as AnchoredThread;
	let change = () => {};
	const stopped = jest.fn(), read = jest.fn(async () => catalog), linked = jest.fn(async () => ({ thread })), cached = jest.fn(async () => thread);
	const session = { get status() { return access.status; }, permission: () => ({ read: access.read, comment: false }),
		knownDocumentGeneration: () => access.generation, baseRegistryRevision: () => 2,
		linkedThread: linked, cachedThread: cached, readTimelineMarkers: read, verifiedTargetCatalog: () => access.fresh,
		onChange: (listener: () => void) => { change = listener; return stopped; } } as unknown as DiscussionSession;
	const reveal = jest.fn<Promise<void>, [BaseAnchor, () => boolean]>().mockResolvedValue(undefined);
	const modal = new TimelineMarkerComparisonModal({} as App, session, scope, id(30), 1, anchor, () => access.live, reveal);
	return { modal, catalog, anchor, access, read, linked, cached, reveal, stopped, change: () => change(),
		retarget() { thread = { ...thread, anchor_revision: 2 }; } };
}
afterEach(() => { document.body.replaceChildren(); jest.restoreAllMocks(); });

test("a reader compares changed marker content and navigates either immutable position without writes", async () => {
	const f = fixture(), marker = f.catalog.markers[0];
	marker.revision = marker.target.marker_revision = 2; f.catalog.catalog_revision = 2;
	marker.content.label = "Updated launch";
	marker.content.range = { ...marker.content.range, start: "2026-12-01", end: "2026-12-01" } as TimelineRange;
	f.modal.open(); await flush();
	expect(document.body.textContent).toContain("Captured launch"); expect(document.body.textContent).toContain("Updated launch");
	expect(document.body.textContent).toContain("Changed: label, position");
	expect(f.linked).toHaveBeenCalledWith(scope, id(30)); expect(f.read).toHaveBeenCalledTimes(1);
	click("Show captured position"); await flush(); click("Show checked position"); await flush();
	expect(f.reveal.mock.calls[0][0].target).toMatchObject({ marker_revision: 1, content: { label: "Captured launch", range: { start: "2026-11-07" } } });
	expect(f.reveal.mock.calls[1][0].target).toMatchObject({ marker_revision: 2, content: { label: "Updated launch", range: { start: "2026-12-01" } } });
	expect(f.reveal.mock.calls[0][1]()).toBe(true);
	f.modal.close(); expect(f.reveal.mock.calls[0][1]()).toBe(false); expect(f.stopped).toHaveBeenCalledTimes(1);
});

test.each(["archived", "detached"])("%s markers retain captured details without offering current navigation", async kind => {
	const f = fixture();
	if (kind === "archived") f.catalog.markers[0].active = false; else f.catalog.markers[0].placement.active = false;
	f.modal.open(); await flush();
	expect(document.body.textContent).toContain(kind); expect(buttons("Show captured position")).toHaveLength(1);
	expect(buttons("Show checked position")).toHaveLength(0); f.modal.close();
});

test.each([false, true])("missing marker status distinguishes saved data from a fresh read (fresh %s)", async fresh => {
	const f = fixture(); f.access.fresh = fresh; f.catalog.markers = [];
	f.modal.open(); await flush();
	expect(document.body.textContent).toContain(fresh ? "no longer listed" : "current status is unknown");
	expect(document.body.textContent).toContain(fresh ? "Checked with the server" : "Last saved catalog");
	expect(buttons("Show checked position")).toHaveLength(0); f.modal.close();
});

test("refresh is explicit, bounded and does not retain an obsolete navigation callback", async () => {
	const f = fixture(); f.modal.open(); await flush();
	expect(document.body.textContent).toContain("Matches the captured marker revision");
	click("Show checked position"); await flush(); const previous = f.reveal.mock.calls[0][1];
	let complete!: (value: TimelineMarkerCatalog) => void;
	f.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
	click("Refresh comparison"); click("Refresh comparison"); await flush();
	expect(f.read).toHaveBeenCalledTimes(2); expect(previous()).toBe(false);
	f.catalog.catalog_revision = f.catalog.markers[0].revision = f.catalog.markers[0].target.marker_revision = 2;
	complete(f.catalog); await flush();
	expect(document.body.textContent).toContain("content and axis match the captured target"); f.modal.close();
});

test.each(["permission", "authentication", "generation", "closed"])("%s changes clear the comparison and fence a late catalog", async change => {
	const f = fixture(); let complete!: (value: TimelineMarkerCatalog) => void;
	f.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
	f.modal.open(); await flush();
	if (change === "permission") f.access.read = false;
	if (change === "authentication") f.access.status = "authentication_required";
	if (change === "generation") f.access.generation = id(99);
	if (change === "closed") f.modal.close(); else f.change();
	f.access.read = true; f.access.status = "ready"; f.access.generation = id(4);
	complete(f.catalog); await flush();
	expect(document.body.textContent).toBe(""); expect(f.reveal).not.toHaveBeenCalled(); expect(f.stopped).toHaveBeenCalledTimes(1);
});

test("a retargeted thread cannot display a comparison completed for its previous anchor", async () => {
	const f = fixture(); let complete!: (value: TimelineMarkerCatalog) => void;
	f.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
	f.modal.open(); await flush(); f.retarget(); complete(f.catalog); await flush();
	expect(document.body.textContent).toContain("could not be verified"); expect(buttons("Show captured position")).toHaveLength(0); f.modal.close();
});

test.each(["definition_id", "entry_id", "view_id", "generation", "registry_revision"])("mismatched %s catalog is not displayed", async key => {
	const f = fixture(); Object.assign(f.catalog, { [key]: key === "registry_revision" ? 1 : id(99) });
	f.modal.open(); await flush(); expect(document.body.textContent).toContain("could not be verified");
	expect(document.body.textContent).not.toContain("Captured launch"); f.modal.close();
});

test.each<TimelineRange>([
	{ version: 1, kind: "ordinal", start: "999999999999999.000000001", end: "999999999999999.000000001", unit: "property-value", start_inclusive: true, end_inclusive: true },
	{ version: 1, kind: "historical", start: { precision: "year", year: -4000 }, end: { precision: "year", year: -4000 }, calendar: "proleptic-gregorian", year_numbering: "astronomical", start_inclusive: true, end_inclusive: true },
])("exact $kind coordinates retain their typed navigation payload", async range => {
	const f = fixture(range); f.modal.open(); await flush(); click("Show captured position"); await flush();
	expect(f.reveal.mock.calls[0][0].target).toMatchObject({ content: { range } }); f.modal.close();
});
