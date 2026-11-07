/** @jest-environment jsdom */
import type { App } from "obsidian";
import { TimelineMarkerManager } from "../../src/collaboration/ui/TimelineMarkerManager";
import type { BaseCommentContext } from "../../src/collaboration/BaseCommentContext";
import type { TimelineAxisContext } from "../../src/collaboration/TimelineRangeProtocol";
import type { TimelineMarkerCatalog } from "../../src/collaboration/TimelineMarkerProtocol";
import type { TimelineMarkerManagementState } from "../../src/collaboration/TimelineMarkerManagement";
import type { TimelineMarkerCommand, TimelineMarkerDetail, TimelineMarkerReceipt } from "../../src/collaboration/TimelineMarkerManagementProtocol";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import type { NativeTimelineSelection } from "../../src/bases/NativeBasesSurface";
import type { NativeLocalMarker } from "../../src/bases/TimelineLocalMarkerBridge";
import { promotedMarkerId } from "../../src/collaboration/LocalTimelineMarkers";

jest.mock("obsidian", () => ({ TFile: class {}, Notice: jest.fn(), Modal: class {
	contentEl = document.createElement("div"); titleEl = document.createElement("h2");
	onOpen() {} onClose() {} setTitle(title: string) { this.titleEl.textContent = title; }
	open() { document.body.append(this.titleEl, this.contentEl); this.onOpen(); }
	close() { this.onClose(); this.titleEl.remove(); this.contentEl.remove(); }
} }));
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); },
	addClass(this: HTMLElement, name: string) { this.classList.add(name); }, setText(this: HTMLElement, text: string) { this.textContent = text; } });
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const id = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = baseDiscussionScope(id(1), id(3));
const range = { version: 1 as const, kind: "calendar" as const, start: "2026-11-07", end: "2026-11-07", time_zone: "America/Denver", start_inclusive: true, end_inclusive: true };
const button = (name: string) => [...document.querySelectorAll("button")].find(button => button.textContent === name)!;
function input(name: string, value: string | boolean) {
	const field = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${name}"]`)!;
	if (typeof value === "boolean") (field as HTMLInputElement).checked = value; else field.value = value;
	field.dispatchEvent(new Event("input")); field.dispatchEvent(new Event("change")); return field;
}
function confirmation(text: string) {
	const label = [...document.querySelectorAll("label")].find(label => label.textContent?.includes(text))!;
	const field = label.querySelector<HTMLInputElement>("input")!; field.checked = true; field.dispatchEvent(new Event("change"));
}
function fixture() {
	const local: NativeLocalMarker = { id: id(60), label: "Local launch", color: "var(--color-blue)", date: "2026-11-07", enabled: true, current: () => true };
	let preference: unknown;
	const readPreference = jest.fn(async () => preference);
	const comparePreference = jest.fn(async (_key: string, expected: unknown, value: unknown, current: () => boolean) => {
		if (!current() || JSON.stringify(expected) !== JSON.stringify(preference)) return false;
		preference = value; return true;
	});
	const access = { current: true, read: true, edit: true, online: true, enabled: true, status: "ready", generation: id(4) };
	const proof: TimelineAxisContext = { protocol_version: 1, entry_id: id(1), definition_id: id(2), view_id: id(3), generation: id(4), registry_revision: 2,
		axis: { id: id(5), kind: "axis", revision: 2, fingerprint: "a".repeat(64), axis: { version: 1, renderer: "sabidurian-timeline", start_property: { source: "note", name: "start" }, end_property: null, time_zone: "America/Denver" } } };
	const placement = { view_id: id(3), active: true, axis_definition_id: id(5), axis_definition_revision: 2, axis: proof.axis.axis };
	const content = { kind: "point" as const, label: "Launch", color: "#aabbcc", range };
	const marker = { id: id(20), revision: 1, active: true, content, placement, target: { type: "timeline_marker" as const, marker_id: id(20), marker_revision: 1, content, axis_definition_id: id(5), axis_definition_revision: 2, axis: proof.axis.axis } };
	const { axis: _axis, ...common } = proof;
	const catalog: TimelineMarkerCatalog = { ...common, catalog_revision: 1, markers: [marker] };
	const detail: TimelineMarkerDetail = { protocol_version: 1, entry_id: id(1), definition_id: id(2), generation: id(4), registry_revision: 2, catalog_revision: 1,
		marker: { id: id(20), revision: 1, active: true, content, placements: [placement, { ...placement, view_id: id(30), axis_definition_id: id(31) }] } };
	let recovery: TimelineMarkerManagementState | undefined;
	const state = jest.fn(async () => recovery);
	const accepted = (request: TimelineMarkerCommand): TimelineMarkerReceipt => ({ ...detail, operation_id: request.operation_id, catalog_revision: request.expected_catalog_revision + 1,
		marker: { ...detail.marker, id: request.command.marker_id, revision: request.command.expected_marker_revision + 1, active: request.command.type !== "marker.archive" } });
	const save = jest.fn(async (_scope: string, request: TimelineMarkerCommand) => { const receipt = accepted(request); recovery = { version: 1, scope_id: scope, request, status: "accepted", receipt }; return receipt; });
	const retry = jest.fn(async () => { if (!recovery) throw new Error("Missing intent"); const receipt = accepted(recovery.request); recovery = { version: 1, scope_id: scope, request: recovery.request, status: "accepted", receipt }; return receipt; });
	const acknowledge = jest.fn(async () => { recovery = undefined; return true; });
	const readAxis = jest.fn(async () => proof), readCatalog = jest.fn(async () => catalog), readDetail = jest.fn(async () => detail), closed = jest.fn();
	const readPlacementAxis = jest.fn(async () => ({ ...proof, view_id: id(40), axis: { ...proof.axis, id: id(41) } }));
	const listeners = new Set<() => void>();
	let select: ((value: NativeTimelineSelection) => void) | undefined, stopped: (() => void) | undefined;
	const stop = jest.fn(() => stopped?.());
	const native = { axis: proof.axis.axis, kinds: ["calendar", "instant", "historical"], pointSelection: false, effectiveTimeZone: "America/Denver", current: () => access.current };
	const context = { current: () => access.current, entryId: scope, baseEntryId: id(1),
		binding: { name: "Planning", type: "sabidurian-timeline", viewId: id(3), snapshot: { definition_id: id(2), generation: id(4), revision: 2,
			views: [{ id: id(3), name: "Planning", type: "sabidurian-timeline" }, { id: id(30), name: "Roadmap", type: "sabidurian-timeline" },
				{ id: id(40), name: "Schedule", type: "sabidurian-timeline" }, { id: null, name: "Unmatched", type: "sabidurian-timeline" }, { id: id(50), name: "Table", type: "table" }] } },
		session: { trackLocal: <T>(promise: Promise<T>) => promise, store: { preference: readPreference, comparePreference }, get online() { return access.online; }, get status() { return access.status; }, knownDocumentGeneration: () => access.generation,
			onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
			permission: () => ({ read: access.read, edit: access.edit, comment: true }), canAnchorBase: () => access.enabled, readTimelineAxis: readAxis,
			readTimelineMarkerInventory: readCatalog, readTimelineMarkerDetail: readDetail, readTimelineMarkerPlacementAxis: readPlacementAxis, markerManagement: { state, save, retry, acknowledge } },
		surface: { localMarkers: () => [local], rangeContext: () => native, beginRange: jest.fn((_kind, _precision, callback, end) => { select = callback; stopped = end; return stop; }) },
	} as unknown as BaseCommentContext;
	const manager = new TimelineMarkerManager({} as App, context, () => true, closed);
	return { access, native, proof, catalog, detail, state, save, retry, acknowledge, readAxis, readCatalog, readDetail, readPlacementAxis, manager, closed, stop, context, listeners, local, readPreference, comparePreference,
		setRecovery: (value: TimelineMarkerManagementState | undefined) => { recovery = value; },
		pick: (point = false) => { stopped?.(); select?.({ context: native as NativeTimelineSelection["context"], draft: { ...range, end: point ? range.start : "2026-11-09" }, current: () => access.current }); } };
}
afterEach(() => { document.body.replaceChildren(); jest.restoreAllMocks(); });
async function loaded(f = fixture()) { f.manager.open(); await flush(); input("Shared marker", id(20)); await flush(); return f; }

