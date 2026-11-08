/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import { webcrypto } from "node:crypto";
import type { App } from "obsidian";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { SavedDraftCopyModal } from "../../src/collaboration/ui/SavedDraftCopy";
import { DiscussionDrafts } from "../../src/collaboration/ui/DiscussionDrafts";
import { copySavedDraft, reviewSavedDraftCopy, type SavedDraftCopyReview } from "../../src/collaboration/SavedDraftCopy";
import type { LocalDiscussionAnchor } from "../../src/collaboration/LocalDiscussionAnchor";
import { CommentComposer } from "../../src/collaboration/ui/CommentComposer";
jest.mock("obsidian", () => ({ Modal: class { contentEl = document.createElement("div"); setTitle() {} close() { (this as unknown as { onClose(): void }).onClose(); } } }));
jest.mock("../../src/collaboration/ui/CommentComposer", () => ({ CommentComposer: jest.fn().mockImplementation(() => ({ flush: jest.fn().mockResolvedValue(true), update() {}, dispose() {}, onRevealTarget() {} })) }));
Object.assign(globalThis, { IDBKeyRange, TextEncoder, TextDecoder, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; }, appendText(this: HTMLElement, text: string) { this.append(document.createTextNode(text)); } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "copy-ui" }, scope = id(3), destination = id(4);
const target: LocalDiscussionAnchor = { version: 1, type: "note" };
async function until(check: () => boolean): Promise<void> { for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("Draft-copy UI did not settle"); }
async function fixture(count = 1, missing = false) {
	const store = await DiscussionStore.open(identity, new IDBFactory()), listeners = new Set<() => void>(); let current = true;
	for (let n = 0; n < count; n++) await store.saveDraft({ id: "draft:" + String(n).padStart(3, "0"), scopeId: scope, revision: 0,
		body: { text: "Saved body " + n, mentions: [], ...(missing ? { pictures: [{ type: "picture", picture_id: id(20) }] } : {}) } });
	const session = { store, identity, status: "offline", canQueue: true, queue: jest.fn(), canCopySavedDraft: () => current, knownDocumentGeneration: () => id(30), permission: () => ({ read: true, comment: true }),
		trackLocal: <T>(promise: Promise<T>) => promise, onChange: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
		reviewSavedDraftCopy: jest.fn((sourceId: string, scopeId: string, anchor: LocalDiscussionAnchor, active: string | undefined, visible: () => boolean) => reviewSavedDraftCopy(store, sourceId, scopeId, anchor, active, visible)),
		copySavedDraft: jest.fn((review: SavedDraftCopyReview, copyId: string, omit: boolean, visible: () => boolean) => copySavedDraft(store, review, copyId, omit, visible)) };
	const modal = new SavedDraftCopyModal({} as App, session as unknown as DiscussionSession, destination, target, undefined, () => current, "Destination.md"); document.body.append(modal.contentEl);
	const button = (text: string) => Array.from(modal.contentEl.querySelectorAll("button")).find(button => button.textContent === text)!;
	return { store, session, modal, button, invalidate: () => { current = false; modal.validate(); }, close: () => { modal.onClose(); modal.contentEl.remove(); store.close(); } };
}

test("reviews destination and content, requires explicit missing-picture omission, then creates a separate unsent draft", async () => {
	const f = await fixture(1, true);
	try {
		await f.modal.onOpen(); expect(f.modal.contentEl.textContent).toContain("Destination.md"); expect(f.modal.contentEl.textContent).toContain("Entire note");
		f.button("Review this draft").click(); await until(() => !!f.button("Create discussion draft"));
		expect(f.button("Create discussion draft").disabled).toBe(true); expect(f.modal.contentEl.textContent).toContain("Saved body 0");
		const check = f.modal.contentEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!; check.checked = true; check.dispatchEvent(new Event("change"));
		expect(f.button("Create discussion draft").disabled).toBe(false); f.button("Create discussion draft").click();
		await until(() => f.modal.contentEl.textContent === ""); expect(await f.store.storageUsage()).toMatchObject({ drafts: 2, queued: 0 });
		const selection = (await f.store.selectionDrafts(destination)).drafts[0]; expect(selection.body).toMatchObject({ text: "Saved body 0", pictures: [] }); expect(await f.store.getDraft("draft:000")).toBeDefined();
		expect(f.session.queue).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("a source edit after review keeps the source and restores controls for a fresh review", async () => {
	const f = await fixture();
	try {
		await f.modal.onOpen(); f.button("Review this draft").click(); await until(() => !!f.button("Create discussion draft"));
		const source = (await f.store.getDraft("draft:000"))!; await f.store.saveDraft({ ...source, revision: 1, body: "Changed elsewhere" }, 0);
		f.button("Create discussion draft").click(); await until(() => f.modal.contentEl.textContent!.includes("changed after review"));
		expect(f.button("Choose another draft").disabled).toBe(false); f.button("Choose another draft").click(); await until(() => !!f.button("Review this draft"));
		expect(f.modal.contentEl.textContent).toContain("Changed elsewhere"); expect(await f.store.storageUsage()).toMatchObject({ drafts: 1 });
	} finally { f.close(); }
});

test("pages stay bounded and unconfirmed drafts have no copy-review action", async () => {
	const f = await fixture(12);
	try {
		await f.store.setPreference("online:draft:000", {}); await f.modal.onOpen(); expect(f.modal.contentEl.querySelectorAll("section")).toHaveLength(10);
		expect(f.modal.contentEl.querySelector("section")!.querySelector("button")).toBeNull(); f.button("More drafts").click();
		await until(() => f.modal.contentEl.querySelectorAll("section").length === 2); expect(f.modal.contentEl.textContent).toContain("Page 2");
	} finally { f.close(); }
});

test("context loss while a picture/source review is pending clears content and prevents a copy", async () => {
	const f = await fixture();
	try {
		await f.modal.onOpen(); let finish!: (value: SavedDraftCopyReview) => void;
		const reviewed = await reviewSavedDraftCopy(f.store, "draft:000", destination, target, undefined, () => true);
		f.session.reviewSavedDraftCopy.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.button("Review this draft").click(); f.invalidate(); finish(reviewed); await new Promise(resolve => setTimeout(resolve, 20));
		expect(f.modal.contentEl.textContent).toBe(""); expect(f.session.copySavedDraft).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("the destination control flushes the active composer and passes a selection guard without sending", async () => {
	const f = await fixture(), parent = document.createElement("div"), open = jest.fn();
	const drafts = new DiscussionDrafts(parent, f.session as unknown as DiscussionSession, destination, () => {}, undefined, undefined, undefined, open);
	try {
		await until(() => !!Array.from(parent.querySelectorAll("button")).find(button => button.textContent === "Use saved work at this target"));
		Array.from(parent.querySelectorAll("button")).find(button => button.textContent === "Use saved work at this target")!.click();
		await until(() => open.mock.calls.length === 1); expect(open.mock.calls[0].slice(0, 2)).toEqual([target, undefined]); expect(open.mock.calls[0][2]()).toBe(true);
		expect(jest.mocked(CommentComposer).mock.results.at(-1)!.value.flush).toHaveBeenCalled();
		drafts.dispose(); expect(open.mock.calls[0][2]()).toBe(false);
	} finally { drafts.dispose(); f.close(); }
});
