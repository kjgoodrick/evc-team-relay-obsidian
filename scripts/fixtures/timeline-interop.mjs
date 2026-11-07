import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { Window } from "happy-dom";
import { TFile, Modal, StringValue } from "obsidian";
import * as Y from "yjs";
import { SabidurianView } from "timeline-view";
import { SequenceView } from "sequence-view";
import { CollaborationBridge } from "timeline-bridge";
import { TaskInspector } from "timeline-inspector";
import { TimelineBridgeClient } from "../../src/bases/TimelineBridgeClient.ts";
import { NativeBasesSurface } from "../../src/bases/NativeBasesSurface.ts";
import { sha256Hex } from "../../src/contentDigest.ts";
import { NativeBaseGroupComments } from "../../src/collaboration/NativeBaseGroupComments.ts";
import { TimelineRangeWorkflow } from "../../src/collaboration/ui/TimelineRangeWorkflow.ts";
import { renderTimelineRangeMarkers } from "../../src/collaboration/TimelineRangeMarkers.ts";

const win = new Window();
Object.assign(globalThis, { window: win, document: win.document, MouseEvent: win.MouseEvent, CSS: win.CSS });
Object.defineProperty(window.crypto, "subtle", { value: webcrypto.subtle });
const proto = win.HTMLElement.prototype;
Modal.prototype.setTitle = function(text) { this.contentEl.setAttribute("aria-label", text); };
proto.createEl = function(tag, opts = {}) {
	const element = document.createElement(tag);
	if (opts.text != null) element.textContent = opts.text;
	if (opts.cls) element.className = opts.cls;
	for (const [key, value] of Object.entries(opts.attr ?? {})) element.setAttribute(key, String(value));
	for (const key of ["type", "value", "placeholder"]) if (opts[key] != null) element[key] = opts[key];
	this.append(element); return element;
};
proto.createDiv = function(opts) { return this.createEl("div", opts); };
proto.createSpan = function(opts) { return this.createEl("span", opts); };
proto.addClass = function(...classes) { this.classList.add(...classes); };
proto.empty = function() { this.replaceChildren(); };
proto.setText = function(text) { this.textContent = text; };
win.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 40, height: 20 });
const frames = new Map(); let frame = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++frame, callback); return frame; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const uuid = n => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const file = path => Object.assign(new TFile(), { path, basename: path.split("/").pop().split(".")[0], extension: path.split(".").pop(),
	parent: { path: "Tasks" }, stat: { mtime: 1, ctime: 1, size: 1 } });

