import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { prepareLocalPicture, PICTURE_SOURCE_QUOTA } from "../../src/collaboration/PictureProtocol";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "recovery" };
const entry = id(3), oldId = id(4), newId = id(5), operationId = id(6), replacementId = id(7);
const raw = () => new TextEncoder().encode("unchanged saved picture bytes").buffer;
const picture = (picture_id: string) => ({ type: "picture", picture_id, alt: "Keep this description" });
const command = (): QueuedCommand => ({ operationId, scopeId: entry, type: "thread.create", dependsOn: [], payload: {
	type: "thread.create", thread_id: id(8), message_id: id(9), anchor: { version: 1, type: "note" },
	body: { version: 1, blocks: [{ type: "code", text: "Rich content stays exact" }, picture(oldId)] },
} });
let store: DiscussionStore, factory: IDBFactory;
beforeEach(async () => {
	factory = new IDBFactory(); store = await DiscussionStore.open(identity, factory);
	const source = await prepareLocalPicture(oldId, entry, raw());
	await store.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: { text: "Saved", mentions: [], pictures: [picture(oldId)] } }, null, [source]);
	await store.enqueue(command(), 1, { id: "draft", revision: 0 });
});
afterEach(() => store.close());
const replacements = (nextId = newId) => [{ oldId, newId: nextId }];

test("atomic replacement preserves rich body/target, transfers originals and ignores a late upload response", async () => {
	const upload = (await store.claimNext("upload-worker", 2))!;
	const original = (await store.getOperation(operationId))!;
	await store.replacePicturesAfterWithdrawal(original, replacementId, await replacements(), 3);
	expect(await store.getOperation(operationId)).toMatchObject({ state: "withdrawn", replacementId, payload: original.payload });
	expect(await store.getOperation(oldId)).toMatchObject({ state: "withdrawn" });
	await store.accept(oldId, { state: "verified" }); await store.fail(oldId, upload.lease!, "late failure");
	expect((await store.getOperation(oldId))?.state).toBe("withdrawn");
	expect((await store.getOperation(replacementId))?.payload).toEqual({ ...command().payload as object,
		body: { version: 1, blocks: [{ type: "code", text: "Rich content stays exact" }, picture(newId)] } });
	expect((await store.getOperation(replacementId))?.dependsOn).toEqual([newId]);
	expect(await store.pictureSource(oldId, entry)).toBeUndefined();
	expect((await store.pictureSource(newId, entry))?.bytes).toEqual(raw());
	expect(await store.preference("pictureSourceBytes")).toBe(raw().byteLength);
	expect((await store.claimNext("new-worker", 4))?.operationId).toBe(newId);
	await store.accept(newId, { state: "verified" });
	expect((await store.claimNext("new-worker", 5))?.operationId).toBe(replacementId);
	await store.accept(replacementId, {}); expect(await store.pictureSource(newId, entry)).toBeUndefined();
});

test("two windows produce one replacement and keep unsent downstream dependencies runnable", async () => {
	const dependent = { ...command(), operationId: id(20), dependsOn: [operationId], payload: { type: "reply.create", thread_id: id(8), message_id: id(21), body: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Dependent" }] }] } }, type: "reply.create" as const };
	await store.enqueue(dependent, 2);
	const other = await DiscussionStore.open(identity, factory);
	try {
		const a = await replacements(), b = await replacements(id(30));
		const result = await Promise.all([store.replacePicturesAfterWithdrawal(command(), replacementId, a), other.replacePicturesAfterWithdrawal(command(), id(31), b)]);
		expect(result[0]).toBe(result[1]);
		expect((await store.getOperation(id(20)))?.dependsOn).toEqual([result[0]]);
		expect(await store.preference("pictureSourceBytes")).toBe(raw().byteLength);
		expect((await store.pending(entry)).filter(op => op.type === "thread.create")).toHaveLength(1);
	} finally { other.close(); }
});

test("shared originals remain available for other drafts and failed quota rolls back every mutation", async () => {
	await store.saveDraft({ id: "other", scopeId: entry, revision: 0, body: { text: "Another draft", mentions: [], pictures: [picture(oldId)] } });
	await store.setPreference("pictureSourceBytes", PICTURE_SOURCE_QUOTA);
	await expect(store.replacePicturesAfterWithdrawal(command(), replacementId, await replacements())).rejects.toThrow("100 MiB");
	expect((await store.getOperation(operationId))?.state).toBe("queued");
	expect(await store.getOperation(replacementId)).toBeUndefined();
	expect(await store.pictureSource(oldId, entry)).toBeDefined();
	expect(await store.pictureSource(newId, entry)).toBeUndefined();
	await store.setPreference("pictureSourceBytes", raw().byteLength);
	await store.replacePicturesAfterWithdrawal(command(), replacementId, await replacements());
	expect(await store.pictureSource(oldId, entry)).toBeDefined();
	expect(await store.preference("pictureSourceBytes")).toBe(raw().byteLength * 2);
});

test("a local accepted receipt or changed original cannot be overwritten by repair", async () => {
	const changed = command(); (changed.payload as Record<string, unknown>).anchor = { version: 1, type: "different" };
	await expect(store.replacePicturesAfterWithdrawal(changed, replacementId, await replacements())).rejects.toThrow("changed");
	await store.accept(operationId, {});
	await expect(store.replacePicturesAfterWithdrawal(command(), replacementId, await replacements())).rejects.toThrow("completed");
});

test("withdrawal validates exact identities, preserves the wire command and never treats a timeout as retirement", async () => {
	const op = command(), fetcher = jest.fn();
	const transport = new DiscussionTransport(identity, async () => ({ accountId: identity.accountId, accessToken: "synthetic" }), fetcher);
	fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ status: "withdrawn", operation_id: operationId, entry_id: entry })));
	await expect(transport.withdraw(op)).resolves.toEqual({ status: "withdrawn" });
	expect(JSON.parse(fetcher.mock.calls[0][1].body).command).toEqual(op.payload);
	expect(fetcher.mock.calls[0][0]).toBe(identity.serverId + "/v1/collaboration/commands/withdraw");
	fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ status: "withdrawn", operation_id: id(90), entry_id: entry })));
	await expect(transport.withdraw(op)).rejects.toMatchObject({ code: "invalid_withdrawal_response" });
	fetcher.mockRejectedValueOnce(new Error("Lost response"));
	await expect(transport.withdraw(op)).rejects.toMatchObject({ action: "retry" });
	expect((await store.getOperation(operationId))?.state).toBe("queued");
});

