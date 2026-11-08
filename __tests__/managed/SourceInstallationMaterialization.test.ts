import "fake-indexeddb/auto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { createDesktopSourceInstallationIO } from "../../src/DesktopSourceInstallationIO";
import { createDesktopSourceMaterializationIO } from "../../src/DesktopSourceMaterializationIO";
import { INSTALLATION_METADATA, materializeSourceInstallation, withMaterializedSourceInstallation, type MaterializedSourceSession } from "../../src/SourceInstallationMaterialization";
import { prepareRecoveryBackup } from "../../src/ManagedRecoveryBackup";
import { stageSourceInstallation } from "../../src/SourceInstallationStaging";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { ItemKind } from "../../src/ItemKinds";
import { trackNativeSourceMutation } from "../../src/storage/native-document-writes";
import { seedSourceInstallationCaches } from "../../src/SourceInstallationCaches";
import { openSourceDocumentCache, sourceDocumentCacheSync, sourceInventoryCacheSync } from "../../src/storage/source-document-cache";
import { admitSourceStartup, releaseRetiredSourceHold } from "../../src/storage/source-startup-admission";
import { stageSourceInstallationMapping } from "../../src/SourceInstallationMapping";
import { Settings, SettingsScope } from "../../src/SettingsPersistence";
import type { VaultShareSettings } from "../../src/VaultShare";
import { activateSourceInstallation, sourceActivationRequest } from "../../src/SourceInstallationActivation";
import { UnsavedFileStore } from "../../src/UnsavedFile";

jest.mock("obsidian", () => ({ Platform: { isMobile: false }, FileSystemAdapter: class {} }));
const encode = (text: string) => new TextEncoder().encode(text).buffer;
const digest = (bytes: ArrayBuffer) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
let directory: string, vault: Vault;
const journals: SourceSelectionJournal[] = [];
const settingsScopes: SettingsScope<VaultShareSettings[]>[] = [];
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-native-installation-")); Object.assign(Platform, { isMobile: false });
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => directory;
	adapter.stat = async name => {
		try { const value = await fs.stat(path.join(directory, name)); return { type: value.isDirectory() ? "folder" : "file", size: value.size, ctime: value.ctimeMs, mtime: value.mtimeMs }; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	};
	adapter.readBinary = async name => new Uint8Array(await fs.readFile(path.join(directory, name))).buffer;
	vault = { adapter, createBinary: jest.fn(() => { throw new Error("Unsafe native write"); }), createFolder: jest.fn(() => { throw new Error("Unsafe native mkdir"); }) } as unknown as Vault;
});
afterEach(async () => {
	jest.restoreAllMocks(); journals.splice(0).forEach(journal => journal.close());
	settingsScopes.splice(0).forEach(scope => scope.destroy());
	await fs.rm(directory, { recursive: true, force: true });
	await fs.rm(directory + "-moved", { recursive: true, force: true });
});
async function fixture() {
	await fs.mkdir(path.join(directory, "Team")); await fs.writeFile(path.join(directory, "Team", "Note.md"), "Original offline work");
	const backup = await prepareRecoveryBackup({ stat: vault.adapter.stat.bind(vault.adapter), readBinary: vault.adapter.readBinary.bind(vault.adapter),
		mkdir: async name => { await fs.mkdir(path.join(directory, name), { recursive: true }); },
		write: (name, text) => fs.writeFile(path.join(directory, name), text),
		writeBinary: (name, data) => fs.writeFile(path.join(directory, name), new Uint8Array(data)),
	}, async () => ({ files: [{ path: "Team/Note.md", bytes: encode("Original offline work") }], documents: [], index: new Uint8Array([0, 0]) }), {});
	const doc = new Y.Doc(); doc.getText("contents").insert(0, "Restored source"); const update = Y.encodeStateAsUpdate(doc); doc.destroy();
	const image = encode("Synthetic attachment"), noteId = crypto.randomUUID();
	const source = { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())), restoreGeneration: crypto.randomUUID() };
	const reviewId = crypto.randomUUID(), staging = createDesktopSourceInstallationIO(vault);
	const staged = await stageSourceInstallation(staging, { source, reviewId, archive: backup.reference, originalRoot: "Team", destinationRoot: "Restored Team",
		snapshot: { records: {
			"Notes/Note.md": { id: noteId, version: 0, type: ItemKind.Document },
			"Empty": { id: crypto.randomUUID(), version: 0, type: ItemKind.Folder },
			"Picture.png": { id: crypto.randomUUID(), version: 0, type: ItemKind.Image, hash: digest(image), synctime: 1, mimetype: "image/png" },
		}, permissions: { "Notes/Note.md": "read", Empty: "read", "Picture.png": "read" }, activity: {}, owner: false, restore_guard: true, restore_generation: source.restoreGeneration },
	}, { source: async () => update, attachment: async () => image });
	const journal = await SourceSelectionJournal.open(source); journals.push(journal);
	let selection = await journal.apply({ type: "begin", expectedRevision: null, operationId: crypto.randomUUID(), reviewId, restoreGeneration: source.restoreGeneration });
	selection = await journal.apply({ type: "prepare", expectedRevision: selection.revision, operationId: crypto.randomUUID(), reviewId,
		preparation: { archive: backup.reference, plan: staged.reference } });
	const request = { source, reviewId, revision: selection.revision!, operationId: crypto.randomUUID() };
	return { journal, staging, staged, request, image, noteId, native: createDesktopSourceMaterializationIO(vault, staged.plan) };
}
const installed = (name: string) => path.join(directory, "Restored Team", name);
async function reopen(f: Awaited<ReturnType<typeof fixture>>) {
	f.journal.close(); const journal = await SourceSelectionJournal.open(f.request.source); journals.push(journal);
	const request = { ...f.request, revision: (await journal.read()).revision! };
	return { journal, request, native: createDesktopSourceMaterializationIO(vault, f.staged.plan) };
}

