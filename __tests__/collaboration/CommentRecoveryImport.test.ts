/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import { webcrypto } from "node:crypto";
import type { App } from "obsidian";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import type { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { CommentRecoveryImportModal } from "../../src/collaboration/ui/CommentRecoveryImport";
import { saveLocalWorkRecovery, type LocalWorkIO } from "../../src/collaboration/LocalWorkRecovery";
import type { LocalWorkImportIO } from "../../src/collaboration/LocalWorkImport";
import { protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";

jest.mock("obsidian", () => ({ Platform: { isMobile: false }, Modal: class {
	contentEl = document.createElement("div"); setTitle() {}
	close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
Object.assign(globalThis, { IDBKeyRange, TextEncoder, TextDecoder, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; }, appendText(this: HTMLElement, text: string) { this.append(document.createTextNode(text)); } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "import-ui" }, scope = id(3);
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
	throw new Error("Recovery view did not settle");
}
async function fixture(count = 1, foreign = false) {
	const texts = new Map<string, string>(), folders = new Set<string>();
	const io: LocalWorkIO & LocalWorkImportIO = {
		mkdir: async path => { folders.add(path); }, write: async (path, text) => { texts.set(path, text); },
		read: jest.fn(async path => texts.get(path)!), stat: jest.fn(async path => folders.has(path) ? { type: "folder" as const, size: 0 } : texts.has(path) ? { type: "file" as const, size: new TextEncoder().encode(texts.get(path)!).byteLength } : null),
		writeBinary: jest.fn(), readBinary: jest.fn().mockRejectedValue(new Error("No pictures")),
	};
	const source = await DiscussionStore.open({ ...identity, vaultId: "source", ...(foreign ? { accountId: id(99) } : {}) }, new IDBFactory());
	for (let n = 0; n < count; n++) await source.saveDraft({ id: "draft:" + String(n).padStart(3, "0"), scopeId: scope, revision: 0, body: protocolJson(editableCommentDraft({ version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Rich draft " + n, marks: ["bold"] }] }] }, () => "Member")), target: { version: 1, type: "note" } });
	if (count > 1) await source.setPreference("online:draft:000", { operationId: id(20) });
	const path = await saveLocalWorkRecovery(source, io, () => true); source.close(); jest.mocked(io.read).mockClear();
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = { identity, send: jest.fn(), sendOnline: jest.fn() };
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport); const wake = jest.spyOn(session.outbox, "wake");
	let current = true;
	const modal = new CommentRecoveryImportModal({} as App, session, () => current, io); document.body.append(modal.contentEl); modal.onOpen();
	const button = (label: string) => Array.from(modal.contentEl.querySelectorAll("button")).find(item => item.textContent === label)!;
	const inspect = async () => { const input = modal.contentEl.querySelector("input")!; input.value = path; input.dispatchEvent(new Event("input")); button("Inspect recovery copy").click(); await until(() => !button("Inspect recovery copy").disabled); };
	return { store, session, transport, wake, modal, button, inspect, path, texts, io, invalidate: () => { current = false; modal.validate(); }, close: async () => { modal.onClose(); modal.contentEl.remove(); await session.close(); } };
}

test("opening reads nothing; explicit inspection renders rich review and restore remains entirely local", async () => {
	const f = await fixture();
	try {
		expect(f.io.read).not.toHaveBeenCalled(); expect(f.io.stat).not.toHaveBeenCalled();
		await f.inspect(); expect(f.modal.contentEl.querySelector("strong")?.textContent).toBe("Rich draft 0"); expect(await f.store.storageUsage()).toMatchObject({ drafts: 0 });
		f.button("Restore as a local draft").click(); await until(() => f.modal.contentEl.textContent!.includes("Local draft restored"));
		expect(await f.store.storageUsage()).toMatchObject({ drafts: 1, queued: 0 }); expect(f.wake).not.toHaveBeenCalled(); expect(f.transport.send).not.toHaveBeenCalled(); expect(f.transport.sendOnline).not.toHaveBeenCalled();
		f.button("Restore as a local draft").click(); await until(() => f.modal.contentEl.textContent!.includes("already restored")); expect(await f.store.storageUsage()).toMatchObject({ drafts: 1 });
	} finally { await f.close(); }
});

test("draft pages are bounded and unconfirmed delivery has no restore button", async () => {
	const f = await fixture(12);
	try {
		await f.inspect(); expect(f.modal.contentEl.querySelectorAll("section")).toHaveLength(10);
		const first = f.modal.contentEl.querySelector("section")!; expect(first.textContent).toContain("saved delivery"); expect(first.querySelector("button")).toBeNull();
		f.button("Next drafts").click(); expect(f.modal.contentEl.querySelectorAll("section")).toHaveLength(2); expect(f.modal.contentEl.textContent).toContain("Page 2 of 2");
		f.button("Previous drafts").click(); expect(f.modal.contentEl.querySelectorAll("section")).toHaveLength(10);
	} finally { await f.close(); }
});

test("foreign account recovery can be inspected but offers no applying action", async () => {
	const f = await fixture(1, true);
	try { await f.inspect(); expect(f.modal.contentEl.textContent).toContain("same server, account and shared folder"); expect(f.button("Restore as a local draft")).toBeUndefined(); expect(await f.store.storageUsage()).toMatchObject({ drafts: 0 }); }
	finally { await f.close(); }
});

test("account loss while files are reread cancels application and late content never returns", async () => {
	const f = await fixture();
	try {
		await f.inspect(); let finish!: (text: string) => void;
		jest.mocked(f.io.read).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.button("Restore as a local draft").click(); await until(() => !!finish); f.invalidate(); finish(f.texts.get(f.path + "/COMPLETE.json")!);
		await new Promise(resolve => setTimeout(resolve, 30)); expect(f.modal.contentEl.textContent).toBe(""); expect(await f.store.storageUsage()).toMatchObject({ drafts: 0 }); expect(f.wake).not.toHaveBeenCalled();
	} finally { await f.close(); }
});

test("editing the selected path removes the previous review and its restore controls", async () => {
	const f = await fixture();
	try { await f.inspect(); const input = f.modal.contentEl.querySelector("input")!; input.value = "another"; input.dispatchEvent(new Event("input")); expect(f.button("Restore as a local draft")).toBeUndefined(); }
	finally { await f.close(); }
});
