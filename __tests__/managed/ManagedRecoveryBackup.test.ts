import "fake-indexeddb/auto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { TFile, TFolder } from "obsidian";
import { Document } from "../../src/Document";
import { VaultShare, ShareRegistry } from "../../src/VaultShare";
import { LocalDocumentStore } from "../../src/storage/local-document-store";
import { UnsavedFileStore } from "../../src/UnsavedFile";
import { ManagedIndexTransport } from "../../src/client/ManagedIndexTransport";
import { CONFLICTS, makeConflict, diff } from "../../src/client/managedRecovery";
import { prepareRecoveryBackup, type RecoveryCapture } from "../../src/ManagedRecoveryBackup";
import { RECOVERY_FOLDER, isConflictCopyPath } from "../../src/conflictCopyPath";
import { platformFetch } from "../../src/platformFetch";
import { ItemKind, type ItemRecord } from "../../src/ItemKinds";
import { RemoteFolderAddress, RemoteDocumentAddress, ResourceAddress } from "../../src/ResourceAddress";
import type { ManagedRestoreReview } from "../../src/client/ManagedIndexTransport";
import { openSourceDocumentCache, sourceDocumentCache, openSourceInventoryCache, sourceInventoryCache } from "../../src/storage/source-document-cache";
import { SOURCE_CACHE_IDENTITY } from "../../src/storage/document-cache-binding";
import { readManagedSource } from "../../src/client/readManagedSource";
import type { ManagedRestoreInspection } from "../../src/client/ManagedIndexTransport";
import { readDocumentRecoverySnapshot } from "../../src/storage/document-recovery-snapshot";
import * as nativeWrites from "../../src/storage/native-document-writes";

jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
jest.mock("../../src/client/readManagedSource", () => ({ readManagedSource: jest.fn() }));
const fetchMock = platformFetch as jest.Mock;
const sourceMock = jest.mocked(readManagedSource);
let root: string;
const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-recovery-test-")); fetchMock.mockReset(); sourceMock.mockReset(); });
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); await fs.rm(root, { recursive: true, force: true }); });
const io = () => ({
	mkdir: async (p: string) => { await fs.mkdir(path.join(root, p), { recursive: true }); },
	write: (p: string, text: string) => fs.writeFile(path.join(root, p), text),
	writeBinary: (p: string, bytes: ArrayBuffer) => fs.writeFile(path.join(root, p), new Uint8Array(bytes)),
	readBinary: async (p: string) => new Uint8Array(await fs.readFile(path.join(root, p))).buffer,
});
const capture = (): RecoveryCapture => ({ files: [{ path: "Team/Local.md", bytes: new TextEncoder().encode("disk edit").buffer }], documents: [{ id: "a", update: new Uint8Array([0, 0]), text: "editor edit", unsaved: "unflushed buffer" }], index: new Uint8Array([0, 0]) });

test("backup preserves binary bytes, readable editor buffers, and independently restorable Yjs history", async () => {
	const doc = new Y.Doc(); cleanup.push(() => doc.destroy()); doc.getText("contents").insert(0, "unsent live edit");
	const state = capture(); state.files.push({ path: "Team/photo.bin", bytes: new Uint8Array([0, 255, 0, 128]).buffer });
	state.documents[0].update = Y.encodeStateAsUpdate(doc);
	const backup = await prepareRecoveryBackup(io(), async () => state, { reason: "divergent rename" });
	expect(await fs.readFile(path.join(root, backup.path, "files/Team/photo.bin"))).toEqual(Buffer.from([0, 255, 0, 128]));
	const restored = new Y.Doc(); cleanup.push(() => restored.destroy());
	Y.applyUpdate(restored, await fs.readFile(path.join(root, backup.path, "documents/a.yjs")));
	expect(restored.getText("contents").toString()).toBe("unsent live edit");
	expect(await fs.readFile(path.join(root, backup.path, "documents/a.unsaved.txt"), "utf8")).toBe("unflushed buffer");
	expect(isConflictCopyPath(backup.path)).toBe(true);
	expect(isConflictCopyPath(`${backup.path}/files/Team/Local.md`)).toBe(true);
	const manifest = JSON.parse(await fs.readFile(path.join(root, backup.path, "manifest.json"), "utf8")) as { format: string; version: number; files: { path: string; bytes: number; sha256: string }[] };
	expect(manifest.format).toBe("team-relay-local-recovery"); expect(manifest.version).toBe(1);
	for (const file of manifest.files) {
		const content = await fs.readFile(path.join(root, backup.path, file.path));
		expect(content.length).toBe(file.bytes); expect(createHash("sha256").update(content).digest("hex")).toBe(file.sha256);
	}
	await backup.verify();
});

test.each(["files/Team/Local.md", "documents/a.txt", "recovery.json", "manifest.json"])("a silently corrupted %s write cannot authorize recovery", async target => {
	const disk = io(), write = disk.write, writeBinary = disk.writeBinary;
	disk.write = (p, text) => write(p, p.endsWith("/" + target) ? text + "corruption" : text);
	disk.writeBinary = (p, bytes) => writeBinary(p, p.endsWith("/" + target) ? new Uint8Array([7]).buffer : bytes);
	await expect(prepareRecoveryBackup(disk, async () => capture(), {})).rejects.toThrow("verification failed");
	for (const entry of await fs.readdir(path.join(root, RECOVERY_FOLDER))) {
		await expect(fs.access(path.join(root, RECOVERY_FOLDER, entry, "BACKUP-COMPLETE.txt"))).rejects.toThrow();
	}
});

test("later verification detects changed archive bytes and does not trust the completion marker alone", async () => {
	const backup = await prepareRecoveryBackup(io(), async () => capture(), {});
	await fs.writeFile(path.join(root, backup.path, "inventory.yjs"), new Uint8Array([9, 9]));
	await expect(backup.verify()).rejects.toThrow("verification failed");
});

test("completion itself must survive readback before a backup is returned", async () => {
	const disk = io(), write = disk.write;
	disk.write = (p, text) => write(p, p.endsWith("/BACKUP-COMPLETE.txt") ? text + "corruption" : text);
	await expect(prepareRecoveryBackup(disk, async () => capture(), {})).rejects.toThrow("BACKUP-COMPLETE.txt");
});

test("an unreadable saved archive is not reported complete", async () => {
	const disk = io(); disk.readBinary = async () => { throw new Error("temporary read failure"); };
	await expect(prepareRecoveryBackup(disk, async () => capture(), {})).rejects.toThrow("temporary read failure");
	for (const entry of await fs.readdir(path.join(root, RECOVERY_FOLDER))) {
		await expect(fs.access(path.join(root, RECOVERY_FOLDER, entry, "BACKUP-COMPLETE.txt"))).rejects.toThrow();
	}
});

