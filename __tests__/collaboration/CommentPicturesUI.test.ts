/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const fixtures = JSON.parse(readFileSync(join(__dirname, "fixtures/comment-pictures.json"), "utf8")) as Record<string, string>;
import { inspectPicture } from "../../src/collaboration/PictureInput";
import { DiscussionPictures } from "../../src/collaboration/DiscussionPictures";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { CommentComposer } from "../../src/collaboration/ui/CommentComposer";
import { CommentPicture } from "../../src/collaboration/ui/CommentPicture";
import { editableCommentDraft, commentDraftBody } from "../../src/collaboration/ui/CommentDraft";
import { prepareLocalPicture, PictureOfflineError } from "../../src/collaboration/PictureProtocol";

Object.assign(globalThis, { IDBKeyRange, TextEncoder, TextDecoder, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: webcrypto.subtle });
Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; },
	appendText(this: HTMLElement, text: string) { this.append(document.createTextNode(text)); },
});
Object.assign(URL, { createObjectURL: jest.fn(() => "blob:private-picture"), revokeObjectURL: jest.fn() });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry = id(3), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "pictures-ui" };
const bytes = (format: keyof typeof fixtures = "png") => new Uint8Array(Buffer.from(fixtures[format], "base64")).buffer;
const file = (format: keyof typeof fixtures = "png") => new File([bytes(format)], "picture", { type: "image/png" });
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("UI did not settle"); }
async function setup() {
	const factory = new IDBFactory(), store = await DiscussionStore.open(identity, factory), parent = document.createElement("div"); document.body.append(parent);
	const listeners = new Set<() => void>();
	const session = { store, identity, status: "offline", canQueue: true, canAttachPictures: true, online: false,
		permission: () => ({ read: true, comment: true, edit: false, moderate: false }), participants: () => [],
		onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		trackLocal: <T>(promise: Promise<T>) => promise,
		queue: jest.fn(async (command: QueuedCommand, draft?: { id: string; revision: number }) => { await store.enqueue(command, Date.now(), draft); }),
	};
	const typed = session as unknown as DiscussionSession; Object.assign(typed, { pictures: new DiscussionPictures(typed) });
	const make = () => new CommentComposer(parent, typed, entry, "draft", body => ({ type: "reply.create", payload: { type: "reply.create", thread_id: id(4), message_id: id(5), body } }));
	return { factory, store, session, typed, parent, listeners, make };
}

test.each(["png", "jpeg", "gif", "webp", "webp_lossless"] as const)("preflights a real encoded %s before local display", format => {
	expect(inspectPicture(bytes(format))).toMatchObject({ width: 8, height: 6, mime: "image/" + (format.startsWith("webp") ? "webp" : format) });
});
test.each(["animated_png", "animated_gif", "animated_webp"] as const)("rejects actual %s animation before preview decoding", format => {
	expect(() => inspectPicture(bytes(format))).toThrow("Animated");
});
test("rejects oversized dimensions, truncation, active SVG and spoofed headers", () => {
	const bomb = bytes(); new DataView(bomb).setUint32(16, 100_000);
	new DataView(bomb).setUint32(20, 100_000); expect(() => inspectPicture(bomb)).toThrow("20 megapixels");
	expect(() => inspectPicture(bytes().slice(0, 22))).toThrow();
	expect(() => inspectPicture(new TextEncoder().encode('<svg onload="alert(1)"/>').buffer)).toThrow("static");
	expect(() => inspectPicture(new Uint8Array([0x47, 0x49, 0x46]).buffer)).toThrow();
});

