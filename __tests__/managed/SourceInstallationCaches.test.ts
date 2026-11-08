import "fake-indexeddb/auto";
import * as Y from "yjs";
import { seedSourceInstallationCaches } from "../../src/SourceInstallationCaches";
import { prepareRecoveryBackup, type RecoveryIO } from "../../src/ManagedRecoveryBackup";
import { stageSourceInstallation } from "../../src/SourceInstallationStaging";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";
import { LocalDocumentStore } from "../../src/storage/local-document-store";
import { openSourceDocumentCache, openSourceInventoryCache, sourceDocumentCacheSync, sourceInventoryCacheSync } from "../../src/storage/source-document-cache";
import { SOURCE_CACHE_IDENTITY } from "../../src/storage/document-cache-binding";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { ItemKind } from "../../src/ItemKinds";
import { UnsavedFileStore } from "../../src/UnsavedFile";
import { assertNoInstallationLocalWork } from "../../src/SourceInstallationLocalWork";

const encode = (text: string) => new TextEncoder().encode(text).buffer;
const journals: SourceSelectionJournal[] = [];
afterEach(() => { journals.splice(0).forEach(journal => journal.close()); jest.restoreAllMocks(); });
async function fixture() {
	const files = new Map<string, ArrayBuffer>(), folders = new Set<string>();
	const io: RecoveryIO & { createDirectoryExclusive(path: string): Promise<void> } = {
		stat: async name => files.has(name) ? { type: "file", size: files.get(name)!.byteLength } : folders.has(name) ? { type: "folder", size: 0 } : null,
		readBinary: async name => { if (!files.has(name)) throw new Error("Missing fixture artifact"); return files.get(name)!.slice(0); },
		mkdir: async name => { folders.add(name); }, createDirectoryExclusive: async name => { if (folders.has(name)) throw new Error("Existing fixture directory"); folders.add(name); },
		write: async (name, text) => { files.set(name, encode(text)); }, writeBinary: async (name, bytes) => { files.set(name, bytes.slice(0)); },
	};
	const backup = await prepareRecoveryBackup(io, async () => ({ files: [{ path: "Team/Note.md", bytes: encode("Old offline text") }], documents: [], index: new Uint8Array([0, 0]) }), {});
	const noteId = crypto.randomUUID(), canvasId = crypto.randomUUID(), note = new Y.Doc(), canvas = new Y.Doc();
	note.getText("contents").insert(0, "Restored note"); canvas.getMap("nodes").set("node", { id: "node", type: "text", x: 0, y: 0, width: 100, height: 100, text: "Restored canvas" });
	const noteUpdate = Y.encodeStateAsUpdate(note), canvasUpdate = Y.encodeStateAsUpdate(canvas); note.destroy(); canvas.destroy();
	const source = { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())), restoreGeneration: crypto.randomUUID() };
	const reviewId = crypto.randomUUID(), staged = await stageSourceInstallation(io, { source, reviewId, archive: backup.reference, originalRoot: "Team", destinationRoot: "Restored Team",
		snapshot: { records: { "Note.md": { id: noteId, version: 0, type: ItemKind.Document }, "Map.canvas": { id: canvasId, version: 0, type: ItemKind.Canvas } },
			permissions: { "Note.md": "read", "Map.canvas": "read" }, activity: {}, owner: false, restore_guard: true, restore_generation: source.restoreGeneration },
	}, { source: async entry => entry.record.id === noteId ? noteUpdate : canvasUpdate, attachment: async () => { throw new Error("Unexpected attachment"); } });
	const journal = await SourceSelectionJournal.open(source); journals.push(journal);
	let selection = await journal.apply({ type: "begin", expectedRevision: null, operationId: crypto.randomUUID(), reviewId, restoreGeneration: source.restoreGeneration });
	selection = await journal.apply({ type: "prepare", expectedRevision: selection.revision, operationId: crypto.randomUUID(), reviewId, preparation: { archive: backup.reference, plan: staged.reference } });
	const prepared = selection;
	selection = await journal.apply({ type: "start", expectedRevision: selection.revision, operationId: crypto.randomUUID(), reviewId });
	const noteIdentity = { ...source, s3rn: `${source.s3rn}:doc:${noteId}` }, canvasIdentity = { ...source, s3rn: `${source.s3rn}:canvas:${canvasId}` };
	return { io, files, staged, journal, prepared, source, noteIdentity, canvasIdentity,
		request: { source, reviewId, revision: selection.revision! }, noteUpdate };
}
async function mutateCache(name: string, action: (custom: IDBObjectStore, updates: IDBObjectStore) => void) {
	const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name, 1);
		request.onupgradeneeded = () => { request.result.createObjectStore("custom"); request.result.createObjectStore("updates", { autoIncrement: true }); };
		request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
	try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(["custom", "updates"], "readwrite");
		tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); action(tx.objectStore("custom"), tx.objectStore("updates")); }); }
	finally { db.close(); }
}
async function readNote(identity: Parameters<typeof openSourceDocumentCache>[0]) {
	const doc = new Y.Doc(), store = await openSourceDocumentCache(identity, doc);
	try { return { text: doc.getText("contents").toString(), serverSync: store.serverSyncKnown, origin: await store.get("origin"), syncBase: await store.get("syncBase") }; }
	finally { await store.close(); doc.destroy(); }
}

