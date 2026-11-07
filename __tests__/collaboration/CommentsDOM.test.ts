/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import type { WorkspaceLeaf } from "obsidian";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import { CommentComposer } from "../../src/collaboration/ui/CommentComposer";
import { CommentsView } from "../../src/collaboration/ui/CommentsView";
import { bodyFromText, type ThreadSummary } from "../../src/collaboration/DiscussionProtocol";
import { renderCommentBody } from "../../src/collaboration/ui/CommentBody";
import { PendingComments } from "../../src/collaboration/ui/PendingComments";
import { DiscussionDrafts } from "../../src/collaboration/ui/DiscussionDrafts";
import { protocolJson } from "../../src/collaboration/DiscussionProtocol";
import type { OnlineOperation } from "../../src/collaboration/DiscussionTransport";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";

jest.mock("obsidian", () => ({
	ItemView: class {
		containerEl = document.createElement("div"); contentEl = document.createElement("div");
		app = { workspace: { on: jest.fn() } };
		constructor() { this.containerEl.append(this.contentEl); document.body.append(this.containerEl); }
		registerEvent() {}
	},
	Modal: class { contentEl = document.createElement("div"); setTitle() {} open() {} close() {} },
}));

Object.assign(globalThis, { IDBKeyRange, TextEncoder, TextDecoder, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); },
	setText(this: HTMLElement, text: string) { this.textContent = text; },
	appendText(this: HTMLElement, text: string) { this.append(document.createTextNode(text)); },
	addClass(this: HTMLElement, name: string) { this.classList.add(name); },
	getClientRects() { return [{ width: 300, height: 600 }]; },
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry = id(3), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "dom" };
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
	throw new Error("DOM condition did not settle");
}
async function fixture() {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	const session = {
		store, identity, status: "ready", canQueue: true, online: true,
		permission: () => ({ read: true, comment: true, edit: false, moderate: false }),
		participants: () => [{ id: id(1), name: "Alice" }], displayName: () => "Alice", syncStatus: () => "current",
		trackLocal: <T>(promise: Promise<T>) => promise,
		queue: jest.fn(async (command: QueuedCommand, draft?: { id: string; revision: number }) => { await store.enqueue(command, Date.now(), draft); }),
		watch: jest.fn(() => jest.fn()), refresh: jest.fn(), local: jest.fn(), messages: jest.fn(),
		retryRejected: jest.fn().mockResolvedValue(true),
		canRepairPictures: true, repairPictures: jest.fn().mockResolvedValue("requeued"),
		canAnchorBase: () => true, documentGeneration: () => id(7),
		baseRegistryRevision: () => 1, baseDefinitionStatus: jest.fn().mockResolvedValue("Matches the latest verified definition."),
	};
	return { store, session, typed: session as unknown as DiscussionSession };
}

test("composer preserves explicit mention identities in durable drafts and atomic sends", async () => {
	const { store, session, typed } = await fixture(), parent = document.createElement("div"); document.body.append(parent);
	const composer = new CommentComposer(parent, typed, entry, "new", body => ({ type: "thread.create", payload: {
		type: "thread.create", thread_id: id(4), message_id: id(5), anchor: { version: 1, type: "note" }, body } }));
	try {
		await until(() => !composer.textarea.disabled);
		composer.textarea.value = "Hi "; composer.textarea.dispatchEvent(new Event("input"));
		composer.textarea.setSelectionRange(3, 3);
		const select = parent.querySelector("select")!; select.value = id(1); select.dispatchEvent(new Event("change"));
		await until(() => parent.textContent!.includes("Draft saved"));
		expect((await store.getDraft("new"))?.body).toMatchObject({ text: "Hi @Alice ", mentions: [{ start: 3, end: 9, userId: id(1) }] });
		await composer.submit();
		expect(session.queue).toHaveBeenCalledTimes(1);
		expect(session.queue.mock.calls[0][0].payload).toMatchObject({ body: { blocks: [{ type: "paragraph", children: [
			{ type: "text", text: "Hi " }, { type: "mention", user_id: id(1) }, { type: "text", text: " " },
		] }] } });
		expect(await store.getDraft("new")).toBeUndefined(); expect(composer.textarea.value).toBe("");
	} finally { composer.dispose(); store.close(); parent.remove(); }
});

