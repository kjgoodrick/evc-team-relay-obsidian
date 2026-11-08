/** @jest-environment jsdom */
import * as Y from "yjs";
import { ManagedConflictsModal } from "../../src/ui/ManagedConflictsModal";
import { CONFLICTS, makeConflict, diff } from "../../src/client/managedRecovery";
import { ItemKind, type ItemRecord } from "../../src/ItemKinds";
import type { VaultShare } from "../../src/VaultShare";
import type { App } from "obsidian";
import { ManagedRestoreTextModal } from "../../src/ui/ManagedRestoreTextModal";

jest.mock("../../src/ui/ManagedRestoreTextModal", () => ({ ManagedRestoreTextModal: jest.fn().mockImplementation(() => ({ open: jest.fn() })) }));

jest.mock("obsidian", () => {
	const enhance = (el: HTMLElement) => Object.assign(el, {
		empty() { el.replaceChildren(); },
		addClass(...names: string[]) { el.classList.add(...names); },
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
	const save = jest.fn(async () => "Relay Recovery (local only)/restore-copy");
	const inspect = jest.fn(async () => ({ reviewId: "restore", checkedAt: "2026-11-08T00:00:00Z", local,
		server: { records: remote, permissions: {}, activity: {}, owner: false } }));
	const authListeners = new Set<() => void>();
	const share = { crdtDoc: doc, authSession: { on: (listener: () => void) => { authListeners.add(listener); return () => authListeners.delete(listener); } },
		_liveProvider: { managedIndex: { snapshot: { records: remote } } }, resolveManagedConflict: resolve, saveManagedRestoreRecoveryCopy: save, inspectManagedRestore: inspect } as unknown as VaultShare;
	const modal = new ManagedConflictsModal({} as App, share); modal.onOpen();
	return { modal, doc, resolve, save, inspect, conflict, remote, authChanged: () => authListeners.forEach(listener => listener()), authListeners,
		close: () => { modal.onClose(); doc.destroy(); } };
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

test("restore review explains the share-wide pause and offers no ordinary layout replay", () => {
	const s = fixture(); try {
		s.doc.getMap("managed_base_v1").set("restoreReview", { id: "restore", local: s.conflict.local });
		expect(s.modal.contentEl.textContent).toContain("Shared folder restored");
		expect(s.modal.contentEl.textContent).toContain("Synchronization is paused");
		expect(s.modal.contentEl.textContent).toContain("1 local inventory entries");
		expect([...s.modal.contentEl.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Save local recovery copy", "Compare server inventory"]);
		expect(s.resolve).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("restore comparison is read-only and is withdrawn after the retained inventory changes", async () => {
	const s = fixture(); try {
		s.doc.getMap("managed_base_v1").set("restoreReview", { id: "restore", local: s.conflict.local });
		[...s.modal.contentEl.querySelectorAll("button")].find(button => button.textContent === "Compare server inventory")!.click(); await flush();
		expect(s.modal.contentEl.textContent).toContain("Local.md → Server.md");
		expect(s.modal.contentEl.textContent).toContain("File contents, unsaved text and untracked local files are not compared");
		expect(s.inspect).toHaveBeenCalledTimes(1); expect(s.save).not.toHaveBeenCalled(); expect(s.resolve).not.toHaveBeenCalled();
		s.doc.getMap("filemeta_v0").set("Later.md", { id: "later", type: ItemKind.Document, version: 0 });
		expect(s.modal.contentEl.textContent).not.toContain("Local.md → Server.md");
	} finally { s.close(); }
});

test("a comparison finishing after close and reopen cannot repopulate the new review", async () => {
	const s = fixture(); try {
		s.doc.getMap("managed_base_v1").set("restoreReview", { id: "restore", local: s.conflict.local });
		const result = await s.inspect(); let finish!: (value: typeof result) => void;
		s.inspect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		[...s.modal.contentEl.querySelectorAll("button")].find(button => button.textContent === "Compare server inventory")!.click();
		s.modal.onClose(); s.modal.onOpen(); finish(result); await flush();
		expect(s.modal.contentEl.textContent).not.toContain("Local.md → Server.md");
		expect(s.modal.contentEl.textContent).toContain("Compare server inventory");
	} finally { s.close(); }
});

test("comparison pages bound rendered rows and failed reads can be retried", async () => {
	const s = fixture(); try {
		s.doc.getMap("managed_base_v1").set("restoreReview", { id: "restore", local: s.conflict.local });
		const click = (label: string) => [...s.modal.contentEl.querySelectorAll("button")].find(button => button.textContent === label)!.click();
		s.inspect.mockRejectedValueOnce(new Error("File inventory refused (403)")); click("Compare server inventory"); await flush();
		expect(s.modal.contentEl.textContent).toContain("File inventory refused (403)");
		const result = await s.inspect(); result.local = {} as typeof result.local;
		result.server.records = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`Note ${String(i).padStart(2, "0")}.md`, { id: String(i), type: ItemKind.Document, version: 0 }])) as typeof result.server.records;
		s.inspect.mockResolvedValueOnce(result); click("Compare server inventory"); await flush();
		expect(s.modal.contentEl.textContent).toContain("Page 1 of 2"); expect(s.modal.contentEl.textContent).toContain("Note 00.md");
		expect(s.modal.contentEl.textContent).not.toContain("Note 50.md"); click("Next page");
		expect(s.modal.contentEl.textContent).toContain("Note 50.md"); expect(s.modal.contentEl.textContent).not.toContain("Note 00.md");
	} finally { s.close(); }
});

test.each(["account", "inventory"])("a pending comparison cannot survive a later %s change", async change => {
	const s = fixture(); try {
		s.doc.getMap("managed_base_v1").set("restoreReview", { id: "restore", local: s.conflict.local });
		const result = await s.inspect(); let finish!: (value: typeof result) => void;
		s.inspect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		[...s.modal.contentEl.querySelectorAll("button")].find(button => button.textContent === "Compare server inventory")!.click();
		if (change === "account") s.authChanged(); else s.doc.getMap("filemeta_v0").set("Later.md", { id: "later", type: ItemKind.Document, version: 0 });
		finish(result); await flush(); expect(s.modal.contentEl.textContent).not.toContain("Local.md → Server.md");
		s.modal.onClose(); expect(s.authListeners.size).toBe(0);
	} finally { s.close(); }
});

test("inventory review opens the selected source only while its captured context is valid", async () => {
	const s = fixture(), constructor = jest.mocked(ManagedRestoreTextModal); constructor.mockClear();
	try {
		s.doc.getMap("managed_base_v1").set("restoreReview", { id: "restore", local: s.conflict.local });
		const result = Object.assign(await s.inspect(), { check: jest.fn() }); s.inspect.mockResolvedValueOnce(result);
		const click = (label: string) => [...s.modal.contentEl.querySelectorAll("button")].find(button => button.textContent === label)!.click();
		click("Compare server inventory"); await flush(); click("Compare source text");
		expect(constructor).toHaveBeenCalledTimes(1); expect(constructor.mock.calls[0].slice(2)).toEqual([result, "one"]);
		result.check.mockImplementation(() => { throw new Error("Source account changed"); }); click("Compare source text");
		expect(constructor).toHaveBeenCalledTimes(1); expect(s.modal.contentEl.textContent).toContain("Source account changed");
	} finally { s.close(); }
});

test("restore export shows the verified path, keeps review visible and prevents concurrent saves", async () => {
	const s = fixture(); try {
		s.doc.getMap("managed_base_v1").set("restoreReview", { id: "restore", local: s.conflict.local });
		let finish!: (path: string) => void;
		s.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		s.modal.contentEl.querySelector("button")!.click();
		expect(s.modal.contentEl.querySelector("button")!.disabled).toBe(true);
		s.modal.contentEl.querySelector("button")!.click(); expect(s.save).toHaveBeenCalledTimes(1);
		finish("Relay Recovery (local only)/verified"); await flush();
		expect(s.modal.contentEl.textContent).toContain("Verified recovery copy: Relay Recovery (local only)/verified");
		expect(s.modal.contentEl.textContent).toContain("Synchronization is paused"); expect(s.resolve).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("a failed restore export displays its error and enables a fresh attempt", async () => {
	const s = fixture(); try {
		s.doc.getMap("managed_base_v1").set("restoreReview", { id: "restore", local: s.conflict.local });
		s.save.mockRejectedValueOnce(new Error("Local edits arrived while saving recovery files"));
		s.modal.contentEl.querySelector("button")!.click(); await flush();
		expect(s.modal.contentEl.textContent).toContain("Local edits arrived while saving recovery files");
		expect(s.modal.contentEl.querySelector("button")!.disabled).toBe(false);
		s.modal.contentEl.querySelector("button")!.click(); await flush();
		expect(s.modal.contentEl.textContent).toContain("Verified recovery copy");
		expect(s.modal.contentEl.textContent).not.toContain("Local edits arrived");
	} finally { s.close(); }
});

test("closing the dialog during export does not repopulate its detached content", async () => {
	const s = fixture(); try {
		s.doc.getMap("managed_base_v1").set("restoreReview", { id: "restore", local: s.conflict.local });
		let finish!: (path: string) => void;
		s.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		s.modal.contentEl.querySelector("button")!.click(); s.modal.onClose();
		finish("Relay Recovery (local only)/verified"); await flush();
		expect(s.modal.contentEl.childElementCount).toBe(0);
		s.modal.onOpen(); expect(s.modal.contentEl.textContent).toContain("Verified recovery copy");
	} finally { s.close(); }
});