test("seeded Markdown, Canvas and inventory reopen through the existing store, stay inactive, and resume exactly", async () => {
	const f = await fixture();
	expect(await seedSourceInstallationCaches(f.journal, f.io, f.request)).toMatchObject({ created: 3, resumed: 0 });
	expect(await readNote(f.noteIdentity)).toEqual({ text: "Restored note", serverSync: true, origin: "remote", syncBase: "Restored note" });
	const inventory = new Y.Doc(), inventoryStore = await openSourceInventoryCache(f.source, inventory);
	expect(inventory.getMap("docs").get("Note.md")).toBe(f.noteIdentity.s3rn.split(":").pop());
	expect(inventory.getMap("managed_base_v1").get("snapshot")).toMatchObject({ restore_generation: f.source.restoreGeneration });
	await inventoryStore.close(); inventory.destroy();
	const canvas = new Y.Doc(), canvasStore = await openSourceDocumentCache(f.canvasIdentity, canvas);
	expect(canvas.getMap("nodes").get("node")).toMatchObject({ text: "Restored canvas" });
	expect(JSON.parse((await canvasStore.loadSyncBase())!).nodes[0].text).toBe("Restored canvas");
	await canvasStore.close(); canvas.destroy();
	expect(await seedSourceInstallationCaches(f.journal, f.io, f.request)).toMatchObject({ created: 0, resumed: 3 });
	expect(await f.journal.read()).toMatchObject({ active: { kind: "legacy" }, pending: { phase: "applying" } });
});

test.each([false, true])("older Canvas seeds acquire the missing baseline only with unchanged history (changed: %s)", async changed => {
	const f = await fixture(), descriptor = sourceDocumentCacheSync(f.canvasIdentity);
	await seedSourceInstallationCaches(f.journal, f.io, f.request);
	await mutateCache(descriptor.name, (custom, updates) => {
		custom.delete("syncBase");
		if (changed) updates.add(new Uint8Array([0, 0]));
	});
	const before = await snapshot(descriptor.name);
	if (changed) {
		await expect(seedSourceInstallationCaches(f.journal, f.io, f.request)).rejects.toThrow("not replaced or merged");
		expect(await snapshot(descriptor.name)).toEqual(before);
	} else {
		expect(await seedSourceInstallationCaches(f.journal, f.io, f.request)).toMatchObject({ created: 0, resumed: 3 });
		const doc = new Y.Doc(), store = await openSourceDocumentCache(f.canvasIdentity, doc);
		expect(JSON.parse((await store.loadSyncBase())!).nodes[0].text).toBe("Restored canvas");
		await store.close(); doc.destroy();
	}
});

test("legacy and previous-generation histories remain separate and unchanged", async () => {
	const f = await fixture(), oldIdentity = { ...f.noteIdentity, restoreGeneration: null };
	const old = new Y.Doc(), oldStore = await openSourceDocumentCache(oldIdentity, old); old.getText("contents").insert(0, "Previous generation offline edits"); await oldStore.close(); old.destroy();
	const legacy = new Y.Doc(), legacyName = crypto.randomUUID(), legacyStore = new LocalDocumentStore(legacyName, legacy);
	await legacyStore.whenSynced; legacy.getText("contents").insert(0, "Legacy offline edits"); await legacyStore.close(); legacy.destroy();
	await seedSourceInstallationCaches(f.journal, f.io, f.request);
	expect((await readNote(oldIdentity)).text).toBe("Previous generation offline edits");
	expect((await readNote(f.noteIdentity)).text).toBe("Restored note");
	const reopened = new Y.Doc(), retained = new LocalDocumentStore(legacyName, reopened); await retained.whenSynced;
	expect(reopened.getText("contents").toString()).toBe("Legacy offline edits"); await retained.close(); reopened.destroy();
});