test("Bases drafts require an explicit target, survive sidebar recreation, and cannot send under another saved view", async () => {
	const { store, session, typed } = await fixture(), parent = document.createElement("div");
	const scope = baseDiscussionScope(entry, id(4)), other = baseDiscussionScope(entry, id(5));
	const target = { type: "base", version: 1, definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1,
		target: { type: "cell", record_id: id(8), record_generation: id(9), property: { source: "note", name: "status" } } };
	const begin = jest.fn().mockResolvedValue(undefined); let drafts = new DiscussionDrafts(parent, typed, scope, () => {}, undefined, begin);
	try {
		await until(() => !!parent.querySelector(".relay-base-view-new"));
		expect(parent.querySelector("textarea")).toBeNull();
		(parent.querySelector(".relay-base-view-new") as HTMLButtonElement).click(); await until(() => begin.mock.calls.length === 1);
		expect(session.queue).not.toHaveBeenCalled();
		const draftId = "selection:" + scope + ":captured";
		await store.saveDraft({ id: draftId, scopeId: scope, revision: 0, body: "Review status", target });
		await store.setPreference("activeNewDraft:" + scope, draftId); drafts.update();
		await until(() => parent.querySelector("textarea")?.value === "Review status");
		expect(parent.textContent).toContain("Cell: status");
		drafts.dispose(); drafts = new DiscussionDrafts(parent, typed, scope, () => {}, undefined, begin);
		await until(() => parent.querySelector("textarea")?.value === "Review status");
		parent.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await until(() => session.queue.mock.calls.length === 1);
		expect(session.queue.mock.calls[0][0]).toMatchObject({ scopeId: scope, payload: { anchor: target } });
		drafts.dispose();
		const wrongId = "selection:" + other + ":wrong";
		await store.saveDraft({ id: wrongId, scopeId: other, revision: 0, body: "Retain for recovery", target });
		await store.setPreference("activeNewDraft:" + other, wrongId);
		drafts = new DiscussionDrafts(parent, typed, other, () => {}, undefined, begin);
		await until(() => parent.textContent!.includes("Could not restore"));
		expect(parent.querySelector("textarea")?.readOnly).toBe(true);
		parent.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(session.queue).toHaveBeenCalledTimes(1); expect(await store.getDraft(wrongId)).toBeDefined();
	} finally { drafts.dispose(); await new Promise(resolve => setTimeout(resolve, 10)); store.close(); }
});

test("concurrent draft changes preserve the editor's text and prevent sending a stale draft", async () => {
	const { store, session, typed } = await fixture(), parent = document.createElement("div");
	await store.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: "Original" });
	const composer = new CommentComposer(parent, typed, entry, "draft", body => ({ type: "reply.create", payload: { type: "reply.create", thread_id: id(4), message_id: id(5), body } }));
	try {
		await until(() => !composer.textarea.disabled);
		await store.saveDraft({ id: "draft", scopeId: entry, revision: 1, body: "Other window" }, 0);
		composer.textarea.value = "My local changes"; composer.textarea.dispatchEvent(new Event("input"));
		await until(() => parent.textContent!.includes("another window")); await composer.submit();
		expect(session.queue).not.toHaveBeenCalled(); expect(composer.textarea.value).toBe("My local changes");
		expect((await store.getDraft("draft"))?.body).toBe("Other window");
	} finally { composer.dispose(); store.close(); }
});

test("safe body renderer treats HTML as text and uses explicit safe links", () => {
	const parent = document.createElement("div");
	renderCommentBody(parent, bodyFromText("<img src=x onerror=alert(1)>"), () => "Alice");
	expect(parent.querySelector("img")).toBeNull(); expect(parent.textContent).toContain("<img");
	renderCommentBody(parent, { version: 1, blocks: [{ type: "paragraph", children: [{ type: "link", url: "https://example.test", children: [{ type: "text", text: "Safe" }] }] }] }, () => "Alice");
	expect(parent.querySelector("a")?.rel).toBe("noopener noreferrer");
});