test("offline picker persists bytes before showing pictures, survives reload and queues a picture-only reply", async () => {
	const { store, session, parent, make } = await setup(); let composer = make();
	try {
		await composer.flush();
		const input = parent.querySelector<HTMLInputElement>('input[type="file"]')!;
		Object.defineProperty(input, "files", { value: [file()] }); input.dispatchEvent(new Event("change"));
		await until(() => parent.textContent!.includes("Draft and pictures saved"));
		const draft = (await store.getDraft("draft"))!, pictureId = (draft.body as { pictures: { picture_id: string }[] }).pictures[0].picture_id;
		expect((await store.pictureSource(pictureId, entry))?.bytes).toEqual(bytes());
		const alt = parent.querySelector<HTMLInputElement>('input[aria-label="Picture description"]')!;
		alt.value = "A red diagram"; alt.dispatchEvent(new Event("input")); await composer.flush();
		composer.dispose(); composer = make(); await composer.flush();
		expect(parent.querySelector<HTMLInputElement>('input[aria-label="Picture description"]')!.value).toBe("A red diagram");
		await until(() => !!parent.querySelector('img[src^="blob:"]'));
		expect(parent.querySelector("img")!.alt).toBe("A red diagram");
		await composer.submit(); expect(session.queue).toHaveBeenCalledTimes(1);
		expect(session.queue.mock.calls[0][0].payload).toMatchObject({ body: { blocks: [{ type: "picture", picture_id: pictureId, alt: "A red diagram" }] } });
		expect(await store.getDraft("draft")).toBeUndefined(); expect(await store.pending(entry)).toHaveLength(2);
		expect(await store.pictureSource(pictureId, entry)).toBeDefined();
	} finally { composer.dispose(); store.close(); parent.remove(); }
});

test("pasting an image preserves accompanying text; invalid picks do not lock or discard the saved draft", async () => {
	const { store, parent, make } = await setup(), composer = make();
	try {
		await composer.flush();
		const paste = new Event("paste", { cancelable: true });
		Object.defineProperty(paste, "clipboardData", { value: { files: [file()], getData: () => "Caption" } });
		composer.textarea.dispatchEvent(paste); expect(paste.defaultPrevented).toBe(true);
		await until(() => parent.textContent!.includes("Draft and pictures saved"));
		await composer.addPictures([file("animated_gif")]); expect(parent.textContent).toContain("Animated pictures");
		expect(composer.textarea.value).toBe("Caption"); expect(composer.textarea.readOnly).toBe(false);
		expect(parent.querySelectorAll("figure")).toHaveLength(1);
		parent.querySelector<HTMLButtonElement>('.relay-comment-draft-picture > button')!.click(); await composer.flush();
		expect(await store.preference("pictureSourceBytes")).toBe(0); expect(parent.querySelectorAll("figure")).toHaveLength(0);
		await composer.submit(); expect(await store.getDraft("draft")).toBeUndefined();
	} finally { composer.dispose(); store.close(); parent.remove(); }
});

test("a competing window wins without orphaning the losing picture or overwriting its text", async () => {
	const { store, parent, make } = await setup(), composer = make();
	try {
		await composer.flush(); await store.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: "Other window" }, null);
		await composer.addPictures([file()]);
		expect(parent.textContent).toContain("another window"); expect((await store.getDraft("draft"))?.body).toBe("Other window");
		expect(await store.preference("pictureSourceBytes")).toBe(0); expect(parent.querySelector("figure")).toBeNull();
	} finally { composer.dispose(); store.close(); parent.remove(); }
});

test("picture edits preserve mentions and descriptions and refuse unsupported rich or interleaved content", () => {
	const picture = { type: "picture" as const, picture_id: id(8), alt: "Diagram" };
	const body = { version: 1 as const, blocks: [{ type: "paragraph" as const, children: [{ type: "mention" as const, user_id: id(1) }, { type: "text" as const, text: " see this" }] }, picture] };
	const draft = editableCommentDraft(body, () => "Alice")!;
	expect(draft.text).toBe("@Alice see this"); expect(commentDraftBody(draft)).toEqual(body);
	expect(editableCommentDraft({ version: 1, blocks: [picture, body.blocks[0]] }, () => "Alice")).toBeUndefined();
	expect(editableCommentDraft({ version: 1, blocks: [{ type: "code", text: "Keep this" }] }, () => "Alice")).toBeUndefined();
});

