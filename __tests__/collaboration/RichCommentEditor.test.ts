/** @jest-environment jsdom */
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import { webcrypto } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TextSelection } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import { RichCommentEditor } from "../../src/collaboration/ui/RichCommentEditor";
import { CommentComposer } from "../../src/collaboration/ui/CommentComposer";
import { editableCommentDraft, readCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson, type MessageBody, type Paragraph } from "../../src/collaboration/DiscussionProtocol";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { prepareLocalPicture, PictureOfflineError } from "../../src/collaboration/PictureProtocol";

Object.assign(globalThis, { TextEncoder, TextDecoder, IDBKeyRange, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: webcrypto.subtle });
Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; },
	appendText(this: HTMLElement, text: string) { this.append(this.ownerDocument.createTextNode(text)); },
});
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry = id(3), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "rich-editor" };
const button = (el: HTMLElement, label: string) => [...el.querySelectorAll("button")].find(b => b.textContent === label)!;
const select = (editor: RichCommentEditor, from: number, to = from) => editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, from, to)));
const listeners = new Set<() => void>();
const session = { identity, status: "offline", canQueue: true, online: false, canAttachPictures: true,
	displayName: () => "Alice", participants: () => [{ id: id(1), name: "Alice" }],
	permission: () => ({ read: true, comment: true, edit: false, moderate: false }),
	onChange: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
	pictures: { load: jest.fn().mockRejectedValue(new PictureOfflineError("offline")) },
	trackLocal: <T>(promise: Promise<T>) => promise,
};
const editors: RichCommentEditor[] = [];
function editor(body: MessageBody = bodyFromText("Hello world")) {
	const parent = document.createElement("div"); document.body.append(parent);
	const change = jest.fn(), error = jest.fn(), send = jest.fn(), attach = jest.fn();
	const value = new RichCommentEditor(parent, session as unknown as DiscussionSession, entry, body, change, error, send, attach, "Comment"); editors.push(value);
	return { editor: value, parent, change, error, send, attach };
}
afterEach(() => { editors.splice(0).forEach(e => e.dispose()); document.body.replaceChildren(); expect(listeners.size).toBe(0); });

test("formatting preserves selected text and supports undo/redo", () => {
	const { editor: e, parent, change } = editor(); select(e, 1, 6); button(parent, "Bold").click();
	expect(e.body().blocks[0]).toEqual({ type: "paragraph", children: [{ type: "text", text: "Hello", marks: ["bold"] }, { type: "text", text: " world" }] });
	expect(e.view.state.selection.from).toBe(1); expect(e.view.state.selection.to).toBe(6);
	button(parent, "Undo").click(); expect(e.body()).toEqual(bodyFromText("Hello world")); button(parent, "Redo").click();
	expect(parent.querySelector("strong")?.textContent).toBe("Hello"); expect(change).toHaveBeenCalledTimes(3);
});

test("flat lists split, switch kind and lift selected items without losing their neighbors", () => {
	const { editor: e, parent, error } = editor(); button(parent, "Bulleted list").click();
	expect(e.body().blocks[0].type).toBe("list"); select(e, 8);
	e.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	expect(parent.querySelectorAll("li")).toHaveLength(2); expect(e.view.state.doc.textContent).toBe("Hello world");
	button(parent, "Numbered list").click(); expect(parent.querySelector("ol")).not.toBeNull();
	button(parent, "Numbered list").click(); expect(e.view.state.doc.textContent).toBe("Hello world");
	expect(e.body().blocks.map(b => b.type)).toEqual(["list", "paragraph"]); expect(error).not.toHaveBeenCalled();
});