test("cache metadata is checksummed and changes prevent a recovery decision", async () => {
	const state = capture(); state.documents[0].cacheMetadata = '{"review":"retained"}';
	const backup = await prepareRecoveryBackup(io(), async () => state, {});
	expect(await fs.readFile(path.join(root, backup.path, "documents/a.cache.json"), "utf8")).toBe(state.documents[0].cacheMetadata);
	state.documents[0].cacheMetadata = '{"review":"changed"}';
	await expect(backup.verify()).rejects.toThrow("Local edits arrived");
	await fs.writeFile(path.join(root, backup.path, "documents/a.cache.json"), "corrupt metadata");
	await expect(backup.verify()).rejects.toThrow("verification failed");
});

test("changing caller buffers or the returned initial capture cannot rewrite the private comparison base", async () => {
	const state = capture(), disk = io(), write = disk.writeBinary;
	let mutated = false;
	disk.writeBinary = async (p, data) => {
		if (!mutated) { mutated = true; new Uint8Array(state.files[0].bytes)[0] = 7; }
		await write(p, data);
	};
	await expect(prepareRecoveryBackup(disk, async () => state, {})).rejects.toThrow("Local edits arrived");
	const newer = capture(), backup = await prepareRecoveryBackup(io(), async () => newer, {});
	newer.documents[0].text = "later edit"; backup.initial.documents[0].text = "later edit";
	await expect(backup.verify()).rejects.toThrow("Local edits arrived");
});

test.each(["../escape", "/absolute", "C:/absolute", "Team/../escape", "Team\\escape", "Team//empty"])("unsafe capture path %s is rejected before creating an archive", async unsafe => {
	const state = capture(); state.files[0].path = unsafe;
	await expect(prepareRecoveryBackup(io(), async () => state, {})).rejects.toThrow("unsafe relative path");
	expect(await fs.readdir(root)).toEqual([]);
});

test.each(["identity", "file collision", "identity collision", "directory collision", "source cache key", "source collision", "inventory key", "inventory collision"])("invalid capture %s cannot overwrite another recovery item", async kind => {
	const state = capture();
	if (kind === "identity") state.documents[0].id = "../escape";
	if (kind === "file collision") state.files.push({ ...state.files[0], path: "team/local.md" });
	if (kind === "identity collision") state.documents.push({ ...state.documents[0], id: "A" });
	if (kind === "directory collision") state.files.push({ ...state.files[0], path: "Team/Local.md/nested" }, { ...state.files[0], path: "Team/Local.md-other" });
	if (kind === "source cache key") state.documents[0].cacheKey = "../escape";
	if (kind === "source collision") {
		state.documents[0].cacheKey = "relay-source-v1-" + "a".repeat(64); state.documents.push({ ...state.documents[0] });
	}
	if (kind === "inventory key") state.inventories = [{ cacheKey: "../escape", update: state.index, cacheMetadata: "{}" }];
	if (kind === "inventory collision") {
		const inventory = { cacheKey: "relay-inventory-v1-" + "a".repeat(64), update: state.index, cacheMetadata: "{}" };
		state.inventories = [inventory, { ...inventory }];
	}
	await expect(prepareRecoveryBackup(io(), async () => state, {})).rejects.toThrow();
	expect(await fs.readdir(root)).toEqual([]);
});

test.each(["file write", "editor edit", "binary edit", "unsaved edit"])("backup does not authorize recovery after %s", async failure => {
	const state = capture(); let calls = 0;
	const disk = io();
	if (failure === "file write") disk.writeBinary = async () => { throw Error("disk full"); };
	await expect(prepareRecoveryBackup(disk, async () => {
		calls++;
		if (calls > 1) {
			const changed = capture();
			if (failure === "editor edit") changed.documents[0].text += "new edit";
			if (failure === "binary edit") changed.files[0].bytes = new Uint8Array([3]).buffer;
			if (failure === "unsaved edit") changed.documents[0].unsaved += "new edit";
			return changed;
		}
		return state;
	}, {})).rejects.toThrow();
	const entries = await fs.readdir(path.join(root, RECOVERY_FOLDER));
	for (const entry of entries) await expect(fs.access(path.join(root, RECOVERY_FOLDER, entry, "BACKUP-COMPLETE.txt"))).rejects.toThrow();
});

async function shareFixture() {
	const doc = new Y.Doc(), localDoc = new Y.Doc(); cleanup.push(() => { doc.destroy(); localDoc.destroy(); });
	const host = crypto.randomUUID();
	const note: ItemRecord = { id: crypto.randomUUID(), type: ItemKind.Document, version: 0 };
	const binary: ItemRecord = { id: crypto.randomUUID(), type: ItemKind.File, version: 0, mimetype: "application/octet-stream", hash: "abc", synctime: 0 };
	const base = { "Old.md": note, "Old.bin": binary }, local = { "Local.md": note, "Local.bin": binary };
	const server = { records: { "Remote.md": note, "Remote.bin": binary }, permissions: {}, activity: {}, owner: true };
	const conflict = makeConflict(diff(base, local), base, local, "competing move");
	doc.getMap("managed_base_v1").set("snapshot", server);
	doc.getMap(CONFLICTS).set(conflict.id, conflict);
	for (const [p, r] of Object.entries(local)) doc.getMap("filemeta_v0").set(p, r);
	const store = new LocalDocumentStore(`${host}-relay-doc-${note.id}`, localDoc); await store.whenSynced;
	localDoc.getText("contents").insert(0, "OFFLINE EDIT IN INDEXEDDB");
	await store.close();
	const unsavedStore = new UnsavedFileStore(); await unsavedStore.persistUnsaved(note.id, "UNSAVED EDITOR BUFFER");
	const nodes: (TFile | TFolder)[] = [];
	const addFile = async (p: string, bytes: Uint8Array) => {
		await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true }); await fs.writeFile(path.join(root, p), bytes);
		const file = Object.create(TFile.prototype) as TFile; file.path = p; nodes.push(file); return file;
	};
	await addFile("Team/Local.md", new TextEncoder().encode("OFFLINE DISK EDIT"));
	await addFile("Team/Local.bin", new Uint8Array([255, 0, 19]));
	const transport = new ManagedIndexTransport(doc, () => ({ endpoint: "https://test.invalid/inventory", token: "test" }), () => {}, () => {}); cleanup.push(() => transport.destroy());
	fetchMock.mockImplementation(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(server) }));
	const disk = io();
	const vault = {
		getAllLoadedFiles: () => nodes,
		readBinary: async (file: TFile) => new Uint8Array(await fs.readFile(path.join(root, file.path))).buffer,
		createFolder: async (p: string) => { await disk.mkdir(p); const folder = Object.create(TFolder.prototype); folder.path = p; nodes.push(folder); return folder; },
		rename: async (file: TFile, p: string) => { await fs.rename(path.join(root, file.path), path.join(root, p)); file.path = p; },
		adapter: { ...disk, exists: async (p: string) => fs.access(path.join(root, p)).then(() => true, () => false) },
	};
	const share = Object.create(VaultShare.prototype) as VaultShare;
	const config = { onpremServerId: "test-server" }, checkAuth = jest.fn();
	Object.assign(share, { path: "Team", hostAppId: host, entityGuid: "share", crdtDoc: doc, vaultApi: vault, trackedEntries: new Map(), pathSet: new Set(), unsavedStore,
		_liveProvider: { managedIndex: transport }, scanFileTree: jest.fn(async () => {}),
		folderIndex: { stagedWrites: new Map(), stagedDeletes: new Set(), aliases: new Map() }, uploadClaims: new Map(),
		_config: { readValue: () => config }, _resourceAddress: new RemoteFolderAddress(crypto.randomUUID(), crypto.randomUUID()),
		credentialCache: { captureFileContext: () => checkAuth }, log: jest.fn(), warn: jest.fn() });
	return { share, transport, conflict, server, note, vault, nodes, host, addFile, config, checkAuth };
}