async function activationFixture() {
	const f = await fixture(), address = ResourceAddress.parse(f.request.source.s3rn) as RemoteFolderAddress;
	const configuration = path.join(directory, "fixture-settings.json");
	await fs.writeFile(configuration, JSON.stringify({ sharedFolders: [{ guid: address.folderGuid, path: "Team", relay: address.relayGuid, onpremServerId: f.request.source.serverId }] }));
	const backend = { loadData: async () => JSON.parse(await fs.readFile(configuration, "utf8")) as { sharedFolders: VaultShareSettings[] },
		saveData: jest.fn(async (data: { sharedFolders: VaultShareSettings[] }) => { await fs.writeFile(configuration, JSON.stringify(data)); }) };
	const settings = new Settings(backend, { sharedFolders: [] as VaultShareSettings[] }); await settings.hydrate();
	const scope = new SettingsScope<VaultShareSettings[]>(settings as unknown as Settings<unknown>, "sharedFolders"); settingsScopes.push(scope);
	const local = new Map<string, unknown>(), buffers = new UnsavedFileStore();
	const host = { settings: scope, app: { loadLocalStorage: jest.fn((key: string) => local.get(key)) }, buffers, checkIsolation: jest.fn() };
	const request = { ...f.request, commitOperationId: crypto.randomUUID() };
	const downloads = { revalidate: jest.fn(async () => structuredClone(f.staged.inventorySnapshot)) };
	const bufferKey = sourceDocumentCacheSync({ ...request.source, s3rn: `${request.source.s3rn}:doc:${f.noteId}` }).bufferKey;
	const run = () => activateSourceInstallation(f.journal, f.staging, f.native, request, host, downloads);
	return { ...f, configuration, backend, settings, scope, local, buffers, host, request, downloads, bufferKey, run };
}

