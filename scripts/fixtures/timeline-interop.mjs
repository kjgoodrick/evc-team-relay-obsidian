import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { Window } from "happy-dom";
import { TFile, Modal } from "obsidian";
import { SabidurianView } from "timeline-view";
import { SequenceView } from "sequence-view";
import { CollaborationBridge } from "timeline-bridge";
import { TaskInspector } from "timeline-inspector";
import { TimelineBridgeClient } from "../../src/bases/TimelineBridgeClient.ts";
import { NativeBasesSurface } from "../../src/bases/NativeBasesSurface.ts";
import { sha256Hex } from "../../src/contentDigest.ts";

const win = new Window();
Object.assign(globalThis, { window: win, document: win.document, MouseEvent: win.MouseEvent, CSS: win.CSS });
Object.defineProperty(window.crypto, "subtle", { value: webcrypto.subtle });
const proto = win.HTMLElement.prototype;
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

for (const type of ["sabidurian-timeline", "sabidurian-sequence"]) for (const providerFirst of [true, false]) {
	const files = [file("Tasks/one.md"), file("Tasks/two.md")], base = file("Tasks/Plan.base");
	const metadata = new Map(files.map(value => [value.path, { start: "2026-11-26T08:00:00Z", end: "2026-11-26T09:00:00Z", status: "Ready", title: "Same label" }]));
	const values = { startDateProp: "note.start", endDateProp: "note.end", labelProp: "note.title", orderProp: "note.order", orderEndProp: null,
		timeZone: "UTC", scaleId: "day", snapMinutes: 5, tickMinutes: 15, oneTaskPerRow: true, showTable: false, showArrows: false, showToday: false,
		locked: true, initialScroll: "start", collapsedGroups: [], barDisplayProp1: "note.status", barDisplayProp2: "formula.total" };
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
	view.config = { type, name: "Work", query, get: key => values[key], set: (...args) => writes.push(args),
		getAsPropertyId: key => values[key] ?? null, getOrder: () => [], getDisplayName: key => "Alias " + key };
	query.views = [view.config]; view.allProperties = ["note.status", "formula.total"];
	view.data = { data: files.map((value, index) => ({ file: value, getValue: key => key === "note.order" ? index + 1 : key === "formula.total" ? index + 20 : metadata.get(value.path)[key.replace(/^note\./, "")] })), groupedData: [] };
	const client = new TimelineBridgeClient(workspace, () => {}); client.start();
	try {
		view.onDataUpdated(); for (const callback of [...frames.values()]) callback(0); frames.clear();
		if (!providerFirst) { assert.equal(client.find(view), undefined); published = true; listeners.get("time-and-line:collaboration-ready")(bridge); }
		const host = { file: base, contentEl: root, data: source, lastSavedData: source, dirty: false, controller, query, getViewType: () => "bases" };
		const surface = NativeBasesSurface.inspect(host, "1.13.7", true, client); assert.ok(surface, "actual view must bind through the actual client");
		const snapshot = { protocol_version: 1, definition_id: uuid(1), entry_id: uuid(2), generation: uuid(3), revision: 1,
			content_sha256: await sha256Hex(new TextEncoder().encode(source).buffer), views: [{ slot: 0, id: uuid(4), name: "Work", type, descriptor_sha256: "a".repeat(64) }],
			unmatched: { views: [], has_more: false, next_after: null } };
		assert.ok(await surface.bind(snapshot, uuid(2), async () => source, () => true));
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
		const captured = surface.handles()[1]; view.onDataUpdated(); assert.equal(captured.current(), false);
		bridge.dispose(); assert.equal(client.find(view), undefined); assert.equal(surface.current(), false);
		console.log(`PASS actual ${type}: ${providerFirst ? "provider" : "consumer"} first; saved view, property target, annotation, navigation, dirty inspector and disposal`);
	} finally {
		client.close(); view.onunload(); bridge.dispose(); for (const modal of Modal.opened) modal.close(); Modal.opened = [];
		frames.clear(); root.remove();
	}
}
await win.happyDOM.close();
