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
import { BasePresenceMotion } from "../../src/collaboration/presence/BasePresenceMotion.ts";
import { NativeBasesSurface } from "../../src/bases/NativeBasesSurface.ts";
import { sha256Hex } from "../../src/contentDigest.ts";
import { NativeBaseGroupComments } from "../../src/collaboration/NativeBaseGroupComments.ts";
import { TimelineRangeWorkflow } from "../../src/collaboration/ui/TimelineRangeWorkflow.ts";
import { renderTimelineDiscussionMarkers, renderTimelineSharedMarkers } from "../../src/collaboration/TimelineRangeMarkers.ts";
import { TimelineMarkerPicker } from "../../src/collaboration/ui/TimelineMarkerPicker.ts";
import { TimelineMarkerManager } from "../../src/collaboration/ui/TimelineMarkerManager.ts";
import { TimelineMarkerComparisonModal } from "../../src/collaboration/ui/TimelineMarkerComparison.ts";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope.ts";
import { parseTimelineMarkerReceipt } from "../../src/collaboration/TimelineMarkerManagementProtocol.ts";
import { parseTimelineMarkerCatalog, timelineMarkerAnchor } from "../../src/collaboration/TimelineMarkerProtocol.ts";

const win = new Window();
Object.assign(globalThis, { window: win, document: win.document, MouseEvent: win.MouseEvent, CSS: win.CSS, MutationObserver: win.MutationObserver });
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
	const trace = phase => { if (process.env.EVC_TIMELINE_TRACE) console.error(`TRACE ${type}/${providerFirst ? "provider" : "consumer"}/${grouped ? "grouped" : "plain"}: ${phase}`); };
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
		selected = undefined;
		assert.ok(surface.beginAnnotation(handle => { selected = handle; }, () => stopped++));
		const keyboardPicker = root.querySelector(".sabidurian-annotation-picker select"); assert.ok(keyboardPicker);
		const keyboardProperty = [...keyboardPicker.options].find(option => option.textContent === `Property: ${files[0].path} — formula.total`); assert.ok(keyboardProperty);
		keyboardPicker.value = keyboardProperty.value; keyboardPicker.dispatchEvent(new win.Event("change", { bubbles: true }));
		keyboardPicker.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		assert.equal(stopped, 2); assert.equal(selected.target.file, files[0]); assert.deepEqual(selected.target.property, { source: "formula", name: "total" });
		assert.equal(root.querySelector(".sabidurian-annotation-picker"), null);
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
			selectedLane = undefined;
			surface.beginAnnotation(() => assert.fail("keyboard lane became item"), () => {}, location => { selectedLane = location; });
			const lanePicker = root.querySelector(".sabidurian-annotation-picker select"); assert.ok(lanePicker);
			lanePicker.value = [...lanePicker.options].find(option => option.textContent.startsWith("Lane:")).value;
			lanePicker.dispatchEvent(new win.Event("change", { bubbles: true }));
			lanePicker.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			assert.equal(selectedLane.group, view.data.groupedData[0]);
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
		// Actual renderer -> bridge -> native adapter -> presence capture/overlay/
		// navigation. Saved identities and record metadata are synthetic ports.
		root.getBoundingClientRect = () => new win.DOMRect(0, 0, 1000, 600);
		Object.defineProperty(viewport, "scrollHeight", { value: 400, configurable: true });
		let publishedPosition;
		const location = { kind: "base", share_id: uuid(90), entry_id: uuid(2), generation: uuid(3), definition_id: uuid(1), view_id: uuid(4), registry_revision: 1 };
		const motion = new BasePresenceMotion(root, { current: () => surface.current(), publishing: () => true, surface: () => surface, location: () => location,
			local: file => { const index = files.indexOf(file); return index < 0 ? undefined : { id: uuid(6 + index), type: "markdown", path: file.path }; },
			file: id => files.find((_file, index) => uuid(6 + index) === id),
			read: async id => ({ protocol_version: 1, share_id: uuid(90), entry_id: id, generation: uuid(50 + files.findIndex((_file, index) => uuid(6 + index) === id)), type: "markdown" }),
			publish: state => { publishedPosition = state; }, groups: { supported: () => true, resolve: () => null, fileAtPath: path => files.find(file => file.path === path) ?? null } });
		try {
			const layer = root.querySelector(".relay-base-presence");
			Object.defineProperties(layer, { clientWidth: { value: 1000 }, clientHeight: { value: 600 } }); layer.getBoundingClientRect = root.getBoundingClientRect;
			svg.dispatchEvent(new win.MouseEvent("pointermove", { bubbles: true, clientX: 300, clientY: 150 }));
			for (let n = 0; n < 30 && publishedPosition?.pointer?.target.type !== "timeline_range"; n++) await new Promise(resolve => setTimeout(resolve, 50));
			assert.equal(publishedPosition?.pointer?.target.type, "timeline_range", "native range pointer reaches presence");
			assert.equal(publishedPosition.version, 2); assert.equal(publishedPosition.viewport.target.type, "timeline_range");
			assert.equal(publishedPosition.pointer.target.range.kind, sequence ? "ordinal" : "instant");
			const position = publishedPosition; assert.equal(!!position.pointer.target.lane, grouped, "lane identity is retained through the complete bridge");
			motion.setPeers([{ key: "remote", userId: uuid(80), name: "Timeline peer", baseState: position }]);
			for (let n = 0; n < 30 && !layer.children.length; n++) await new Promise(resolve => setTimeout(resolve, 20));
			const pointer = layer.querySelector(".relay-base-presence-pointer"); assert.ok(pointer); assert.equal(pointer.textContent, "Timeline peer");
			assert.ok(Math.abs(parseFloat(pointer.style.left) - 300) < 0.1); assert.ok(Math.abs(parseFloat(pointer.style.top) - 150) < 0.1);
			assert.ok(await motion.reveal(position, false, () => true)); assert.ok(await motion.reveal(position, true, () => true));
			assert.equal(root.querySelector(".sabidurian-range-selection-status"), null); assert.deepEqual(writes, []); assert.equal(host.data, source);
		} finally { motion.close(); viewport.scrollLeft = 0; viewport.scrollTop = 0; }
		let selectedRange, rangeStops = 0;
		assert.ok(surface.beginRange(sequence ? "ordinal" : "calendar", "day", value => { selectedRange = value; }, () => rangeStops++));
		const status = root.querySelector(".sabidurian-range-selection-status"); assert.ok(status);
		for (const key of ["Enter", "ArrowRight", "Enter"]) status.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
		assert.equal(rangeStops, 1); assert.ok(selectedRange?.current()); assert.equal(selectedRange.draft.kind, sequence ? "ordinal" : "calendar");
		const laneElement = grouped ? surface.groupHandles(() => null)[0].element : undefined;
		if (laneElement) laneElement.getBoundingClientRect = () => ({ left: 100, right: 500, top: 100, bottom: 128, width: 400, height: 28 });
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
			session: { permission: () => ({ read: true, comment: true }), canAnchorBase: () => true, canAnchorBaseGroup: () => true, readTimelineAxis: async () => axisProof } };
		if (grouped) {
			const catalog = { protocol_version: 1, entry_id: uuid(2), view_id: uuid(4), definition_id: uuid(1), generation: uuid(3), registry_revision: 1,
				computed_values: false, targets: [{ kind: "group", id: uuid(5), revision: 1, property: { source: "note", name: "status" }, fingerprint: "a".repeat(64) }] };
			rangeCommentContext.groups = new NativeBaseGroupComments(rangeCommentContext, catalog, { resolve: () => null });
		}
		let savedRange, savedLane;
		const workflow = new TimelineRangeWorkflow(plugin.app, rangeCommentContext, () => true, async (proof, range, current, lane) => {
			assert.ok(current()); assert.equal(proof, axisProof); savedRange = range; savedLane = lane; return true;
		});
		await workflow.open();
		const rangeButton = label => [...document.querySelectorAll(".relay-timeline-range-dialog button")].find(button => button.textContent === label);
		const laneChoice = () => document.querySelector('.relay-timeline-range-dialog [data-field="lane"]');
		let selectedLaneId;
		if (grouped) {
			assert.equal(laneChoice().options.length, 2); selectedLaneId = laneChoice().options[1].value;
			laneChoice().value = selectedLaneId; laneChoice().dispatchEvent(new win.Event("change", { bubbles: true }));
		}
		assert.ok(rangeButton("Select endpoints on timeline")); rangeButton("Select endpoints on timeline").click();
		const rangeStatus = root.querySelector(".sabidurian-range-selection-status"); assert.ok(rangeStatus);
		for (const key of ["Enter", "ArrowRight", "Enter"]) rangeStatus.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
		if (grouped) assert.equal(laneChoice().value, selectedLaneId);
		assert.equal(rangeButton("Write comment").disabled, false); rangeButton("Write comment").click();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		assert.equal(savedRange.kind, sequence ? "ordinal" : "calendar"); workflow.close();
		if (grouped) { assert.ok(savedLane.current()); assert.equal(savedLane.element, laneElement); }
		else assert.equal(savedLane, undefined);
		const savedLaneTarget = savedLane && { ...savedLane.target, definition_id: uuid(5), definition_revision: 1, group_id: uuid(42), witness_id: uuid(43) };
		const rangeAnchor = { version: 1, type: "base", definition_id: uuid(1), generation: uuid(3), view_id: uuid(4), registry_revision: 1,
			target: { type: "timeline_range", axis_definition_id: uuid(40), axis_definition_revision: 1, axis: rangeContext.axis, range: savedRange, ...(savedLaneTarget ? { lane: savedLaneTarget } : {}) } };
		const marks = document.createElement("div"); root.append(marks); let markerOpened = false;
		assert.equal(renderTimelineDiscussionMarkers({ context: rangeCommentContext, proof: axisProof, threads: [{ id: uuid(41), anchor: rangeAnchor }],
			lanes: new Map(savedLane ? [[uuid(41), savedLane.target]] : []), root: { left: 0, right: 1000, top: 0, bottom: 600 }, viewport: viewport.getBoundingClientRect(), marks, limit: 128,
			open: (_threads, _button, current) => { assert.ok(current()); markerOpened = true; } }), 1);
		marks.querySelector("button").click(); assert.ok(markerOpened); marks.remove();
		// Shared-marker identity survives the real picker, geometry and range
		// reveal bridge. Server authority/offline delivery have HTTP evidence.
		const sharedContent = { kind: "point", label: "Shared launch", color: "#123abc", range: { ...savedRange,
			end: savedRange.start, start_inclusive: true, end_inclusive: true } };
		const markerTarget = { type: "timeline_marker", marker_id: uuid(60), marker_revision: 1,
			axis_definition_id: uuid(40), axis_definition_revision: 1, axis: axisProof.axis.axis, content: sharedContent };
		const markerCatalog = parseTimelineMarkerCatalog({ protocol_version: 1, entry_id: uuid(2), definition_id: uuid(1), generation: uuid(3), view_id: uuid(4), registry_revision: 1,
			catalog_revision: 1, markers: [{ id: uuid(60), revision: 1, active: true, content: sharedContent,
				placement: { view_id: uuid(4), active: true, axis_definition_id: uuid(40), axis_definition_revision: 1, axis: axisProof.axis.axis }, target: markerTarget }] }, uuid(2), uuid(4));
		rangeCommentContext.session.readTimelineMarkers = async () => markerCatalog;
		let capturedMarker, shownMarker = false;
		const pickerActions = { write: async (catalog, id, current) => {
			assert.ok(current()); assert.equal(id, uuid(60)); capturedMarker = timelineMarkerAnchor(catalog, catalog.markers[0]); return true;
		}, show: async (catalog, id, current) => {
			assert.ok(current()); assert.equal(id, uuid(60)); const marker = catalog.markers[0];
			assert.equal(surface.revealRange(marker.content.range, marker.target.axis, current), "revealed"); shownMarker = true; return true;
		} };
		for (const action of ["Write comment", "Show selected position"]) {
			const picker = new TimelineMarkerPicker(plugin.app, rangeCommentContext, () => surface.current(), pickerActions); picker.open();
			for (let i = 0; i < 12; i++) await Promise.resolve();
			const choice = document.querySelector('.relay-timeline-marker-dialog [aria-label="Marker"]'); assert.ok(choice); choice.value = uuid(60); choice.dispatchEvent(new win.Event("change"));
			const button = [...document.querySelectorAll(".relay-timeline-marker-dialog button")].find(button => button.textContent === action); assert.equal(button.disabled, false); button.click();
			for (let i = 0; i < 12; i++) await Promise.resolve(); picker.close();
		}
		assert.equal(capturedMarker.target.type, "timeline_marker"); assert.equal(capturedMarker.target.marker_id, uuid(60)); assert.ok(shownMarker);
		// The management form uses the actual endpoint-selection bridge, then
		// presents the durable command's result. HTTP and IDB recovery have their
		// own real-stack fixtures; this port verifies the native source seam.
		const { view_id: _markerView, markers: _markers, ...markerIdentity } = markerCatalog;
		const markerDetail = { ...markerIdentity, marker: { id: uuid(60), revision: 1, active: true, content: sharedContent, placements: [markerCatalog.markers[0].placement] } };
		let managementState, managementRequest;
		Object.assign(rangeCommentContext.session, { online: true, permission: () => ({ read: true, comment: true, edit: true }),
			transport: { timelineMarkers: async () => markerCatalog, timelineMarker: async () => markerDetail },
			markerManagement: { state: async () => managementState, save: async (_scope, request) => {
				managementRequest = request;
				const receipt = parseTimelineMarkerReceipt({ ...markerIdentity, operation_id: request.operation_id, catalog_revision: 2,
					marker: { ...markerDetail.marker, revision: 2, content: request.command.content } }, uuid(2), request);
				managementState = { version: 1, scope_id: "synthetic-scope", status: "accepted", request, receipt }; return receipt;
			} } });
		const settleManagement = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
		const managementButton = label => [...document.querySelectorAll(".relay-timeline-marker-dialog button, .relay-timeline-range-dialog button")].find(button => button.textContent === label);
		const manager = new TimelineMarkerManager(plugin.app, rangeCommentContext, () => surface.current(), () => {}); manager.open(); await settleManagement();
		const managedChoice = document.querySelector('[aria-label="Shared marker"]'); managedChoice.value = uuid(60); managedChoice.dispatchEvent(new win.Event("change")); await settleManagement();
		const shape = document.querySelector('[aria-label="Marker shape"]'); shape.value = "range"; shape.dispatchEvent(new win.Event("change"));
		managementButton("Choose marker position").click(); await settleManagement(); managementButton("Select endpoints on timeline").click();
		const managedRangeStatus = root.querySelector(".sabidurian-range-selection-status"); assert.ok(managedRangeStatus);
		for (const key of ["Enter", "ArrowRight", "Enter"]) managedRangeStatus.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
		await settleManagement(); managementButton("Use position").click(); await settleManagement();
		assert.equal(managementRequest, undefined); assert.equal(managementButton("Save marker").disabled, false);
		managementButton("Save marker").click(); await settleManagement();
		assert.equal(managementRequest.command.marker_id, uuid(60)); assert.equal(managementRequest.command.content.kind, "range");
		assert.equal(managementRequest.command.content.range.kind, sequence ? "ordinal" : "calendar");
		assert.deepEqual(managementRequest.command.placements, [{ view_id: uuid(4), axis_definition_id: uuid(40), axis_definition_revision: 1 }]);
		assert.ok(document.body.textContent.includes("Marker save confirmed")); assert.equal(managementButton("Save marker").disabled, true);
		manager.close(); assert.equal(document.querySelector(".relay-timeline-marker-dialog"), null); assert.deepEqual(writes, []);
		const currentMarks = document.createElement("div"); root.append(currentMarks); let openedCurrent = false;
		assert.equal(renderTimelineSharedMarkers({ context: rangeCommentContext, proof: axisProof, catalog: markerCatalog,
			root: { left: 0, right: 1000, top: 0, bottom: 600 }, viewport: viewport.getBoundingClientRect(), marks: currentMarks, limit: 64,
			current: () => surface.current(), open: markers => { assert.equal(markers[0].id, uuid(60)); openedCurrent = true; } }), 1);
		assert.ok(currentMarks.querySelector("button").getAttribute("aria-label").includes("Shared marker: Shared launch"));
		currentMarks.querySelector("button").click(); assert.ok(openedCurrent); currentMarks.remove();
		const sharedMarks = document.createElement("div"); root.append(sharedMarks);
		assert.equal(renderTimelineDiscussionMarkers({ context: rangeCommentContext, proof: axisProof, threads: [{ id: uuid(61), anchor: capturedMarker }], lanes: new Map(),
			root: { left: 0, right: 1000, top: 0, bottom: 600 }, viewport: viewport.getBoundingClientRect(), marks: sharedMarks, limit: 128, open: threads => assert.equal(threads[0].anchor.target.marker_id, uuid(60)) }), 1);
		assert.ok(sharedMarks.querySelector("button").getAttribute("aria-label").includes("Captured marker: Shared launch")); sharedMarks.querySelector("button").click(); sharedMarks.remove();
		// A discussion outside the data-derived domain opens a temporary range
		// viewport through the actual provider/consumer, preserving the saved view.
		const farRange = { ...savedRange, start: sequence ? "-100" : "1800-01-01", end: sequence ? "-50" : "1800-01-02" };
		assert.equal(surface.revealRange(farRange, rangeContext.axis, () => true, laneElement), "revealed");
		assert.ok(root.querySelector(".sabidurian-comment-range-focus")); assert.equal(rangeContext.current(), false);
		const focusedContext = surface.rangeContext(); assert.ok(focusedContext.current()); assert.deepEqual(focusedContext.axis, rangeContext.axis);
		const focusedViewport = view.timelineRenderer.element, focusedSvg = view.timelineRenderer.svgElement;
		focusedViewport.getBoundingClientRect = () => ({ left: 100, right: 900, top: 50, bottom: 250, width: 800, height: 200 });
		focusedSvg.getBoundingClientRect = () => ({ left: 100, right: 900, top: 50, bottom: 450, width: 800, height: 400 });
		const focusedLane = grouped ? surface.groupHandles(() => null)[0] : undefined;
		if (focusedLane) focusedLane.element.getBoundingClientRect = () => ({ left: 100, right: 900, top: 100, bottom: 128, width: 800, height: 28 });
		const focusedGeometry = surface.rangeGeometry(farRange, rangeContext.axis, focusedLane?.element);
		assert.ok(focusedGeometry?.current()); assert.ok(focusedGeometry.startX >= 100 && focusedGeometry.endX <= 900);
		const focusedMarks = document.createElement("div"); root.append(focusedMarks);
		assert.equal(renderTimelineDiscussionMarkers({ context: rangeCommentContext, proof: axisProof,
			threads: [{ id: uuid(41), anchor: { ...rangeAnchor, target: { ...rangeAnchor.target, range: farRange } } }],
			lanes: new Map(savedLane ? [[uuid(41), savedLane.target]] : []), root: { left: 0, right: 1000, top: 0, bottom: 600 },
			viewport: focusedViewport.getBoundingClientRect(), marks: focusedMarks, limit: 128, open: () => {} }), 1);
		focusedMarks.remove(); root.querySelector(".sabidurian-comment-range-focus button").click();
		for (const callback of [...frames.values()]) callback(0); frames.clear();
		assert.equal(root.querySelector(".sabidurian-comment-range-focus"), null); assert.equal(focusedContext.current(), false);
		// The comparison keeps the immutable target while both navigation buttons
		// exercise the real Timeline/Sequence provider and saved-axis bridge.
		const checkedContent = { ...sharedContent, label: "Updated shared launch", range: { ...sharedContent.range,
			start: savedRange.end, end: savedRange.end } };
		const checkedCatalog = parseTimelineMarkerCatalog({ ...markerCatalog, catalog_revision: 2,
			markers: [{ ...markerCatalog.markers[0], revision: 2, content: checkedContent,
				target: { ...markerTarget, marker_revision: 2, content: checkedContent } }] }, uuid(2), uuid(4));
		const comparisonThread = { id: uuid(61), anchor_revision: 1, anchor: capturedMarker }, navigation = [];
		const comparisonSession = { status: "ready", permission: () => ({ read: true, comment: false }),
			knownDocumentGeneration: () => uuid(3), baseRegistryRevision: () => 1, onChange: () => () => {},
			linkedThread: async () => ({ thread: comparisonThread }), cachedThread: async () => comparisonThread,
			readTimelineMarkers: async () => checkedCatalog, verifiedTargetCatalog: () => true };
		const comparison = new TimelineMarkerComparisonModal(plugin.app, comparisonSession, baseDiscussionScope(uuid(2), uuid(4)),
			uuid(61), 1, capturedMarker, () => surface.current(), async (anchor, current) => {
				assert.ok(current()); assert.equal(surface.revealRange(anchor.target.content.range, anchor.target.axis, current), "revealed");
				navigation.push(anchor);
			});
		comparison.open(); await settleManagement();
		assert.ok(document.body.textContent.includes("Updated shared launch"));
		for (const label of ["Show captured position", "Show checked position"]) {
			const button = [...document.querySelectorAll(".relay-marker-comparison button")].find(button => button.textContent === label);
			assert.ok(button); button.click(); await settleManagement();
		}
		assert.equal(navigation.length, 2); assert.deepEqual(navigation[0], capturedMarker);
		assert.equal(navigation[1].target.marker_revision, 2); assert.deepEqual(navigation[1].target.content.range.start, savedRange.end);
		assert.deepEqual(writes, []); comparison.close(); assert.equal(document.querySelector(".relay-marker-comparison"), null);
		// Empty query results retain the configured axis and whole-view range
		// workflow. Missing lanes never become whole-view markers or targets.
		const originalData = view.data, oldHandle = surface.handles()[0];
		trace("empty query render");
		view.data = { data: [], groupedData: [] }; view.onDataUpdated();
		for (const callback of [...frames.values()]) callback(0); frames.clear();
		assert.equal(oldHandle.current(), false); assert.equal(surface.current(), false);
		const emptySurface = NativeBasesSurface.inspect(host, "1.13.7", true, client); assert.ok(emptySurface);
		trace("empty query binding");
		const emptyBinding = await emptySurface.bind(snapshot, uuid(2), async () => source, () => true); assert.ok(emptyBinding);
		trace("empty query bound");
		const emptyCommentContext = { ...rangeCommentContext, surface: emptySurface, binding: emptyBinding, groups: undefined, current: () => emptySurface.current() };
		trace(`empty handle counts: ${emptySurface.handles().length}/${emptySurface.groupHandles(() => null).length}`);
		assert.deepEqual(emptySurface.handles().map(handle => handle.target.type), ["view"]); assert.equal(emptySurface.groupHandles(() => null).length, 0);
		assert.ok(emptySurface.rangeContext()?.current()); assert.deepEqual(emptySurface.rangeContext().axis, axisProof.axis.axis);
		trace("empty axis verified");
		let emptyRange;
		const emptyWorkflow = new TimelineRangeWorkflow(plugin.app, emptyCommentContext, () => true, async (proof, range, current, lane) => {
			assert.ok(current()); assert.equal(proof, axisProof); assert.equal(lane, undefined); emptyRange = range; return true;
		});
		trace("opening empty workflow"); await emptyWorkflow.open(); trace("opened empty workflow"); assert.equal(laneChoice().options.length, 1);
		trace("empty range picker");
		const emptyBody = view.timelineRenderer.element, emptySvg = view.timelineRenderer.svgElement;
		Object.defineProperties(emptyBody, { clientWidth: { value: 800, configurable: true }, clientHeight: { value: 200, configurable: true } });
		emptyBody.getBoundingClientRect = () => ({ left: 100, right: 900, top: 50, bottom: 250, width: 800, height: 200 });
		emptySvg.getBoundingClientRect = () => ({ left: 100, right: 900, top: 50, bottom: 450, width: 800, height: 400 });
		rangeButton("Select endpoints on timeline").click();
		const emptyStatus = root.querySelector(".sabidurian-range-selection-status"); assert.ok(emptyStatus);
		for (const key of ["Enter", "ArrowRight", "Enter"]) emptyStatus.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
		assert.equal(rangeButton("Write comment").disabled, false); rangeButton("Write comment").click();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		assert.equal(emptyRange.kind, sequence ? "ordinal" : "calendar"); emptyWorkflow.close();
		trace("empty range reveal");
		assert.equal(emptySurface.revealRange(farRange, axisProof.axis.axis, () => true), "revealed");
		const emptyFocusedBody = view.timelineRenderer.element, emptyFocusedSvg = view.timelineRenderer.svgElement;
		emptyFocusedBody.getBoundingClientRect = emptyBody.getBoundingClientRect; emptyFocusedSvg.getBoundingClientRect = emptySvg.getBoundingClientRect;
		const emptyMarks = document.createElement("div"); root.append(emptyMarks);
		const emptyMarkerOptions = { context: emptyCommentContext, proof: axisProof, lanes: new Map(),
			root: { left: 0, right: 1000, top: 0, bottom: 600 }, viewport: emptyFocusedBody.getBoundingClientRect(), marks: emptyMarks, limit: 128, open: () => {} };
		const wholeTarget = { ...rangeAnchor.target, range: farRange }; delete wholeTarget.lane;
		assert.equal(renderTimelineDiscussionMarkers({ ...emptyMarkerOptions, threads: [{ id: uuid(41), anchor: { ...rangeAnchor, target: wholeTarget } }] }), 1);
		trace("empty range marker");
		if (grouped) {
			assert.equal(renderTimelineDiscussionMarkers({ ...emptyMarkerOptions, threads: [{ id: uuid(41), anchor: rangeAnchor }] }), 0);
			assert.equal(emptySurface.revealRange(farRange, axisProof.axis.axis, () => true, laneElement), "unavailable");
		}
		emptyMarks.remove(); root.querySelector(".sabidurian-comment-range-focus button").click();
		trace("restore query");
		view.data = originalData; view.onDataUpdated();
		for (const callback of [...frames.values()]) callback(0); frames.clear();
		assert.equal(host.data, source); assert.deepEqual(writes, []);
		trace("dispose");
		const captured = surface.handles()[1]; view.onDataUpdated(); assert.equal(captured.current(), false);
		assert.equal(rangeContext.current(), false); assert.equal(selectedRange.current(), false); assert.equal(geometry.current(), false);
		bridge.dispose(); assert.equal(client.find(view), undefined); assert.equal(surface.current(), false);
		console.log(`PASS actual ${type}: ${providerFirst ? "provider" : "consumer"} first; ${grouped ? "lane source capture" : "ungrouped"}, saved view, range presence/Jump/Follow, range confirmation/markers, focus/return, empty query, dirty inspector and disposal`);
	} finally {
		client.close(); view.onunload(); bridge.dispose(); for (const modal of Modal.opened) modal.close(); Modal.opened = [];
		frames.clear(); root.remove();
	}
}
await win.happyDOM.close();