test("activation integrates native files, selected caches, saved mapping and fresh inventory under both holds", async () => {
	const f = await activationFixture();
	f.downloads.revalidate.mockImplementationOnce(async () => {
		for (const target of ["Team/Note.md", "Restored Team/Notes/Note.md"]) await expect(trackNativeSourceMutation(vault, [target], async () => {})).rejects.toThrow("paused");
		expect((await f.scope.readPersistedValue())![0].path).toBe("Restored Team");
		return structuredClone(f.staged.inventorySnapshot);
	});
	const result = await f.run();
	expect(result).toMatchObject({ destinationRoot: "Restored Team", reconciled: false, selection: { nativeRoot: "Restored Team", pending: null,
		active: { kind: "source", restoreGeneration: f.request.source.restoreGeneration } } });
	expect(f.downloads.revalidate).toHaveBeenCalledTimes(1); expect(f.host.checkIsolation).toHaveBeenCalled();
	const doc = new Y.Doc(), store = await openSourceDocumentCache({ ...f.request.source, s3rn: `${f.request.source.s3rn}:doc:${f.noteId}` }, doc);
	try { expect(doc.getText("contents").toString()).toBe(await fs.readFile(installed("Notes/Note.md"), "utf8")); }
	finally { await store.close(); doc.destroy(); }
	expect(await fs.readFile(path.join(directory, "Team", "Note.md"), "utf8")).toBe("Original offline work");
});

test("a committed retry preserves subsequent native edits, saved buffers and cache history without revalidation or installation", async () => {
	const f = await activationFixture(), result = await f.run();
	await fs.writeFile(installed("Notes/Note.md"), "Legitimate edit after activation");
	await f.buffers.persistUnsaved(f.bufferKey, "New saved local work");
	const doc = new Y.Doc(), store = await openSourceDocumentCache({ ...f.request.source, s3rn: `${f.request.source.s3rn}:doc:${f.noteId}` }, doc);
	doc.getText("contents").insert(0, "New CRDT edit. "); await store.close(); doc.destroy();
	const claim = jest.spyOn(f.native, "claim"), read = jest.spyOn(f.staging, "readBinary"), count = jest.spyOn(f.buffers, "countSavedBuffers");
	f.downloads.revalidate.mockClear(); f.backend.saveData.mockClear(); f.host.checkIsolation.mockImplementation(() => { throw new Error("Providers already resumed"); });
	expect(await f.run()).toEqual({ ...result, reconciled: true });
	expect(claim).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(count).not.toHaveBeenCalled();
	expect(f.downloads.revalidate).not.toHaveBeenCalled(); expect(f.backend.saveData).not.toHaveBeenCalled();
	expect(await fs.readFile(installed("Notes/Note.md"), "utf8")).toBe("Legitimate edit after activation");
	expect(await f.buffers.readUnsaved(f.bufferKey)).toBe("New saved local work");
	const reopened = new Y.Doc(), cache = await openSourceDocumentCache({ ...f.request.source, s3rn: `${f.request.source.s3rn}:doc:${f.noteId}` }, reopened);
	try { expect(reopened.getText("contents").toString()).toBe("New CRDT edit. Restored source"); } finally { await cache.close(); reopened.destroy(); }
});

test("an activation reply lost after commit is reconciled once without a second commit", async () => {
	const f = await activationFixture(), apply = f.journal.apply.bind(f.journal);
	const saved = jest.spyOn(f.journal, "apply").mockImplementation(async (change, options) => {
		const state = await apply(change, options); if (change.type === "commit") throw new Error("Lost activation reply"); return state;
	});
	expect(await f.run()).toMatchObject({ reconciled: true, selection: { pending: null } });
	expect(saved.mock.calls.filter(([change]) => change.type === "commit")).toHaveLength(1);
});

test("a failed commit without a receipt stays applying and resumes only after rereading its revision", async () => {
	const f = await activationFixture(), apply = f.journal.apply.bind(f.journal);
	const saved = jest.spyOn(f.journal, "apply").mockImplementation(async (change, options) => {
		if (change.type === "commit") throw new Error("Synthetic transaction failure"); return apply(change, options);
	});
	await expect(f.run()).rejects.toThrow("transaction failure"); saved.mockRestore();
	const state = await f.journal.read(); expect(state.pending?.phase).toBe("applying");
	f.request.revision = state.revision!; expect(await f.run()).toMatchObject({ reconciled: false, selection: { pending: null } });
});