async function chooseLocal(f = fixture()) {
	f.manager.open(); await flush(); button("Local markers…").click(); input("Local marker", f.local.id); await flush(); return f;
}
test("local promotion prepares a stable shared identity and requires the separate reviewed save", async () => {
	const f = await chooseLocal();
	expect(f.save).not.toHaveBeenCalled(); button("Prepare shared copy").click(); await flush();
	expect(document.body.textContent).toContain("The local marker uses theme blue");
	expect(f.save).not.toHaveBeenCalled(); expect(f.local.color).toBe("var(--color-blue)");
	button("Save marker").click(); await flush();
	expect(f.save.mock.calls[0][1].command).toMatchObject({ type: "marker.put", marker_id: promotedMarkerId(id(2), id(4), id(60)), expected_marker_revision: 0,
		content: { label: "Local launch", range: { kind: "calendar", start: "2026-11-07", end_inclusive: true } } });
	f.manager.close();
});
test("source edits before the shared save refuse promotion", async () => {
	const f = await chooseLocal(); button("Prepare shared copy").click(); f.local.current = () => false;
	f.manager.validate(); button("Save marker").click(); await flush(); expect(f.save).not.toHaveBeenCalled(); f.manager.close();
});
test("an unavailable axis explains why a local shared copy cannot be prepared", async () => {
	const f = fixture(); f.readAxis.mockRejectedValue(new Error("Axis unavailable")); await chooseLocal(f);
	button("Prepare shared copy").click(); await flush(); expect(document.body.textContent).toContain("saved axis is unavailable");
	expect(document.querySelector('[aria-label="Local marker"]')).not.toBeNull(); expect(f.save).not.toHaveBeenCalled(); f.manager.close();
});
test("an existing deterministic promotion cannot become a second shared copy", async () => {
	const f = fixture(); f.catalog.markers.push({ ...f.catalog.markers[0], id: promotedMarkerId(id(2), id(4), id(60)) });
	await chooseLocal(f); expect(button("Prepare shared copy").disabled).toBe(true);
	expect(document.body.textContent).toContain("already has a shared association"); f.manager.close();
});
test("matching previews the checked marker and stores only the explicit local association", async () => {
	const f = await chooseLocal(); input("Shared marker to match", id(20)); button("Check shared marker").click(); await flush();
	expect(document.body.textContent).toContain("Checked shared marker"); expect(f.comparePreference).not.toHaveBeenCalled();
	button("Confirm local match").click(); await flush();
	expect(f.comparePreference).toHaveBeenCalledWith(expect.any(String), undefined, { version: 1, marker_id: id(20) }, expect.any(Function));
	expect(f.save).not.toHaveBeenCalled(); expect(document.querySelector('[aria-label="Marker label"]')).not.toBeNull();
	button("Local markers…").click(); input("Local marker", f.local.id); await flush(); expect(button("Prepare shared copy").disabled).toBe(true); f.manager.close();
});
test("readers can explicitly match without shared edit permission", async () => {
	const f = fixture(); f.access.edit = false; await chooseLocal(f);
	expect(button("Prepare shared copy").disabled).toBe(true);
	input("Shared marker to match", id(20)); button("Check shared marker").click(); await flush();
	expect(button("Confirm local match").disabled).toBe(false); button("Confirm local match").click(); await flush();
	expect(f.comparePreference).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled(); f.manager.close();
});
test("a shared marker edited after matching review must be checked again", async () => {
	const f = await chooseLocal(); input("Shared marker to match", id(20)); button("Check shared marker").click(); await flush();
	f.readDetail.mockResolvedValueOnce({ ...f.detail, marker: { ...f.detail.marker, revision: 2 } });
	button("Confirm local match").click(); await flush(); expect(f.comparePreference).not.toHaveBeenCalled();
	expect(document.body.textContent).toContain("changed after review"); f.manager.close();
});
test("a competing local match cannot be overwritten from an older review", async () => {
	const f = await chooseLocal(); input("Shared marker to match", id(20)); button("Check shared marker").click(); await flush();
	f.comparePreference.mockResolvedValueOnce(false); button("Confirm local match").click(); await flush();
	expect(document.body.textContent).toContain("Another window changed"); f.manager.close();
});
test.each(["source", "closed", "permission", "offline"])("a pending match check fences %s changes", async kind => {
	const f = await chooseLocal(); let resolve!: (value: TimelineMarkerDetail) => void;
	f.readDetail.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
	input("Shared marker to match", id(20)); button("Check shared marker").click(); await flush();
	if (kind === "source") f.local.current = () => false;
	if (kind === "closed") f.manager.close();
	if (kind === "permission") f.access.read = false;
	if (kind === "offline") f.access.online = false;
	resolve(f.detail); await flush(); expect(f.comparePreference).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("Checked shared marker"); f.manager.close();
});

