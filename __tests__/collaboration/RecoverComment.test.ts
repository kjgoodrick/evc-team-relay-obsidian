/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import type { App } from "obsidian";
import { DiscussionStore, type QueuedCommand, type OutboxOperation, type Json, type ReviewedAbandonment } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { RecoverCommentModal } from "../../src/collaboration/ui/RecoverComment";
import { PendingComments } from "../../src/collaboration/ui/PendingComments";
import { commentTargetDescription } from "../../src/collaboration/ui/ReattachComment";
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
jest.mock("obsidian", () => ({ setIcon: (el: HTMLElement, icon: string) => { el.textContent = ""; el.setAttribute("data-icon", icon); }, Modal: class {
	contentEl = document.createElement("div"); setTitle() {}
	close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
Object.assign(globalThis, { IDBKeyRange, TextEncoder, TextDecoder, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); },
	setText(this: HTMLElement, text: string) { this.textContent = text; }, appendText(this: HTMLElement, text: string) { this.append(document.createTextNode(text)); } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "recovery-ui" }, scope = id(3);
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
	throw new Error("Recovery view did not settle");
}
async function fixture(type: "thread.create" | "reply.create" | "message.edit" = "thread.create", target: Json = { version: 1, type: "note" }) {
	const store = await DiscussionStore.open(identity, new IDBFactory()), listeners = new Set<() => void>();
	let readable = true;
	const body = bodyFromText("My saved change"), draft = editableCommentDraft(body, () => "Alice");
	if (type === "message.edit") draft.editBaseRevision = 1;
	const original = await store.enqueue({ operationId: id(4), scopeId: scope, type, dependsOn: [], payload: { type,
		thread_id: id(5), message_id: id(6), body: protocolJson(body), ...(type === "thread.create" ? { anchor: target } : {}),
		...(type === "message.edit" ? { expected_revision: 1 } : {}) } }, 1);
	const session = { store, identity, status: "ready", online: true, canQueue: true, canRecoverSavedCommand: true,
		permission: () => ({ read: readable, comment: readable }), participants: () => [], displayName: () => "Alice",
		trackLocal: <T>(promise: Promise<T>) => promise,
		onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		recoverSavedCommand: jest.fn(async () => ({ status: "editable", draft: await store.restoreCommandForReview(original, protocolJson(draft)),
			operation: { ...original, state: "review", reviewDraftId: "recovery:" + original.operationId } })),
		queue: jest.fn(async (command: QueuedCommand, saved?: { id: string; revision: number }) => { await store.enqueue(command, Date.now(), saved); }),
		reviewAbandonment: jest.fn((id: string) => store.reviewAbandonment(id)),
		abandonReviewedWork: jest.fn((review: ReviewedAbandonment, current: () => boolean) => store.abandonReviewedWork(review, current)),
		linkedThread: jest.fn().mockResolvedValue({ thread: { removed: false }, message: { id: id(6), author_id: id(1), deleted: false, revision: 2, body: bodyFromText("Current server comment") } }),
	};
	const hooks = { current: () => true, choose: jest.fn(), reveal: jest.fn(), label: commentTargetDescription };
	const modal = new RecoverCommentModal({} as App, session as unknown as DiscussionSession, original, hooks); document.body.append(modal.contentEl);
	const button = (label: string) => [...modal.contentEl.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent) === label)!;
	return { store, original, session, modal, hooks, button, listeners,
		revoke: () => { readable = false; listeners.forEach(listener => listener()); },
		close: () => { modal.onClose(); modal.contentEl.remove(); store.close(); } };
}

test.each(["thread.create", "reply.create"] as const)("reviewed %s sends explicitly with original identities, then closes", async type => {
	const f = await fixture(type);
	try {
		await f.modal.onOpen(); await until(() => !!f.button("Send") && !f.button("Send").disabled);
		expect(f.session.queue).not.toHaveBeenCalled();
		expect(f.modal.contentEl.textContent).toContain("My saved change");
		f.button("Send").click(); await until(() => f.modal.contentEl.textContent === "");
		expect(f.session.queue).toHaveBeenCalledWith(expect.objectContaining({ type, payload: expect.objectContaining({ thread_id: id(5), message_id: id(6) }) }), expect.any(Object));
		expect((await f.store.getOperation(id(4)))?.state).toBe("withdrawn");
	} finally { f.close(); }
});

test("discard review lists the dependent work, pauses editing and requires explicit confirmation", async () => {
	const f = await fixture();
	try {
		await f.store.enqueue({ operationId: id(7), scopeId: scope, type: "reply.create", dependsOn: [id(4)], payload: { type: "reply.create", thread_id: id(5), message_id: id(8), body: protocolJson(bodyFromText("Dependent reply")) } });
		await f.modal.onOpen(); await until(() => !!f.button("Send") && !f.button("Send").disabled);
		f.button("Review discard").click(); await until(() => !!f.button("Discard reviewed local work"));
		expect(f.modal.contentEl.textContent).toContain("Dependent reply"); expect(f.button("Discard reviewed local work").disabled).toBe(true);
		expect(f.button("Send").disabled).toBe(true); expect(f.modal.contentEl.querySelector('[contenteditable="true"]')).toBeNull();
		expect(f.session.abandonReviewedWork).not.toHaveBeenCalled();
		const checkbox = f.modal.contentEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		checkbox.checked = true; checkbox.dispatchEvent(new Event("change")); f.button("Discard reviewed local work").click();
		await until(() => f.modal.contentEl.textContent === "");
		expect((await f.store.getOperation(id(7)))?.state).toBe("withdrawn"); expect(await f.store.getDraft("recovery:" + id(4))).toBeUndefined();
		expect(f.session.queue).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("cancel and stale discard preserve local content and require a fresh review", async () => {
	const f = await fixture();
	try {
		await f.modal.onOpen(); await until(() => !!f.button("Send") && !f.button("Send").disabled);
		f.button("Review discard").click(); await until(() => !!f.button("Discard reviewed local work"));
		f.button("Cancel discard review").click(); expect(f.button("Send").disabled).toBe(false); expect(f.session.abandonReviewedWork).not.toHaveBeenCalled();
		f.button("Review discard").click(); await until(() => !!f.button("Discard reviewed local work"));
		const draft = (await f.store.getDraft("recovery:" + id(4)))!;
		await f.store.saveDraft({ ...draft, revision: draft.revision + 1, body: protocolJson(editableCommentDraft(bodyFromText("Newer correction"), () => "Alice")) }, draft.revision);
		const checkbox = f.modal.contentEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		checkbox.checked = true; checkbox.dispatchEvent(new Event("change")); f.button("Discard reviewed local work").click();
		await until(() => f.modal.contentEl.textContent!.includes("Nothing was discarded"));
		expect(f.button("Discard reviewed local work")).toBeUndefined(); expect((await f.store.getDraft(draft.id))?.body).toMatchObject({ text: "Newer correction" });
	} finally { f.close(); }
});

test("stale edit shows current body and requires acknowledging its revision before sending", async () => {
	const f = await fixture("message.edit");
	try {
		await f.modal.onOpen(); await until(() => !!f.button("Use this revision for my edit"));
		expect(f.modal.contentEl.textContent).toContain("Current server comment");
		expect(f.modal.contentEl.textContent).toContain("My saved change");
		expect(f.button("Send").disabled).toBe(true);
		f.button("Use this revision for my edit").click(); await until(() => !f.button("Send").disabled);
		f.button("Send").click(); await until(() => f.modal.contentEl.textContent === "");
		expect(f.session.queue).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ expected_revision: 2, body: bodyFromText("My saved change") }) }), expect.any(Object));
	} finally { f.close(); }
});

