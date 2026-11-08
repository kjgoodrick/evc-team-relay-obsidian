/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import { webcrypto } from "node:crypto";
import type { App } from "obsidian";
import { DiscussionStore, type Draft } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { CommentLocalWorkModal } from "../../src/collaboration/ui/CommentLocalWork";
import { CommentComposer } from "../../src/collaboration/ui/CommentComposer";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { copyToClipboard } from "../../src/utils/clipboard";
jest.mock("../../src/utils/clipboard", () => ({ copyToClipboard: jest.fn().mockResolvedValue(undefined) }));
jest.mock("obsidian", () => ({ Modal: class {
	contentEl = document.createElement("div"); setTitle() {}
	close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
Object.assign(globalThis, { IDBKeyRange, TextEncoder, TextDecoder, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = id(3), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "local-work-ui" };
const draft = (n = 10): Draft => ({ id: "selection:" + scope + ":" + id(n), scopeId: scope, revision: 0, body: { text: "Saved text " + n, mentions: [] }, target: { version: 1, type: "note" } });
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
	throw new Error("Saved work did not settle");
}
async function fixture() {
	const store = await DiscussionStore.open(identity, new IDBFactory()), listeners = new Set<() => void>(); let current = true;
	const session = { store, identity, status: "unavailable", online: false, canQueue: false, canAttachPictures: false,
		permission: () => undefined, participants: jest.fn(() => []), displayName: jest.fn(() => "Member"), queue: jest.fn(),
		trackLocal: <T>(promise: Promise<T>) => promise,
		onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		discardDraft: jest.fn(async (review: Draft, valid: () => boolean) => { if (!await store.removeDraft(review.id, review.revision, review, valid)) throw new Error("Draft changed"); }),
	};
	const modal = new CommentLocalWorkModal({} as App, session as unknown as DiscussionSession, () => current); document.body.append(modal.contentEl);
	const button = (text: string) => Array.from(modal.contentEl.querySelectorAll("button")).find(item => item.textContent === text)!;
	return { store, session, modal, button, listeners, invalidate: () => { current = false; modal.validate(); }, close: () => { modal.onClose(); modal.contentEl.remove(); store.close(); } };
}

test("drafts remain editable with an inaccessible target, preserving the target and hiding send actions", async () => {
	const f = await fixture();
	try {
		await f.store.saveDraft(draft()); await f.modal.onOpen(); f.button("Open saved draft").click();
		await until(() => !!f.modal.contentEl.querySelector("textarea") && !f.modal.contentEl.querySelector("textarea")!.disabled);
		const input = f.modal.contentEl.querySelector("textarea")!; expect(input.readOnly).toBe(false);
		expect(f.button("Send").hidden).toBe(true); expect(f.button("Add pictures").hidden).toBe(true); expect(f.button("Refresh picture uploads").hidden).toBe(true);
		input.value = "Changed offline"; input.dispatchEvent(new Event("input")); f.button("Back to saved work").click();
		await until(() => !!f.button("Open saved draft")); expect(await f.store.getDraft(draft().id)).toMatchObject({ revision: 1, body: { text: "Changed offline" }, target: draft().target });
		expect(f.session.queue).not.toHaveBeenCalled(); expect(f.session.participants).not.toHaveBeenCalled();
		f.button("Copy text").click(); await until(() => f.modal.contentEl.textContent!.includes("Text copied")); expect(copyToClipboard).toHaveBeenCalledWith("Changed offline");
	} finally { f.close(); }
});

test("imported copies are labeled and remain locally editable without a send or automatic target conversion", async () => {
	const f = await fixture();
	try {
		const copied = { ...draft(), id: "imported:" + id(99) };
		await f.store.importLocalDraft({ version: 1, manifestSha256: "a".repeat(64), snapshotId: id(98), draftId: draft().id, scopeId: scope, identity }, copied, [], () => true);
		await f.modal.onOpen(); expect(f.modal.contentEl.textContent).toContain("Imported local draft");
		f.button("Open saved draft").click(); await until(() => !!f.modal.contentEl.querySelector("textarea") && !f.modal.contentEl.querySelector("textarea")!.disabled);
		expect(f.modal.contentEl.textContent).toContain("Use saved work at this target"); expect(f.button("Send").hidden).toBe(true);
		const input = f.modal.contentEl.querySelector("textarea")!; input.value = "Edited recovered content"; input.dispatchEvent(new Event("input"));
		f.button("Back to saved work").click(); await until(() => !!f.button("Open saved draft"));
		expect(await f.store.getDraft(copied.id)).toMatchObject({ revision: 1, target: draft().target, body: { text: "Edited recovered content" } });
		expect(await f.store.selectionDrafts(scope)).toEqual({ drafts: [], hasMore: false }); expect(f.session.queue).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("local drafts can be discarded with review while uncertain sends remain locked", async () => {
	const f = await fixture();
	try {
		await f.store.saveDraft(draft()); await f.modal.onOpen(); f.button("Open saved draft").click();
		await until(() => !f.button("Discard draft").hidden); f.button("Discard draft").click(); await until(() => !!f.button("Discard saved draft"));
		f.button("Discard saved draft").click(); await until(() => f.modal.contentEl.textContent!.includes("No saved items")); expect(await f.store.getDraft(draft().id)).toBeUndefined();
		await f.store.saveDraft(draft()); await f.store.setPreference("online:" + draft().id, "pending");
		f.button("Refresh saved work").click(); await until(() => !!f.button("Inspect saved draft")); f.button("Inspect saved draft").click();
		await until(() => !!f.modal.contentEl.querySelector("textarea") && !f.modal.contentEl.querySelector("textarea")!.disabled);
		expect(f.modal.contentEl.querySelector("textarea")!.readOnly).toBe(true); expect(f.button("Check delivery and edit").hidden).toBe(true); expect(f.button("Discard draft").hidden).toBe(true);
	} finally { f.close(); }
});

test("paging bounds rendered drafts and waiting changes are inspectable without replay", async () => {
	const f = await fixture();
	try {
		for (let n = 10; n < 22; n++) await f.store.saveDraft(draft(n));
		await f.store.enqueue({ operationId: id(40), scopeId: scope, type: "reply.create", dependsOn: [], payload: { type: "reply.create", thread_id: id(41), message_id: id(42), body: protocolJson(bodyFromText("Waiting reply")) } });
		await f.modal.onOpen(); expect(f.modal.contentEl.querySelectorAll("section")).toHaveLength(10);
		f.button("Next page").click(); await until(() => f.modal.contentEl.textContent!.includes("page 2")); expect(f.modal.contentEl.querySelectorAll("section")).toHaveLength(2);
		f.button("Waiting changes").click(); await until(() => f.modal.contentEl.textContent!.includes("Waiting reply")); expect(f.modal.contentEl.querySelectorAll("section")).toHaveLength(1);
		expect(f.modal.contentEl.textContent).toContain("read-only"); expect(f.session.queue).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("a vanished draft is not recreated", async () => {
	const f = await fixture();
	try {
		await f.store.saveDraft(draft()); await f.modal.onOpen(); await f.store.removeDraft(draft().id, 0);
		f.button("Open saved draft").click(); await until(() => f.modal.contentEl.textContent!.includes("Could not restore"));
		expect(f.modal.contentEl.querySelector("textarea")!.readOnly).toBe(true); expect(await f.store.getDraft(draft().id)).toBeUndefined();
	} finally { f.close(); }
});

test.each([false, true])("local composer blocks direct send and honors context loss (rich %s)", async rich => {
	const f = await fixture(); let current = true;
	const saved = rich ? { ...draft(), body: protocolJson(editableCommentDraft(bodyFromText("Rich draft"), () => "Member")) } : draft();
	await f.store.saveDraft(saved);
	const command = jest.fn(), online = jest.fn();
	const composer = new CommentComposer(f.modal.contentEl, f.session as unknown as DiscussionSession, scope, saved.id, command, "Saved", "", () => {}, { current: () => current });
	try {
		await composer.flush(); await composer.submit(); await composer.submit(online);
		expect(command).not.toHaveBeenCalled(); expect(online).not.toHaveBeenCalled(); expect(f.session.displayName).not.toHaveBeenCalled();
		current = false; composer.update(); expect(composer.textarea.readOnly).toBe(true);
		composer.textarea.value = "Do not save"; composer.textarea.dispatchEvent(new Event("input")); await composer.flush();
		expect(await f.store.getDraft(saved.id)).toEqual(saved);
	} finally { composer.dispose(); f.close(); }
});


test("account loss clears a pending page and prevents its late completion from restoring text", async () => {
	const f = await fixture();
	try {
		await f.store.saveDraft(draft()); const page = await f.store.localDraftPage();
		let finish!: (value: typeof page) => void;
		jest.spyOn(f.store, "localDraftPage").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const opening = f.modal.onOpen(); f.invalidate(); finish(page); await opening;
		expect(f.modal.contentEl.textContent).toBe(""); expect(f.listeners.size).toBe(0);
	} finally { f.close(); }
});

test.each([false, true])("local editor pictures use the strict original-only loader (rich %s)", async rich => {
	const f = await fixture(), picture = { type: "picture" as const, picture_id: id(70), alt: "Saved picture" };
	const body = rich ? protocolJson(editableCommentDraft({ version: 1, blocks: [picture] }, () => "Member")) : { text: "Picture draft", mentions: [], pictures: [picture] };
	const load = jest.fn().mockRejectedValue(new Error("No retained original")); Object.assign(f.session, { pictures: { load } });
	const composerParent = document.createElement("div"); document.body.append(composerParent);
	await f.store.saveDraft({ ...draft(), body });
	const composer = new CommentComposer(composerParent, f.session as unknown as DiscussionSession, scope, draft().id,
		() => { throw new Error("Unexpected send"); }, "Saved", "", () => {}, { current: () => true });
	try {
		await composer.flush(); await until(() => load.mock.calls.length > 0);
		expect(load).toHaveBeenCalledWith(scope, picture.picture_id, "thumbnail", "only");
		await until(() => composer.el.textContent!.includes("Original picture not available"));
	} finally { composer.dispose(); composerParent.remove(); f.close(); }
});
