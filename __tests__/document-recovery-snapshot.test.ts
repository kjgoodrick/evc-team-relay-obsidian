import "fake-indexeddb/auto";
import * as Y from "yjs";
import { LocalDocumentStore } from "../src/storage/local-document-store";
import { readDocumentComparisonSnapshot, readDocumentRecoverySnapshot } from "../src/storage/document-recovery-snapshot";

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

test("bounded source inspection reads only associations and update cursors, leaving raw storage unchanged", async () => {
	const cacheName = name(), source = new Y.Doc(), store = new LocalDocumentStore(cacheName, source);
	await store.whenSynced; source.getText("contents").insert(0, "source comparison");
	await store.set("appId", "host"); await store.set("s3rn", "address"); await store.set("unrelated", new ArrayBuffer(1024 * 1024)); await store.close(); source.destroy();
	const before = await readDocumentRecoverySnapshot(cacheName);
	const getAll = jest.spyOn(IDBObjectStore.prototype, "getAll"), keys = jest.spyOn(IDBObjectStore.prototype, "getAllKeys");
	try {
		const result = await readDocumentComparisonSnapshot(cacheName);
		expect(result).toMatchObject({ exists: true, appId: "host", s3rn: "address", update: before.update, updateCount: before.updateCount });
		expect(getAll).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
	} finally { getAll.mockRestore(); keys.mockRestore(); }
	expect(await readDocumentRecoverySnapshot(cacheName)).toEqual(before);
});

test("an absent comparison cache is not created and already-cancelled reads never open it", async () => {
	const cacheName = name(), abort = new AbortController();
	expect(await readDocumentComparisonSnapshot(cacheName)).toMatchObject({ exists: false, updateCount: 0 });
	abort.abort(); const open = jest.spyOn(indexedDB, "open");
	try { await expect(readDocumentComparisonSnapshot(cacheName, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" }); expect(open).not.toHaveBeenCalled(); }
	finally { open.mockRestore(); }
	expect((await indexedDB.databases()).some(db => db.name === cacheName)).toBe(false);
});

test.each(["bytes", "backing buffer", "rows", "bad update", "association"])("a comparison refuses excess or invalid %s while export still retains the original records", async kind => {
	const cacheName = name(), db = await rawDatabase(cacheName), source = new Y.Doc(); source.getText("contents").insert(0, "retained source");
	const update = Y.encodeStateAsUpdate(source); source.destroy();
	let value: unknown = update;
	if (kind === "backing buffer") { const backing = new Uint8Array(update.length + 20); backing.set(update); value = backing.subarray(0, update.length); }
	if (kind === "bad update") value = new Uint8Array([255]);
	await append(db, value); if (kind === "rows") await append(db, update);
	if (kind === "association") await new Promise<void>(resolve => { const tx = db.transaction("custom", "readwrite"); tx.objectStore("custom").put({ wrong: true }, "appId"); tx.oncomplete = () => resolve(); });
	db.close();
	const options = kind === "bytes" ? { maxBytes: 1 } : kind === "backing buffer" ? { maxBytes: update.length } : kind === "rows" ? { maxRecords: 1 } : {};
	await expect(readDocumentComparisonSnapshot(cacheName, options)).rejects.toThrow();
	if (kind !== "bad update") expect((await readDocumentRecoverySnapshot(cacheName)).updateCount).toBe(kind === "rows" ? 2 : 1);
	else { const reopened = await rawDatabase(cacheName); const tx = reopened.transaction("updates", "readonly"); const row = tx.objectStore("updates").get(1); await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); expect(row.result).toEqual(value); reopened.close(); }
});

test.each(["context", "abort"])("a source comparison stops a cache cursor after %s invalidation", async kind => {
	const cacheName = name(), db = await rawDatabase(cacheName); await append(db, new Uint8Array([0, 0])); db.close();
	const abort = new AbortController(); let checks = 0;
	await expect(readDocumentComparisonSnapshot(cacheName, { signal: abort.signal, check: () => {
		if (++checks < 3) return;
		if (kind === "abort") abort.abort(); else throw new Error("Source context changed");
	} })).rejects.toThrow(kind === "abort" ? "cancelled" : "context changed");
	expect((await readDocumentRecoverySnapshot(cacheName)).updateCount).toBe(1);
});

test("cancelling a comparison blocked behind cache deletion cannot create a database later", async () => {
	const cacheName = name(), held = await rawDatabase(cacheName), abort = new AbortController();
	const deletion = indexedDB.deleteDatabase(cacheName), deleted = new Promise<void>((resolve, reject) => { deletion.onsuccess = () => resolve(); deletion.onerror = () => reject(deletion.error); });
	try {
		await new Promise<void>(resolve => { deletion.onblocked = () => resolve(); });
		const pending = readDocumentComparisonSnapshot(cacheName, { signal: abort.signal }); abort.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" }); held.close(); await deleted;
		for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve));
		expect((await indexedDB.databases()).some(db => db.name === cacheName)).toBe(false);
	} finally { held.close(); }
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