test("retained local text is selectable without access, keeps selection on refresh, and retries only the original operation", async () => {
	const { store, session, typed } = await fixture(), parent = document.createElement("div"); document.body.append(parent);
	const pending = new PendingComments(parent, typed, entry);
	await store.enqueue({ operationId: id(20), scopeId: entry, type: "reply.create", dependsOn: [], payload: {
		type: "reply.create", thread_id: id(4), message_id: id(5), body: { version: 1, blocks: [{ type: "paragraph", children: [
			{ type: "mention", user_id: id(1) }, { type: "link", url: "https://example.test", children: [{ type: "text", text: "Link" }] },
		] }] } } });
	const claimed = (await store.claimNext("worker"))!; await store.fail(claimed.operationId, claimed.lease!, "comment_forbidden");
	const operation = (await store.getOperation(id(20)))!;
	try {
		session.permission = () => ({ read: false, comment: false, edit: false, moderate: false });
		pending.update([operation]);
		expect(parent.textContent).not.toContain("Not sent");
		const find = (text: string) => [...parent.querySelectorAll("button")].find(button => button.textContent === text)!;
		expect(find("Retry original request").disabled).toBe(true);
		find("Select text to copy").click(); const textarea = parent.querySelector("textarea")!;
		expect(textarea.hidden).toBe(false); expect(textarea.value).toContain("@AliceLink (https://example.test)");
		textarea.setSelectionRange(2, 8); pending.update([operation]);
		expect(parent.querySelector("textarea")).toBe(textarea); expect(textarea.selectionEnd).toBe(8);
		session.permission = () => ({ read: true, comment: true, edit: false, moderate: false }); pending.update([operation]);
		find("Retry original request").click(); await until(() => parent.textContent!.includes("Saved for retry"));
		expect(session.retryRejected).toHaveBeenCalledWith(operation);
		expect((await store.getOperation(id(20)))?.payload).toEqual(operation.payload);
	} finally { pending.dispose(); store.close(); parent.remove(); }
});

test("pending picture recovery is explicit, permission gated, and preserves the visible original", async () => {
	const { store, session, typed } = await fixture(), parent = document.createElement("div");
	const pending = new PendingComments(parent, typed, entry);
	await store.enqueue({ operationId: id(20), scopeId: entry, type: "reply.create", dependsOn: [], payload: {
		type: "reply.create", thread_id: id(4), message_id: id(5), body: { version: 1, blocks: [{ type: "picture", picture_id: id(6), alt: "My saved diagram" }] } } });
	const op = (await store.getOperation(id(20)))!;
	try {
		session.canRepairPictures = false; pending.update([op]);
		const find = () => [...parent.querySelectorAll("button")].find(button => button.textContent === "Refresh picture uploads and retry")!;
		expect(find().disabled).toBe(true); expect(parent.textContent).toContain("My saved diagram");
		session.canRepairPictures = true; pending.update([op]); find().click();
		await until(() => parent.textContent!.includes("queued again"));
		expect(session.repairPictures).toHaveBeenCalledWith(op);
		expect((await store.getOperation(id(20)))?.payload).toEqual(op.payload);
	} finally { pending.dispose(); store.close(); }
});

test("the sidebar retains local recovery when access is revoked and clears it synchronously on account change", async () => {
	const { store, session, typed } = await fixture();
	await store.enqueue({ operationId: id(20), scopeId: entry, type: "reply.create", dependsOn: [], payload: {
		type: "reply.create", thread_id: id(4), message_id: id(5), body: bodyFromText("Retained local text") } });
	let notify!: () => void, currentSession: DiscussionSession | undefined = typed;
	const host = { focusedThread: jest.fn(), onChange: (fn: () => void) => { notify = fn; return () => {}; },
		current: () => ({ path: "Note.md", entryId: entry, session: currentSession }) } as unknown as DiscussionHost;
	const view = new CommentsView({} as WorkspaceLeaf, host);
	try {
		session.permission = () => ({ read: false, comment: false, edit: false, moderate: false });
		await view.onOpen(); await until(() => view.contentEl.textContent!.includes("Retained local text"));
		expect(session.local).not.toHaveBeenCalled(); expect(session.messages).not.toHaveBeenCalled();
		currentSession = undefined; notify(); expect(view.contentEl.textContent).not.toContain("Retained local text");
	} finally { await view.onClose(); store.close(); }
});