test.each(["saved buffer", "upload", "mapping", "native bytes", "generation", "permissions", "isolation"])("a change during final revalidation blocks activation and preserves evidence: %s", async kind => {
	const f = await activationFixture();
	f.downloads.revalidate.mockImplementationOnce(async () => {
		const fresh = structuredClone(f.staged.inventorySnapshot);
		if (kind === "saved buffer") await f.buffers.persistUnsaved(f.bufferKey, "");
		if (kind === "upload") f.local.set(sourceInventoryCacheSync(f.request.source).name + "/pendingUploads", { "Notes/Note.md": "pending" });
		if (kind === "mapping") { const data = await f.backend.loadData(); data.sharedFolders[0].path = "Team"; await f.backend.saveData(data); }
		if (kind === "native bytes") await fs.writeFile(installed("Notes/Note.md"), "External edit");
		if (kind === "generation") fresh.restore_generation = crypto.randomUUID();
		if (kind === "permissions") fresh.permissions["Notes/Note.md"] = "write";
		if (kind === "isolation") f.host.checkIsolation.mockImplementation(() => { throw new Error("Isolation expired"); });
		return fresh;
	});
	await expect(f.run()).rejects.toThrow(); expect((await f.journal.read()).pending?.phase).toBe("applying");
	await expect(f.journal.reconcileCommit({ operationId: f.request.commitOperationId, reviewId: f.request.reviewId, restoreGeneration: f.request.source.restoreGeneration })).rejects.toThrow("missing");
	if (kind === "saved buffer") expect(await f.buffers.readUnsaved(f.bufferKey)).toBe("");
	if (kind === "mapping") expect((await f.backend.loadData()).sharedFolders[0].path).toBe("Team");
	if (kind === "native bytes") expect(await fs.readFile(installed("Notes/Note.md"), "utf8")).toBe("External edit");
});

test("cancelling a slow final server read cannot cause a late activation", async () => {
	const f = await activationFixture(), controller = new AbortController(); let release!: () => void, entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
	f.downloads.revalidate.mockImplementationOnce(async () => { entered(); await gate; return structuredClone(f.staged.inventorySnapshot); });
	const operation = activateSourceInstallation(f.journal, f.staging, f.native, f.request, f.host, f.downloads, { signal: controller.signal });
	await started; controller.abort(); await expect(operation).rejects.toMatchObject({ name: "AbortError" });
	release(); await Promise.resolve(); expect((await f.journal.read()).pending?.phase).toBe("applying");
	f.request.revision = (await f.journal.read()).revision!; expect(await f.run()).toMatchObject({ selection: { pending: null } });
});

test("invalid activation operations and a lost writer lease are refused before creating native files", async () => {
	const f = await activationFixture();
	await expect(activateSourceInstallation(f.journal, f.staging, f.native, { ...f.request, commitOperationId: f.request.operationId }, f.host, f.downloads)).rejects.toThrow("distinct");
	f.host.checkIsolation.mockImplementation(() => { throw new Error("Isolation unavailable"); });
	await expect(f.run()).rejects.toThrow("Isolation"); await expect(fs.stat(installed(""))).rejects.toMatchObject({ code: "ENOENT" });
	expect((await f.journal.read()).pending?.phase).toBe("prepared");
});

test("durable activation intent resumes after a journal restart without regenerating operation IDs", async () => {
	const f = await activationFixture(), request = await sourceActivationRequest(f.journal, f.request);
	expect(request.revision).not.toBe(f.request.revision);
	const first = await materializeSourceInstallation(f.journal, f.staging, f.native, request);
	f.journal.close(); const journal = await SourceSelectionJournal.open(f.request.source); journals.push(journal);
	const resumed = await sourceActivationRequest(journal, { ...request, revision: first.selection.revision! });
	expect(resumed).toEqual({ ...request, revision: first.selection.revision });
	expect(await activateSourceInstallation(journal, f.staging, f.native, resumed, f.host, f.downloads)).toMatchObject({ selection: { pending: null } });
	expect(await activateSourceInstallation(journal, f.staging, f.native, resumed, f.host, f.downloads)).toMatchObject({ reconciled: true });
});

test("a lost reservation reply is recovered from saved intent without another reservation", async () => {
	const f = await activationFixture(), apply = f.journal.apply.bind(f.journal);
	const spy = jest.spyOn(f.journal, "apply").mockImplementationOnce(async (change, options) => { await apply(change, options); throw new Error("Lost intent response"); });
	await expect(sourceActivationRequest(f.journal, f.request)).rejects.toThrow("Lost intent"); spy.mockRestore();
	const state = await f.journal.read(), saved = state.pending!.preparation!.activation!, writes = jest.spyOn(f.journal, "apply");
	const resumed = await sourceActivationRequest(f.journal, { ...f.request, revision: state.revision! });
	expect(resumed.operationId).toBe(saved.startOperationId); expect(resumed.commitOperationId).toBe(saved.commitOperationId); expect(writes).not.toHaveBeenCalled();
});