test("editing preserves every active saved-view placement and requires reviewing the result before another save", async () => {
	const f = await loaded(); input("Marker label", "Revised launch"); expect(button("Refresh marker list").disabled).toBe(true);
	confirmation("Archive this marker in every view"); expect(button("Archive marker").disabled).toBe(true);
	button("Save marker").click(); await flush();
	expect(f.save).toHaveBeenCalledTimes(1);
	expect(f.save.mock.calls[0][1]).toMatchObject({ expected_catalog_revision: 1, command: { type: "marker.put", expected_marker_revision: 1, content: { label: "Revised launch" },
		placements: [{ view_id: id(3), axis_definition_id: id(5) }, { view_id: id(30), axis_definition_id: id(31) }] } });
	expect(button("Save marker").disabled).toBe(true); expect(button("Load current marker").disabled).toBe(false);
	button("Load current marker").click(); await flush();
	expect(f.acknowledge).toHaveBeenCalledWith(scope, f.save.mock.calls[0][1].operation_id);
	expect(document.body.textContent).not.toContain("Marker save confirmed"); f.manager.close();
});

test("new milestone uses a single exact coordinate and returns from position editing without saving prematurely", async () => {
	const f = fixture(); f.manager.open(); await flush(); button("New shared marker").click(); input("Marker label", "New launch");
	button("Choose marker position").click(); await flush(); expect(document.querySelector(".relay-timeline-marker-dialog")).toBeNull();
	expect(button("Select position on timeline").hidden).toBe(true); input("Start date", "2026-12-01"); button("Use position").click(); await flush();
	expect(f.save).not.toHaveBeenCalled(); expect(input("Marker label", "New launch").value).toBe("New launch");
	button("Save marker").click(); await flush();
	expect(f.save.mock.calls[0][1].command).toMatchObject({ type: "marker.put", expected_marker_revision: 0, content: { kind: "point", range: { start: "2026-12-01", end: "2026-12-01", start_inclusive: true, end_inclusive: true } } });
	expect(f.closed).not.toHaveBeenCalled(); f.manager.close(); expect(f.closed).toHaveBeenCalledTimes(1);
});

