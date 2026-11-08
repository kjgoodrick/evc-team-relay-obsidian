import "fake-indexeddb/auto";
import * as Y from "yjs";
import { ResourceAddress, RemoteDocumentAddress, RemoteCanvasAddress, RemoteFolderAddress } from "../src/ResourceAddress";
import { ItemKind } from "../src/ItemKinds";
import { openSourceDocumentCache, sourceDocumentCache, openSourceInventoryCache, sourceInventoryCache, type SourceDocumentIdentity } from "../src/storage/source-document-cache";
import { discoverSourceRecovery } from "../src/storage/discover-source-recovery";
import { SOURCE_CACHE_IDENTITY } from "../src/storage/document-cache-binding";

function fixture() {
	const share = new RemoteFolderAddress("relay-onprem", crypto.randomUUID()), id = crypto.randomUUID();
	const scope = { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test", share };
	const identity = { ...scope, s3rn: ResourceAddress.serialize(new RemoteDocumentAddress(share.relayGuid, share.folderGuid, id)), restoreGeneration: crypto.randomUUID() };
	return { scope, identity, id };
}
async function save(identity: SourceDocumentIdentity, inventory = false) {
	const doc = new Y.Doc(), store = await (inventory ? openSourceInventoryCache(identity, doc) : openSourceDocumentCache(identity, doc));
	doc.getText("contents").insert(0, "content discovery must not read");
	await store.close(); doc.destroy(); return inventory ? sourceInventoryCache(identity) : sourceDocumentCache(identity);
}
afterEach(() => jest.restoreAllMocks());

test("catalog discovery preserves separate inventory generations without reading their update logs", async () => {
	const f = fixture(), selected = { ...f.identity, s3rn: ResourceAddress.serialize(f.scope.share) };
	const first = await save(selected, true), second = await save({ ...selected, restoreGeneration: crypto.randomUUID() }, true);
	const source = await save(f.identity);
	const all = jest.spyOn(IDBObjectStore.prototype, "getAll"), get = jest.spyOn(IDBObjectStore.prototype, "get");
	const found = await discoverSourceRecovery(f.scope);
	expect(found.inventories).toEqual(expect.arrayContaining([
		{ cacheName: first.name, sourceIdentity: first.identity }, { cacheName: second.name, sourceIdentity: second.identity },
	]));
	expect(found.inventories).toHaveLength(2); expect(found.documents).toHaveLength(1);
	expect(found.documents[0].cacheName).toBe(source.name);
	expect(all).not.toHaveBeenCalled(); expect(new Set(get.mock.calls.map(call => call[0]))).toEqual(new Set([SOURCE_CACHE_IDENTITY]));
});

test("catalog discovery keeps same-ID histories in multiple generations and kinds separate without loading contents", async () => {
	const f = fixture(), first = await save(f.identity), second = await save({ ...f.identity, restoreGeneration: crypto.randomUUID() });
	const canvas = await save({ ...f.identity, s3rn: ResourceAddress.serialize(new RemoteCanvasAddress(f.scope.share.relayGuid, f.scope.share.folderGuid, f.id)) });
	const all = jest.spyOn(IDBObjectStore.prototype, "getAll"), get = jest.spyOn(IDBObjectStore.prototype, "get");
	const found = await discoverSourceRecovery(f.scope);
	expect(found.documents).toHaveLength(3);
	expect(found.documents).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: f.id, type: ItemKind.Document, cacheName: first.name }),
		expect.objectContaining({ id: f.id, type: ItemKind.Document, cacheName: second.name }),
		expect.objectContaining({ id: f.id, type: ItemKind.Canvas, cacheName: canvas.name }),
	]));
	expect(all).not.toHaveBeenCalled(); expect(new Set(get.mock.calls.map(call => call[0]))).toEqual(new Set([SOURCE_CACHE_IDENTITY]));
});

test.each(["vault", "server", "endpoint", "share", "relay"])("a different %s never contributes history", async difference => {
	const f = fixture(), other = { ...f.identity };
	if (difference === "vault") other.hostAppId = crypto.randomUUID();
	if (difference === "server") other.serverId = "different";
	if (difference === "endpoint") other.controlPlaneUrl = "https://different.test";
	if (difference === "share" || difference === "relay") other.s3rn = ResourceAddress.serialize(new RemoteDocumentAddress(
		difference === "relay" ? "different" : f.scope.share.relayGuid, difference === "share" ? crypto.randomUUID() : f.scope.share.folderGuid, f.id));
	await save(other);
	const address = ResourceAddress.parse(other.s3rn) as RemoteDocumentAddress;
	await save({ ...other, s3rn: ResourceAddress.serialize(new RemoteFolderAddress(address.relayGuid, address.folderGuid)) }, true);
	const found = await discoverSourceRecovery(f.scope);
	expect(found.documents).toEqual([]); expect(found.inventories).toEqual([]);
});

test("missing catalog access reports limited coverage and leaves histories intact", async () => {
	const f = fixture(); await save(f.identity);
	jest.spyOn(indexedDB, "databases").mockRejectedValueOnce(new Error("unavailable"));
	expect(await discoverSourceRecovery(f.scope)).toMatchObject({ status: "unavailable", documents: [] });
	expect((await discoverSourceRecovery(f.scope)).documents).toHaveLength(1);
});

test("a changing source context aborts even when catalog access also fails", async () => {
	const f = fixture(), check = jest.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("changed"); });
	jest.spyOn(indexedDB, "databases").mockRejectedValueOnce(new Error("unavailable"));
	await expect(discoverSourceRecovery(f.scope, check)).rejects.toThrow("changed");
});

test("a cache whose name does not match its recorded identity cannot be associated", async () => {
	const f = fixture(), saved = await save(f.identity), alternate = await sourceDocumentCache({ ...f.identity, restoreGeneration: crypto.randomUUID() });
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(saved.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
	});
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction("custom", "readwrite"); tx.objectStore("custom").put(alternate.identity, SOURCE_CACHE_IDENTITY);
		tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
	}); db.close();
	expect((await discoverSourceRecovery(f.scope)).documents).toEqual([]);
});