test("incoming sidebar refresh preserves the focused draft and closes the old note subscription", async () => {
	const { store, session, typed } = await fixture();
	const thread: ThreadSummary = { id: id(4), author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1, removed: false,
		created_sequence: 1, activity_sequence: 1, created_at: "2026-11-05T00:00:00Z" };
	session.local.mockResolvedValue({ threads: [thread], pending: [], hasMore: false, nextAfter: 1 });
	session.messages.mockResolvedValue({ messages: [{ id: id(5), author_id: id(1), revision: 1, deleted: false, body: bodyFromText("Existing"),
		created_sequence: 1, created_at: thread.created_at, edited_at: null, reactions: [] }], hasMore: false });
	let notify!: () => void, currentEntry = entry, currentSession: DiscussionSession | undefined = typed;
	const host = { focusedThread: jest.fn(), onChange: (fn: () => void) => { notify = fn; return () => {}; },
		current: () => ({ path: "Note.md", entryId: currentEntry, session: currentSession }) } as unknown as DiscussionHost;
	const view = new CommentsView({} as WorkspaceLeaf, host);
	try {
		await view.onOpen(); await until(() => !!view.contentEl.querySelector("textarea:not([disabled])") && view.contentEl.textContent!.includes("Existing"));
		const textarea = view.contentEl.querySelector("textarea")!;
		textarea.value = "Unsent text"; textarea.dispatchEvent(new Event("input")); textarea.focus(); textarea.setSelectionRange(2, 5);
		notify(); await new Promise(resolve => setTimeout(resolve, 100));
		expect(view.contentEl.querySelector("textarea")).toBe(textarea); expect(document.activeElement).toBe(textarea);
		expect(textarea.selectionStart).toBe(2); expect(textarea.value).toBe("Unsent text");
		currentEntry = id(9); notify(); await until(() => view.contentEl.querySelector("textarea") !== textarea);
		expect(session.watch.mock.results[0].value).toHaveBeenCalled();
		expect((await store.getDraft("new:" + entry))?.body).toMatchObject({ text: "Unsent text" });
		currentSession = undefined; notify();
		expect(view.contentEl.querySelector("textarea")).toBeNull(); // No debounce window exposing the old account.
	} finally { await view.onClose(); store.close(); }
});