test("range endpoint selection returns to the marker draft and cancels renderer handlers on host close", async () => {
	const f = await loaded(); input("Marker shape", "range"); button("Choose marker position").click(); await flush();
	button("Select endpoints on timeline").click(); f.pick(); await flush(); button("Use position").click(); await flush();
	button("Save marker").click(); await flush();
	expect(f.save.mock.calls[0][1].command).toMatchObject({ content: { kind: "range", range: { end: "2026-11-09" } } }); f.manager.close();
	const second = await loaded(); input("Marker shape", "range"); button("Choose marker position").click(); await flush(); button("Select endpoints on timeline").click();
	second.manager.close(); second.pick(); await flush(); expect(second.stop).toHaveBeenCalledTimes(1); expect(second.closed).toHaveBeenCalledTimes(1); expect(document.body.textContent).toBe("");
});

test("direct milestone selection remains a reviewed draft until the separate marker save", async () => {
	const f = fixture(); f.native.pointSelection = true; await loaded(f);
	button("Choose marker position").click(); await flush();
	expect(button("Select position on timeline").hidden).toBe(false); button("Select position on timeline").click();
	expect(f.context.surface.beginRange).toHaveBeenCalledWith("calendar", "day", expect.any(Function), expect.any(Function), true);
	f.pick(true); await flush(); expect(f.save).not.toHaveBeenCalled();
	expect(input("Start date", range.start).value).toBe(range.start);
	button("Use position").click(); await flush(); expect(f.save).not.toHaveBeenCalled();
	button("Save marker").click(); await flush();
	expect(f.save.mock.calls[0][1].command).toMatchObject({ content: { kind: "point", range } }); f.manager.close();
});