test.each(["populated unbound", "identity only", "wrong identity", "changed seed", "unknown metadata", "extra update", "changed bytes"])("refuse and preserve an existing cache: %s", async kind => {
	const f = await fixture(), descriptor = sourceDocumentCacheSync(f.noteIdentity);
	if (["changed seed", "unknown metadata", "extra update", "changed bytes"].includes(kind)) await seedSourceInstallationCaches(f.journal, f.io, f.request);
	await mutateCache(descriptor.name, (custom, updates) => {
		if (kind === "populated unbound") updates.add(f.noteUpdate);
		if (kind === "identity only") custom.put(descriptor.identity, SOURCE_CACHE_IDENTITY);
		if (kind === "wrong identity") { custom.put("different-source", SOURCE_CACHE_IDENTITY); updates.add(f.noteUpdate); }
		if (kind === "changed seed") custom.put("other-installation", "sourceInstallationSeed");
		if (kind === "unknown metadata") custom.put(true, "restoreReviewRequired");
		if (kind === "extra update") updates.add(new Uint8Array([0, 0]));
		if (kind === "changed bytes") { updates.clear(); updates.add(new Uint8Array([0, 0])); }
	});
	const before = await snapshot(descriptor.name);
	await expect(seedSourceInstallationCaches(f.journal, f.io, f.request)).rejects.toThrow("not replaced or merged");
	expect(await snapshot(descriptor.name)).toEqual(before);
});

async function snapshot(name: string) {
	let customValues: unknown, updatesValues: unknown;
	await mutateCache(name, (custom, updates) => {
		const c = custom.getAll(), u = updates.getAll(); c.onsuccess = () => { customValues = c.result; }; u.onsuccess = () => { updatesValues = u.result; };
	});
	return { customValues, updatesValues };
}

test("partial multi-cache import resumes without writing the completed cache again", async () => {
	const f = await fixture(), read = f.io.readBinary.bind(f.io); let inventoryReads = 0;
	// Verification reads inventory first; the second read supplies its import.
	const io = { ...f.io, readBinary: async (name: string) => {
		if (name === `${f.staged.path}/inventory.yjs`) inventoryReads++;
		if (inventoryReads === 2 && name.includes("/sources/")) throw new Error("Simulated artifact read interruption");
		return read(name);
	} };
	await expect(seedSourceInstallationCaches(f.journal, io, f.request)).rejects.toThrow("read interruption");
	const result = await seedSourceInstallationCaches(f.journal, f.io, f.request);
	expect(result).toMatchObject({ created: 2, resumed: 1 });
});

test("corrupted artifacts and a stale journal cannot seed a source cache", async () => {
	const f = await fixture();
	await expect(seedSourceInstallationCaches(f.journal, f.io, { ...f.request, revision: f.prepared.revision! })).rejects.toThrow("selection changed");
	f.files.set(`${f.staged.path}/inventory.yjs`, new Uint8Array([0, 0]).buffer);
	await expect(seedSourceInstallationCaches(f.journal, f.io, f.request)).rejects.toThrow();
	expect((await indexedDB.databases()).some(db => db.name === sourceInventoryCacheSync(f.source).name)).toBe(false);
});

test("two concurrent imports produce one seed and one exact resume per cache", async () => {
	const f = await fixture(), results = await Promise.all([seedSourceInstallationCaches(f.journal, f.io, f.request), seedSourceInstallationCaches(f.journal, f.io, f.request)]);
	expect(results.reduce((count, result) => count + result.created, 0)).toBe(3);
	expect(results.reduce((count, result) => count + result.resumed, 0)).toBe(3);
	expect((await readNote(f.noteIdentity)).text).toBe("Restored note");
});

