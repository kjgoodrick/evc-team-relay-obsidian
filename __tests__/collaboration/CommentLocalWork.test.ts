/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import { webcrypto } from "node:crypto";
import type { App } from "obsidian";
import { DiscussionStore, type Draft, type OutboxOperation } from "../../src/collaboration/storage/DiscussionStore";
import type { CommandStatus } from "../../src/collaboration/DiscussionTransport";
import type { RestoreBinding } from "../../src/collaboration/RestoreGeneration";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { CommentLocalWorkModal } from "../../src/collaboration/ui/CommentLocalWork";
import { CommentComposer } from "../../src/collaboration/ui/CommentComposer";
import type { RichCommentEditor } from "../../src/collaboration/ui/RichCommentEditor";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { copyToClipboard } from "../../src/utils/clipboard";
jest.mock("../../src/utils/clipboard", () => ({ copyToClipboard: jest.fn().mockResolvedValue(undefined) }));
jest.mock("obsidian", () => ({ setIcon: (el: HTMLElement, icon: string) => { el.textContent = ""; el.setAttribute("data-icon", icon); }, Modal: class {
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
		canCheckSavedCommand: false, restoreBinding: {} as RestoreBinding,
		checkSavedCommand: jest.fn(async (_operation: OutboxOperation, _visible: () => boolean): Promise<CommandStatus> => ({ status: "unknown" })),
		canCopyRestoredCommand: false,
		copyRestoredCommand: jest.fn(async (operation: OutboxOperation, visible: () => boolean) => store.copyRestoredCommandDraft(operation,
			protocolJson(editableCommentDraft(bodyFromText("Waiting reply"), () => "Member")), id(90), visible)),
		permission: () => undefined, participants: jest.fn(() => []), displayName: jest.fn(() => "Member"), queue: jest.fn(),
		trackLocal: <T>(promise: Promise<T>) => promise,
		onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		discardDraft: jest.fn(async (review: Draft, valid: () => boolean) => { if (!await store.removeDraft(review.id, review.revision, review, valid)) throw new Error("Draft changed"); }),
	};
	const modal = new CommentLocalWorkModal({} as App, session as unknown as DiscussionSession, () => current); document.body.append(modal.contentEl);
	const button = (text: string) => Array.from(modal.contentEl.querySelectorAll("button")).find(item => (item.getAttribute("aria-label") ?? item.textContent) === text)!;
	return { store, session, modal, button, listeners, notify: () => listeners.forEach(listener => listener()), invalidate: () => { current = false; modal.validate(); }, close: () => { modal.onClose(); modal.contentEl.remove(); store.close(); } };
}

async function receiptFixture() {
	const f = await fixture();
	await f.store.enqueue({ operationId: id(40), scopeId: scope, type: "reply.create", dependsOn: [], payload: { type: "reply.create", thread_id: id(41), message_id: id(42), body: protocolJson(bodyFromText("Waiting reply")) } });
	await f.store.observeRestoreContext({ supported: true, generation: id(90) }, 0, () => true); f.session.restoreBinding = { restoreGeneration: id(90) };
	await f.modal.onOpen(); f.button("Waiting changes").click(); await until(() => !!f.button("Check server receipt"));
	return { ...f, saved: (await f.store.getOperation(id(40)))! };
}

test.each(["accepted", "withdrawn", "unknown"] as const)("saved-work receipt result %s preserves the original request and never queues recovery", async status => {
	const f = await receiptFixture();
	try {
		expect(f.saved).toMatchObject({ error: "restore_generation_changed" }); expect(f.button("Check server receipt").disabled).toBe(true);
		f.session.canCheckSavedCommand = true; f.notify(); expect(f.button("Check server receipt").disabled).toBe(false);
		const result: CommandStatus = status === "accepted" ? { status, result: { operation_id: id(40), scope_id: scope, thread_id: id(41), sequence: 1, state: "open", state_revision: 1, removed: false, changed: true, message_id: id(42), message_revision: 1 } } : { status };
		f.session.checkSavedCommand.mockResolvedValueOnce(result); f.button("Check server receipt").click();
		await until(() => f.modal.contentEl.textContent!.includes("Checked "));
		expect(f.session.checkSavedCommand).toHaveBeenCalledWith(f.saved, expect.any(Function));
		expect(f.modal.contentEl.textContent).toContain(status === "accepted" ? "recorded this request as accepted" : status === "withdrawn" ? "recorded this request as cancelled" : "does not prove the change was never accepted");
		expect(await f.store.getOperation(id(40))).toEqual(f.saved); expect(f.session.queue).not.toHaveBeenCalled();
		expect(f.session.participants).not.toHaveBeenCalled(); expect(f.session.displayName).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test.each(["page", "account", "offline", "restore"])("a pending saved-work receipt is ignored after %s changes", async change => {
	const f = await receiptFixture();
	try {
		f.session.canCheckSavedCommand = true; f.notify(); let finish!: (result: CommandStatus) => void;
		f.session.checkSavedCommand.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const button = f.button("Check server receipt"); button.click(); button.click(); expect(f.session.checkSavedCommand).toHaveBeenCalledTimes(1);
		const current = f.session.checkSavedCommand.mock.calls[0][1]; expect(current()).toBe(true);
		if (change === "page") f.button("Drafts").click();
		if (change === "account") f.invalidate();
		if (change === "offline") { f.session.canCheckSavedCommand = false; f.notify(); }
		if (change === "restore") { f.session.restoreBinding = { restoreGeneration: id(91) }; f.notify(); }
		expect(current()).toBe(false); finish({ status: "unknown" });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(f.modal.contentEl.textContent).not.toContain("No matching receipt was found"); expect(await f.store.getOperation(id(40))).toEqual(f.saved);
	} finally { f.close(); }
});

test("failed receipt inspection can retry and cannot resurrect a result after close", async () => {
	const f = await receiptFixture();
	try {
		f.session.canCheckSavedCommand = true; f.notify(); f.session.checkSavedCommand.mockRejectedValueOnce(new Error("Disconnected"));
		f.button("Check server receipt").click(); await until(() => f.modal.contentEl.textContent!.includes("receipt could not be checked"));
		expect(f.button("Check server receipt").disabled).toBe(false);
		let finish!: (result: CommandStatus) => void;
		f.session.checkSavedCommand.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.button("Check server receipt").click(); f.modal.onClose(); finish({ status: "withdrawn" });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(f.modal.contentEl.textContent).toBe(""); expect(f.listeners.size).toBe(0); expect(await f.store.getOperation(id(40))).toEqual(f.saved);
	} finally { f.close(); }
});

test("picture uploads and unprepared group requests explain why a comment receipt is unavailable", async () => {
	const f = await receiptFixture();
	try {
		jest.spyOn(f.store, "waitingWorkPage").mockResolvedValueOnce({ items: [{ ...f.saved, type: "picture.upload" }, { ...f.saved, operationId: id(43), type: "base.group.create" } ] });
		f.button("Refresh saved work").click(); await until(() => f.modal.contentEl.textContent!.includes("no saved final target"));
		expect(f.button("Check server receipt")).toBeUndefined(); expect(f.modal.contentEl.textContent).toContain("Picture uploads have separate receipts");
		expect(f.session.checkSavedCommand).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("reopened saved-work browsing cannot adopt a receipt from the previous lifetime", async () => {
	const f = await receiptFixture();
	try {
		f.session.canCheckSavedCommand = true; f.notify(); let finish!: (result: CommandStatus) => void;
		f.session.checkSavedCommand.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.button("Check server receipt").click(); f.modal.onClose(); await f.modal.onOpen();
		expect(f.button("Check server receipt")).toBeDefined(); finish({ status: "withdrawn" });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(f.modal.contentEl.textContent).not.toContain("recorded this request as cancelled");
		f.button("Check server receipt").click(); await until(() => f.modal.contentEl.textContent!.includes("No matching receipt"));
		expect(await f.store.getOperation(id(40))).toEqual(f.saved);
	} finally { f.close(); }
});

test("an offline restored request opens one editable local copy while the original remains held", async () => {
	const f = await receiptFixture();
	try {
		f.session.canCopyRestoredCommand = true; f.notify(); expect(f.button("Check server receipt").disabled).toBe(true);
		f.button("Make local draft copy").click();
		await until(() => !!f.modal.contentEl.querySelector("textarea") && !f.modal.contentEl.querySelector("textarea")!.disabled);
		expect(f.modal.contentEl.textContent).toContain("local copy of a request"); expect(f.modal.contentEl.querySelector("textarea")!.value).toBe("Waiting reply");
		expect(f.button("Send").hidden).toBe(true); expect(f.session.checkSavedCommand).not.toHaveBeenCalled(); expect(f.session.queue).not.toHaveBeenCalled();
		const editor = (f.modal as unknown as { composer: { rich: RichCommentEditor } }).composer.rich.view;
		editor.dispatch(editor.state.tr.insertText("Edit the separate copy", 1, editor.state.doc.content.size - 1));
		f.button("Back to saved work").click(); await until(() => !!f.button("Make local draft copy"));
		f.button("Make local draft copy").click(); await until(() => !!f.modal.contentEl.querySelector("textarea") && !f.modal.contentEl.querySelector("textarea")!.disabled);
		expect(f.modal.contentEl.querySelector("textarea")!.value).toBe("Edit the separate copy"); expect(await f.store.getOperation(id(40))).toEqual(f.saved);
		expect((await f.store.localDraftPage()).items).toHaveLength(1);
	} finally { f.close(); }
});

test("a copied request discarded from saved drafts is not recreated by the original request's button", async () => {
	const f = await receiptFixture();
	try {
		f.session.canCopyRestoredCommand = true; f.notify();
		const copied = await f.session.copyRestoredCommand(f.saved, () => true); await f.store.removeDraft(copied.draft!.id, 0);
		f.button("Make local draft copy").click(); await until(() => f.modal.contentEl.textContent!.includes("already removed"));
		expect((await f.store.localDraftPage()).items).toEqual([]); expect(await f.store.getOperation(id(40))).toEqual(f.saved);
	} finally { f.close(); }
});

test.each(["account", "page", "restore"])("a local-copy completion cannot reopen the editor after %s changes", async change => {
	const f = await receiptFixture();
	try {
		f.session.canCopyRestoredCommand = true; f.notify(); let finish!: (result: { draft?: Draft; created: boolean }) => void;
		f.session.copyRestoredCommand.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.button("Make local draft copy").click(); f.button("Make local draft copy").click(); expect(f.session.copyRestoredCommand).toHaveBeenCalledTimes(1);
		const valid = f.session.copyRestoredCommand.mock.calls[0][1];
		if (change === "account") f.invalidate();
		if (change === "page") f.button("Drafts").click();
		if (change === "restore") { f.session.restoreBinding = { restoreGeneration: id(91) }; f.notify(); }
		expect(valid()).toBe(false); finish({ draft: { ...draft(), body: { text: "Stale completion", mentions: [] } }, created: true });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(f.modal.contentEl.querySelector("textarea")).toBeNull(); expect(await f.store.getOperation(id(40))).toEqual(f.saved);
	} finally { f.close(); }
});

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