test("offline edit remains locally editable but cannot send before current revision review", async () => {
	const f = await fixture("message.edit");
	try {
		f.session.online = false; await f.modal.onOpen();
		await until(() => !!f.modal.contentEl.querySelector('[contenteditable="true"]'));
		expect(f.button("Send").disabled).toBe(true); expect(f.session.linkedThread).not.toHaveBeenCalled();
		f.revoke(); expect(f.modal.contentEl.textContent).toBe("");
		expect((await f.store.getDraft("recovery:" + id(4)))?.body).toMatchObject({ text: "My saved change" });
		expect(f.listeners.size).toBe(0);
	} finally { f.close(); }
});

test("checking a newer revision pauses typing until the existing draft can be safely reloaded", async () => {
	const f = await fixture("message.edit");
	try {
		f.session.online = false; await f.modal.onOpen();
		await until(() => !!f.modal.contentEl.querySelector('[contenteditable="true"]'));
		let finish!: (value: unknown) => void;
		f.session.linkedThread.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.session.online = true; f.listeners.forEach(listener => listener()); f.button("Review current comment").click();
		await until(() => !!finish);
		expect(f.modal.contentEl.querySelector('[contenteditable="true"]')).toBeNull();
		finish({ thread: { removed: false }, message: { author_id: id(1), revision: 2, body: bodyFromText("Current server comment") } });
		await until(() => !!f.modal.contentEl.querySelector('[contenteditable="true"]'));
		expect(f.modal.contentEl.textContent).toContain("My saved change"); expect(f.button("Send").disabled).toBe(true);
	} finally { f.close(); }
});

