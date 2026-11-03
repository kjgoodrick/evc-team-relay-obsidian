/** @jest-environment jsdom */
import * as Y from "yjs";
import { ManagedConflictsModal } from "../../src/ui/ManagedConflictsModal";
import { CONFLICTS, makeConflict, diff } from "../../src/client/managedRecovery";
import { ItemKind, type ItemRecord } from "../../src/ItemKinds";
import type { VaultShare } from "../../src/VaultShare";
import type { App } from "obsidian";

jest.mock("obsidian", () => {
	const enhance = (el: HTMLElement) => Object.assign(el, {
		empty() { el.replaceChildren(); },
		createEl(tag: string, options: { text?: string; cls?: string }) { const child = document.createElement(tag); child.textContent = options.text ?? ""; el.append(child); return child; },
	});
	class Modal { contentEl = enhance(document.createElement("div")); }
	class Setting {
		constructor(private el: HTMLElement) {}
		setName(text: string) { const p = document.createElement("strong"); p.textContent = text; this.el.append(p); return this; }
		setDesc(text: string) { const p = document.createElement("p"); p.textContent = text; this.el.append(p); return this; }
		addButton(configure: (b: unknown) => void) {
			const button = document.createElement("button"); this.el.append(button);
			const api = { setButtonText(text: string) { button.textContent = text; return api; }, setDisabled(value: boolean) { button.disabled = value; return api; }, onClick(handler: () => void) { button.onclick = handler; return api; } };
			configure(api); return this;
		}
	}
	return { Modal, Setting, Notice: jest.fn() };
});

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
	const doc = new Y.Doc();
	const record: ItemRecord = { id: "one", type: ItemKind.Document, version: 0 };
	const base = { "Old.md": record }, local = { "Local.md": record }, remote = { "Server.md": record };
	const conflict = makeConflict(diff(base, local), base, local, "Competing moves");
	doc.getMap(CONFLICTS).set(conflict.id, conflict);
	const resolve = jest.fn(async () => { doc.getMap(CONFLICTS).delete(conflict.id); return "Relay Recovery (local only)/backup"; });
	const share = { crdtDoc: doc, _liveProvider: { managedIndex: { snapshot: { records: remote } } }, resolveManagedConflict: resolve } as unknown as VaultShare;
	const modal = new ManagedConflictsModal({} as App, share); modal.onOpen();
	return { modal, doc, resolve, conflict, remote, close: () => { modal.onClose(); doc.destroy(); } };
}

test.each(["Use server layout", "Keep my local layout"])("the conflict dialog routes %s with the reviewed server state", async label => {
	const { modal, resolve, conflict, remote, close } = fixture();
	expect(modal.contentEl.textContent).toContain("This device: Local.md");
	expect(modal.contentEl.textContent).toContain("Server (visible to you): Server.md");
	const button = [...modal.contentEl.querySelectorAll("button")].find(b => b.textContent === label)!;
	button.click(); await flush();
	expect(resolve).toHaveBeenCalledWith(conflict.id, label === "Use server layout" ? "server" : "local", remote);
	expect(modal.contentEl.textContent).toContain("No file conflicts need a decision"); close();
});

test("a failed decision stays visible and buttons cannot start a second concurrent recovery", async () => {
	const { modal, resolve, doc, close } = fixture();
	let reject!: (error: Error) => void;
	resolve.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
	modal.contentEl.querySelector("button")!.click();
	expect([...modal.contentEl.querySelectorAll("button")].every(b => b.disabled)).toBe(true);
	reject(Error("Backup failed: disk full")); await flush();
	expect(modal.contentEl.textContent).toContain("Backup failed: disk full");
	expect(doc.getMap(CONFLICTS).size).toBe(1);
	expect([...modal.contentEl.querySelectorAll("button")].every(b => !b.disabled)).toBe(true); close();
});