async function restoreFixture() {
	const state = await shareFixture();
	const review: ManagedRestoreReview = { id: "restore-review", createdAt: "2026-11-08T00:00:00Z", before: state.server,
		observed: { ...state.server, restore_guard: true, restore_generation: "restored-copy" }, local: state.conflict.local, activity: { [state.note.id]: "pending" } };
	state.share.crdtDoc.getMap("managed_base_v1").set("restoreReview", review);
	fetchMock.mockImplementation(() => { throw new Error("Recovery must work offline"); });
	return { ...state, review };
}

async function sourceTextFixture() {
	const state = await restoreFixture(), serverDoc = new Y.Doc();
	serverDoc.getText("contents").insert(0, "RESTORED SERVER TEXT");
	const update = Y.encodeStateAsUpdate(serverDoc), stateVector = Y.encodeStateVector(serverDoc); serverDoc.destroy();
	const inspection: ManagedRestoreInspection = { reviewId: state.review.id, checkedAt: state.review.createdAt,
		local: state.review.local, server: { ...state.server, restore_guard: true, restore_generation: crypto.randomUUID() }, check: state.checkAuth };
	sourceMock.mockImplementation(async (_credentials, _address, _path, _server, _binding, options) => {
		options?.check?.(); return { update, stateVector, downloadedAt: "2026-11-08T00:00:00Z", check: () => options?.check?.() };
	});
	return { ...state, inspection, update, name: `${state.host}-relay-doc-${state.note.id}` };
}

test("source comparison keeps local history, buffer, disk and restored text distinct without writing", async () => {
	const s = await sourceTextFixture(), before = await readDocumentRecoverySnapshot(s.name), index = Y.encodeStateAsUpdate(s.share.crdtDoc);
	const result = await s.share.inspectManagedRestoreText(s.inspection, s.note.id);
	expect(result.serverText).toBe("RESTORED SERVER TEXT");
	expect(result.local).toEqual([
		{ label: "Local editing history", text: "OFFLINE EDIT IN INDEXEDDB" },
		{ label: "Local unsaved buffer", text: "UNSAVED EDITOR BUFFER" },
		{ label: "Local file on disk", text: "OFFLINE DISK EDIT" },
	]);
	const parent = s.share.resourceAddress as RemoteFolderAddress;
	expect(sourceMock).toHaveBeenCalledWith(s.share.credentialCache,
		ResourceAddress.serialize(new RemoteDocumentAddress(parent.relayGuid, parent.folderGuid, s.note.id)), "Team/Remote.md", "test-server",
		{ restoreGeneration: s.inspection.server.restore_generation }, expect.objectContaining({ check: expect.any(Function) }));
	expect(await readDocumentRecoverySnapshot(s.name)).toEqual(before);
	expect(await fs.readFile(path.join(root, "Team/Local.md"), "utf8")).toBe("OFFLINE DISK EDIT");
	expect(await s.share.unsavedStore.readUnsaved(s.note.id)).toBe("UNSAVED EDITOR BUFFER");
	expect(Y.encodeStateAsUpdate(s.share.crdtDoc)).toEqual(index); expect(fetchMock).not.toHaveBeenCalled();
	result.check(); s.config.onpremServerId = "different"; expect(result.check).toThrow("changed");
});

test.each(["complete", "cancel"])("source comparison can %s while an admitted native write is still pending", async mode => {
	const s = await sourceTextFixture(), controller = new AbortController();
	let release!: () => void, entered!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
	const write = s.vault.adapter.write, read = jest.spyOn(s.vault, "readBinary");
	s.vault.adapter.write = async (path, text) => { await held; await write(path, text); };
	Object.assign(s.share, { deletedEntries: new Set(), isDeletePending: () => false });
	const save = s.share.writeContents({ entryPath: "Local.md" } as Document, "FINISHED NATIVE SAVE");
	const originalWait = nativeWrites.waitForNativeDocumentWrites;
	const spy = jest.spyOn(nativeWrites, "waitForNativeDocumentWrites").mockImplementation((...args) => { entered(); return originalWait(...args); });
	try {
		const comparison = s.share.inspectManagedRestoreText(s.inspection, s.note.id, controller.signal);
		await waiting; expect(read).not.toHaveBeenCalled(); expect(sourceMock).not.toHaveBeenCalled();
		if (mode === "cancel") {
			controller.abort(); await expect(comparison).rejects.toMatchObject({ name: "AbortError" });
			expect(read).not.toHaveBeenCalled(); expect(sourceMock).not.toHaveBeenCalled();
			release(); await save;
		} else {
			release(); await save;
			expect((await comparison).local).toContainEqual({ label: "Local file on disk", text: "FINISHED NATIVE SAVE" });
		}
		expect(await fs.readFile(path.join(root, "Team/Local.md"), "utf8")).toBe("FINISHED NATIVE SAVE");
	} finally { release(); await save; spy.mockRestore(); read.mockRestore(); }
});

test("server-only text inspection creates no retained cache or local buffer", async () => {
	const s = await sourceTextFixture(), id = crypto.randomUUID(), cacheName = `${s.host}-relay-doc-${id}`;
	s.inspection.server.records = { "New.md": { ...s.note, id } };
	expect((await s.share.inspectManagedRestoreText(s.inspection, id)).local).toEqual([]);
	expect((await readDocumentRecoverySnapshot(cacheName)).exists).toBe(false);
	expect(await s.share.unsavedStore.readUnsaved(id)).toBeNull();
});