test("cancellation after an atomic import leaves it resumable and never activates synchronization", async () => {
	const f = await fixture(), controller = new AbortController();
	const transaction = IDBDatabase.prototype.transaction;
	jest.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
		const tx = transaction.apply(this, args);
		if (this.name === sourceInventoryCacheSync(f.source).name && args[1] === "readwrite") tx.addEventListener("complete", () => controller.abort());
		return tx;
	});
	await expect(seedSourceInstallationCaches(f.journal, f.io, f.request, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
	jest.restoreAllMocks();
	expect(await seedSourceInstallationCaches(f.journal, f.io, f.request)).toMatchObject({ created: 2, resumed: 1 });
	expect((await f.journal.read()).pending?.phase).toBe("applying");
});

test.each(["quota failure", "cancellation"])("identity, receipt, metadata and update roll back together on %s", async kind => {
	const f = await fixture(), name = sourceInventoryCacheSync(f.source).name, add = IDBObjectStore.prototype.add, controller = new AbortController();
	jest.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>) {
		if (this.transaction.db.name === name && this.name === "updates") {
			if (kind === "quota failure") throw new DOMException("Synthetic fixture quota", "QuotaExceededError");
			controller.abort();
		}
		return add.apply(this, args);
	});
	await expect(seedSourceInstallationCaches(f.journal, f.io, f.request, { signal: controller.signal })).rejects.toMatchObject({ name: kind === "quota failure" ? "QuotaExceededError" : "AbortError" });
	jest.restoreAllMocks();
	expect(await snapshot(name)).toEqual({ customValues: [], updatesValues: [] });
	expect(await seedSourceInstallationCaches(f.journal, f.io, f.request)).toMatchObject({ created: 3, resumed: 0 });
});

test("caller mutation after entry cannot change the source being imported", async () => {
	const f = await fixture(), request = { ...f.request, source: { ...f.source } };
	const result = seedSourceInstallationCaches(f.journal, f.io, request);
	request.source.controlPlaneUrl = "https://other.test"; request.source.restoreGeneration = crypto.randomUUID(); request.revision = crypto.randomUUID();
	expect(await result).toMatchObject({ created: 3, resumed: 0 });
	expect((await readNote(f.noteIdentity)).text).toBe("Restored note");
});

test("activation preflight checks only the selected generation and preserves older buffers and upload claims", async () => {
	const f = await fixture(), buffers = new UnsavedFileStore(), oldKey = sourceDocumentCacheSync({ ...f.noteIdentity, restoreGeneration: null }).bufferKey;
	await buffers.persistUnsaved(oldKey, "Old offline work");
	const selectedUploads = sourceInventoryCacheSync(f.source).name + "/pendingUploads";
	const app = { loadLocalStorage: jest.fn((key: string) => key === selectedUploads ? {} : { retained: "old upload" }) };
	await assertNoInstallationLocalWork(app, buffers, f.staged.plan);
	expect(app.loadLocalStorage.mock.calls.every(([key]) => key === selectedUploads)).toBe(true);
	expect(await buffers.readUnsaved(oldKey)).toBe("Old offline work");
	const selected = sourceDocumentCacheSync(f.noteIdentity).bufferKey; await buffers.persistUnsaved(selected, "");
	await expect(assertNoInstallationLocalWork(app, buffers, f.staged.plan)).rejects.toThrow("saved local buffers");
	expect(await buffers.readUnsaved(selected)).toBe("");
});

test.each(["claim", "invalid object", "invalid scalar"])("activation refuses selected upload state without inspecting buffer bodies: %s", async kind => {
	const f = await fixture(), value = kind === "claim" ? { "Note.md": "pending" } : kind === "invalid object" ? [] : "unrecognized";
	const app = { loadLocalStorage: jest.fn((_key: string) => value) }, buffers = { countSavedBuffers: jest.fn(async () => 0) };
	await expect(assertNoInstallationLocalWork(app, buffers, f.staged.plan)).rejects.toThrow("upload state");
	expect(buffers.countSavedBuffers).not.toHaveBeenCalled(); expect(app.loadLocalStorage.mock.results[0].value).toBe(value);
});

test("a pending upload appearing during buffer inspection blocks activation", async () => {
	const f = await fixture(); let value: Record<string, string> = {};
	const app = { loadLocalStorage: (_key: string) => value }, buffers = { countSavedBuffers: async () => { value = { local: "new claim" }; return 0; } };
	await expect(assertNoInstallationLocalWork(app, buffers, f.staged.plan)).rejects.toThrow("upload state");
	expect(value).toEqual({ local: "new claim" });
});
