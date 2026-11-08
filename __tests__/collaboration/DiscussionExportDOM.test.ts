/** @jest-environment jsdom */
import type { App } from "obsidian";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionExportModal } from "../../src/collaboration/ui/DiscussionExport";
import { exportDisk, exportId as id } from "../mocks/DiscussionExport";
jest.mock("obsidian", () => ({ Modal: class {
	contentEl = document.createElement("div"); setTitle() {}
	close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; } });
function fixture() {
	let current = true; const listeners = new Set<() => void>(), disk = exportDisk();
	const session = { status: "ready", canExport: true, permission: () => ({ read: true, comment: false }),
		onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		saveDiscussionExport: jest.fn<ReturnType<DiscussionSession["saveDiscussionExport"]>, Parameters<DiscussionSession["saveDiscussionExport"]>>(async () => "Relay Recovery (local only)/Discussions-synthetic") };
	const modal = new DiscussionExportModal({} as App, session as unknown as DiscussionSession, id(3), "Roadmap.base · Timeline", () => current, disk.io);
	modal.onOpen(); const button = modal.contentEl.querySelector("button")!, checkbox = modal.contentEl.querySelector("input")!;
	return { modal, session, disk, button, checkbox, listeners, invalidate: () => { current = false; modal.validate(); } };
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test("read-only export explains scope and omissions; selected picture mode is passed to the session", async () => {
	const f = fixture();
	try {
		expect(f.modal.contentEl.textContent).toContain("Roadmap.base · Timeline"); expect(f.modal.contentEl.textContent).toContain("unsent drafts are excluded");
		expect(f.button.disabled).toBe(false); expect(f.checkbox.checked).toBe(true);
		f.checkbox.checked = false; f.button.click(); expect(f.button.disabled).toBe(true); await settle();
		expect(f.session.saveDiscussionExport).toHaveBeenCalledWith(id(3), f.disk.io, expect.any(Function), false, expect.any(Function));
		expect(f.modal.contentEl.textContent).toContain("archive verified and saved"); expect(f.button.disabled).toBe(false);
	} finally { f.modal.onClose(); }
});

test("disconnect disables export and failures allow a fresh retry without claiming completion", async () => {
	const f = fixture();
	try {
		f.session.canExport = false; f.listeners.forEach(listener => listener()); expect(f.button.disabled).toBe(true);
		f.session.canExport = true; f.listeners.forEach(listener => listener());
		f.session.saveDiscussionExport.mockRejectedValueOnce(new Error("Disk full")); f.button.click(); await settle();
		expect(f.modal.contentEl.textContent).toContain("Export did not finish"); expect(f.modal.contentEl.textContent).not.toContain("verified and saved");
		f.button.click(); await settle(); expect(f.session.saveDiscussionExport).toHaveBeenCalledTimes(2);
	} finally { f.modal.onClose(); }
});

test("closing or changing the saved view invalidates the writer and drops late completion", async () => {
	const f = fixture(); let finish!: (path: string) => void;
	f.session.saveDiscussionExport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	f.button.click(); const current = f.session.saveDiscussionExport.mock.calls[0][2] as unknown as () => boolean;
	expect(current()).toBe(true); f.invalidate(); expect(current()).toBe(false); expect(f.listeners.size).toBe(0);
	finish("late-copy"); await settle(); expect(f.modal.contentEl.childElementCount).toBe(0);
});
