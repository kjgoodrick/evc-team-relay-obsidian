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

test("incoming sidebar refresh preserves the focused draft and closes the old note subscription", async () => {
	const { store, session, typed } = await fixture();
	const thread: ThreadSummary = { id: id(4), author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1, removed: false,
		created_sequence: 1, activity_sequence: 1, created_at: "2026-11-05T00:00:00Z" };
	session.local.mockResolvedValue({ threads: [thread], pending: [], hasMore: false, nextAfter: 1 });
	session.messages.mockResolvedValue({ messages: [{ id: id(5), author_id: id(1), revision: 1, deleted: false, body: bodyFromText("Existing"),
		created_sequence: 1, created_at: thread.created_at, edited_at: null, reactions: [] }], hasMore: false });
	let notify!: () => void, currentEntry = entry, currentSession: DiscussionSession | undefined = typed;
	const host = { onChange: (fn: () => void) => { notify = fn; return () => {}; },
		current: () => ({ path: "Note.md", entryId: currentEntry, session: currentSession }) } as unknown as DiscussionHost;
	const view = new CommentsView({} as WorkspaceLeaf, host);
	try {
		await view.onOpen(); await until(() => !!view.contentEl.querySelector("textarea:not([disabled])"));
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