test("Send and reopen after recovery uses a fresh identity and the reviewed draft", async () => {
	const { store, session, typed } = await fixture();
	const thread: ThreadSummary = { id: id(4), author_id: id(1), state: "resolved", state_revision: 2, anchor_revision: 1, removed: false,
		created_sequence: 1, activity_sequence: 2, created_at: "2026-11-05T00:00:00Z" };
	session.local.mockResolvedValue({ threads: [thread], pending: [], hasMore: false, nextAfter: 1 });
	session.messages.mockResolvedValue({ messages: [], hasMore: false });
	const draftId = `reply:${entry}:${thread.id}`;
	await store.saveDraft({ id: draftId, scopeId: entry, revision: 0, body: "Unconfirmed reply" }, null);
	const original: OnlineOperation = { operationId: id(20), scopeId: entry, payload: { type: "reply.create", thread_id: thread.id, message_id: id(21),
		body: protocolJson(bodyFromText("Unconfirmed reply")), reopen: true, expected_state_revision: 2 } };
	await store.prepareOnlineDraft(draftId, 0, original);
	const send = jest.fn(async (draft: { id: string; revision: number }, operation: OnlineOperation) => {
		await store.prepareOnlineDraft(draft.id, draft.revision, operation); await store.completeOnlineDraft(draft.id, draft.revision, operation.operationId);
	});
	Object.assign(typed, { canRecoverOnlineDraft: true, onlineDraft: send, recoverOnlineDraft: async () => ({ status: "editable", draft: await store.withdrawOnlineDraft(draftId, 0, original) }) });
	const host = { focusedThread: jest.fn(), onChange: () => () => {}, current: () => ({ path: "Note.md", entryId: entry, session: typed }) } as unknown as DiscussionHost;
	const view = new CommentsView({} as WorkspaceLeaf, host);
	const find = (text: string) => [...view.contentEl.querySelectorAll("button")].find(button => button.textContent === text)!;
	try {
		await view.onOpen(); await until(() => !!find("Show replies")); find("Show replies").click();
		await until(() => !!view.contentEl.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')?.readOnly);
		find("Check delivery and edit").click(); await until(() => view.contentEl.textContent!.includes("ready to edit"));
		const reply = view.contentEl.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!;
		reply.value = "Reviewed reply"; reply.dispatchEvent(new Event("input")); find("Send and reopen").click();
		await until(() => send.mock.calls.length === 1 && reply.value === "");
		expect(send.mock.calls[0][1].operationId).not.toBe(original.operationId);
		expect(send.mock.calls[0][1].payload).toMatchObject({ expected_state_revision: 2, body: bodyFromText("Reviewed reply") });
		expect(await store.getDraft(draftId)).toBeUndefined();
	} finally { await view.onClose(); store.close(); }
});

test("definition status refreshes after registry changes without replacing the active draft", async () => {
	const { store, session, typed } = await fixture(), scope = baseDiscussionScope(entry, id(8));
	const thread = { id: id(4), author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1, removed: false,
		created_sequence: 1, activity_sequence: 1, created_at: "2026-11-05T00:00:00Z", anchor: { version: 1, type: "base",
			definition_id: id(6), view_id: id(8), generation: id(7), registry_revision: 1,
			target: { type: "formula", definition_id: id(9), definition_revision: 1, property: { source: "formula", name: "Total" } } } };
	session.local.mockResolvedValue({ threads: [thread], pending: [], hasMore: false, nextAfter: 1 });
	session.messages.mockResolvedValue({ messages: [], hasMore: false });
	let notify!: () => void;
	const host = { focusedThread: jest.fn(), onChange: (fn: () => void) => { notify = fn; return () => {}; },
		current: () => ({ path: "Review.base", kind: "base", baseViewName: "Review", entryId: scope, session: typed }),
		targetLabel: () => "Formula definition: Total" } as unknown as DiscussionHost;
	const draftId = "selection:" + scope + ":active";
	await store.saveDraft({ id: draftId, scopeId: scope, revision: 0, body: "Original", target: protocolJson(thread.anchor) });
	await store.setPreference("activeNewDraft:" + scope, draftId);
	const view = new CommentsView({} as WorkspaceLeaf, host);
	try {
		await view.onOpen(); await until(() => view.contentEl.textContent!.includes("latest verified definition") && !!view.contentEl.querySelector("textarea:not([disabled])"));
		const draft = view.contentEl.querySelector("textarea")!; draft.value = "Keep this"; draft.dispatchEvent(new Event("input"));
		session.baseRegistryRevision = () => 2; session.baseDefinitionStatus.mockResolvedValue("The definition has changed. Original discussion retained.");
		notify(); await until(() => view.contentEl.textContent!.includes("definition has changed"));
		expect(view.contentEl.querySelector("textarea")).toBe(draft); expect(draft.value).toBe("Keep this");
		expect(session.baseDefinitionStatus).toHaveBeenCalledTimes(2);
	} finally { await view.onClose(); store.close(); }
});

test("selected drafts keep their exact targets and text across switching, restart and send", async () => {
	const { store, session, typed } = await fixture(), parent = document.createElement("div"); document.body.append(parent);
	const selection = (label: string) => ({ version: 1, type: "text", document_id: entry, generation: id(30),
		start: "AA==", end: "AA==", dependency: "AAA=", selected_length: label.length,
		context: { quote: label, prefix: "", suffix: "", truncated: false } });
	const first = "selection:" + entry + ":" + id(40), second = "selection:" + entry + ":" + id(41);
	await store.saveDraft({ id: first, scopeId: entry, revision: 0, body: { text: "First draft", mentions: [] }, target: protocolJson(selection("alpha")) });
	await store.saveDraft({ id: second, scopeId: entry, revision: 0, body: { text: "Second draft", mentions: [] }, target: protocolJson(selection("beta")) });
	await store.setPreference("activeNewDraft:" + entry, first);
	const reveal = jest.fn(); let drafts = new DiscussionDrafts(parent, typed, entry, reveal);
	try {
		// Text is restored before the pending-send check finishes. A real user
		// cannot type until the composer enables this field.
		await until(() => parent.querySelector("textarea")?.value === "First draft" && !parent.querySelector("textarea")?.disabled);
		const textarea = parent.querySelector("textarea")!; textarea.value = "Preserve my first draft"; textarea.dispatchEvent(new Event("input"));
		const picker = parent.querySelector<HTMLSelectElement>('select[aria-label="Discussion draft"]')!;
		picker.value = second; picker.dispatchEvent(new Event("change"));
		await until(() => parent.querySelector("textarea")?.value === "Second draft");
		expect((await store.getDraft(first))?.body).toMatchObject({ text: "Preserve my first draft" });
		expect((await store.getDraft(first))?.target).toEqual(selection("alpha"));
		drafts.dispose(); drafts = new DiscussionDrafts(parent, typed, entry, reveal);
		await until(() => parent.querySelector("textarea")?.value === "Second draft");
		[...parent.querySelectorAll("button")].find(button => button.textContent === "Show selection")!.click();
		expect(reveal).toHaveBeenCalledWith(selection("beta"));
		parent.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await until(() => session.queue.mock.calls.length === 1 && parent.textContent!.includes("New discussion on this note"));
		expect(session.queue.mock.calls[0][0].payload).toMatchObject({ anchor: selection("beta") });
		expect(await store.getDraft(second)).toBeUndefined(); expect(await store.getDraft(first)).toBeDefined();
	} finally { drafts.dispose(); store.close(); parent.remove(); }
});

test("finishing a send after switching drafts preserves the newly selected target", async () => {
	const { store, session, typed } = await fixture(), parent = document.createElement("div"); document.body.append(parent);
	const target = { version: 1, type: "text", document_id: entry, generation: id(30), start: "AA==", end: "AA==", dependency: "AAA=",
		selected_length: 4, context: { quote: "beta", prefix: "", suffix: "", truncated: false } };
	const first = "selection:" + entry + ":" + id(40), second = "selection:" + entry + ":" + id(41);
	for (const [draftId, text] of [[first, "Sending first"], [second, "Continue second"]]) {
		await store.saveDraft({ id: draftId, scopeId: entry, revision: 0, body: { text, mentions: [] }, target: protocolJson(target) });
	}
	await store.setPreference("activeNewDraft:" + entry, first);
	let finish!: () => void;
	const pending = new Promise<void>(resolve => { finish = resolve; });
	session.queue.mockImplementation(async (command, draft) => { await pending; await store.enqueue(command, Date.now(), draft); });
	const drafts = new DiscussionDrafts(parent, typed, entry, () => {});
	try {
		await until(() => parent.querySelector("textarea")?.value === "Sending first");
		parent.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await until(() => session.queue.mock.calls.length === 1);
		const picker = parent.querySelector<HTMLSelectElement>('select[aria-label="Discussion draft"]')!;
		picker.value = second; picker.dispatchEvent(new Event("change"));
		await until(() => parent.querySelector("textarea")?.value === "Continue second");
		finish(); await pending;
		await until(() => !parent.textContent!.includes("Sending first") && session.queue.mock.calls.length === 1);
		// Wait for the durable retirement, including its late onSent callback.
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(await store.getDraft(first)).toBeUndefined();
		expect(await store.preference("activeNewDraft:" + entry)).toBe(second);
		expect(parent.querySelector("textarea")?.value).toBe("Continue second");
		expect(session.queue.mock.calls[0][0].payload).toMatchObject({ anchor: target });
	} finally { finish(); drafts.dispose(); store.close(); parent.remove(); }
});

test("an older asynchronous draft refresh cannot undo a new picker choice", async () => {
	const { store, typed } = await fixture(), parent = document.createElement("div"); document.body.append(parent);
	const second = "selection:" + entry + ":" + id(41);
	await store.saveDraft({ id: second, scopeId: entry, revision: 0, body: { text: "Selection draft", mentions: [] },
		target: { version: 1, type: "text", document_id: entry, generation: id(30), start: "AA==", end: "AA==", dependency: "AAA=",
			selected_length: 4, context: { quote: "beta", prefix: "", suffix: "", truncated: false } } });
	const drafts = new DiscussionDrafts(parent, typed, entry, () => {});
	let finish!: () => void;
	const pending = new Promise<void>(resolve => { finish = resolve; });
	try {
		await until(() => !!parent.querySelector("textarea:not([disabled])"));
		const page = store.selectionDrafts.bind(store);
		const delayed = jest.spyOn(store, "selectionDrafts").mockImplementationOnce(async (...args) => { const result = await page(...args); await pending; return result; });
		drafts.update(); await until(() => delayed.mock.calls.length > 0);
		const picker = parent.querySelector<HTMLSelectElement>('select[aria-label="Discussion draft"]')!;
		picker.value = second; picker.dispatchEvent(new Event("change"));
		await until(() => !picker.disabled);
		finish(); await until(() => parent.querySelector("textarea")?.value === "Selection draft");
		expect(await store.preference("activeNewDraft:" + entry)).toBe(second);
	} finally { finish(); drafts.dispose(); store.close(); parent.remove(); }
});

test("a corrupt saved target keeps draft text selectable and never submits as a whole-note comment", async () => {
	const { store, session, typed } = await fixture(), parent = document.createElement("div");
	await store.saveDraft({ id: "corrupt", scopeId: entry, revision: 0, body: "Keep this text", target: { type: "unknown" } });
	const composer = new CommentComposer(parent, typed, entry, "corrupt", () => { throw new Error("Must not send"); });
	try {
		await until(() => parent.textContent!.includes("Could not restore"));
		expect(composer.textarea.value).toBe("Keep this text"); expect(composer.textarea.disabled).toBe(false);
		await composer.submit(); expect(session.queue).not.toHaveBeenCalled();
	} finally { composer.dispose(); store.close(); }
});

test("pending group drafts survive composer recreation and enqueue evidence without fabricating a verified anchor", async () => {
	const { store, session, typed } = await fixture(), parent = document.createElement("div"), scope = baseDiscussionScope(entry, id(4));
	const target = { version: 1, type: "base_group_pending", entry_id: entry, property: { source: "note", name: "status" }, capture: {
		operation_id: id(5), definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 2, group_definition_id: id(8),
		group_definition_revision: 2, record_id: id(9), record_generation: id(10), dependency: "AA==", time_zone: "UTC", value: { type: "text", value: "Done" } } };
	const draftId = "selection:" + scope + ":group", begin = jest.fn().mockResolvedValue(undefined);
	await store.saveDraft({ id: draftId, scopeId: scope, revision: 0, body: "Offline group comment", target });
	await store.setPreference("activeNewDraft:" + scope, draftId);
	let drafts = new DiscussionDrafts(parent, typed, scope, () => {}, undefined, begin);
	try {
		await until(() => parent.querySelector("textarea")?.value === "Offline group comment");
		expect(parent.textContent).toContain("Group: status (verification pending)");
		drafts.dispose(); drafts = new DiscussionDrafts(parent, typed, scope, () => {}, undefined, begin);
		await until(() => parent.querySelector("textarea")?.value === "Offline group comment");
		parent.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await until(() => session.queue.mock.calls.length === 1);
		expect(session.queue.mock.calls[0][0]).toMatchObject({ scopeId: scope, type: "base.group.create", payload: { anchor: target } });
		await until(() => !parent.querySelector("textarea"));
		expect((await store.pending(scope))[0].payload).toMatchObject({ anchor: target });
	} finally { drafts.dispose(); await new Promise(resolve => setTimeout(resolve, 10)); store.close(); }
});