test("an activation with different saved operations fails before any native writes", async () => {
	const f = await activationFixture(), request = await sourceActivationRequest(f.journal, f.request), claim = jest.spyOn(f.native, "claim");
	await expect(activateSourceInstallation(f.journal, f.staging, f.native, { ...request, commitOperationId: crypto.randomUUID() }, f.host, f.downloads)).rejects.toThrow("saved source activation");
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, { ...request, operationId: crypto.randomUUID() })).rejects.toThrow("saved source installation");
	expect(claim).not.toHaveBeenCalled(); expect((await f.journal.read()).pending?.phase).toBe("prepared");
});

test("real desktop installation preserves originals and source artifacts, creates implicit/empty directories, and stays paused", async () => {
	const f = await fixture(), result = await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	expect(result).toMatchObject({ created: 2, resumed: 0, destinationRoot: "Restored Team" });
	expect(result.selection.pending?.phase).toBe("applying"); expect(result.selection.active).toEqual({ kind: "legacy" });
	expect(await fs.readFile(installed("Notes/Note.md"), "utf8")).toBe("Restored source");
	expect(await fs.readdir(installed("Empty"))).toEqual([]);
	expect(await fs.readFile(installed("Picture.png"), "utf8")).toBe("Synthetic attachment");
	expect(await fs.readFile(path.join(directory, "Team", "Note.md"), "utf8")).toBe("Original offline work");
	expect(await f.staging.stat(`${f.staged.path}/sources/${f.noteId}.yjs`)).toMatchObject({ type: "file" });
	expect(vault.createBinary).not.toHaveBeenCalled(); expect(vault.createFolder).not.toHaveBeenCalled();
	expect(await seedSourceInstallationCaches(f.journal, f.staging, { ...f.request, revision: result.selection.revision! })).toMatchObject({ created: 2, resumed: 0 });
	const doc = new Y.Doc(), store = await openSourceDocumentCache({ ...f.request.source, s3rn: `${f.request.source.s3rn}:doc:${f.noteId}` }, doc);
	expect(doc.getText("contents").toString()).toBe(await fs.readFile(installed("Notes/Note.md"), "utf8"));
	await store.close(); doc.destroy();
	const again = await reopen(f), resumed = await materializeSourceInstallation(again.journal, f.staging, again.native, again.request);
	expect(resumed).toMatchObject({ created: 0, resumed: 2 }); expect(await fs.readdir(installed(INSTALLATION_METADATA))).toEqual(["owner.json"]);
	expect(await seedSourceInstallationCaches(again.journal, f.staging, again.request)).toMatchObject({ created: 0, resumed: 2 });
});

test("lost completion after the first published file resumes by verifying bytes after a journal/adapter restart", async () => {
	const f = await fixture(); let interrupted = false;
	const native = { ...f.native, createFileExclusive: async (name: string, bytes: ArrayBuffer) => {
		await f.native.createFileExclusive(name, bytes); if (!interrupted) { interrupted = true; throw new Error("Simulated lost completion"); }
	} };
	await expect(materializeSourceInstallation(f.journal, f.staging, native, f.request)).rejects.toThrow("lost completion");
	const next = await reopen(f), result = await materializeSourceInstallation(next.journal, f.staging, next.native, next.request);
	expect(result).toMatchObject({ created: 1, resumed: 1 });
});

