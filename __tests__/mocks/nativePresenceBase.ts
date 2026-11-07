import { FileView, TFile } from "obsidian";
import { createHash } from "node:crypto";
import type { BasePresenceContext } from "../../src/collaboration/presence/BasePresenceProtocol";
import { basePresenceLocation } from "../../src/collaboration/presence/BasePresenceProtocol";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A real NativeBasesSurface contract; only Obsidian layout/config objects are simulated. */
export function nativePresenceBase(initialType: "table" | "cards" | "list" = "table") {
	const root = document.body.appendChild(document.createElement("div")), content = root.appendChild(document.createElement("div"));
	const serial = { filters: 'file.inFolder("Team")', views: [{ name: "Work", type: initialType, order: ["file.name", "note.status"] }, { name: "Cards", type: "cards", order: ["file.name", "note.status"] }] };
	const source = JSON.stringify(serial), hash = createHash("sha256").update(source).digest("hex");
	const file: TFile = Object.assign(Object.create(TFile.prototype), { path: "Planning.base", extension: "base", stat: { mtime: 1, size: Buffer.byteLength(source) } });
	class Query { static parse(value: unknown) { return { getSerializable: () => value }; } }
	const query = { constructor: Query, file, views: [] as unknown[], getSerializable: () => serial };
	const configs = serial.views.map(view => ({ ...view, query })); query.views = configs;
	const controller = { query, initialScan: false, viewName: "Work", view: {} as Record<string, unknown>, selectView: jest.fn((_name: string) => {}) };
	const renderers = configs.map(config => {
		const container = document.createElement("div"), scroll = container.appendChild(document.createElement("div")); scroll.scrollIntoView = jest.fn();
		return { queryController: controller, type: config.type, config, containerEl: container, scrollEl: scroll, order: config.order,
			data: { groupedData: [] as { entries: { file: TFile }[] }[], properties: ["file.name", "note.status"] },
			rows: [] as Record<string, unknown>[], items: [] as Record<string, unknown>[], groups: [] as Record<string, unknown>[],
			header: { cells: [] as Record<string, unknown>[] }, getCellRect: jest.fn(() => ({ top: 400, left: 0 })), updateVirtualDisplay: jest.fn() };
	});
	controller.selectView.mockImplementation(name => {
		const index = configs.findIndex(config => config.name === name);
		if (index < 0) throw new Error("Unknown view");
		controller.viewName = name; controller.view = renderers[index]; content.replaceChildren(renderers[index].containerEl);
	});
	controller.selectView("Work"); controller.selectView.mockClear();
	const host = Object.assign(Object.create(FileView.prototype), { file, contentEl: content, containerEl: root, data: source, lastSavedData: source, dirty: false,
		controller, query, getViewType: () => "bases", addAction: (_icon: string, _title: string, callback: () => void) => { const button = root.appendChild(document.createElement("button")); button.onclick = callback; return button; } });
	const context: BasePresenceContext = { protocol_version: 1, share_id: id(3), entry_id: id(30), definition_id: id(31), generation: id(32), registry_revision: 1,
		content_sha256: hash, views: serial.views.map((view, slot) => ({ id: id(33 + slot), slot, name: view.name, type: view.type })) };
	const setRecords = (files: TFile[]) => renderers.map(renderer => {
		const entries = files.map(file => ({ file })); renderer.data = { ...renderer.data, groupedData: [{ entries }] };
		renderer.scrollEl.replaceChildren();
		const rows = entries.map(entry => {
			const el = renderer.scrollEl.appendChild(document.createElement("div")); el.scrollIntoView = jest.fn();
			const cells = renderer.data.properties.map(prop => { const el = document.createElement("div"); el.scrollIntoView = jest.fn(); return { el, view: renderer, prop, propertyId: prop, entry }; });
			cells.forEach(cell => el.append(cell.el)); return { view: renderer, entry, el, cells, props: cells };
		});
		renderer.rows = rows; renderer.items = rows; renderer.groups = [{ rows, tbodyEl: renderer.scrollEl, containerEl: renderer.scrollEl }];
		renderer.header.cells = renderer.data.properties.map(prop => { const el = renderer.containerEl.appendChild(document.createElement("div")); el.scrollIntoView = jest.fn(); return { view: renderer, el, prop }; });
		return rows;
	});
	return { root, content, file, source, hash, serial, query, controller, renderers, host, view: host as FileView, context, setRecords,
		record: { id: id(30), type: "file", hash }, location: (slot = 0) => basePresenceLocation(context, id(33 + slot))!, close: () => root.remove() };
}