test("archive is an explicit all-view action and restoring requires selected placements", async () => {
	const f = await loaded(); expect(button("Archive marker").disabled).toBe(true); confirmation("Archive this marker in every view"); button("Archive marker").click(); await flush();
	expect(f.save.mock.calls[0][1].command).toEqual({ type: "marker.archive", marker_id: id(20), expected_marker_revision: 1 }); f.manager.close();
	const archived = fixture(); archived.detail.marker.active = false; for (const p of archived.detail.marker.placements) p.active = false;
	archived.catalog.markers[0].active = false;
	await loaded(archived); expect(document.body.textContent).toContain("archived"); input("Place in Planning", false); expect(button("Restore marker").disabled).toBe(true);
	input("Place in Roadmap", true); button("Restore marker").click(); await flush();
	expect(archived.save.mock.calls[0][1].command).toMatchObject({ type: "marker.put", placements: [{ view_id: id(30) }] }); archived.manager.close();
});

test("uncertain save survives modal close and exposes exact retry even after creation is disabled", async () => {
	const f = await loaded();
	f.save.mockImplementationOnce(async (_scope, request) => { f.setRecovery({ version: 1, scope_id: scope, request, status: "pending", error: "network_error" }); throw new Error("Connection lost"); });
	button("Save marker").click(); await flush(); expect(document.body.textContent).toContain("Marker save not confirmed"); expect(button("New shared marker").disabled).toBe(true);
	f.manager.close(); f.access.enabled = false;
	const reopened = new TimelineMarkerManager({} as App, f.context, () => true, () => {}); reopened.open(); await flush();
	expect(button("Retry original save").disabled).toBe(false);
	button("Retry original save").click(); await flush(); expect(f.retry).toHaveBeenCalledWith(scope); expect(document.body.textContent).toContain("Marker save confirmed"); reopened.close();
});

test("read-only and offline access keep recovery inspectable but cannot manage markers", async () => {
	const f = await loaded(); f.access.edit = false; f.manager.validate(); await flush(); expect(button("Save marker").disabled).toBe(true); expect(button("New shared marker").disabled).toBe(true);
	f.access.edit = true; f.access.online = false; f.manager.validate(); await flush(); expect(button("Save marker").disabled).toBe(true);
	f.access.read = false; f.manager.validate(); expect(f.closed).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled();
});

test("discarding a conflicting attempt requires review and preserves the saved request until acknowledgement", async () => {
	const f = await loaded();
	f.save.mockImplementationOnce(async (_scope, request) => { f.setRecovery({ version: 1, scope_id: scope, request, status: "rejected", error: "timeline_marker_changed" }); throw new Error("Marker changed"); });
	input("Marker label", "Attempted edit"); button("Save marker").click(); await flush();
	expect(button("Acknowledge and reload").disabled).toBe(true); expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toContain("Attempted edit");
	confirmation("I have reviewed"); button("Acknowledge and reload").click(); await flush();
	expect(f.acknowledge).toHaveBeenCalledTimes(1); expect(document.querySelector<HTMLInputElement>('[aria-label="Marker label"]')!.value).toBe("Launch"); f.manager.close();
});

