/** @jest-environment jsdom */
import type { App } from "obsidian";
import type { VaultShare } from "../../src/VaultShare";
import type { AttachmentFile } from "../../src/AttachmentFile";
import type { BaseSyncHost } from "../../src/bases/BaseSyncHost";
import type { BaseRegistryRecord } from "../../src/bases/BaseRegistryStore";
import type { BaseRegistrySnapshot, BaseViewPage } from "../../src/bases/BaseRegistryProtocol";
import { BaseViewsModal } from "../../src/bases/BaseViewsModal";

jest.mock("../../src/bases/BaseSyncHost", () => ({ baseSyncMessage: (error: Error) => error.message }));
jest.mock("obsidian", () => {
	const enhance = (element: HTMLElement) => Object.assign(element, {
		empty() { element.replaceChildren(); },
		createEl(tag: string, options: { text?: string; attr?: Record<string, string> } = {}) {
			const child = document.createElement(tag); child.textContent = options.text ?? "";
			for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, value);
			element.append(child); return enhance(child);
		},
	});
	class Setting {
		constructor(private element: HTMLElement) {}
		setName(text: string) { this.element.append(document.createTextNode(text)); return this; }
		setDesc(text: string) { this.element.append(document.createTextNode(text)); return this; }
		addButton(configure: (value: unknown) => void) {
			const button = document.createElement("button"); this.element.append(button);
			const api = { setButtonText(text: string) { button.textContent = text; return api; }, setDisabled(value: boolean) { button.disabled = value; return api; },
				onClick(handler: () => void) { button.onclick = handler; return api; } };
			configure(api); return this;
		}
	}
	return { Modal: class { contentEl = enhance(document.createElement("div")); }, Setting };
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const id = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const snapshot = (): BaseRegistrySnapshot => ({ protocol_version: 1, entry_id: id(1), definition_id: id(2), generation: id(3), revision: 1, content_sha256: "a".repeat(64),
	views: [{ slot: 0, id: id(4), name: "Planning", type: "table", descriptor_sha256: "b".repeat(64) }, { slot: 1, id: id(5), name: "Cards", type: "cards", descriptor_sha256: "c".repeat(64) }],
	unmatched: { views: [], has_more: false, next_after: null } });
function fixture() {
	const file = { path: "Planning.base", entityGuid: id(1) } as AttachmentFile;
	const record: BaseRegistryRecord = { entryId: id(1), revision: 1, snapshot: snapshot() };
	let changed = (_reset: boolean) => {};
	const host = { cachedViews: jest.fn(async () => record), refreshViews: jest.fn(async () => record),
		repairViews: jest.fn(async () => record), checkViewRepair: jest.fn(async () => record),
		viewRepairStatus: jest.fn(async () => ({ status: "unknown" as const, operation_id: id(8), entry_id: id(1) })),
		savedViewPage: jest.fn(async (): Promise<BaseViewPage> => ({ views: [{ id: id(6), state: "archived", name: "Old timeline", type: "timeline", descriptor_sha256: "d".repeat(64) }], has_more: false, next_after: id(6) })),
		export: jest.fn(async () => "local-export"), onChange: (listener: typeof changed) => { changed = listener; return () => {}; } };
	const folder = { canWriteManagedPath: jest.fn(() => true) };
	const modal = new BaseViewsModal({} as App, host as unknown as BaseSyncHost, folder as unknown as VaultShare, file);
	document.body.append(modal.contentEl);
	const button = (label: string) => [...modal.contentEl.querySelectorAll("button")].find(item => item.textContent === label)!;
	const select = (slot: number, value: string) => { const element = modal.contentEl.querySelectorAll("select")[slot]; element.value = value; element.dispatchEvent(new Event("change")); };
	return { modal, host, folder, file, record, button, select, changed: (reset: boolean) => changed(reset), close: () => { modal.onClose(); modal.contentEl.remove(); } };
}

test("read-only reviewers inspect current and archived associations without repair controls", async () => {
	const s = fixture(); try {
		s.folder.canWriteManagedPath.mockReturnValue(false); s.modal.onOpen(); await flush();
		expect(s.modal.contentEl.textContent).toContain("Verified saved-view revision 1");
		expect([...s.modal.contentEl.querySelectorAll("select")].every(item => item.disabled)).toBe(true);
		s.button("Load archived views").click(); await flush();
		expect(s.host.savedViewPage).toHaveBeenCalledWith(s.folder, s.file, s.record.snapshot, "archived", undefined);
		expect(s.modal.contentEl.textContent).toContain("Old timeline"); expect(s.button("Save associations").disabled).toBe(true);
		expect(s.host.repairViews).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("duplicate associations are explained before saving, and corrected choices preserve the reviewed mapping", async () => {
	const s = fixture(); try {
		s.modal.onOpen(); await flush(); s.select(1, id(4));
		expect(s.button("Save associations").disabled).toBe(true); expect(s.modal.contentEl.querySelector('[role="alert"]')?.textContent).toContain("more than once");
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Association for Cards");
		s.select(0, ""); s.button("Save associations").click(); await flush();
		expect(s.host.repairViews).toHaveBeenCalledWith(s.folder, s.file, s.record.snapshot, [{ slot: 0, view_id: null }, { slot: 1, view_id: id(4) }], []);
	} finally { s.close(); }
});

test("pending repairs show their original choices and refresh never retries them", async () => {
	const s = fixture(); try {
		s.record.pending = { definitionId: id(2), generation: id(3), reviewed: snapshot(), request: { operation_id: id(8), expected_revision: 1, content_sha256: "a".repeat(64), bindings: [{ slot: 0, view_id: id(6) }, { slot: 1, view_id: null }], archive: [] } };
		s.record.snapshot!.views[0].name = "Renamed later";
		s.modal.onOpen(); await flush(); s.button("Refresh views").click(); await flush();
		expect(s.modal.contentEl.textContent).toContain(`Planning: continue identity ${id(6)}`);
		expect(s.host.checkViewRepair).not.toHaveBeenCalled(); expect(s.button("Save associations").disabled).toBe(true);
		s.button("Check repair delivery").click(); await flush(); expect(s.host.checkViewRepair).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test("restored repairs can inspect receipts with read access while replay stays disabled", async () => {
	const s = fixture(); try {
		s.record.pending = { definitionId: id(2), generation: id(3), reviewed: snapshot(), request: { operation_id: id(8), expected_revision: 1, content_sha256: "a".repeat(64), bindings: [{ slot: 0, view_id: id(6) }, { slot: 1, view_id: null }], archive: [] } };
		s.record.snapshot = { ...snapshot(), restore_guard: true, restore_generation: id(50) };
		s.folder.canWriteManagedPath.mockReturnValue(false); s.modal.onOpen(); await flush();
		expect(s.modal.contentEl.textContent).toContain("before restoration"); expect(s.button("Check repair delivery").disabled).toBe(true);
		expect(s.button("Check saved result").disabled).toBe(false); s.button("Check saved result").click(); await flush();
		expect(s.host.viewRepairStatus).toHaveBeenCalledWith(s.folder, s.file);
		expect(s.modal.contentEl.textContent).toContain("does not prove the repair never committed");
		expect(s.record.pending).toBeDefined(); expect(s.host.checkViewRepair).not.toHaveBeenCalled(); expect(s.host.repairViews).not.toHaveBeenCalled();
		s.folder.canWriteManagedPath.mockReturnValue(true); s.button("Refresh views").click(); await flush();
		expect(s.button("Check repair delivery").disabled).toBe(true);
	} finally { s.close(); }
});

test("a failed refresh leaves cached mapping and recovery export available without enabling edits", async () => {
	const s = fixture(); try {
		s.host.refreshViews.mockRejectedValue(new Error("Offline")); s.modal.onOpen(); await flush();
		expect(s.modal.contentEl.textContent).toContain("Cached associations"); expect(s.button("Save associations").disabled).toBe(true);
		s.button("Export recovery copies").click(); await flush(); expect(s.host.export).toHaveBeenCalledWith(s.folder, s.file.entityGuid);
	} finally { s.close(); }
});

test.each(["reset", "close"])("%s removes old-account mapping and ignores a delayed refresh", async action => {
	const s = fixture(); try {
		let finish!: (record: BaseRegistryRecord) => void;
		s.host.refreshViews.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		s.modal.onOpen(); await flush(); expect(s.modal.contentEl.textContent).toContain("Planning (table)");
		if (action === "reset") s.changed(true); else s.modal.onClose();
		finish(s.record); await flush(); expect(s.modal.contentEl.textContent).not.toContain("Planning (table)");
		expect(s.modal.contentEl.querySelectorAll("select")).toHaveLength(0);
	} finally { s.close(); }
});