test("existing canvas source can be inspected as JSON without opening a canvas editor", async () => {
	const s = await sourceTextFixture(), id = crypto.randomUUID(), doc = new Y.Doc();
	s.inspection.server.records = { "Restored.canvas": { id, type: ItemKind.Canvas, version: 0 } };
	doc.getMap("nodes").set("node", { id: "node", type: "text", text: "before", x: 0, y: 0, width: 200, height: 100 });
	doc.getText("node").insert(0, "current node text");
	const update = Y.encodeStateAsUpdate(doc), stateVector = Y.encodeStateVector(doc); doc.destroy();
	sourceMock.mockResolvedValueOnce({ update, stateVector, downloadedAt: "2026-11-08T00:00:00Z", check: s.checkAuth });
	const result = await s.share.inspectManagedRestoreText(s.inspection, id);
	expect(JSON.parse(result.serverText)).toMatchObject({ edges: [], nodes: [{ id: "node", text: "current node text" }] });
	expect(result.local).toEqual([]); expect(s.share.trackedEntries.size).toBe(0);
});

test("source comparison includes live unsaved work without appending it to the retained cache", async () => {
	const s = await sourceTextFixture(), before = await readDocumentRecoverySnapshot(s.name), liveDoc = new Y.Doc();
	Y.applyUpdate(liveDoc, before.update); liveDoc.getText("contents").insert(liveDoc.getText("contents").length, " + LIVE");
	const live = Object.create(Document.prototype) as Document;
	Object.assign(live, { entityGuid: s.note.id, _parent: s.share, crdtDoc: liveDoc, _unsavedFile: { unsavedText: "LIVE BUFFER" } });
	s.share.trackedEntries.set(s.note.id, live);
	try {
		const result = await s.share.inspectManagedRestoreText(s.inspection, s.note.id);
		expect(result.local.slice(0, 2)).toEqual([{ label: "Local editing history", text: "OFFLINE EDIT IN INDEXEDDB + LIVE" }, { label: "Local unsaved buffer", text: "LIVE BUFFER" }]);
		expect(await readDocumentRecoverySnapshot(s.name)).toEqual(before);
	} finally { liveDoc.destroy(); }
});

test("incomplete retained history stays exportable and is compared only after live history supplies its dependency", async () => {
	const s = await sourceTextFixture(), source = new Y.Doc(), updates: Uint8Array[] = [];
	source.on("update", update => updates.push(update)); source.getMap("seed").set("owner", "test"); source.getText("contents").insert(0, "MISSING BASE TEXT");
	await new Promise<void>((resolve, reject) => {
		const opened = indexedDB.open(s.name); opened.onerror = () => reject(opened.error);
		opened.onsuccess = () => { const db = opened.result, tx = db.transaction("updates", "readwrite"); tx.objectStore("updates").add(updates[1]); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); }; };
	});
	const retained = await readDocumentRecoverySnapshot(s.name);
	try {
		await expect(s.share.inspectManagedRestoreText(s.inspection, s.note.id)).rejects.toThrow("incomplete changes"); expect(sourceMock).not.toHaveBeenCalled();
		expect(await readDocumentRecoverySnapshot(s.name)).toEqual(retained);
		const live = Object.create(Document.prototype) as Document;
		Object.assign(live, { entityGuid: s.note.id, _parent: s.share, crdtDoc: source, _unsavedFile: { unsavedText: "LIVE BUFFER" } }); s.share.trackedEntries.set(s.note.id, live);
		const result = await s.share.inspectManagedRestoreText(s.inspection, s.note.id);
		expect(result.local[0].text).toContain("MISSING BASE TEXT"); expect(result.local[0].text).toContain("OFFLINE EDIT IN INDEXEDDB");
		expect(await readDocumentRecoverySnapshot(s.name)).toEqual(retained);
	} finally { source.destroy(); }
});

test.each(["duplicate server", "duplicate local", "different type", "unsafe server path", "unsafe local path", "missing check"])("source comparison rejects %s before downloading", async kind => {
	const s = await sourceTextFixture();
	if (kind === "duplicate server") s.inspection.server.records["Other.md"] = s.note;
	if (kind === "duplicate local") s.inspection.local["Other.md"] = s.note;
	if (kind === "different type") s.inspection.local["Local.md"] = { ...s.note, type: ItemKind.Canvas };
	if (kind === "unsafe server path") s.inspection.server.records = { "../Other.md": s.note };
	if (kind === "unsafe local path") s.inspection.local = { "../Other.md": s.note };
	if (kind === "missing check") delete s.inspection.check;
	await expect(s.share.inspectManagedRestoreText(s.inspection, s.note.id)).rejects.toThrow(); expect(sourceMock).not.toHaveBeenCalled();
});

test.each(["stored host", "stored address", "live owner", "live kind"])("source comparison refuses a mismatched %s", async kind => {
	const s = await sourceTextFixture(), doc = new Y.Doc();
	try {
		if (kind.startsWith("stored")) {
			const store = new LocalDocumentStore(s.name, doc); await store.whenSynced;
			await store.set(kind === "stored host" ? "appId" : "s3rn", "different"); await store.close();
		} else if (kind === "live owner") {
			const live = Object.create(Document.prototype) as Document;
			Object.assign(live, { _parent: {}, crdtDoc: doc }); s.share.trackedEntries.set(s.note.id, live);
		} else s.share.trackedEntries.set(s.note.id, {} as Document);
		await expect(s.share.inspectManagedRestoreText(s.inspection, s.note.id)).rejects.toThrow(); expect(sourceMock).not.toHaveBeenCalled();
	} finally { doc.destroy(); }
});

test.each(["invalid utf8", "large disk", "large buffer", "moved file"])("source comparison rejects %s without fetching server text", async kind => {
	const s = await sourceTextFixture();
	if (kind === "invalid utf8") await fs.writeFile(path.join(root, "Team/Local.md"), new Uint8Array([255]));
	if (kind === "large disk") s.vault.readBinary = async () => new Uint8Array(2 * 1024 * 1024 + 1).buffer;
	if (kind === "large buffer") await s.share.unsavedStore.persistUnsaved(s.note.id, "a".repeat(2 * 1024 * 1024 + 1));
	if (kind === "moved file") s.vault.readBinary = async file => { file.path = "Team/Moved.md"; return new ArrayBuffer(0); };
	await expect(s.share.inspectManagedRestoreText(s.inspection, s.note.id)).rejects.toThrow(); expect(sourceMock).not.toHaveBeenCalled();
});

test.each(["account", "generation", "parent", "cancelled"])("a %s change during a local read prevents the source request", async kind => {
	const s = await sourceTextFixture(), abort = new AbortController();
	s.vault.readBinary = async () => {
		if (kind === "account") s.checkAuth.mockImplementation(() => { throw new Error("Account changed"); });
		if (kind === "generation") s.inspection.server.restore_generation = crypto.randomUUID();
		if (kind === "parent") Object.assign(s.share, { _resourceAddress: new RemoteFolderAddress(crypto.randomUUID(), crypto.randomUUID()) });
		if (kind === "cancelled") abort.abort();
		return new ArrayBuffer(0);
	};
	await expect(s.share.inspectManagedRestoreText(s.inspection, s.note.id, abort.signal)).rejects.toThrow(); expect(sourceMock).not.toHaveBeenCalled();
});