test("closing during save-axis verification cannot start a management request", async () => {
	const f = await loaded(); let finish!: (value: TimelineAxisContext) => void;
	f.readAxis.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); button("Save marker").click(); f.manager.close(); finish(f.proof); await flush();
	expect(f.save).not.toHaveBeenCalled(); expect(f.closed).toHaveBeenCalledTimes(1); expect(document.body.textContent).toBe("");
});

test("changed catalog during detail loading requires refresh and cannot edit stale metadata", async () => {
	const f = fixture(); f.detail.catalog_revision = 2; await loaded(f);
	expect(document.body.textContent).toContain("Markers changed while loading"); expect(button("Save marker")).toBeUndefined(); expect(f.save).not.toHaveBeenCalled(); f.manager.close();
});

test("an older axis requires an explicit placement review and rebind before saving", async () => {
	const f = fixture(); f.detail.marker.placements[0] = { ...f.detail.marker.placements[0], axis_definition_id: id(99), axis_definition_revision: 1 };
	await loaded(f); expect(button("Save marker").disabled).toBe(true); expect(document.body.textContent).toContain("older axis");
	button("Use current axis in this view").click(); expect(button("Save marker").disabled).toBe(false); button("Save marker").click(); await flush();
	expect(f.save.mock.calls[0][1].command).toMatchObject({ placements: expect.arrayContaining([{ view_id: id(3), axis_definition_id: id(5), axis_definition_revision: 2 }]) }); f.manager.close();
});

test("an unreadable recovery record prevents starting a replacement operation", async () => {
	const f = fixture(); f.state.mockRejectedValue(new Error("Saved request needs repair")); f.manager.open(); await flush();
	expect(button("New shared marker").disabled).toBe(true); expect(document.body.textContent).toContain("Saved request needs repair"); expect(f.readCatalog).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled(); f.manager.close();
});

test("a shared recovery update arriving during an earlier local read is not lost", async () => {
	const f = await loaded(); let finish!: (value: TimelineMarkerManagementState | undefined) => void;
	f.state.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); f.manager.validate();
	const request: TimelineMarkerCommand = { operation_id: id(80), definition_id: id(2), generation: id(4), registry_revision: 2, expected_catalog_revision: 1,
		command: { type: "marker.archive", marker_id: id(20), expected_marker_revision: 1 } };
	f.setRecovery({ version: 1, scope_id: scope, request, status: "pending" }); f.manager.validate(); finish(undefined); await flush();
	expect(document.body.textContent).toContain("Marker save not confirmed"); expect(button("Save marker").disabled).toBe(true); f.manager.close();
});

test("a marker from another view can be placed here and in a checked third view without dropping its original placement", async () => {
	const f = fixture(); f.detail.marker.placements = [f.detail.marker.placements[1]];
	await loaded(f); expect(document.body.textContent).toContain("not currently placed in this view");
	expect(f.readPlacementAxis).not.toHaveBeenCalled();
	input("Place in Planning", true); input("Saved view to check", id(40));
	expect(document.querySelector('[aria-label="Saved view to check"]')?.textContent).not.toContain("Table");
	expect(document.querySelector('[aria-label="Saved view to check"]')?.textContent).not.toContain("Unmatched");
	button("Check selected view").click(); await flush();
	expect(f.readPlacementAxis).toHaveBeenCalledWith(scope, id(40), 2);
	expect(document.activeElement).toBe(button("Add checked placement"));
	expect(document.querySelector('[aria-label="Place in Schedule"]')).toBeNull(); expect(f.save).not.toHaveBeenCalled();
	button("Add checked placement").click(); expect(document.querySelector<HTMLInputElement>('[aria-label="Place in Schedule"]')!.checked).toBe(true);
	expect(document.activeElement).toBe(button("Save marker"));
	expect(f.save).not.toHaveBeenCalled(); button("Save marker").click(); await flush();
	expect(f.save.mock.calls[0][1].command).toMatchObject({ placements: [
		{ view_id: id(30), axis_definition_id: id(31), axis_definition_revision: 2 },
		{ view_id: id(3), axis_definition_id: id(5), axis_definition_revision: 2 },
		{ view_id: id(40), axis_definition_id: id(41), axis_definition_revision: 2 },
	] }); f.manager.close(); expect(f.listeners.size).toBe(0);
});