test("version-seven upgrade backfills dependencies and preserves queued picture originals", async () => {
	const legacy = new IDBFactory(), name = "team-relay-discussions:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]);
	const old = await new Promise<IDBDatabase>((resolve, reject) => {
		const open = legacy.open(name, 7); open.onerror = () => reject(open.error); open.onsuccess = () => resolve(open.result);
		open.onupgradeneeded = () => {
			const db = open.result;
			db.createObjectStore("drafts", { keyPath: "id" }).createIndex("scopeId", ["scopeId", "id"]);
			for (const key of ["preferences", "cursors", "generations"]) db.createObjectStore(key);
			const outbox = db.createObjectStore("outbox", { keyPath: "operationId" });
			outbox.createIndex("state", "state"); outbox.createIndex("scope", "scopeId"); outbox.createIndex("scopeState", ["scopeId", "state", "createdAt", "operationId"]);
			const entities = db.createObjectStore("entities", { keyPath: ["scopeId", "id"] }); entities.createIndex("scope", "scopeId"); entities.createIndex("ordered", ["scopeId", "collection", "position"]);
			db.createObjectStore("pictureSources", { keyPath: "id" }).createIndex("scope", "scopeId");
			const refs = db.createObjectStore("pictureReferences", { keyPath: ["pictureId", "kind", "ownerId"] }); refs.createIndex("owner", ["kind", "ownerId"]); refs.createIndex("picture", "pictureId");
			const cache = db.createObjectStore("pictureCache", { keyPath: ["scopeId", "id", "variant"] }); cache.createIndex("scope", "scopeId"); cache.createIndex("usedAt", "usedAt");
		};
	});
	const source = await prepareLocalPicture(oldId, entry, raw());
	await new Promise<void>((resolve, reject) => {
		const tx = old.transaction(["outbox", "pictureSources", "pictureReferences", "preferences"], "readwrite");
		tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
		tx.objectStore("pictureSources").put(source); tx.objectStore("preferences").put(source.size, "pictureSourceBytes");
		const state = { state: "queued", createdAt: 1, attempt: 0, nextAttemptAt: 1 };
		tx.objectStore("outbox").put({ ...command(), ...state, dependsOn: [oldId] });
		tx.objectStore("outbox").put({ ...command(), ...state, operationId: id(20), dependsOn: [operationId] });
		tx.objectStore("outbox").put({ operationId: oldId, scopeId: entry, type: "picture.upload", payload: { type: "picture.upload", picture_id: oldId, sha256: source.sha256, size: source.size }, dependsOn: [], ...state });
		for (const ownerId of [oldId, operationId, id(20)]) tx.objectStore("pictureReferences").put({ pictureId: oldId, scopeId: entry, kind: "outbox", ownerId });
	});
	old.close(); const upgraded = await DiscussionStore.open(identity, legacy);
	try {
		await upgraded.replacePicturesAfterWithdrawal(command(), replacementId, replacements());
		expect((await upgraded.getOperation(id(20)))?.dependsOn).toEqual([replacementId]);
		expect((await upgraded.pictureSource(newId, entry))?.bytes).toEqual(raw());
		expect((await upgraded.pictureSource(oldId, entry))?.bytes).toEqual(raw());
	} finally { upgraded.close(); }
});
