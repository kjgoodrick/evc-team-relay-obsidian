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

jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
const fetchMock = platformFetch as jest.Mock;
let root: string;
const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-recovery-test-")); fetchMock.mockReset(); });
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

test.each(["identity", "file collision", "identity collision", "directory collision"])("invalid capture %s cannot overwrite another recovery item", async kind => {
	const state = capture();
	if (kind === "identity") state.documents[0].id = "../escape";
	if (kind === "file collision") state.files.push({ ...state.files[0], path: "team/local.md" });
	if (kind === "identity collision") state.documents.push({ ...state.documents[0], id: "A" });
	if (kind === "directory collision") state.files.push({ ...state.files[0], path: "Team/Local.md/nested" }, { ...state.files[0], path: "Team/Local.md-other" });
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
	Object.assign(share, { path: "Team", hostAppId: host, entityGuid: "share", crdtDoc: doc, vaultApi: vault, trackedEntries: new Map(), pathSet: new Set(), unsavedStore,
		_liveProvider: { managedIndex: transport }, scanFileTree: jest.fn(async () => {}), folderIndex: {}, log: jest.fn(), warn: jest.fn() });
	return { share, transport, conflict, server, note, vault, nodes, host };
}

test("real filesystem + IndexedDB: accepting the server layout archives originals and retains offline state", async () => {
	const { share, transport, conflict, server, note, host } = await shareFixture();
	const folder = await share.resolveManagedConflict(conflict.id, "server", server.records);
	expect(transport.conflicts).toHaveLength(0);
	await expect(fs.access(path.join(root, "Team/Local.md"))).rejects.toThrow();
	expect(await fs.readFile(path.join(root, folder, "originals/Team/Local.md"), "utf8")).toBe("OFFLINE DISK EDIT");
	expect(await fs.readFile(path.join(root, folder, "files/Team/Local.bin"))).toEqual(Buffer.from([255, 0, 19]));
	expect(await fs.readFile(path.join(root, folder, `documents/${note.id}.txt`), "utf8")).toBe("OFFLINE EDIT IN INDEXEDDB");
	expect(await fs.readFile(path.join(root, folder, `documents/${note.id}.unsaved.txt`), "utf8")).toBe("UNSAVED EDITOR BUFFER");
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
