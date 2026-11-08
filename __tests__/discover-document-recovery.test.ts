import "fake-indexeddb/auto";
import { ItemKind } from "../src/ItemKinds";
import { ResourceAddress, RemoteFolderAddress, RemoteDocumentAddress, RemoteCanvasAddress, FolderAddress, DocumentAddress } from "../src/ResourceAddress";
import { discoverDocumentRecovery } from "../src/storage/discover-document-recovery";
import { readDocumentRecoveryIdentity } from "../src/storage/document-recovery-snapshot";

async function cache(name: string, appId: unknown, s3rn: unknown, schema = true) {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onupgradeneeded = () => {
			request.result.createObjectStore("updates", { autoIncrement: true });
			if (schema) request.result.createObjectStore("custom");
		};
		request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
	});
	if (schema) await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(["custom", "updates"], "readwrite");
		tx.objectStore("custom").put(appId, "appId"); tx.objectStore("custom").put(s3rn, "s3rn");
		tx.objectStore("custom").put("comparison text must not be read", "syncBase");
		// Discovery must not inspect or decode this unrelated update log.
		tx.objectStore("updates").add("intentionally unsupported update record");
		tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
	});
	db.close();
}
afterEach(() => jest.restoreAllMocks());

test("discovery reads only exact association fields and never opens another vault's caches", async () => {
	const host = crypto.randomUUID(), folder = new RemoteFolderAddress("relay-one", crypto.randomUUID());
	const note = crypto.randomUUID(), canvas = crypto.randomUUID(), otherHost = crypto.randomUUID();
	const noteName = `${host}-relay-doc-${note}`, canvasName = `${host}-relay-canvas-${canvas}`;
	const noteAddress = ResourceAddress.serialize(new RemoteDocumentAddress(folder.relayGuid, folder.folderGuid, note));
	const canvasAddress = ResourceAddress.serialize(new RemoteCanvasAddress(folder.relayGuid, folder.folderGuid, canvas));
	await cache(noteName, host, noteAddress); await cache(canvasName, host, canvasAddress);
	await cache(`${otherHost}-relay-doc-${note}`, otherHost, noteAddress);
	const before = await indexedDB.databases(), open = jest.spyOn(indexedDB, "open"), get = jest.spyOn(IDBObjectStore.prototype, "get");
	const all = jest.spyOn(IDBObjectStore.prototype, "getAll");
	const found = await discoverDocumentRecovery(host, folder);
	expect(found.status).toBe("available"); expect(found.unassociated).toBe(0); expect(found.unreadable).toBe(0);
	expect(found.documents).toEqual(expect.arrayContaining([
		{ id: note, type: ItemKind.Document, cacheName: noteName, appId: host, s3rn: noteAddress },
		{ id: canvas, type: ItemKind.Canvas, cacheName: canvasName, appId: host, s3rn: canvasAddress },
	]));
	expect(open.mock.calls.map(args => args[0]).sort()).toEqual([noteName, canvasName].sort());
	expect(get.mock.calls.map(args => args[0])).toEqual(["appId", "s3rn", "appId", "s3rn"]);
	expect(all).not.toHaveBeenCalled(); expect(await indexedDB.databases()).toEqual(before);
});

test.each(["other host", "other share", "other relay", "other document", "wrong kind", "extra suffix", "missing metadata", "invalid id"])("%s cannot associate an orphan cache with this shared folder", async reason => {
	const host = crypto.randomUUID(), share = new RemoteFolderAddress("relay-one", crypto.randomUUID());
	const id = crypto.randomUUID(), correct = ResourceAddress.serialize(new RemoteDocumentAddress(share.relayGuid, share.folderGuid, id));
	let appId: unknown = host, s3rn: unknown = correct, suffix: string = id;
	if (reason === "other host") appId = "another-vault";
	if (reason === "other share") s3rn = ResourceAddress.serialize(new RemoteDocumentAddress(share.relayGuid, crypto.randomUUID(), id));
	if (reason === "other relay") s3rn = ResourceAddress.serialize(new RemoteDocumentAddress("another-relay", share.folderGuid, id));
	if (reason === "other document") s3rn = ResourceAddress.serialize(new RemoteDocumentAddress(share.relayGuid, share.folderGuid, crypto.randomUUID()));
	if (reason === "wrong kind") s3rn = ResourceAddress.serialize(new RemoteCanvasAddress(share.relayGuid, share.folderGuid, id));
	if (reason === "extra suffix") s3rn = correct + ":ignored:extra";
	if (reason === "missing metadata") { appId = undefined; s3rn = undefined; }
	if (reason === "invalid id") suffix = "not-a-document-uuid";
	await cache(`${host}-relay-doc-${suffix}`, appId, s3rn);
	expect(await discoverDocumentRecovery(host, share)).toMatchObject({ status: "available", documents: [], unassociated: 1 });
});

test("local folder addresses also require an exact recorded document address", async () => {
	const host = crypto.randomUUID(), share = new FolderAddress(crypto.randomUUID()), id = crypto.randomUUID();
	await cache(`${host}-relay-doc-${id}`, host, ResourceAddress.serialize(new DocumentAddress(share.folderGuid, id)));
	expect((await discoverDocumentRecovery(host, share)).documents.map(d => d.id)).toEqual([id]);
});

test("unreadable identities are counted without guessing ownership or deleting the cache", async () => {
	const host = crypto.randomUUID(), name = `${host}-relay-doc-${crypto.randomUUID()}`;
	await cache(name, host, "unreadable", false);
	expect(await discoverDocumentRecovery(host, new FolderAddress(crypto.randomUUID()))).toMatchObject({ documents: [], unreadable: 1 });
	expect((await indexedDB.databases()).some(db => db.name === name)).toBe(true);
});

test("catalog failures and unsupported hosts explicitly retain limited discovery coverage", async () => {
	const share = new FolderAddress(crypto.randomUUID()), host = crypto.randomUUID();
	const catalog = jest.spyOn(indexedDB, "databases").mockRejectedValue(new Error("catalog unavailable"));
	expect(await discoverDocumentRecovery(host, share)).toMatchObject({ status: "unavailable", documents: [] });
	catalog.mockRestore();
	const descriptor = Object.getOwnPropertyDescriptor(indexedDB, "databases");
	Object.defineProperty(indexedDB, "databases", { value: undefined, configurable: true });
	try { expect(await discoverDocumentRecovery(host, share)).toMatchObject({ status: "unsupported", documents: [] }); }
	finally { if (descriptor) Object.defineProperty(indexedDB, "databases", descriptor); else Reflect.deleteProperty(indexedDB, "databases"); }
});

test("a context change during catalog access is not swallowed as an unavailable catalog", async () => {
	let changed = false;
	jest.spyOn(indexedDB, "databases").mockImplementationOnce(async () => { changed = true; throw new Error("catalog unavailable"); });
	await expect(discoverDocumentRecovery(crypto.randomUUID(), new FolderAddress(crypto.randomUUID()), () => {
		if (changed) throw new Error("account changed");
	})).rejects.toThrow("account changed");
});

test("identity inspection of a vanished catalog entry does not create a database", async () => {
	const name = `absent-${crypto.randomUUID()}`;
	expect(await readDocumentRecoveryIdentity(name)).toEqual({ exists: false });
	expect((await indexedDB.databases()).some(db => db.name === name)).toBe(false);
});
