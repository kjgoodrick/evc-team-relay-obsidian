import "fake-indexeddb/auto";
import * as Y from "yjs";
import { LocalDocumentStore } from "../src/storage/local-document-store";
import { readDocumentRecoverySnapshot } from "../src/storage/document-recovery-snapshot";

const name = () => `snapshot-${crypto.randomUUID()}`;
async function rawDatabase(cacheName: string, schema = true): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(cacheName);
		request.onupgradeneeded = () => {
			if (schema) { request.result.createObjectStore("updates", { autoIncrement: true }); request.result.createObjectStore("custom"); }
		};
		request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
	});
}
async function append(db: IDBDatabase, update: unknown) {
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction("updates", "readwrite"); tx.objectStore("updates").add(update);
		tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
	});
}

test("a missing cache remains absent after inspection", async () => {
	const cacheName = name();
	expect(await readDocumentRecoverySnapshot(cacheName)).toMatchObject({ exists: false, updateCount: 0, custom: [] });
	expect((await indexedDB.databases()).some(db => db.name === cacheName)).toBe(false);
});

test("inspection preserves updates, review metadata and raw custom values without appending captured live edits", async () => {
	const cacheName = name(), source = new Y.Doc(), store = new LocalDocumentStore(cacheName, source);
	await store._dbref; source.getText("contents").insert(0, "retained work");
	await store.rememberSyncBase("earlier shared text"); await store.markRestoreReview();
	await store.set("s3rn", "fixture-identity"); await store.set("extension-value", new Date("2026-11-08T00:00:00Z"));
	await store.close(); source.destroy();
	const before = await readDocumentRecoverySnapshot(cacheName), recovered = new Y.Doc({ gc: false });
	Y.applyUpdate(recovered, before.update); expect(recovered.getText("contents").toString()).toBe("retained work");
	expect(Object.fromEntries(before.custom.map(item => [item.key, item.value]))).toMatchObject({
		syncBase: "earlier shared text", restoreReviewRequired: 1, s3rn: "fixture-identity", "extension-value": new Date("2026-11-08T00:00:00Z"),
	});
	recovered.getText("contents").insert(0, "export-only overlay "); recovered.destroy();
	const after = await readDocumentRecoverySnapshot(cacheName);
	expect(after.updateCount).toBe(before.updateCount); expect(after.update).toEqual(before.update); expect(after.custom).toEqual(before.custom);
});

test("a pending dependency remains recoverable after snapshotting an incomplete update log", async () => {
	const source = new Y.Doc(), updates: Uint8Array[] = [];
	source.on("update", update => updates.push(update));
	source.getMap("seed").set("owner", "fixture"); source.getText("contents").insert(0, "offline work with missing seed");
	const cacheName = name(), db = await rawDatabase(cacheName);
	await append(db, updates[1]); db.close();
	const snapshot = await readDocumentRecoverySnapshot(cacheName), recovered = new Y.Doc();
	Y.applyUpdate(recovered, snapshot.update); expect(recovered.getText("contents").toString()).toBe("");
	const exported = new Y.Doc(); Y.applyUpdate(exported, Y.encodeStateAsUpdate(recovered));
	Y.applyUpdate(exported, updates[0]); expect(exported.getText("contents").toString()).toBe("offline work with missing seed");
	Y.applyUpdate(recovered, updates[0]); expect(recovered.getText("contents").toString()).toBe("offline work with missing seed");
	source.destroy(); recovered.destroy(); exported.destroy();
});

test("snapshotting does not garbage-collect retained deleted document content", async () => {
	const source = new Y.Doc({ gc: false }); source.getText("contents").insert(0, "deleted but retained"); source.getText("contents").delete(0, 20);
	const encoded = Y.encodeStateAsUpdate(source), cacheName = name(), db = await rawDatabase(cacheName);
	await append(db, encoded); db.close();
	const snapshot = await readDocumentRecoverySnapshot(cacheName);
	expect(snapshot.update).toEqual(encoded); source.destroy();
});

test.each(["wrong record type", "broken update", "unknown schema"])("invalid %s is rejected without changing or deleting the cache", async kind => {
	const cacheName = name(), db = await rawDatabase(cacheName, kind !== "unknown schema");
	if (kind !== "unknown schema") await append(db, kind === "broken update" ? new Uint8Array([255]) : { content: "unsupported" });
	db.close();
	await expect(readDocumentRecoverySnapshot(cacheName)).rejects.toThrow();
	expect((await indexedDB.databases()).some(db => db.name === cacheName)).toBe(true);
	const reopened = await rawDatabase(cacheName, false); expect(reopened.version).toBe(1); reopened.close();
});

test("an open queued behind another window's deletion times out and cannot later create a cache", async () => {
	jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
	const cacheName = name(), held = await rawDatabase(cacheName);
	try {
		const deletion = indexedDB.deleteDatabase(cacheName);
		const deleted = new Promise<void>((resolve, reject) => { deletion.onsuccess = () => resolve(); deletion.onerror = () => reject(deletion.error); });
		await new Promise<void>(resolve => { deletion.onblocked = () => resolve(); });
		const timedOut = expect(readDocumentRecoverySnapshot(cacheName)).rejects.toThrow("timed out");
		await jest.advanceTimersByTimeAsync(10_001); await timedOut;
		held.close(); await deleted;
		for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve));
		expect((await indexedDB.databases()).some(db => db.name === cacheName)).toBe(false);
	} finally { held.close(); jest.useRealTimers(); }
});