test("source comparison refuses a changed inventory after the server download", async () => {
	const s = await sourceTextFixture(), implementation = sourceMock.getMockImplementation()!;
	sourceMock.mockImplementationOnce(async (...args) => {
		const result = await implementation(...args); s.inspection.server.records = {}; return result;
	});
	await expect(s.share.inspectManagedRestoreText(s.inspection, s.note.id)).rejects.toThrow("changed");
});

test("shared-folder restore inspection retains source state and fences a changing account or folder", async () => {
	const s = await restoreFixture(), before = Y.encodeStateAsUpdate(s.share.crdtDoc);
	await expect(s.share.inspectManagedRestore()).rejects.toThrow("selected server is unavailable"); expect(fetchMock).not.toHaveBeenCalled();
	s.share.credentialCache.captureDocumentSourceContext = () => ({ serverId: "test-server", controlPlaneUrl: "https://fixture.test", check: s.checkAuth });
	fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(s.server) }));
	const inspected = await s.share.inspectManagedRestore(); expect(inspected.server).toEqual(s.server);
	expect(Y.encodeStateAsUpdate(s.share.crdtDoc)).toEqual(before); expect(s.checkAuth).toHaveBeenCalled();
	let finish!: (value: unknown) => void;
	fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const pending = s.share.inspectManagedRestore(); s.config.onpremServerId = "different-server";
	finish({ ok: true, status: 200, text: async () => JSON.stringify(s.server) });
	await expect(pending).rejects.toThrow("changed");
	expect(Y.encodeStateAsUpdate(s.share.crdtDoc)).toEqual(before); expect(fetchMock.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
});

test("paused-share archive preserves original and multiple restored histories without merging their bytes or buffers", async () => {
	const s = await restoreFixture(), address = s.share.resourceAddress as RemoteFolderAddress;
	s.share.credentialCache.captureDocumentSourceContext = () => ({ serverId: "test-server", controlPlaneUrl: "https://fixture.test", check: s.checkAuth });
	const descriptors = [];
	const inventories = [];
	for (const label of ["first restored generation", "second restored generation"]) {
		const identity = { hostAppId: s.host, serverId: "test-server", controlPlaneUrl: "https://fixture.test",
			s3rn: ResourceAddress.serialize(new RemoteDocumentAddress(address.relayGuid, address.folderGuid, s.note.id)), restoreGeneration: crypto.randomUUID() };
		const doc = new Y.Doc(), store = await openSourceDocumentCache(identity, doc), descriptor = await sourceDocumentCache(identity);
		doc.getText("contents").insert(0, label); await store.close(); doc.destroy();
		await s.share.unsavedStore.persistUnsaved(descriptor.bufferKey, label + " unsaved");
		descriptors.push({ ...descriptor, label });
		const inventoryIdentity = { ...identity, s3rn: ResourceAddress.serialize(address) };
		const index = new Y.Doc(), inventory = await openSourceInventoryCache(inventoryIdentity, index);
		index.getMap("filemeta_v0").set(label + ".md", s.note); index.getMap("docactivity_v0").set(s.note.id, label);
		index.getMap("managed_base_v1").set("restoreReview", { label });
		await inventory.markRestoreReview(); await inventory.close(); index.destroy();
		inventories.push({ ...await sourceInventoryCache(inventoryIdentity), label });
	}
	const folder = await s.share.saveManagedRestoreRecoveryCopy();
	expect(await fs.readFile(path.join(root, folder, `documents/${s.note.id}.txt`), "utf8")).toBe("OFFLINE EDIT IN INDEXEDDB");
	for (const descriptor of descriptors) {
		const prefix = path.join(root, folder, `documents/${s.note.id}/${descriptor.name}`);
		expect(await fs.readFile(prefix + ".txt", "utf8")).toBe(descriptor.label);
		expect(await fs.readFile(prefix + ".unsaved.txt", "utf8")).toBe(descriptor.label + " unsaved");
		const recovered = new Y.Doc(); Y.applyUpdate(recovered, await fs.readFile(prefix + ".yjs"));
		expect(recovered.getText("contents").toString()).toBe(descriptor.label); recovered.destroy();
	}
	for (const inventory of inventories) {
		const prefix = path.join(root, folder, `inventories/${inventory.name}`), recovered = new Y.Doc();
		Y.applyUpdate(recovered, await fs.readFile(prefix + ".yjs"));
		expect(recovered.getMap("filemeta_v0").get(inventory.label + ".md")).toEqual(s.note);
		expect(recovered.getMap("docactivity_v0").get(s.note.id)).toBe(inventory.label);
		expect(recovered.getMap("managed_base_v1").get("restoreReview")).toEqual({ label: inventory.label }); recovered.destroy();
		const cache = JSON.parse(await fs.readFile(prefix + ".cache.json", "utf8"));
		expect(cache.custom).toEqual(expect.arrayContaining([
			expect.objectContaining({ key: { type: "string", value: SOURCE_CACHE_IDENTITY }, value: { type: "string", value: inventory.identity } }),
			expect.objectContaining({ key: { type: "string", value: "restoreReviewRequired" } }),
		]));
	}
	const metadata = JSON.parse(await fs.readFile(path.join(root, folder, "recovery.json"), "utf8"));
	expect(metadata.sourceCacheDiscovery.documents).toHaveLength(2); expect(metadata.sourceCacheDiscovery.inventories).toHaveLength(2);
	expect(fetchMock).not.toHaveBeenCalled();
	expect(s.transport.restoreReview).toEqual(s.review);
});