test.each(["file changed", "unexpected file", "unexpected folder", "missing marker", "wrong marker", "symlink", "hard link"])("restart preserves and refuses %s", async kind => {
	const f = await fixture(); await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	if (kind === "file changed") await fs.writeFile(installed("Notes/Note.md"), "User-edited restored note");
	if (kind === "unexpected file") await fs.writeFile(installed("New.md"), "New local work");
	if (kind === "unexpected folder") await fs.mkdir(installed("New"));
	if (kind === "missing marker") await fs.unlink(installed(`${INSTALLATION_METADATA}/owner.json`));
	if (kind === "wrong marker") await fs.writeFile(installed(`${INSTALLATION_METADATA}/owner.json`), "Different installation");
	if (kind === "symlink" || kind === "hard link") {
		await fs.unlink(installed("Notes/Note.md"));
		await (kind === "symlink" ? fs.symlink : fs.link)(path.join(directory, "Team", "Note.md"), installed("Notes/Note.md"));
	}
	const before = await fs.readFile(path.join(directory, "Team", "Note.md"), "utf8"), next = await reopen(f);
	await expect(materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).rejects.toThrow();
	expect(await fs.readFile(path.join(directory, "Team", "Note.md"), "utf8")).toBe(before);
	expect((await next.journal.read()).pending?.phase).toBe("applying");
	if (kind === "file changed") expect(await fs.readFile(installed("Notes/Note.md"), "utf8")).toBe("User-edited restored note");
	if (kind === "unexpected file") expect(await fs.readFile(installed("New.md"), "utf8")).toBe("New local work");
});

test("an existing unowned empty destination is never adopted", async () => {
	const f = await fixture(); await fs.mkdir(installed(""));
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow("no installation ownership marker");
	expect(await fs.readdir(installed(""))).toEqual([]);
});

test("recovery can use a hold left by paused startup without releasing the original source barrier", async () => {
	const f = await fixture();
	await expect(admitSourceStartup(vault, "Team", f.request.source, { check: () => {} })).rejects.toThrow("awaiting recovery");
	expect(await materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).toMatchObject({ created: 2, resumed: 0 });
	await expect(trackNativeSourceMutation(vault, ["Team/Note.md"], async () => {})).rejects.toThrow("paused");
	const next = await reopen(f);
	expect(await materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).toMatchObject({ created: 0, resumed: 2 });
	await expect(trackNativeSourceMutation(vault, ["Team/Note.md"], async () => {})).rejects.toThrow("paused");
});

test("a restart at an already-mapped destination can resume remaining writes under its paused hold", async () => {
	const f = await fixture();
	const interrupted = { ...f.native, createFileExclusive: async (name: string, bytes: ArrayBuffer) => {
		await f.native.createFileExclusive(name, bytes); throw new Error("Simulated interruption");
	} };
	await expect(materializeSourceInstallation(f.journal, f.staging, interrupted, f.request)).rejects.toThrow("interruption");
	await expect(admitSourceStartup(vault, "Restored Team", f.request.source, { check: () => {} })).rejects.toThrow("awaiting recovery");
	const next = await reopen(f);
	expect(await materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).toMatchObject({ created: 1, resumed: 1 });
	await expect(trackNativeSourceMutation(vault, ["Restored Team/Note.md"], async () => {})).rejects.toThrow("paused");
});

test("a hold for an unexpected third location cannot be borrowed by the installation", async () => {
	const f = await fixture();
	await expect(admitSourceStartup(vault, "Unexpected", f.request.source, { check: () => {} })).rejects.toThrow("awaiting recovery");
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow("paused source location changed");
	await expect(fs.stat(installed(""))).rejects.toMatchObject({ code: "ENOENT" });
});

