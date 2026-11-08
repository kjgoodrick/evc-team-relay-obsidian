import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type Draft } from "../../src/collaboration/storage/DiscussionStore";
import { type ImportedDraftOrigin } from "../../src/collaboration/storage/ImportedDrafts";
import { pictureHash, prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
import { protocolJson } from "../../src/collaboration/DiscussionProtocol";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "destination" }, scope = id(3);
const origin: ImportedDraftOrigin = { version: 1, manifestSha256: "a".repeat(64), snapshotId: id(4), draftId: "original", scopeId: scope, identity: { ...identity, vaultId: "source" } };
const draft = (n = 5): Draft => ({ id: "imported:" + id(n), scopeId: scope, revision: 0, body: { text: "Recovered", mentions: [], pictures: [{ type: "picture", picture_id: id(9), alt: "Original" }] }, target: { version: 1, type: "note" } });
const picture = () => prepareLocalPicture(id(9), scope, new Uint8Array([1, 2, 3]).buffer);
const key = async () => "importReceipt:" + await pictureHash(new TextEncoder().encode(JSON.stringify([origin.manifestSha256, origin.snapshotId, origin.draftId, origin.scopeId])).buffer);

test("imports one independent draft, picture and provenance without touching queued work; survives reopen", async () => {
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory);
	try {
		await store.saveDraft({ id: "original", scopeId: scope, revision: 3, body: "Newer source" });
		await store.enqueue({ operationId: id(20), scopeId: scope, type: "reply.create", payload: "pending", dependsOn: [] });
		const waiting = await store.getOperation(id(20));
		const result = await store.importLocalDraft(origin, draft(), [await picture()], () => true);
		expect(result.created).toBe(true); expect(result.receipt.origin).toEqual(origin);
		store.close(); store = await DiscussionStore.open(identity, factory);
		expect(await store.getDraft(draft().id)).toEqual(draft()); expect((await store.getDraft("original"))?.body).toBe("Newer source");
		expect(await store.getOperation(id(20))).toEqual(waiting);
		expect(await store.storageUsage()).toMatchObject({ drafts: 2, queued: 1, savedPictures: 1, savedPictureBytes: 3 });
		expect(await store.preference("importedDraft:" + draft().id)).toEqual(origin);
		expect((await store.localDraftPage()).items.find(item => item.draft.id === draft().id)?.imported).toBe(true);
		const capture = await store.captureLocalWork(id(30));
		expect(capture.actions).toContainEqual({ key: "importedDraft:" + draft().id, value: origin });
	} finally { store.close(); }
});

test("competing windows import once and repeats preserve edits and do not recreate a discarded copy", async () => {
	const factory = new IDBFactory(), store = await DiscussionStore.open(identity, factory), other = await DiscussionStore.open(identity, factory);
	try {
		const source = await picture();
		const results = await Promise.all([store.importLocalDraft(origin, draft(), [source], () => true), other.importLocalDraft(origin, draft(6), [source], () => true)]);
		expect(results.filter(result => result.created)).toHaveLength(1); expect(results[0].receipt).toEqual(results[1].receipt);
		const copied = (await store.getDraft(results[0].receipt.draftId))!;
		await store.saveDraft({ ...copied, revision: 1, body: "Edited" }, 0);
		expect((await other.importLocalDraft(origin, draft(7), [source], () => true)).created).toBe(false);
		expect((await store.getDraft(copied.id))?.body).toBe("Edited");
		await store.removeDraft(copied.id, 1);
		expect((await other.importLocalDraft(origin, draft(8), [source], () => true)).created).toBe(false);
		expect(await store.storageUsage()).toMatchObject({ drafts: 0, savedPictures: 0, queued: 0 });
		const capture = await store.captureLocalWork(id(30)); expect(capture.actions).toEqual([]);
	} finally { store.close(); other.close(); }
});

test.each(["account", "server", "share", "scope", "identity", "picture_scope", "picture_hash", "picture_collision", "quota", "receipt"])("refuses %s and rolls back draft, source ownership and receipts", async change => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		const selected = structuredClone(origin), copy = draft(), source = await picture();
		if (change === "account") selected.identity.accountId = id(99);
		if (change === "server") selected.identity.serverId = "https://other.test";
		if (change === "share") selected.identity.shareId = id(99);
		if (change === "scope") copy.scopeId = id(99);
		if (change === "identity") copy.id = "new:" + scope;
		if (change === "picture_scope") source.scopeId = id(99);
		if (change === "picture_hash") source.sha256 = "b".repeat(64);
		if (change === "picture_collision") await store.saveDraft({ ...draft(99), id: "existing" }, null, [await prepareLocalPicture(id(9), scope, new Uint8Array([9]).buffer)]);
		if (change === "quota") await store.setPreference("pictureSourceBytes", 100 * 1024 * 1024);
		if (change === "receipt") await store.setPreference(await key(), protocolJson({ version: 1, draftId: "imported:bad", scopeId: scope, importedAt: 0, origin }));
		const before = await store.storageUsage();
		await expect(store.importLocalDraft(selected, copy, [source], () => true)).rejects.toThrow();
		expect(await store.getDraft(copy.id)).toBeUndefined(); expect(await store.preference("importedDraft:" + copy.id)).toBeUndefined();
		expect(await store.storageUsage()).toEqual(before);
		if (change !== "receipt") expect(await store.preference(await key())).toBeUndefined();
	} finally { store.close(); }
});

test.each([0, 1, 2])("context loss at check %i leaves no partial import", async stage => {
	const store = await DiscussionStore.open(identity, new IDBFactory()); let checks = 0;
	try {
		await expect(store.importLocalDraft(origin, draft(), [await picture()], () => checks++ < stage)).rejects.toThrow("changed");
		expect(await store.storageUsage()).toMatchObject({ drafts: 0, savedPictures: 0, savedPictureBytes: 0, queued: 0 });
		expect(await store.preference(await key())).toBeUndefined();
	} finally { store.close(); }
});