test("checking another view never silently replaces an old placement axis", async () => {
	const f = await loaded(); f.readPlacementAxis.mockResolvedValue({ ...f.proof, view_id: id(30), axis: { ...f.proof.axis, id: id(32) } });
	input("Saved view to check", id(30)); button("Check selected view").click(); await flush();
	expect(button("Use checked axis for this placement")).toBeDefined(); expect(f.save).not.toHaveBeenCalled();
	button("Use checked axis for this placement").click(); button("Save marker").click(); await flush();
	expect(f.save.mock.calls[0][1].command).toMatchObject({ placements: expect.arrayContaining([{ view_id: id(30), axis_definition_id: id(32), axis_definition_revision: 2 }]) }); f.manager.close();
});

test.each(["time_zone", "renderer", "definition_id", "generation", "registry_revision", "entry_id", "view_id"])("incompatible or changed placement %s leaves the draft untouched", async key => {
	const f = await loaded(), original = await f.readPlacementAxis(); f.readPlacementAxis.mockClear();
	const invalid = key === "time_zone" ? { ...original, axis: { ...original.axis, axis: { ...original.axis.axis, time_zone: "UTC" } } } :
		key === "renderer" ? { ...original, axis: { ...original.axis, axis: { ...original.axis.axis, renderer: "sabidurian-sequence" as const } } } :
		{ ...original, [key]: key === "registry_revision" ? 3 : id(99) };
	f.readPlacementAxis.mockResolvedValue(invalid); input("Saved view to check", id(40)); button("Check selected view").click(); await flush();
	expect(button("Add checked placement")).toBeUndefined(); expect(document.querySelector('[aria-label="Place in Schedule"]')).toBeNull();
	expect(document.body.textContent).toContain(key === "time_zone" ? "incompatible" : "saved view changed");
	button("Save marker").click(); await flush(); expect(f.save.mock.calls[0][1].command).toMatchObject({ placements: f.detail.marker.placements.map(({ view_id, axis_definition_id, axis_definition_revision }) => ({ view_id, axis_definition_id, axis_definition_revision })) }); f.manager.close();
});

test.each(["close", "authentication", "generation", "edit", "offline", "recovery"])("a late placement check cannot change the draft after %s", async reason => {
	const f = await loaded(), proof = await f.readPlacementAxis(); let finish!: (value: TimelineAxisContext) => void;
	f.readPlacementAxis.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	input("Saved view to check", id(40)); button("Check selected view").click();
	expect(button("Check selected view").disabled).toBe(true); expect(button("Save marker").disabled).toBe(true);
	if (reason === "close") f.manager.close();
	if (reason === "authentication") f.access.status = "authentication_required";
	if (reason === "generation") f.access.generation = id(99);
	if (reason === "edit") f.access.edit = false;
	if (reason === "offline") f.access.online = false;
	if (reason === "recovery") f.setRecovery({ version: 1, scope_id: scope, status: "pending", request: { operation_id: id(90), definition_id: id(2), generation: id(4), registry_revision: 2, expected_catalog_revision: 1,
		command: { type: "marker.archive", marker_id: id(20), expected_marker_revision: 1 } } });
	for (const listener of f.listeners) listener(); await flush(); finish(proof); await flush();
	expect(button("Add checked placement")).toBeUndefined(); expect(f.save).not.toHaveBeenCalled(); f.manager.close(); expect(f.listeners.size).toBe(0);
});