test.each(["source", "inventory"].flatMap(kind => ["identity", "edit", "context", "new cache"].map(change => [kind, change])))("a %s %s changing during archive leaves review retryable", async (kind, change) => {
	const s = await restoreFixture(), address = s.share.resourceAddress as RemoteFolderAddress;
	let invalidated = false;
	s.share.credentialCache.captureDocumentSourceContext = () => ({ serverId: "test-server", controlPlaneUrl: "https://fixture.test", check: () => { if (invalidated) throw new Error("Source context changed"); } });
	const identity = { hostAppId: s.host, serverId: "test-server", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(kind === "inventory" ? address : new RemoteDocumentAddress(address.relayGuid, address.folderGuid, s.note.id)), restoreGeneration: crypto.randomUUID() };
	const open = kind === "inventory" ? openSourceInventoryCache : openSourceDocumentCache;
	const doc = new Y.Doc(), store = await open(identity, doc); cleanup.push(async () => { await store.close(); doc.destroy(); });
	doc.getText("contents").insert(0, "retained source"); await store.set("path", "Note.md");
	const write = s.vault.adapter.writeBinary; let changed = false;
	s.vault.adapter.writeBinary = async (p, bytes) => {
		await write(p, bytes); if (changed) return; changed = true;
		if (change === "context") { invalidated = true; return; }
		if (change === "edit") {
			if (kind === "inventory") doc.getMap("filemeta_v0").set("Later.md", s.note);
			else doc.getText("contents").insert(0, "later ");
			await store.set("path", "Note.md"); return;
		}
		if (change === "new cache") {
			const newer = new Y.Doc(), created = await open({ ...identity, restoreGeneration: crypto.randomUUID() }, newer);
			newer.getText("contents").insert(0, "new retained generation"); await created.close(); newer.destroy(); return;
		}
		await new Promise<void>((resolve, reject) => {
			const tx = store.db!.transaction("custom", "readwrite"); tx.objectStore("custom").put("reassociated", SOURCE_CACHE_IDENTITY);
			tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
		});
	};
	await expect(s.share.saveManagedRestoreRecoveryCopy()).rejects.toThrow();
	expect(s.transport.restoreReview).toEqual(s.review); expect(doc.getText("contents").toString()).toContain("retained source");
	for (const entry of await fs.readdir(path.join(root, RECOVERY_FOLDER))) await expect(fs.access(path.join(root, RECOVERY_FOLDER, entry, "BACKUP-COMPLETE.txt"))).rejects.toThrow();
});

test("paused-share copy includes retained source work and metadata without moving originals or networking", async () => {
	const s = await restoreFixture();
	await s.addFile("Team/Untracked.base", new TextEncoder().encode("views: []"));
	await s.addFile("Team/Old (relay conflict today).md", new TextEncoder().encode("retained conflict copy"));
	await s.addFile("Elsewhere/Private.md", new TextEncoder().encode("outside share"));
	await s.addFile(`Team/${RECOVERY_FOLDER}/prior.md`, new TextEncoder().encode("older recovery"));
	const local = new Y.Doc(), store = new LocalDocumentStore(`${s.host}-relay-doc-${s.note.id}`, local); await store.whenSynced;
	await store.set("syncBase", "last shared text"); await store.markRestoreReview();
	await store.close(); local.destroy();
	const before = Y.encodeStateAsUpdate(s.share.crdtDoc), folder = await s.share.saveManagedRestoreRecoveryCopy();
	expect(await fs.readFile(path.join(root, folder, "files/Team/Local.md"), "utf8")).toBe("OFFLINE DISK EDIT");
	expect(await fs.readFile(path.join(root, folder, "files/Team/Untracked.base"), "utf8")).toBe("views: []");
	expect(await fs.readFile(path.join(root, folder, "files/Team/Old (relay conflict today).md"), "utf8")).toBe("retained conflict copy");
	await expect(fs.access(path.join(root, folder, "files/Elsewhere"))).rejects.toThrow();
	await expect(fs.access(path.join(root, folder, `files/Team/${RECOVERY_FOLDER}`))).rejects.toThrow();
	expect(await fs.readFile(path.join(root, "Team/Local.md"), "utf8")).toBe("OFFLINE DISK EDIT");
	expect(await fs.readFile(path.join(root, folder, `documents/${s.note.id}.unsaved.txt`), "utf8")).toBe("UNSAVED EDITOR BUFFER");
	const metadata = JSON.parse(await fs.readFile(path.join(root, folder, `documents/${s.note.id}.cache.json`), "utf8"));
	expect(metadata.custom).toEqual(expect.arrayContaining([
		expect.objectContaining({ key: { type: "string", value: "syncBase" }, value: { type: "string", value: "last shared text" } }),
		expect.objectContaining({ key: { type: "string", value: "restoreReviewRequired" } }),
	]));
	const context = JSON.parse(await fs.readFile(path.join(root, folder, "recovery.json"), "utf8"));
	expect(context).toMatchObject({ kind: "managed-restore-source-copy", review: s.review, coverage: { authorizesResume: false } });
	expect(Y.encodeStateAsUpdate(s.share.crdtDoc)).toEqual(before);
	expect(s.transport.restoreReview).toEqual(s.review); expect(s.transport.conflicts).toHaveLength(1);
	expect(fetchMock).not.toHaveBeenCalled(); expect(s.share.scanFileTree).not.toHaveBeenCalled();
});

test("copy discovers closed, staged, legacy and live document identities without creating absent caches", async () => {
	const s = await restoreFixture();
	const ids = ["before-only", "observed-only", "staged-only", "legacy-only", "live-only", "conflict-only"];
	const record = (id: string): ItemRecord => ({ id, type: ItemKind.Document, version: 0 });
	s.review.before = { ...s.server, records: { "Before.md": record(ids[0]) } };
	s.review.observed.records = { "Observed.md": record(ids[1]) };
	s.share.folderIndex.stagedWrites.set("Staged.md", record(ids[2]));
	s.share.crdtDoc.getMap("docs").set("Legacy.md", ids[3]);
	s.share.crdtDoc.getMap(CONFLICTS).set("another", { ...s.conflict, id: "another", base: { "Prior.md": record(ids[5]) }, local: {} });
	const liveDoc = new Y.Doc(); cleanup.push(() => liveDoc.destroy()); liveDoc.getText("contents").insert(0, "LIVE UNSENT HISTORY");
	const live = Object.create(Document.prototype) as Document;
	Object.assign(live, { entityGuid: ids[4], crdtDoc: liveDoc, _unsavedFile: { unsavedText: "LIVE UNSAVED TEXT" } });
	s.share.trackedEntries.set(ids[4], live);
	for (const id of ids.slice(0, 4)) {
		const doc = new Y.Doc(), store = new LocalDocumentStore(`${s.host}-relay-doc-${id}`, doc); await store.whenSynced;
		doc.getText("contents").insert(0, `retained ${id}`); await store.close(); doc.destroy();
	}
	const databases = await indexedDB.databases(), folder = await s.share.saveManagedRestoreRecoveryCopy();
	for (const id of ids) await expect(fs.access(path.join(root, folder, `documents/${id}.yjs`))).resolves.toBeUndefined();
	expect(await fs.readFile(path.join(root, folder, `documents/${ids[4]}.txt`), "utf8")).toBe("LIVE UNSENT HISTORY");
	expect(await fs.readFile(path.join(root, folder, `documents/${ids[4]}.unsaved.txt`), "utf8")).toBe("LIVE UNSAVED TEXT");
	expect(JSON.parse(await fs.readFile(path.join(root, folder, `documents/${ids[5]}.cache.json`), "utf8"))).toMatchObject({ exists: false });
	expect(await indexedDB.databases()).toEqual(databases);
});