test("the installation session keeps holds through cache/mapping/commit, then hands off only the retired location", async () => {
	const f = await fixture(), address = ResourceAddress.parse(f.request.source.s3rn) as RemoteFolderAddress;
	const configuration = path.join(directory, "fixture-settings.json");
	await fs.writeFile(configuration, JSON.stringify({ sharedFolders: [{ guid: address.folderGuid, path: "Team", relay: address.relayGuid, onpremServerId: f.request.source.serverId }] }));
	const settings = new Settings({ loadData: async () => JSON.parse(await fs.readFile(configuration, "utf8")) as { sharedFolders: VaultShareSettings[] },
		saveData: async (data: { sharedFolders: VaultShareSettings[] }) => { await fs.writeFile(configuration, JSON.stringify(data)); } }, { sharedFolders: [] as VaultShareSettings[] });
	await settings.hydrate(); const scope = new SettingsScope<VaultShareSettings[]>(settings as unknown as Settings<unknown>, "sharedFolders");
	let retained!: MaterializedSourceSession;
	try {
		await expect(admitSourceStartup(vault, "Team", f.request.source, { check: () => {} })).rejects.toThrow("awaiting recovery");
		const selected = await withMaterializedSourceInstallation(f.journal, f.staging, f.native, f.request, async session => {
			retained = session; const request = { ...f.request, revision: session.selection.revision! };
			await seedSourceInstallationCaches(f.journal, f.staging, request);
			await stageSourceInstallationMapping(f.journal, f.staging, scope, request);
			for (const target of ["Team/Note.md", "Restored Team/Note.md"]) await expect(trackNativeSourceMutation(vault, [target], async () => {})).rejects.toThrow("paused");
			await session.verifyNative(); await session.assertCurrent();
			// Synthetic coordinator transition exercises the local integration.
			// Production activation still needs current server/writer admission.
			return f.journal.apply({ type: "commit", expectedRevision: session.selection.revision, operationId: crypto.randomUUID(), reviewId: f.request.reviewId, destinationRoot: session.destinationRoot });
		});
		await expect(retained.assertCurrent()).rejects.toThrow("session ended"); await expect(retained.verifyNative()).rejects.toThrow("session ended");
		await expect(trackNativeSourceMutation(vault, ["Team/Note.md"], async () => {})).rejects.toThrow("paused");
		expect(await releaseRetiredSourceHold(vault, "Team", f.request.source, { revision: selected.revision!, destinationRoot: "Restored Team" }, { check: () => {} })).toBe(true);
		const context = await admitSourceStartup(vault, "Restored Team", f.request.source, { check: () => {} });
		try { expect(context.nativeRoot).toBe("Restored Team"); expect(context.binding?.restoreGeneration).toBe(f.request.source.restoreGeneration); }
		finally { context.close(); }
		expect((await scope.readPersistedValue())![0].path).toBe("Restored Team");
		expect(await fs.readFile(path.join(directory, "Team", "Note.md"), "utf8")).toBe("Original offline work");
	} finally { scope.destroy(); }
});

test("continuation snapshots cannot change the held session's revision or native verification targets", async () => {
	const f = await fixture();
	await withMaterializedSourceInstallation(f.journal, f.staging, f.native, f.request, async session => {
		session.selection.revision = crypto.randomUUID(); session.plan.entries = [];
		await session.assertCurrent();
		await fs.writeFile(installed("Notes/Note.md"), "Changed outside the plugin");
		await expect(session.verifyNative()).rejects.toThrow("changed");
	});
	expect((await f.journal.read()).pending?.phase).toBe("applying");
});

test("a failed publication leaves no partial final file and can resume", async () => {
	const f = await fixture(), nativeFS = require("fs/promises") as typeof fs, link = nativeFS.link;
	let failed = false;
	jest.spyOn(nativeFS, "link").mockImplementation(async (temporary, destination) => {
		if (!failed) {
			failed = true; expect(await fs.readFile(temporary, "utf8")).toBe("Restored source");
			await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
			throw new Error("Simulated publication failure");
		}
		return link(temporary, destination);
	});
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow("publication failure");
	expect(await fs.readdir(installed(INSTALLATION_METADATA))).toEqual(["owner.json"]);
	const next = await reopen(f); expect(await materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).toMatchObject({ created: 2, resumed: 0 });
});

test("cancellation during a native operation waits for settlement and retains both write holds", async () => {
	const f = await fixture(), controller = new AbortController();
	let release!: () => void, started!: () => void;
	const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
	const native = { ...f.native, createFileExclusive: async (name: string, bytes: ArrayBuffer) => { started(); await gate; await f.native.createFileExclusive(name, bytes); } };
	let settled = false;
	const operation = materializeSourceInstallation(f.journal, f.staging, native, f.request, { signal: controller.signal });
	void operation.then(() => { settled = true; }, () => { settled = true; });
	await entered; controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
	for (const target of ["Team/Note.md", "Restored Team/Picture.png"]) await expect(trackNativeSourceMutation(vault, [target], async () => {})).rejects.toThrow("paused");
	release(); await expect(operation).rejects.toMatchObject({ name: "AbortError" });
	await expect(trackNativeSourceMutation(vault, ["Team/Note.md"], async () => {})).resolves.toBeUndefined();
	const next = await reopen(f); expect(await materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).toMatchObject({ created: 1, resumed: 1 });
});