test("online-pending drafts keep picture controls locked until the exact send is resolved", async () => {
	const { store, parent, make } = await setup(), source = await prepareLocalPicture(id(8), entry, bytes());
	await store.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: { text: "", mentions: [], pictures: [{ type: "picture", picture_id: id(8) }] } }, null, [source]);
	await store.prepareOnlineDraft("draft", 0, { operationId: id(9), scopeId: entry, payload: { type: "reply.create" } });
	const composer = make();
	try {
		await composer.flush(); await composer.addPictures([file()]);
		expect(parent.querySelectorAll("figure")).toHaveLength(1);
		expect(parent.querySelector<HTMLInputElement>('input[aria-label="Picture description"]')!.disabled).toBe(true);
		expect([...parent.querySelectorAll("button")].find(b => b.textContent === "Add pictures")!.disabled).toBe(true);
	} finally { composer.dispose(); store.close(); parent.remove(); }
});

test("renderer uses only blob URLs, loads full size on demand, and revokes pixels on permission loss", async () => {
	const { store, typed, session, parent, listeners } = await setup();
	const load = jest.fn().mockResolvedValue({ bytes: bytes(), mime: "image/png", width: 8, height: 6, local: false, offline: false });
	Object.assign(typed, { pictures: { load } });
	const picture = new CommentPicture(parent, typed, entry, { type: "picture", picture_id: id(8), alt: '<img src="https://private">' });
	try {
		await until(() => !!parent.querySelector("img[src]"));
		expect(parent.querySelector("img")!.src).toBe("blob:private-picture"); expect(parent.querySelectorAll("img")).toHaveLength(1);
		parent.querySelector("button")!.click(); await until(() => load.mock.calls.length === 2);
		expect(load.mock.calls[1][2]).toBe("content");
		session.permission = () => ({ read: false, comment: false, edit: false, moderate: false }); listeners.forEach(fn => fn());
		expect(parent.querySelector("img")!.hasAttribute("src")).toBe(false); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:private-picture");
	} finally { picture.dispose(); store.close(); parent.remove(); }
});

test("late picture responses cannot repaint a disposed view or an editor after account closure", async () => {
	const { store, typed, session, parent, listeners } = await setup();
	let resolve!: (value: unknown) => void;
	Object.assign(typed, { pictures: { load: () => new Promise(r => { resolve = r; }) } });
	const picture = new CommentPicture(parent, typed, entry, { type: "picture", picture_id: id(8) }, true);
	session.status = "closed"; listeners.forEach(fn => fn()); picture.dispose();
	resolve({ bytes: bytes(), mime: "image/png", width: 8, height: 6, local: true, offline: true });
	await Promise.resolve(); expect(parent.querySelector("img")).toBeNull(); expect(listeners.size).toBe(0);
	store.close(); parent.remove();
});

test("an uncached full-size image preserves the visible thumbnail offline", async () => {
	const { store, typed, parent } = await setup();
	const load = jest.fn().mockResolvedValueOnce({ bytes: bytes(), mime: "image/png", width: 8, height: 6, local: false, offline: true })
		.mockRejectedValueOnce(new PictureOfflineError("Not cached"));
	Object.assign(typed, { pictures: { load } });
	const picture = new CommentPicture(parent, typed, entry, { type: "picture", picture_id: id(8) });
	try {
		await until(() => !!parent.querySelector("img[src]")); parent.querySelector("button")!.click();
		await until(() => parent.textContent!.includes("saved preview is shown"));
		expect(parent.querySelector("img")!.src).toBe("blob:private-picture");
		expect(parent.querySelector("button")!.disabled).toBe(false);
	} finally { picture.dispose(); store.close(); parent.remove(); }
});
