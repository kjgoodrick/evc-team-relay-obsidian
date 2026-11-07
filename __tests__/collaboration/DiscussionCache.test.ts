import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { pictureHash, prepareLocalPicture, PICTURE_CACHE_QUOTA } from "../../src/collaboration/PictureProtocol";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "cache-controls" }, scope = id(3), mib = 1024 * 1024;
async function picture(size = 4) {
	const bytes = new ArrayBuffer(size), rendition = { sha256: await pictureHash(bytes), size, mime: "image/png" as const, width: 1, height: 1 };
	return { bytes, rendition };
}
test("cache cleanup preserves all saved work and its picture ownership while fencing late downloads", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		const source = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
		const body = { version: 1 as const, blocks: [...bodyFromText("Keep draft").blocks, { type: "picture" as const, picture_id: source.id }] };
		const rich = protocolJson(editableCommentDraft(body, () => "Alice"));
		await store.saveDraft({ id: "draft", scopeId: scope, revision: 0, body: rich }, null, [source]);
		const original = await store.enqueue({ operationId: id(4), scopeId: scope, type: "thread.create", dependsOn: [], payload: { type: "thread.create", thread_id: id(5), message_id: id(6), anchor: { version: 1, type: "note" }, body: protocolJson(body) } }, 1);
		await store.restoreCommandForReview(original, rich);
		const p = await picture(); await store.cachePicture(scope, id(30), "content", p.rendition, p.bytes, 0);
		expect(await store.storageUsage()).toMatchObject({ drafts: 2, queued: 1, review: 1, cachedPictures: 1, cachedPictureBytes: 4, savedPictures: 1, savedPictureBytes: 3, pictureCacheLimit: PICTURE_CACHE_QUOTA });
		await store.clearDownloadedPictures();
		expect(await store.storageUsage()).toMatchObject({ drafts: 2, queued: 1, review: 1, cachedPictures: 0, cachedPictureBytes: 0, savedPictures: 1, savedPictureBytes: 3 });
		expect(await store.cachePicture(scope, id(30), "content", p.rendition, p.bytes, 0, 0)).toBe(false);
		expect(await store.cachePicture(id(99), id(31), "content", p.rendition, p.bytes, 0, 0)).toBe(false);
		expect(await store.cachePicture(scope, id(30), "content", p.rendition, p.bytes, 0, await store.pictureCacheEpoch())).toBe(true);
		expect((await store.getDraft("draft"))?.body).toEqual(rich);
	} finally { store.close(); }
});

test("lower budgets trim oldest downloads atomically and zero still allows local originals", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	const now = jest.spyOn(Date, "now"); let clock = 0; now.mockImplementation(() => ++clock);
	try {
		const p = await picture(mib);
		for (const n of [10, 11, 12]) await store.cachePicture(scope, id(n), "content", p.rendition, p.bytes, 0);
		await store.cachedPicture(scope, id(10), "content");
		await store.setPictureCacheLimit(2 * mib);
		expect(await store.cachedPicture(scope, id(11), "content")).toBeUndefined();
		expect(await store.cachedPicture(scope, id(10), "content")).toBeDefined();
		expect(await store.storageUsage()).toMatchObject({ cachedPictures: 2, cachedPictureBytes: 2 * mib, pictureCacheLimit: 2 * mib });
		await store.setPictureCacheLimit(0);
		expect(await store.cachePicture(scope, id(10), "content", p.rendition, p.bytes, 0, await store.pictureCacheEpoch())).toBe(false);
		expect(await store.storageUsage()).toMatchObject({ cachedPictures: 0, cachedPictureBytes: 0, pictureCacheLimit: 0 });
		for (const limit of [-1, 0.5, 1, NaN, 501 * mib]) await expect(store.setPictureCacheLimit(limit)).rejects.toThrow("limit");
	} finally { now.mockRestore(); store.close(); }
});

test("cache policy is shared between same-account windows and isolated from other accounts", async () => {
	const factory = new IDBFactory(), first = await DiscussionStore.open(identity, factory), second = await DiscussionStore.open(identity, factory);
	const other = await DiscussionStore.open({ ...identity, accountId: id(90) }, factory);
	try {
		await first.setPictureCacheLimit(25 * mib);
		expect((await second.storageUsage()).pictureCacheLimit).toBe(25 * mib);
		expect((await other.storageUsage()).pictureCacheLimit).toBe(100 * mib);
		const epoch = await second.pictureCacheEpoch(), p = await picture();
		await first.clearDownloadedPictures();
		expect(await second.cachePicture(scope, id(30), "content", p.rendition, p.bytes, 0, epoch)).toBe(false);
		expect(await other.cachePicture(scope, id(30), "content", p.rendition, p.bytes, 0, 0)).toBe(true);
	} finally { first.close(); second.close(); other.close(); }
});

test("version-21 upgrade keeps the previous 50 MiB budget and closes workers that ignore cache policy", async () => {
	const factory = new IDBFactory();
	const opening = jest.spyOn(factory, "open").mockImplementationOnce(name => IDBFactory.prototype.open.call(factory, name, 21));
	const old = await DiscussionStore.open(identity, factory); opening.mockRestore();
	await old.saveDraft({ id: "keep", scopeId: scope, revision: 0, body: "Saved before upgrade" });
	const current = await DiscussionStore.open(identity, factory);
	try {
		expect((await current.storageUsage()).pictureCacheLimit).toBe(50 * mib);
		expect((await current.getDraft("keep"))?.body).toBe("Saved before upgrade");
		await expect(old.storageUsage()).rejects.toThrow();
	} finally { old.close(); current.close(); }
});
