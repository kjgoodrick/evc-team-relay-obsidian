/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import { webcrypto } from "node:crypto";
import { DiscussionStore, type Draft, type QueuedCommand, type Json } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { CommentComposer } from "../../src/collaboration/ui/CommentComposer";
import { prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
Object.assign(globalThis, { IDBKeyRange, TextEncoder, TextDecoder, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = id(3), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "draft-discard" };
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
	throw new Error("Draft editor did not settle");
}
async function fixture(rich = false, target?: Json) {
	const store = await DiscussionStore.open(identity, new IDBFactory()), listeners = new Set<(id: string) => void>();
	const draft: Draft = { id: "new:" + scope, scopeId: scope, revision: 0, body: rich ? protocolJson(editableCommentDraft(bodyFromText("Saved rich text"), () => "Member")) : { text: "Saved plain text", mentions: [] }, ...(target ? { target } : {}) };
	await store.saveDraft(draft);
	const session = { store, identity, status: "offline", canQueue: true, canAttachPictures: false, participants: () => [{ id: id(40), name: "Member" }], displayName: () => "Member",
		permission: () => ({ read: true, comment: true }), trackLocal: <T>(promise: Promise<T>) => promise,
		onDraftDiscarded: (listener: (id: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		discardDraft: jest.fn(async (review: Draft, current: () => boolean) => {
			if (!await store.removeDraft(review.id, review.revision, review, current)) throw new Error("Draft changed; nothing was discarded.");
			listeners.forEach(listener => listener(review.id));
		}), queue: jest.fn(async (command: QueuedCommand, draft: { id: string; revision: number }) => store.enqueue(command, Date.now(), draft)),
	};
	const parent = document.createElement("div"); document.body.append(parent); const finished = jest.fn();
	const create = () => new CommentComposer(parent, session as unknown as DiscussionSession, scope, draft.id,
		body => ({ type: "thread.create", payload: { type: "thread.create", thread_id: id(8), message_id: id(9), body: protocolJson(body), anchor: { version: 1, type: "note" } } }), "Draft", "", finished);
	const composer = create(); await composer.flush();
	const button = (text: string, editor = composer) => Array.from(editor.el.querySelectorAll("button")).find(button => (button.getAttribute("aria-label") ?? button.textContent) === text)!;
	return { store, session, draft, composer, create, finished, button, listeners, close: () => { composer.dispose(); parent.remove(); store.close(); } };
}

test.each([false, true])("ordinary draft discard requires confirmation, allows cancel and supports a fresh draft afterward (rich %s)", async rich => {
	const f = await fixture(rich);
	try {
		f.button("Discard draft").click(); await until(() => !!f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child"));
		expect(f.composer.el.querySelector(".relay-comment-confirm-actions")!.textContent).toBe("Keep editingDiscard draft");
		expect(f.button("Send").disabled).toBe(true); expect(f.composer.textarea.readOnly).toBe(true); expect(f.session.discardDraft).not.toHaveBeenCalled();
		f.button("Keep editing").click(); expect(f.button("Send").disabled).toBe(false); expect(await f.store.getDraft(f.draft.id)).toBeDefined();
		f.button("Discard draft").click(); await until(() => !!f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child")); f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child")!.click();
		await until(() => f.finished.mock.calls.length === 1);
		expect(await f.store.getDraft(f.draft.id)).toBeUndefined(); expect(f.composer.textarea.value).toBe(""); expect(f.session.queue).not.toHaveBeenCalled();
		expect(f.button("Discard draft").hidden).toBe(true);
		if (!rich) {
			f.composer.textarea.value = "Fresh draft"; f.composer.textarea.dispatchEvent(new Event("input")); await f.composer.flush();
			expect(await f.store.getDraft(f.draft.id)).toMatchObject({ revision: 0, body: { text: "Fresh draft" } });
		}
	} finally { f.close(); }
});

test("another editor becomes read-only, retains text for copying and cannot resurrect a discarded draft", async () => {
	const f = await fixture(), other = f.create(); await other.flush();
	try {
		f.button("Discard draft").click(); await until(() => !!f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child")); f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child")!.click();
		await until(() => f.finished.mock.calls.length === 1);
		expect(other.textarea.readOnly).toBe(true); expect(other.textarea.value).toBe("Saved plain text");
		expect(other.el.querySelector("select")!.disabled).toBe(true);
		expect(other.el.textContent).toContain("discarded in another view");
		await other.submit(); expect(f.session.queue).not.toHaveBeenCalled(); expect(await f.store.getDraft(f.draft.id)).toBeUndefined();
	} finally { other.dispose(); f.close(); expect(f.listeners.size).toBe(0); }
});

test.each(["discard", "send"])("a completed target draft stays paused during navigation after %s", async action => {
	const f = await fixture(false, { version: 1, type: "note" });
	try {
		if (action === "discard") { f.button("Discard draft").click(); await until(() => !!f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child")); f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child")!.click(); }
		else await f.composer.submit();
		await until(() => f.finished.mock.calls.length === 1);
		expect(f.composer.textarea.readOnly).toBe(true); expect(await f.composer.flush()).toBe(true);
		f.composer.textarea.value = "Do not reuse the retired selection"; f.composer.textarea.dispatchEvent(new Event("input"));
		await f.composer.flush(); await f.composer.submit();
		expect(await f.store.getDraft(f.draft.id)).toBeUndefined(); expect(f.session.queue).toHaveBeenCalledTimes(action === "send" ? 1 : 0);
	} finally { f.close(); }
});

test("a newer draft or changed target invalidates review before removing anything", async () => {
	const f = await fixture();
	try {
		f.button("Discard draft").click(); await until(() => !!f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child"));
		await f.store.saveDraft({ ...f.draft, revision: 1, body: { text: "Newer text", mentions: [] } }, 0);
		f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child")!.click(); await until(() => f.composer.el.textContent!.includes("nothing was discarded"));
		expect((await f.store.getDraft(f.draft.id))?.body).toMatchObject({ text: "Newer text" }); expect(f.finished).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test.each(["online", "recovery"])("an %s draft cannot bypass delivery/dependent review through ordinary discard", async kind => {
	const f = await fixture();
	try {
		await f.store.setPreference(kind + ":" + f.draft.id, "pending");
		await expect(f.session.discardDraft(f.draft, () => true)).rejects.toThrow("Review");
		expect(await f.store.getDraft(f.draft.id)).toBeDefined();
		const reopened = f.create(); await reopened.flush();
		try { expect(f.button("Discard draft", reopened).hidden).toBe(true); } finally { reopened.dispose(); }
	} finally { f.close(); }
});

test("discard releases only the removed draft's picture ownership and rejects changed full snapshots", async () => {
	const f = await fixture();
	try {
		const source = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
		const rich = { version: 1 as const, blocks: [{ type: "picture" as const, picture_id: source.id }] };
		const saved = { ...f.draft, revision: 1, body: protocolJson(editableCommentDraft(rich, () => "Member")) };
		await f.store.saveDraft(saved, 0, [source]); await f.store.captureLocalWork(id(30));
		expect(await f.store.removeDraft(saved.id, saved.revision, { ...saved, scopeId: id(99) })).toBe(false);
		await f.session.discardDraft(saved, () => true); expect(await f.store.pictureSource(source.id, scope)).toBeDefined();
		await f.store.releaseLocalWork(id(30)); expect(await f.store.pictureSource(source.id, scope)).toBeUndefined();
	} finally { f.close(); }
});

test("formatting a plain draft can be discarded without a false other-view conflict", async () => {
 const f = await fixture();
 try {
  f.button("Format comment").click();
  await f.composer.flush();
  f.button("Discard draft").click();
  await until(() => !!f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child"));
  expect(f.composer.el.textContent).not.toContain("changed in another view");
  f.composer.el.querySelector<HTMLButtonElement>(".relay-comment-confirm-actions button:last-child")!.click();
  await until(() => f.finished.mock.calls.length === 1);
  expect(await f.store.getDraft(f.draft.id)).toBeUndefined();
 } finally { f.close(); }
});