for (const type of ["sabidurian-timeline", "sabidurian-sequence"]) for (const providerFirst of [true, false]) for (const grouped of [false, true]) {
	const files = [file("Tasks/one.md"), file("Tasks/two.md")], base = file("Tasks/Plan.base");
	const metadata = new Map(files.map(value => [value.path, { start: "2026-11-26T08:00:00Z", end: "2026-11-26T09:00:00Z", status: "Ready", title: "Same label" }]));
	const values = { startDateProp: "note.start", endDateProp: "note.end", labelProp: "note.title", orderProp: "note.order", orderEndProp: null,
		timeZone: "UTC", scaleId: "day", snapMinutes: 5, tickMinutes: 15, oneTaskPerRow: true, showTable: false, showArrows: false, showToday: false,
		locked: true, initialScroll: "start", collapsedGroups: [], barDisplayProp1: "note.status", barDisplayProp2: "formula.total" };
	if (grouped) values.groupBy = { property: "note.status" };
	const writes = [], bridge = new CollaborationBridge(), listeners = new Map(); let published = providerFirst;
	const workspace = { on: (name, callback) => { listeners.set(name, callback); return { name }; }, offref: ref => listeners.delete(ref.name),
		trigger: (name, receive) => { if (name === "time-and-line:collaboration-request" && published) receive(bridge); },
		getLeaf: () => ({ openFile: (...args) => writes.push(args) }) };
	const plugin = { collaboration: bridge, colorSubscribers: new Set(), settings: { maxEntries: 5000, lockOnMobile: false,
		dependencyProperty: "blocked-by", lockedProperty: "locked", showBarProperties: true, barPropertyMinWidth: 80, markers: [] },
		history: { canUndo: false, patch: (...args) => writes.push(args) }, app: { workspace,
			metadataCache: { getFileCache: value => ({ frontmatter: metadata.get(value.path) }), getFirstLinkpathDest: () => null }, vault: { getMarkdownFiles: () => files } } };
	const root = document.createElement("div"); document.body.append(root);
	const serial = { views: [{ type, name: "Work", ...values }] }, source = JSON.stringify(serial);
	class Query { static parse(value) { return { getSerializable: () => value }; } }
	const query = { constructor: Query, file: base, views: [], getSerializable: () => serial };
	const controller = { query, viewName: "Work", initialScan: false };
	const view = new (type === "sabidurian-timeline" ? SabidurianView : SequenceView)(controller, root, plugin);
	controller.view = view;
	view.config = { type, name: "Work", query, groupBy: values.groupBy, get: key => values[key], set: (...args) => writes.push(args),
		getAsPropertyId: key => values[key] ?? null, getOrder: () => [], getDisplayName: key => "Alias " + key };
	query.views = [view.config]; view.allProperties = ["note.status", "formula.total"];
	const entries = files.map((value, index) => ({ file: value, getValue: key => key === "note.order" ? index + 1 : key === "formula.total" ? index + 20 : key === "note.status" ? new StringValue("Ready") : metadata.get(value.path)[key.replace(/^note\./, "")] }));
	view.data = { data: entries, groupedData: grouped ? [{ entries, hasKey: () => true, key: "Ready" }] : [] };
	const client = new TimelineBridgeClient(workspace, () => {}); client.start();
	try {
		view.onDataUpdated(); for (const callback of [...frames.values()]) callback(0); frames.clear();
		if (!providerFirst) { assert.equal(client.find(view), undefined); published = true; listeners.get("time-and-line:collaboration-ready")(bridge); }
		const host = { file: base, contentEl: root, data: source, lastSavedData: source, dirty: false, controller, query, getViewType: () => "bases" };
		const surface = NativeBasesSurface.inspect(host, "1.13.7", true, client); assert.ok(surface, "actual view must bind through the actual client");
		const snapshot = { protocol_version: 1, definition_id: uuid(1), entry_id: uuid(2), generation: uuid(3), revision: 1,
			content_sha256: await sha256Hex(new TextEncoder().encode(source).buffer), views: [{ slot: 0, id: uuid(4), name: "Work", type, descriptor_sha256: "a".repeat(64) }],
			unmatched: { views: [], has_more: false, next_after: null } };
		const binding = await surface.bind(snapshot, uuid(2), async () => source, () => true); assert.ok(binding);
		const cell = surface.handles().find(handle => handle.target.type === "cell" && handle.target.file === files[0] && handle.target.property.source === "formula"); assert.ok(cell);
		assert.equal(surface.hit(cell.element)?.target.property.name, "total");
		let selected, stopped = 0;
		assert.ok(surface.beginAnnotation(handle => { selected = handle; }, () => stopped++));
		cell.element.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
		assert.equal(stopped, 1); assert.equal(selected.target.file, files[0]); assert.equal(selected.target.property.source, "formula");
		assert.equal(await surface.reveal(cell.target, () => true), "revealed");
		const modal = new TaskInspector(plugin.app, files[0], { start: "start", end: "end", label: "title", dependencies: "blocked-by", zone: "UTC" }, plugin.history, false, () => {}, () => {});
		modal.open(); modal.contentEl.querySelector("input").value = "2026-11-26T08:05:00";
		assert.equal(client.canNavigate(document), false); assert.equal(await surface.reveal(cell.target, () => true), "busy"); modal.close();
		assert.equal(client.canNavigate(document), true); assert.equal(host.data, source); assert.deepEqual(writes, []);
		if (grouped) {
			const lanes = surface.groupHandles(() => null); assert.equal(lanes.length, 1); const lane = lanes[0];
			assert.deepEqual(lane.target, { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "Ready" } });
			assert.deepEqual(lane.members(), files); let selectedLane;
			surface.beginAnnotation(() => assert.fail("lane became item"), () => {}, location => { selectedLane = location; });
			lane.element.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
			assert.equal(selectedLane.group, view.data.groupedData[0]); assert.equal(surface.revealGroup(lane.target, () => null, () => true), "revealed");
			assert.equal(surface.revealGroup(lane.target, () => null, () => false), "unavailable");
			// Exercise real source/witness capture through the shared group adapter.
			// The session is a controlled port; server acceptance is a separate fixture.
			const doc = new Y.Doc({ gc: false }), text = doc.getText("contents"); text.insert(0, "---\nstatus: Ready\n---\nSynthetic task");
			let allowed = true, captured;
			const catalog = { protocol_version: 1, entry_id: uuid(2), view_id: uuid(4), definition_id: uuid(1), generation: uuid(3), registry_revision: 1,
				computed_values: false, targets: [{ kind: "group", id: uuid(5), revision: 1, property: lane.target.property, fingerprint: "a".repeat(64) }] };
			const session = { permission: () => ({ read: true, comment: allowed }), canAnchorBaseGroup: () => true,
				readBaseContext: async (_scope, record) => ({ ...catalog, record_id: record, record_generation: uuid(8) }),
				captureBaseGroupSelection: async (_scope, capture) => { captured = capture; return { version: 1, type: "base_group_pending", entry_id: uuid(2), property: lane.target.property,
					capture: { ...capture, operation_id: uuid(9), definition_id: uuid(1), generation: uuid(3), view_id: uuid(4), registry_revision: 1 } }; } };
			const groups = new NativeBaseGroupComments({ session, surface, entryId: "synthetic-view", baseEntryId: uuid(2), binding: { snapshot: { revision: 1 } }, current: () => surface.current() }, catalog, {
				record: record => { const index = files.indexOf(record); return index < 0 ? undefined : { id: uuid(6 + index), type: "markdown", path: record.basename + ".md" }; },
				file: () => undefined, fileAtPath: () => null, source: () => ({ text, current: () => true }), read: async () => text.toString(), resolve: () => null });
			try {
				const pending = await groups.capture(lane); assert.equal(pending.type, "base_group_pending");
				assert.equal(captured.record_id, uuid(6)); assert.equal(captured.group_definition_id, uuid(5)); assert.deepEqual(captured.value, { type: "text", value: "Ready" });
				assert.ok(Y.decodeSnapshot(Buffer.from(captured.dependency, "base64")).sv.size > 0);
				allowed = false; await assert.rejects(() => groups.capture(lane), /not available/);
			} finally { doc.destroy(); }
			assert.equal(host.data, source); assert.deepEqual(writes, []);
		}
		// Actual optional range provider/consumer boundary, using synthetic geometry.
		const viewport = view.timelineRenderer.element, svg = view.timelineRenderer.svgElement, sequence = type === "sabidurian-sequence";
		view.axis.setView(sequence ? 1 : 2026, sequence ? 5 : 2027, 800);
		Object.defineProperties(viewport, { clientWidth: { value: 400, configurable: true }, clientHeight: { value: 200, configurable: true }, scrollWidth: { value: 800, configurable: true } });
		viewport.scrollLeft = 0;
		viewport.getBoundingClientRect = () => ({ left: 100, right: 500, top: 50, bottom: 250, width: 400, height: 200 });
		svg.getBoundingClientRect = () => ({ left: 100 - viewport.scrollLeft, right: 900 - viewport.scrollLeft, top: 50, bottom: 450, width: 800, height: 400 });
		const rangeContext = surface.rangeContext(); assert.ok(rangeContext?.current()); assert.equal(rangeContext.axis.renderer, type);
		let selectedRange, rangeStops = 0;
		assert.ok(surface.beginRange(sequence ? "ordinal" : "calendar", "day", value => { selectedRange = value; }, () => rangeStops++));
		const status = root.querySelector(".sabidurian-range-selection-status"); assert.ok(status);
		for (const key of ["Enter", "ArrowRight", "Enter"]) status.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
		assert.equal(rangeStops, 1); assert.ok(selectedRange?.current()); assert.equal(selectedRange.draft.kind, sequence ? "ordinal" : "calendar");
		const laneElement = grouped ? surface.groupHandles(() => null)[0].element : undefined;
		const geometry = surface.rangeGeometry(selectedRange.draft, rangeContext.axis, laneElement); assert.ok(geometry?.current());
		assert.equal(surface.revealRange(selectedRange.draft, rangeContext.axis, () => true, laneElement), "revealed");
		assert.equal(surface.revealRange(selectedRange.draft, rangeContext.axis, () => false, laneElement), "unavailable");
		assert.equal(host.data, source); assert.deepEqual(writes, []);
		// Switching selection modes cancels the old mode and releases its handlers.
		surface.beginRange(sequence ? "ordinal" : "calendar", "day", () => assert.fail("cancelled range"), () => rangeStops++);
		const stopAnnotation = surface.beginAnnotation(() => {}, () => {}); assert.equal(rangeStops, 2);
		assert.equal(root.querySelector(".sabidurian-range-selection-status"), null); stopAnnotation();
		// Exercise the real confirmation workflow and saved-marker renderer. The
		// session port supplies a verified axis; actual HTTP persistence is tested
		// separately by realBaseGroupStack.test.ts.
		const axisProof = { protocol_version: 1, entry_id: uuid(2), definition_id: uuid(1), generation: uuid(3), view_id: uuid(4), registry_revision: 1,
			axis: { id: uuid(40), kind: "axis", revision: 1, fingerprint: "a".repeat(64), axis: rangeContext.axis } };
		const rangeCommentContext = { file: base, surface, binding, baseEntryId: uuid(2), entryId: "synthetic-scope", current: () => surface.current(),
			session: { permission: () => ({ read: true, comment: true }), canAnchorBase: () => true, readTimelineAxis: async () => axisProof } };
		let savedRange;
		const workflow = new TimelineRangeWorkflow(plugin.app, rangeCommentContext, () => true, async (proof, range, current) => {
			assert.ok(current()); assert.equal(proof, axisProof); savedRange = range; return true;
		});
		await workflow.open();
		const rangeButton = label => [...document.querySelectorAll(".relay-timeline-range-dialog button")].find(button => button.textContent === label);
		assert.ok(rangeButton("Select endpoints on timeline")); rangeButton("Select endpoints on timeline").click();
		const rangeStatus = root.querySelector(".sabidurian-range-selection-status"); assert.ok(rangeStatus);
		for (const key of ["Enter", "ArrowRight", "Enter"]) rangeStatus.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
		assert.equal(rangeButton("Write comment").disabled, false); rangeButton("Write comment").click();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		assert.equal(savedRange.kind, sequence ? "ordinal" : "calendar"); workflow.close();
		const rangeAnchor = { version: 1, type: "base", definition_id: uuid(1), generation: uuid(3), view_id: uuid(4), registry_revision: 1,
			target: { type: "timeline_range", axis_definition_id: uuid(40), axis_definition_revision: 1, axis: rangeContext.axis, range: savedRange } };
		const marks = document.createElement("div"); root.append(marks); let markerOpened = false;
		assert.equal(renderTimelineRangeMarkers({ context: rangeCommentContext, proof: axisProof, threads: [{ id: uuid(41), anchor: rangeAnchor }],
			lanes: new Map(), root: { left: 0, right: 1000, top: 0, bottom: 600 }, viewport: viewport.getBoundingClientRect(), marks, limit: 128,
			open: (_threads, _button, current) => { assert.ok(current()); markerOpened = true; } }), 1);
		marks.querySelector("button").click(); assert.ok(markerOpened); marks.remove();
		assert.equal(host.data, source); assert.deepEqual(writes, []);
		const captured = surface.handles()[1]; view.onDataUpdated(); assert.equal(captured.current(), false);
		assert.equal(rangeContext.current(), false); assert.equal(selectedRange.current(), false); assert.equal(geometry.current(), false);
		bridge.dispose(); assert.equal(client.find(view), undefined); assert.equal(surface.current(), false);
		console.log(`PASS actual ${type}: ${providerFirst ? "provider" : "consumer"} first; ${grouped ? "lane source capture" : "ungrouped"}, saved view, range confirmation/markers, projection, navigation, dirty inspector and disposal`);
	} finally {
		client.close(); view.onunload(); bridge.dispose(); for (const modal of Modal.opened) modal.close(); Modal.opened = [];
		frames.clear(); root.remove();
	}
}
await win.happyDOM.close();
