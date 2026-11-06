import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const fixtures = JSON.parse(readFileSync(join(__dirname, "fixtures/comment-pictures.json"), "utf8")) as Record<string, string>;
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionPictures } from "../../src/collaboration/DiscussionPictures";
import { DiscussionFailure } from "../../src/collaboration/DiscussionTransport";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { pictureHash, prepareLocalPicture, type PictureRendition } from "../../src/collaboration/PictureProtocol";
Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry = id(3), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "picture-cache" };
const bytes = () => new Uint8Array(Buffer.from(fixtures.png, "base64")).buffer;
let factory: IDBFactory, store: DiscussionStore, rendition: PictureRendition;
beforeEach(async () => {
	factory = new IDBFactory(); store = await DiscussionStore.open(identity, factory);
	rendition = { sha256: await pictureHash(bytes()), size: bytes().byteLength, mime: "image/png", width: 8, height: 6 };
});
afterEach(() => { store.close(); jest.restoreAllMocks(); });
function setup() {
	const transport = { picture: jest.fn().mockImplementation(async (_entry: string, pictureId: string) => ({ picture_id: pictureId, renditions: { thumbnail: rendition, content: rendition } })),
		pictureContent: jest.fn().mockResolvedValue(bytes()) };
	const session = { store, status: "ready", online: true, transport,
		permission: () => ({ read: true }), trackLocal: <T>(flight: Promise<T>) => flight };
	return { transport, session, loader: new DiscussionPictures(session as unknown as DiscussionSession) };
}

test("downloads once but reauthorizes every online read, then serves a verified cached rendition offline", async () => {
	const { loader, session, transport } = setup();
	expect(await loader.load(entry, id(5))).toMatchObject({ offline: false, local: false, bytes: bytes() });
	expect(await loader.load(entry, id(5))).toMatchObject({ offline: false });
	expect(transport.picture).toHaveBeenCalledTimes(2); expect(transport.pictureContent).toHaveBeenCalledTimes(1);
	session.online = false; expect(await loader.load(entry, id(5))).toMatchObject({ offline: true, bytes: bytes() });
	expect(transport.picture).toHaveBeenCalledTimes(2);
	store.close(); store = await DiscussionStore.open(identity, factory);
	expect((await store.cachedPicture(entry, id(5), "thumbnail"))?.bytes).toEqual(bytes());
});

test("403/404 authorization failures purge both variants and never fall back to cached content", async () => {
	const { loader, transport, session } = setup(); await loader.load(entry, id(5)); await loader.load(entry, id(5), "content");
	transport.picture.mockRejectedValue(new DiscussionFailure("reject", "target_unavailable", 404));
	await expect(loader.load(entry, id(5))).rejects.toMatchObject({ status: 404 });
	expect(await store.cachedPicture(entry, id(5), "thumbnail")).toBeUndefined(); expect(await store.cachedPicture(entry, id(5), "content")).toBeUndefined();
	expect(await store.preference("pictureCacheBytes")).toBe(0); session.online = false;
	await expect(loader.load(entry, id(5))).rejects.toThrow("not saved");
});

test("a late download cannot repopulate or display a revoked scope; unsent originals are retained", async () => {
	const { loader, transport, session } = setup(); let finish!: (value: ArrayBuffer) => void;
	transport.pictureContent.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
	const source = await prepareLocalPicture(id(6), entry, bytes());
	await store.saveDraft({ id: "local", scopeId: entry, revision: 0, body: { text: "", mentions: [], pictures: [{ type: "picture", picture_id: id(6) }] } }, null, [source]);
	const flight = loader.load(entry, id(5));
	for (let i = 0; i < 50 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 1));
	session.permission = () => ({ read: false }); await store.clearRemoteScope(entry); finish(bytes());
	await expect(flight).rejects.toThrow("Access"); expect(await store.cachedPicture(entry, id(5), "thumbnail")).toBeUndefined();
	expect((await loader.load(entry, id(6), "thumbnail", true)).local).toBe(true);
	expect(await store.cachePicture(entry, id(5), "thumbnail", rendition, bytes(), 0)).toBe(false);
});

test("image downloads deduplicate and run at most two reads at once; closing stops waiting work", async () => {
	const { loader, transport, session } = setup(), finish: ((value: ArrayBuffer) => void)[] = [];
	transport.pictureContent.mockImplementation(() => new Promise(resolve => finish.push(resolve)));
	const first = loader.load(entry, id(5)), duplicate = loader.load(entry, id(5)), second = loader.load(entry, id(6)), third = loader.load(entry, id(7));
	expect(first).toBe(duplicate);
	const outcomes = Promise.allSettled([first, second, third]);
	for (let i = 0; i < 50 && finish.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 1));
	expect(transport.pictureContent).toHaveBeenCalledTimes(2); session.status = "closed"; finish.forEach(resolve => resolve(bytes()));
	expect((await outcomes).every(result => result.status === "rejected")).toBe(true);
	expect(transport.pictureContent).toHaveBeenCalledTimes(2);
});

test("disposable cache eviction does not remove original draft bytes or another account's data", async () => {
	const source = await prepareLocalPicture(id(20), entry, bytes());
	await store.saveDraft({ id: "local", scopeId: entry, revision: 0, body: { text: "", mentions: [], pictures: [{ type: "picture", picture_id: id(20) }] } }, null, [source]);
	const large = new ArrayBuffer(10 * 1024 * 1024), metadata = { ...rendition, size: large.byteLength, sha256: await pictureHash(large) };
	let time = 0; jest.spyOn(Date, "now").mockImplementation(() => ++time);
	for (let i = 1; i <= 5; i++) await store.cachePicture(entry, id(i), "content", metadata, large, 0);
	await store.cachedPicture(entry, id(1), "content"); // Keep the recently used first image.
	await store.cachePicture(entry, id(6), "content", metadata, large, 0);
	expect(await store.cachedPicture(entry, id(2), "content")).toBeUndefined();
	expect(await store.cachedPicture(entry, id(1), "content")).toBeDefined(); expect(await store.preference("pictureCacheBytes")).toBe(50 * 1024 * 1024);
	expect(await store.pictureSource(id(20), entry)).toBeDefined();
	const other = await DiscussionStore.open({ ...identity, accountId: id(99) }, factory);
	try { expect(await other.cachedPicture(entry, id(1), "content")).toBeUndefined(); } finally { other.close(); }
	await store.clearRemoteScope(entry); expect(await store.preference("pictureCacheBytes")).toBe(0); expect(await store.pictureSource(id(20), entry)).toBeDefined();
	await store.clearAll(); expect(await store.pictureSource(id(20), entry)).toBeUndefined();
});

test("quota errors cannot prevent an authorized download being displayed; corrupted bytes cannot enter the cache", async () => {
	await expect(store.cachePicture(entry, id(5), "thumbnail", rendition, new ArrayBuffer(12), 0)).rejects.toThrow("Invalid");
	jest.spyOn(store, "cachePicture").mockRejectedValue(new Error("QuotaExceededError"));
	const { loader } = setup(); expect(await loader.load(entry, id(5))).toMatchObject({ bytes: bytes(), offline: false });
});

test("forgetting a denied picture fences other in-flight variants in another window", async () => {
	const generation = (await store.checkpoint(entry)).generation;
	const other = await DiscussionStore.open(identity, factory);
	try {
		await other.forgetPicture(entry, id(5));
		expect(await store.cachePicture(entry, id(5), "content", rendition, bytes(), generation)).toBe(false);
	} finally { other.close(); }
});