test("link editing at a caret updates/removes the whole link and maps a pending selection", () => {
	const { editor: e, parent } = editor(); select(e, 1, 6); button(parent, "Link").click();
	const input = parent.querySelector<HTMLInputElement>('input[type="url"]')!;
	input.value = "https://example.com/first"; button(parent, "Apply link").click();
	select(e, 3); button(parent, "Link").click(); expect(input.value).toBe("https://example.com/first");
	e.view.dispatch(e.view.state.tr.insertText("Before ", 1));
	input.value = "https://example.com/second"; button(parent, "Apply link").click();
	expect(e.view.state.doc.textContent).toBe("Before Hello world"); expect(parent.querySelector("a")?.textContent).toBe("Hello");
	select(e, 10); button(parent, "Link").click(); button(parent, "Remove link").click(); expect(parent.querySelector("a")).toBeNull();
});

test("unsafe links and over-limit typing keep the prior draft and provide feedback", () => {
	const { editor: e, parent, error } = editor(); select(e, 1, 6); button(parent, "Link").click();
	parent.querySelector<HTMLInputElement>('input[type="url"]')!.value = "javascript:alert(1)"; button(parent, "Apply link").click();
	expect(parent.querySelector("a")).toBeNull(); expect(error).toHaveBeenCalled();
	e.view.dispatch(e.view.state.tr.insertText("x".repeat(40_000))); expect(e.body()).toEqual(bodyFromText("Hello world"));
});

test("code language is retained; mentions stay atomic and cannot silently become code", () => {
	const { editor: e, parent, error } = editor(); button(parent, "Code block").click();
	const language = parent.querySelector<HTMLInputElement>('.relay-comment-code-language input')!; language.value = "ts"; language.dispatchEvent(new Event("change"));
	expect(e.body().blocks[0]).toEqual({ type: "code", text: "Hello world", language: "ts" });
	e.insertMention(id(1), "Alice"); expect(error).toHaveBeenCalledWith(expect.stringContaining("outside"));
	button(parent, "Code block").click(); select(e, 6); e.insertMention(id(1), "Alice");
	select(e, 1, e.view.state.doc.content.size - 1); button(parent, "Bold").click();
	expect(button(parent, "Code block").disabled).toBe(true);
	expect(JSON.stringify(e.body())).toContain(`"type":"mention","user_id":"${id(1)}"`);
	const nodes: string[] = []; e.view.state.doc.descendants(n => { if (n.type.name === "mention") nodes.push(...n.marks.map(m => m.type.name)); }); expect(nodes).toEqual([]);
});

test("picture removal/movement is undoable, bounds references, and disposes its viewers", () => {
	const picture = { type: "picture" as const, picture_id: id(8), alt: "Diagram" };
	const { editor: e, parent } = editor({ version: 1, blocks: [...bodyFromText("Before").blocks, picture, ...bodyFromText("After").blocks] });
	expect(listeners.size).toBe(1); button(parent, "Move picture down").click(); expect(e.body().blocks[2]).toEqual(picture);
	button(parent, "Remove picture").click();
	expect(e.draft().pictures).toEqual([]); expect(e.draft().undoPictures).toEqual([picture]); expect(listeners.size).toBe(0);
	undo(e.view.state, e.view.dispatch); expect(e.body().blocks[2]).toEqual(picture); expect(listeners.size).toBe(1);
	redo(e.view.state, e.view.dispatch); expect(e.draft().undoPictures).toEqual([picture]);
});

test("staged attachment insertion preserves selected text and code/list content", () => {
	const { editor: e } = editor(); select(e, 1, 6);
	const picture = { type: "picture" as const, picture_id: id(8), alt: "Diagram" }, prepared = e.preparePictures([picture]);
	expect(e.body()).toEqual(bodyFromText("Hello world")); prepared.apply();
	expect(e.view.state.doc.textContent).toBe("Hello world"); expect(e.body().blocks[1]).toEqual(picture);
	e.setBody({ version: 1, blocks: [{ type: "code", text: "first\nsecond", language: "js" }] }); select(e, 6);
	e.preparePictures([picture]).apply(); expect(e.view.state.doc.textContent).toBe("first\nsecond");
	e.setBody({ version: 1, blocks: [{ type: "list", ordered: false, items: [bodyFromText("Item").blocks[0] as Paragraph] }] }); select(e, 4);
	e.preparePictures([picture]).apply(); expect(e.body().blocks.map(b => b.type)).toEqual(["list", "picture"]);
});