test.each(["disk edits", "inventory edits", "unsaved edits", "new file", "review", "path", "server", "provider", "unload", "staging", "account", "address", "credentials"])("paused-share export rejects %s arriving during archive and retains originals", async kind => {
	const s = await restoreFixture();
	const write = s.vault.adapter.writeBinary; let changed = false;
	s.vault.adapter.writeBinary = async (p, bytes) => {
		await write(p, bytes); if (changed) return; changed = true;
		if (kind === "disk edits") await fs.writeFile(path.join(root, "Team/Local.md"), "new edit");
		if (kind === "inventory edits") s.share.crdtDoc.getMap("docactivity_v0").set(s.note.id, "changed");
		if (kind === "unsaved edits") await s.share.unsavedStore.persistUnsaved(s.note.id, "new buffer");
		if (kind === "new file") await s.addFile("Team/New.md", new TextEncoder().encode("new file"));
		if (kind === "review") s.share.crdtDoc.getMap("managed_base_v1").set("restoreReview", { ...s.review, id: "other" });
		if (kind === "path") s.share.path = "Other";
		if (kind === "server") s.config.onpremServerId = "other-server";
		if (kind === "provider") Object.assign(s.share, { _liveProvider: {} });
		if (kind === "unload") s.share.isTornDown = true;
		if (kind === "staging") s.share.folderIndex.stagedDeletes.add("Local.md");
		if (kind === "account") s.checkAuth.mockImplementation(() => { throw new Error("Account changed"); });
		if (kind === "address") Object.assign(s.share, { _resourceAddress: new RemoteFolderAddress(crypto.randomUUID(), crypto.randomUUID()) });
		if (kind === "credentials") Object.assign(s.share, { credentialCache: {} });
	};
	await expect(s.share.saveManagedRestoreRecoveryCopy()).rejects.toThrow();
	expect(await fs.readFile(path.join(root, "Team/Local.md"), "utf8")).toBe(kind === "disk edits" ? "new edit" : "OFFLINE DISK EDIT");
	expect(fetchMock).not.toHaveBeenCalled(); expect(s.transport.conflicts).toHaveLength(1);
	for (const folder of await fs.readdir(path.join(root, RECOVERY_FOLDER))) await expect(fs.access(path.join(root, RECOVERY_FOLDER, folder, "BACKUP-COMPLETE.txt"))).rejects.toThrow();
});

test("failed and concurrent paused-share saves leave a retryable review", async () => {
	const s = await restoreFixture(); const read = s.vault.readBinary;
	let reject!: (error: Error) => void;
	let started!: () => void; const reading = new Promise<void>(resolve => { started = resolve; });
	s.vault.readBinary = () => new Promise((_, fail) => { reject = fail; started(); });
	const pending = s.share.saveManagedRestoreRecoveryCopy();
	await expect(s.share.saveManagedRestoreRecoveryCopy()).rejects.toThrow("already being saved");
	await reading;
	reject(new Error("disk unavailable")); await expect(pending).rejects.toThrow("disk unavailable");
	s.vault.readBinary = read;
	await expect(s.share.saveManagedRestoreRecoveryCopy()).resolves.toContain(RECOVERY_FOLDER);
	expect(s.transport.restoreReview).toEqual(s.review); expect(fetchMock).not.toHaveBeenCalled();
});

test("paused-share copy recovers a closed inventory orphan using exact recorded cache identity", async () => {
	const s = await restoreFixture(), address = s.share.resourceAddress as RemoteFolderAddress;
	const orphan = crypto.randomUUID(), other = crypto.randomUUID();
	for (const id of [orphan, other]) {
		const doc = new Y.Doc(), store = new LocalDocumentStore(`${s.host}-relay-doc-${id}`, doc); await store.whenSynced;
		doc.getText("contents").insert(0, id === orphan ? "CLOSED ORPHAN HISTORY" : "OTHER SHARE HISTORY");
		await store.set("appId", s.host);
		await store.set("s3rn", ResourceAddress.serialize(new RemoteDocumentAddress(address.relayGuid, id === orphan ? address.folderGuid : crypto.randomUUID(), id)));
		await store.close(); doc.destroy();
	}
	const folder = await s.share.saveManagedRestoreRecoveryCopy();
	expect(await fs.readFile(path.join(root, folder, `documents/${orphan}.txt`), "utf8")).toBe("CLOSED ORPHAN HISTORY");
	await expect(fs.access(path.join(root, folder, `documents/${other}.yjs`))).rejects.toThrow();
	const metadata = JSON.parse(await fs.readFile(path.join(root, folder, "recovery.json"), "utf8"));
	expect(metadata.cacheDiscovery).toMatchObject({ status: "available", documents: [expect.objectContaining({ id: orphan })], unreadable: 0 });
	expect(JSON.stringify(metadata)).not.toContain(other);
});

test("an orphan cache reassociated during archive cannot be accepted as the original history", async () => {
	const s = await restoreFixture(), address = s.share.resourceAddress as RemoteFolderAddress, id = crypto.randomUUID();
	const doc = new Y.Doc(), store = new LocalDocumentStore(`${s.host}-relay-doc-${id}`, doc); await store.whenSynced;
	doc.getText("contents").insert(0, "ORIGINAL ORPHAN HISTORY");
	await store.set("appId", s.host); await store.set("s3rn", ResourceAddress.serialize(new RemoteDocumentAddress(address.relayGuid, address.folderGuid, id)));
	const write = s.vault.adapter.writeBinary; let changed = false;
	s.vault.adapter.writeBinary = async (p, bytes) => {
		await write(p, bytes); if (changed) return; changed = true;
		await store.set("s3rn", ResourceAddress.serialize(new RemoteDocumentAddress(address.relayGuid, crypto.randomUUID(), id)));
	};
	try { await expect(s.share.saveManagedRestoreRecoveryCopy()).rejects.toThrow("association changed"); }
	finally { await store.close(); doc.destroy(); }
	expect(await fs.readFile(path.join(root, "Team/Local.md"), "utf8")).toBe("OFFLINE DISK EDIT");
	expect(s.transport.restoreReview).toEqual(s.review); expect(fetchMock).not.toHaveBeenCalled();
});

test("conflicting document types fail without silently skipping one history", async () => {
	const s = await restoreFixture();
	s.share.folderIndex.stagedWrites.set("Changed.canvas", { id: s.note.id, type: ItemKind.Canvas, version: 0 });
	await expect(s.share.saveManagedRestoreRecoveryCopy()).rejects.toThrow("conflicting types");
	await expect(fs.access(path.join(root, RECOVERY_FOLDER))).rejects.toThrow();
});

