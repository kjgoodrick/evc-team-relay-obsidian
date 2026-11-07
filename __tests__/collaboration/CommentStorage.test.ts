/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import { webcrypto } from "node:crypto";
import type { App } from "obsidian";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import type { DiscussionStorageUsage } from "../../src/collaboration/storage/CachePolicy";
import { CommentStorageModal } from "../../src/collaboration/ui/CommentStorage";
import { pictureHash } from "../../src/collaboration/PictureProtocol";
jest.mock("obsidian", () => ({ Modal: class {
	contentEl = document.createElement("div"); setTitle() {}
	close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
Object.assign(globalThis, { IDBKeyRange, TextEncoder, TextDecoder, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mib = 1024 * 1024;
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
	throw new Error("Storage view did not settle");
}
async function fixture() {
	const store = await DiscussionStore.open({ serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "cache-ui" }, new IDBFactory());
	const listeners = new Set<() => void>(); let current = true;
	const session = { status: "offline", store, onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		setPictureCacheLimit: jest.fn(async (value: number) => store.setPictureCacheLimit(value)), clearDownloadedPictures: jest.fn(async () => store.clearDownloadedPictures()) };
	const modal = new CommentStorageModal({} as App, session as unknown as DiscussionSession, () => current); document.body.append(modal.contentEl);
	const button = (label: string) => Array.from(modal.contentEl.querySelectorAll("button")).find(item => item.textContent === label)!;
	return { store, session, modal, button, listeners, invalidate: () => { current = false; modal.validate(); }, close: () => { modal.onClose(); modal.contentEl.remove(); store.close(); } };
}

test("offline storage controls show usage, save limits and clear only downloaded bytes", async () => {
	const f = await fixture();
	try {
		await f.store.saveDraft({ id: "keep", scopeId: id(3), revision: 0, body: "Saved draft" });
		const bytes = new ArrayBuffer(3), rendition = { sha256: await pictureHash(bytes), size: 3, mime: "image/png" as const, width: 1, height: 1 };
		await f.store.cachePicture(id(3), id(4), "content", rendition, bytes, 0);
		await f.modal.onOpen(); expect(f.modal.contentEl.textContent).toContain("Saved drafts: 1");
		const select = f.modal.contentEl.querySelector("select")!; expect(select.value).toBe(String(100 * mib));
		select.value = String(25 * mib); select.dispatchEvent(new Event("change")); f.button("Save cache limit").click();
		await until(() => f.modal.contentEl.textContent!.includes("Picture cache limit saved"));
		expect(f.session.setPictureCacheLimit).toHaveBeenCalledWith(25 * mib);
		await until(() => !f.button("Clear downloaded pictures").disabled); f.button("Clear downloaded pictures").click();
		await until(() => f.modal.contentEl.textContent!.includes("Downloaded pictures cleared"));
		expect(await f.store.storageUsage()).toMatchObject({ drafts: 1, cachedPictures: 0, pictureCacheLimit: 25 * mib });
		expect((await f.store.getDraft("keep"))?.body).toBe("Saved draft");
	} finally { f.close(); }
});

test("usage refresh does not overwrite an unsaved limit selection", async () => {
	const f = await fixture();
	try {
		await f.modal.onOpen(); const select = f.modal.contentEl.querySelector("select")!;
		select.value = "0"; select.dispatchEvent(new Event("change"));
		await f.store.setPictureCacheLimit(50 * mib);
		f.button("Refresh storage usage").click(); await until(() => f.modal.contentEl.textContent!.includes("of 50 MiB"));
		expect(select.value).toBe("0"); expect(f.button("Save cache limit").disabled).toBe(false);
	} finally { f.close(); }
});

test("a usage read started before a limit change cannot replace its fresh result", async () => {
	const f = await fixture();
	try {
		await f.modal.onOpen(); const oldUsage = await f.store.storageUsage();
		let finish!: (value: DiscussionStorageUsage) => void;
		jest.spyOn(f.store, "storageUsage").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.button("Refresh storage usage").click();
		const select = f.modal.contentEl.querySelector("select")!; select.value = String(25 * mib); select.dispatchEvent(new Event("change"));
		f.button("Save cache limit").click(); await until(() => f.modal.contentEl.textContent!.includes("Picture cache limit saved"));
		finish(oldUsage); await until(() => f.modal.contentEl.textContent!.includes("of 25 MiB"));
		expect(select.value).toBe(String(25 * mib));
	} finally { f.close(); }
});

test("account loss clears the panel and late reads cannot restore its content", async () => {
	const f = await fixture();
	try {
		const usage = await f.store.storageUsage(); let finish!: (value: DiscussionStorageUsage) => void;
		jest.spyOn(f.store, "storageUsage").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const opening = f.modal.onOpen(); f.invalidate(); finish(usage); await opening;
		expect(f.modal.contentEl.textContent).toBe(""); expect(f.listeners.size).toBe(0);
	} finally { f.close(); }
});