test("read-only and composition states prevent toolbar changes, mentions and sends", () => {
	const { editor: e, parent, send } = editor(); e.setEditable(false); e.insertMention(id(1), "Alice");
	e.view.dispatch(e.view.state.tr.insertText("Must not change")); button(parent, "Bold").click(); expect(e.body()).toEqual(bodyFromText("Hello world"));
	e.setEditable(true); e.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
	expect(e.composing).toBe(true); e.insertMention(id(1), "Alice"); button(parent, "Bold").click();
	e.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
	expect(send).not.toHaveBeenCalled(); expect(e.body()).toEqual(bodyFromText("Hello world"));
});

test("clipboard processing bounds large pastes before DOM parsing and stages file pictures without parsing their HTML", () => {
	const { editor: e, error, attach } = editor();
	const paste = (text: string, html: string, files: File[] = []) => {
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", { value: { files, getData: (type: string) => type === "text/plain" ? text : type === "text/html" ? html : "" } });
		e.view.dom.dispatchEvent(event); return event;
	};
	expect(paste("x".repeat(65_537), "").defaultPrevented).toBe(true); expect(e.body()).toEqual(bodyFromText("Hello world"));
	expect(paste("", "<p>" + "x".repeat(262_144) + "</p>").defaultPrevented).toBe(true); expect(error).toHaveBeenCalledTimes(2);
	const image = new File([new Uint8Array([1])], "picture.png", { type: "image/png" });
	expect(paste("Caption ", "<img src=\"data:image/png;base64," + "x".repeat(300_000) + "\">", [image]).defaultPrevented).toBe(true);
	expect(attach).toHaveBeenCalledWith([image]); expect(e.view.state.doc.textContent).toBe("Caption Hello world");
});

test("actual editor HTML paste preserves supported marks and cannot forge mention identities", () => {
	const { editor: e, parent } = editor(); select(e, 1, 12);
	e.view.pasteHTML(`<p><strong>Copied</strong> <span class="relay-comment-mention" data-user-id="${id(1)}">@Alice</span></p>`, new Event("paste") as ClipboardEvent);
	expect(parent.querySelector("strong")?.textContent).toBe("Copied"); expect(e.view.state.doc.textContent).toBe("Copied @Alice");
	expect(JSON.stringify(e.body())).not.toContain(id(1));
});

async function composerFixture(initial?: ReturnType<typeof editableCommentDraft>) {
	const factory = new IDBFactory(), store = await DiscussionStore.open(identity, factory), parent = document.createElement("div"); document.body.append(parent);
	const queue = jest.fn(async (command: QueuedCommand, draft?: { id: string; revision: number }) => { await store.enqueue(command, Date.now(), draft); });
	const typed = { ...session, store, queue } as unknown as DiscussionSession;
	const make = () => new CommentComposer(parent, typed, entry, "draft", (body, _anchor, revision) => ({ type: "message.edit", payload: { type: "message.edit", thread_id: id(4), message_id: id(5), expected_revision: revision ?? 1, body: protocolJson(body) } }), "Comment", initial);
	return { store, factory, parent, queue, make };
}