test("real filesystem + IndexedDB: accepting the server layout archives originals and retains offline state", async () => {
	const { share, transport, conflict, server, note, host } = await shareFixture();
	const folder = await share.resolveManagedConflict(conflict.id, "server", server.records);
	expect(transport.conflicts).toHaveLength(0);
	await expect(fs.access(path.join(root, "Team/Local.md"))).rejects.toThrow();
	expect(await fs.readFile(path.join(root, folder, "originals/Team/Local.md"), "utf8")).toBe("OFFLINE DISK EDIT");
	expect(await fs.readFile(path.join(root, folder, "files/Team/Local.bin"))).toEqual(Buffer.from([255, 0, 19]));
	expect(await fs.readFile(path.join(root, folder, `documents/${note.id}.txt`), "utf8")).toBe("OFFLINE EDIT IN INDEXEDDB");
	expect(await fs.readFile(path.join(root, folder, `documents/${note.id}.unsaved.txt`), "utf8")).toBe("UNSAVED EDITOR BUFFER");
	expect(JSON.parse(await fs.readFile(path.join(root, folder, `documents/${note.id}.cache.json`), "utf8"))).toMatchObject({
		format: "team-relay-document-cache-metadata", version: 1, exists: true, cacheName: `${host}-relay-doc-${note.id}`,
	});
	const restarted = new Y.Doc(); const persistence = new LocalDocumentStore(`${host}-relay-doc-${note.id}`, restarted);
	await persistence.whenSynced; expect(restarted.getText("contents").toString()).toBe("OFFLINE EDIT IN INDEXEDDB");
	await persistence.close(); restarted.destroy();
	expect(share.crdtDoc.getMap("filemeta_v0").toJSON()).toEqual(server.records);
});

test("a disk-full failure leaves originals and the persisted conflict intact", async () => {
	const { share, transport, conflict, server, vault } = await shareFixture();
	vault.adapter.writeBinary = async () => { throw Error("disk full"); };
	await expect(share.resolveManagedConflict(conflict.id, "server", server.records)).rejects.toThrow("disk full");
	expect(await fs.readFile(path.join(root, "Team/Local.md"), "utf8")).toBe("OFFLINE DISK EDIT");
	expect(transport.conflicts).toHaveLength(1);
});

test("archive corruption after completion but before the structural decision leaves originals in place", async () => {
	const { share, transport, conflict, server, vault } = await shareFixture();
	const write = vault.adapter.write;
	vault.adapter.write = async (p, text) => {
		await write(p, text);
		if (p.endsWith("/BACKUP-COMPLETE.txt")) await fs.writeFile(path.join(root, path.dirname(p), "files/Team/Local.md"), "CORRUPT COPY");
	};
	await expect(share.resolveManagedConflict(conflict.id, "server", server.records)).rejects.toThrow("verification failed");
	expect(await fs.readFile(path.join(root, "Team/Local.md"), "utf8")).toBe("OFFLINE DISK EDIT");
	expect(transport.conflicts).toHaveLength(1);
});

test("a partial archive failure retains all bytes and leaves a reviewable conflict", async () => {
	const { share, transport, conflict, server, vault } = await shareFixture();
	const rename = vault.rename; let calls = 0;
	vault.rename = async (file, target) => { if (++calls === 2) throw Error("rename failed"); return rename(file, target); };
	await expect(share.resolveManagedConflict(conflict.id, "server", server.records)).rejects.toThrow("rename failed");
	expect(transport.conflicts).toHaveLength(1); expect(share.isRecoveringStructure).toBe(false);
	const folders = await fs.readdir(path.join(root, RECOVERY_FOLDER));
	expect(await fs.readFile(path.join(root, RECOVERY_FOLDER, folders[0], "files/Team/Local.md"), "utf8")).toBe("OFFLINE DISK EDIT");
	// A second attempt can finish; the first archive remains untouched.
	vault.rename = rename;
	await share.resolveManagedConflict(conflict.id, "server", server.records);
	expect(transport.conflicts).toHaveLength(0);
	expect(await fs.readFile(path.join(root, RECOVERY_FOLDER, folders[0], "files/Team/Local.bin"))).toEqual(Buffer.from([255, 0, 19]));
});

test("recovery folders are excluded even when the whole vault is shared", () => {
	const registry = Object.create(ShareRegistry.prototype) as ShareRegistry;
	Object.assign(registry, { locate: () => ({ path: "" }) });
	expect(registry.shareFor(`${RECOVERY_FOLDER}/backup/Note.md`)).toBeNull();
	const share = Object.create(VaultShare.prototype) as VaultShare;
	const folder = Object.create(TFolder.prototype); folder.path = RECOVERY_FOLDER;
	expect(share.isSyncableVaultFile(folder)).toBe(false);
});


test("a disk edit arriving during backup remains at its original path and blocks the decision", async () => {
	const { share, transport, conflict, server, vault } = await shareFixture();
	const write = vault.adapter.writeBinary; let changed = false;
	vault.adapter.writeBinary = async (p, bytes) => {
		await write(p, bytes);
		if (!changed) { changed = true; await fs.writeFile(path.join(root, "Team/Local.md"), "NEW DISK EDIT DURING BACKUP"); }
	};
	await expect(share.resolveManagedConflict(conflict.id, "server", server.records)).rejects.toThrow("Local edits arrived");
	expect(await fs.readFile(path.join(root, "Team/Local.md"), "utf8")).toBe("NEW DISK EDIT DURING BACKUP");
	expect(transport.conflicts).toHaveLength(1);
});

test("a live edit arriving during archive is retained without tearing down its document", async () => {
	const { share, transport, conflict, server, vault, note, host } = await shareFixture();
	const liveDoc = new Y.Doc(), store = new LocalDocumentStore(`${host}-relay-doc-${note.id}`, liveDoc);
	await store.whenSynced; cleanup.push(async () => { await store.close(); liveDoc.destroy(); });
	const live = Object.create(Document.prototype) as Document;
	Object.assign(live, { crdtDoc: liveDoc, entityGuid: note.id, entryPath: "Local.md", dismantle: jest.fn(), goOffline: jest.fn(), scheduleSave: { cancel: jest.fn() } });
	share.trackedEntries.set(note.id, live);
	const rename = vault.rename;
	vault.rename = async (file, target) => { await rename(file, target); liveDoc.getText("contents").insert(0, "LATE EDIT\n"); };
	await expect(share.resolveManagedConflict(conflict.id, "server", server.records)).rejects.toThrow("Editing continued");
	expect(live.dismantle).not.toHaveBeenCalled(); expect(transport.conflicts).toHaveLength(1);
	await store.close();
	const restored = new Y.Doc(), reopened = new LocalDocumentStore(`${host}-relay-doc-${note.id}`, restored);
	await reopened.whenSynced; expect(restored.getText("contents").toString()).toContain("LATE EDIT");
	await reopened.close(); restored.destroy();
});