test("choosing a replacement target flushes the durable draft without enqueueing", async () => {
	const f = await fixture();
	try {
		await f.modal.onOpen(); await until(() => !!f.button("Send") && !f.button("Send").disabled);
		f.button("Choose replacement target").click(); await until(() => f.hooks.choose.mock.calls.length === 1);
		expect(f.hooks.choose).toHaveBeenCalledWith(expect.objectContaining({ operationId: id(4) }), expect.objectContaining({ id: "recovery:" + id(4), body: expect.objectContaining({ text: "My saved change" }) }));
		expect(f.session.queue).not.toHaveBeenCalled(); expect((await f.store.getOperation(id(4)))?.state).toBe("review");
	} finally { f.close(); }
});

test("whole-note recovery saves a reviewed target without changing or sending the body", async () => {
	const f = await fixture("thread.create", { version: 1, type: "text", document_id: scope, generation: id(30), start: "AA==", end: "AA==", dependency: "AAA=", selected_length: 4,
		context: { quote: "beta", prefix: "", suffix: "", truncated: false } });
	try {
		await f.modal.onOpen(); await until(() => !!f.button("Send") && !f.button("Send").disabled);
		f.button("Use entire note").click(); await until(() => f.modal.contentEl.textContent!.includes("Draft target updated"));
		expect(await f.store.getDraft("recovery:" + id(4))).toMatchObject({ revision: 1, target: { version: 1, type: "note" }, body: { text: "My saved change" } });
		expect(f.session.queue).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("pending review cards resume offline and never expose the old picture-retry action", async () => {
	const f = await fixture(), parent = document.createElement("div"), review = jest.fn();
	const view = new PendingComments(parent, f.session as unknown as DiscussionSession, scope, review);
	try {
		f.session.online = false;
		view.update([{ ...f.original, state: "review", payload: { type: "thread.create", body: { version: 1, blocks: [{ type: "picture", picture_id: id(20), alt: "Saved" }] } } } as OutboxOperation]);
		expect(parent.textContent).toContain("send it explicitly");
		expect(parent.textContent).not.toContain("Refresh picture uploads and retry");
		const button = [...parent.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent) === "Continue editing saved change")!;
		expect(button.disabled).toBe(false); button.click(); expect(review).toHaveBeenCalledTimes(1);
	} finally { view.dispose(); f.close(); }
});