test("changed journal cannot start native creation", async () => {
	const f = await fixture();
	await f.journal.apply({ type: "cancel", expectedRevision: f.request.revision, operationId: crypto.randomUUID(), reviewId: f.request.reviewId });
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow("selection changed");
	await expect(fs.stat(installed(""))).rejects.toMatchObject({ code: "ENOENT" });
});

test("staged corruption is rejected before starting installation", async () => {
	const f = await fixture(); await fs.writeFile(path.join(directory, f.staged.path, "files", f.noteId + ".bin"), "Changed source");
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow();
	expect((await f.journal.read()).pending?.phase).toBe("prepared");
	await expect(fs.stat(installed(""))).rejects.toMatchObject({ code: "ENOENT" });
});

test("an uncertain start response writes no native files and resumes from the saved applying state", async () => {
	const f = await fixture(), apply = f.journal.apply.bind(f.journal);
	jest.spyOn(f.journal, "apply").mockImplementation(async command => {
		const state = await apply(command); if (command.type === "start") throw new Error("Lost journal response"); return state;
	});
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow("Lost journal response");
	expect((await f.journal.read()).pending?.phase).toBe("applying");
	await expect(fs.stat(installed(""))).rejects.toMatchObject({ code: "ENOENT" });
	const next = await reopen(f);
	expect(await materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).toMatchObject({ created: 2, resumed: 0 });
});

test("mobile fails explicitly without using a non-exclusive Vault fallback", async () => {
	const f = await fixture(); Object.assign(Platform, { isMobile: true });
	expect(() => createDesktopSourceMaterializationIO(vault, f.staged.plan)).toThrow("does not provide exclusive");
});

test("restart removes only owned interrupted temporary bytes, including the link-publication crash window", async () => {
	const f = await fixture(); await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	await fs.link(installed("Notes/Note.md"), installed(`${INSTALLATION_METADATA}/${crypto.randomUUID()}.tmp`));
	await fs.writeFile(installed(`${INSTALLATION_METADATA}/${crypto.randomUUID()}.tmp`), "Partial unpublished bytes");
	const next = await reopen(f);
	expect(await materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).toMatchObject({ created: 0, resumed: 2 });
	expect(await fs.readdir(installed(INSTALLATION_METADATA))).toEqual(["owner.json"]);
	expect((await fs.stat(installed("Notes/Note.md"))).nlink).toBe(1);
});

test.each(["unknown control file", "linked temporary file"])("unexpected ownership-directory content is retained: %s", async kind => {
	const f = await fixture(); await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	const name = kind === "unknown control file" ? "personal-note.md" : crypto.randomUUID() + ".tmp";
	if (kind === "unknown control file") await fs.writeFile(installed(`${INSTALLATION_METADATA}/${name}`), "Retained work");
	else await fs.symlink(path.join(directory, "Team", "Note.md"), installed(`${INSTALLATION_METADATA}/${name}`));
	const next = await reopen(f);
	await expect(materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).rejects.toThrow();
	expect(await fs.lstat(installed(`${INSTALLATION_METADATA}/${name}`))).toBeTruthy();
});

test("the native adapter refuses existing final files even if their size matches", async () => {
	const f = await fixture(); await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	await expect(f.native.createFileExclusive("Restored Team/Notes/Note.md", encode("Different bytes"))).rejects.toMatchObject({ code: "EEXIST" });
	expect(await fs.readFile(installed("Notes/Note.md"), "utf8")).toBe("Restored source");
});

test("replacing the destination or vault directory invalidates a captured native adapter", async () => {
	const f = await fixture(); await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	await fs.rename(installed(""), path.join(directory, "Moved restore")); await fs.mkdir(installed(""));
	await expect(f.native.stat("Restored Team")).rejects.toThrow("destination changed");
	await fs.rename(directory, directory + "-moved"); await fs.mkdir(directory);
	await expect(f.native.stat("Restored Team")).rejects.toThrow("vault location changed");
});