test("composer upgrade, reload and offline queue preserve formatting and mention IDs", async () => {
	const { store, parent, queue, make } = await composerFixture(); let c = make();
	try {
		await c.flush(); c.textarea.value = "Hello "; c.textarea.dispatchEvent(new Event("input")); c.textarea.setSelectionRange(6, 6);
		const people = parent.querySelector("select")!; people.value = id(1); people.dispatchEvent(new Event("change"));
		c.textarea.setSelectionRange(0, 5); button(parent, "Format comment").click(); button(parent, "Bold").click(); await c.flush();
		const rich = readCommentDraft((await store.getDraft("draft"))!.body).rich!;
		expect(JSON.stringify(rich)).toContain('"marks":["bold"]'); expect(JSON.stringify(rich)).toContain(id(1));
		c.dispose(); c = make(); await c.flush(); expect(parent.querySelector("strong")?.textContent).toBe("Hello");
		await c.submit(); expect(queue).toHaveBeenCalledTimes(1); expect(queue.mock.calls[0][0].payload).toMatchObject({ body: rich });
		expect(await store.getDraft("draft")).toBeUndefined();
	} finally { c.dispose(); store.close(); }
});

test("reopened old edit requires explicit revision review before it can replace newer content", async () => {
	const initial = { ...editableCommentDraft(bodyFromText("Current revision"), () => "Alice"), editBaseRevision: 7 };
	const { store, parent, queue, make } = await composerFixture(initial);
	await store.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: protocolJson({ ...editableCommentDraft(bodyFromText("My unsent edit"), () => "Alice"), editBaseRevision: 2 }) }, null);
	const c = make();
	try {
		// Submit before async restoration settles must also respect the review gate.
		await c.submit(); await c.flush(); expect(queue).not.toHaveBeenCalled(); expect(parent.textContent).toContain("revision 2");
		expect(parent.textContent).toContain("Current revision"); button(parent, "Use this revision for my edit").click(); await c.flush();
		await c.submit(); expect(queue.mock.calls[0][0].payload).toMatchObject({ expected_revision: 7, body: bodyFromText("My unsent edit") });
	} finally { c.dispose(); store.close(); }
});

test("a rich draft changed in another window retains both versions and prevents a stale send", async () => {
	const initial = { ...editableCommentDraft(bodyFromText("Original"), () => "Alice"), editBaseRevision: 1 };
	const { store, parent, queue, make } = await composerFixture(initial); const c = make();
	try {
		await c.flush(); const original = (await store.getDraft("draft"))!;
		await store.saveDraft({ ...original, revision: original.revision + 1, body: "Other window" }, original.revision);
		button(parent, "Bold").click();
		// Stored marks alone are not a document change; paste real formatted text.
		const input = parent.querySelector<HTMLElement>('.relay-comment-rich-input')!;
		input.querySelector("p")!.textContent = "My version"; await new Promise(resolve => setTimeout(resolve, 10));
		await c.flush(); await c.submit(); expect(queue).not.toHaveBeenCalled(); expect(parent.textContent).toContain("another window");
		expect(input.textContent).toContain("My version"); expect((await store.getDraft("draft"))?.body).toBe("Other window");
	} finally { c.dispose(); store.close(); }
});

test("reopening releases inactive undo originals, but unconfirmed online drafts retain them unchanged", async () => {
	const { store, make } = await composerFixture(), source = await prepareLocalPicture(id(8), entry, new TextEncoder().encode("saved picture").buffer);
	const body = { ...editableCommentDraft(bodyFromText("Retained comment"), () => "Alice"), undoPictures: [{ type: "picture" as const, picture_id: source.id }] };
	await store.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: protocolJson(body) }, null, [source]);
	await store.prepareOnlineDraft("draft", 0, { operationId: id(9), scopeId: entry, payload: { type: "reply.create" } });
	let c = make();
	try {
		await c.flush(); expect(await store.pictureSource(source.id, entry)).toBeDefined(); expect((await store.getDraft("draft"))?.revision).toBe(0);
		c.dispose(); await store.setPreference("online:draft", null); c = make(); await c.flush();
		expect(await store.pictureSource(source.id, entry)).toBeUndefined(); expect((await store.getDraft("draft"))?.revision).toBe(1);
	} finally { c.dispose(); store.close(); }
});
