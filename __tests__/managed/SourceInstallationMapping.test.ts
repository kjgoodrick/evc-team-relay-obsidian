import "fake-indexeddb/auto";
import * as Y from "yjs";
import { stageSourceInstallationMapping } from "../../src/SourceInstallationMapping";
import { Settings, SettingsScope } from "../../src/SettingsPersistence";
import type { VaultShareSettings } from "../../src/VaultShare";
import { prepareRecoveryBackup, type RecoveryIO } from "../../src/ManagedRecoveryBackup";
import { stageSourceInstallation } from "../../src/SourceInstallationStaging";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { ItemKind } from "../../src/ItemKinds";

const encode = (text: string) => new TextEncoder().encode(text).buffer;
const journals: SourceSelectionJournal[] = [], scopes: SettingsScope<VaultShareSettings[]>[] = [];
afterEach(() => { journals.splice(0).forEach(journal => journal.close()); scopes.splice(0).forEach(scope => scope.destroy()); jest.restoreAllMocks(); });
async function fixture() {
	const files = new Map<string, ArrayBuffer>(), folders = new Set<string>();
	const io: RecoveryIO & { createDirectoryExclusive(path: string): Promise<void> } = {
		stat: async name => files.has(name) ? { type: "file", size: files.get(name)!.byteLength } : folders.has(name) ? { type: "folder", size: 0 } : null,
		readBinary: async name => { if (!files.has(name)) throw new Error("Missing fixture artifact"); return files.get(name)!.slice(0); },
		mkdir: async name => { folders.add(name); }, createDirectoryExclusive: async name => { if (folders.has(name)) throw new Error("Existing fixture directory"); folders.add(name); },
		write: async (name, text) => { files.set(name, encode(text)); }, writeBinary: async (name, bytes) => { files.set(name, bytes.slice(0)); },
	};
	const backup = await prepareRecoveryBackup(io, async () => ({ files: [{ path: "Team/Note.md", bytes: encode("Original") }], documents: [], index: new Uint8Array([0, 0]) }), {});
	const shareId = crypto.randomUUID(), noteId = crypto.randomUUID(), doc = new Y.Doc(); doc.getText("contents").insert(0, "Restored");
	const update = Y.encodeStateAsUpdate(doc); doc.destroy();
	const source = { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", shareId)), restoreGeneration: crypto.randomUUID() };
	const reviewId = crypto.randomUUID(), staged = await stageSourceInstallation(io, { source, reviewId, archive: backup.reference, originalRoot: "Team", destinationRoot: "Restored Team",
		snapshot: { records: { "Note.md": { id: noteId, version: 0, type: ItemKind.Document } }, permissions: { "Note.md": "read" }, activity: {}, owner: false, restore_guard: true, restore_generation: source.restoreGeneration },
	}, { source: async () => update, attachment: async () => { throw new Error("Unexpected attachment"); } });
	const journal = await SourceSelectionJournal.open(source); journals.push(journal);
	let state = await journal.apply({ type: "begin", operationId: crypto.randomUUID(), expectedRevision: null, reviewId, restoreGeneration: source.restoreGeneration });
	state = await journal.apply({ type: "prepare", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId, preparation: { archive: backup.reference, plan: staged.reference } });
	state = await journal.apply({ type: "start", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId });
	let data = { sharedFolders: [{ guid: shareId, path: "Team", relay: "relay-onprem", onpremServerId: "fixture", connect: false, customSetting: "retained" },
		{ guid: crypto.randomUUID(), path: "Other", relay: "relay-onprem", onpremServerId: "fixture", connect: true, customSetting: "unrelated" }], theme: { value: "retained" } };
	const backend = { loadData: jest.fn(async () => structuredClone(data)), saveData: jest.fn(async (next: typeof data) => { data = structuredClone(next); }) };
	const settings = new Settings(backend, { sharedFolders: [], theme: { value: "default" } }); await settings.hydrate();
	const scope = new SettingsScope<VaultShareSettings[]>(settings as unknown as Settings<unknown>, "sharedFolders"); scopes.push(scope);
	return { io, files, staged, source, shareId, journal, state, backend, settings, scope, request: { source, reviewId, revision: state.revision! },
		disk: () => structuredClone(data), setDisk: (next: typeof data) => { data = structuredClone(next); } };
}

test("mapping writes and reads back only the selected path, preserves other settings, and remains applying", async () => {
	const f = await fixture(), before = f.disk();
	expect(await stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).toMatchObject({ destinationRoot: "Restored Team", resumed: false });
	const expected = structuredClone(before); expected.sharedFolders[0].path = "Restored Team";
	expect(f.disk()).toEqual(expected); expect(await f.journal.read()).toEqual(f.state);
	expect(await stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).toMatchObject({ resumed: true });
	expect(f.backend.saveData).toHaveBeenCalledTimes(1);
});

test.each(["failed write", "lost acknowledgement"])("retry reconciles %s without rolling back a saved mapping", async mode => {
	const f = await fixture(), save = f.backend.saveData.getMockImplementation()!;
	f.backend.saveData.mockImplementationOnce(async next => { if (mode === "lost acknowledgement") await save(next); throw new Error("Synthetic settings interruption"); });
	await expect(stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).rejects.toThrow("interruption");
	expect(f.scope.readValue()[0].path).toBe("Restored Team");
	expect(f.disk().sharedFolders[0].path).toBe(mode === "failed write" ? "Team" : "Restored Team");
	expect((await f.journal.read()).pending?.phase).toBe("applying");
	expect(await stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).toMatchObject({ resumed: mode === "lost acknowledgement" });
	expect(f.disk().sharedFolders[0].path).toBe("Restored Team");
	expect(f.backend.saveData).toHaveBeenCalledTimes(mode === "failed write" ? 2 : 1);
});

test("persisted reads do not hydrate over current in-memory settings", async () => {
	const f = await fixture(), changed = f.disk(); changed.sharedFolders[0].connect = true; f.setDisk(changed);
	expect((await f.scope.readPersistedValue())![0].connect).toBe(true);
	expect(f.scope.readValue()[0].connect).toBe(false);
	await expect(stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).rejects.toThrow("changed outside");
	expect(f.disk()).toEqual(changed); expect(f.backend.saveData).not.toHaveBeenCalled();
});

test.each(["server", "relay", "path", "duplicate identity", "nested share", "parent share", "case alias", "root share"])("changed or conflicting %s mapping is refused before writing", async kind => {
	const f = await fixture(), changed = f.disk();
	if (kind === "server") changed.sharedFolders[0].onpremServerId = "other";
	if (kind === "relay") changed.sharedFolders[0].relay = "other";
	if (kind === "path") changed.sharedFolders[0].path = "Unexpected";
	if (kind === "duplicate identity") changed.sharedFolders[1].guid = changed.sharedFolders[0].guid;
	if (kind === "nested share") changed.sharedFolders[1].path = "Restored Team/Private";
	if (kind === "parent share" || kind === "case alias") changed.sharedFolders[1].path = kind === "parent share" ? "Restored Team" : "RESTORED TEAM";
	if (kind === "root share") changed.sharedFolders[1].path = "";
	f.setDisk(changed); await f.settings.hydrate();
	await expect(stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).rejects.toThrow();
	expect(f.disk()).toEqual(changed); expect(f.backend.saveData).not.toHaveBeenCalled();
});

test("an in-memory change during the persisted read is preserved and prevents a stale mapping write", async () => {
	const f = await fixture(), read = f.scope.readPersistedValue.bind(f.scope);
	jest.spyOn(f.scope, "readPersistedValue").mockImplementationOnce(async () => { const result = await read(); f.scope.readValue()[1].connect = false; return result; });
	await expect(stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).rejects.toThrow("in-memory folder settings changed");
	expect(f.scope.readValue()[1].connect).toBe(false); expect(f.disk().sharedFolders[0].path).toBe("Team"); expect(f.backend.saveData).not.toHaveBeenCalled();
});

test("a save that reports success without preserving the requested path cannot pass readback", async () => {
	const f = await fixture(); f.backend.saveData.mockImplementationOnce(async () => {});
	await expect(stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).rejects.toThrow("not verified");
	expect((await f.journal.read()).pending?.phase).toBe("applying");
	expect(await stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).toMatchObject({ resumed: false });
});

test("late cancellation waits for settings I/O and leaves a saved mapping recoverable", async () => {
	const f = await fixture(), controller = new AbortController(), save = f.backend.saveData.getMockImplementation()!;
	let release!: () => void, started!: () => void;
	const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
	f.backend.saveData.mockImplementationOnce(async next => { started(); await gate; await save(next); });
	const operation = stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request, { signal: controller.signal });
	await entered; controller.abort(); release(); await expect(operation).rejects.toMatchObject({ name: "AbortError" });
	expect(f.disk().sharedFolders[0].path).toBe("Restored Team"); expect((await f.journal.read()).pending?.phase).toBe("applying");
	expect(await stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).toMatchObject({ resumed: true });
});

test("corrupted artifacts or a stale journal prevent any mapping write", async () => {
	const f = await fixture();
	await expect(stageSourceInstallationMapping(f.journal, f.io, f.scope, { ...f.request, revision: crypto.randomUUID() })).rejects.toThrow("selection changed");
	f.files.set(`${f.staged.path}/inventory.yjs`, new Uint8Array([0, 0]).buffer);
	await expect(stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request)).rejects.toThrow();
	expect(f.backend.saveData).not.toHaveBeenCalled(); expect(f.disk().sharedFolders[0].path).toBe("Team");
});

test("a cancelled persisted read cannot cause a late mapping write", async () => {
	const f = await fixture(), controller = new AbortController(); let resolve!: (rows: VaultShareSettings[]) => void, started!: () => void;
	const entered = new Promise<void>(done => { started = done; });
	jest.spyOn(f.scope, "readPersistedValue").mockImplementationOnce(() => { started(); return new Promise(done => { resolve = done; }); });
	const operation = stageSourceInstallationMapping(f.journal, f.io, f.scope, f.request, { signal: controller.signal });
	await entered; controller.abort(); await expect(operation).rejects.toMatchObject({ name: "AbortError" });
	resolve(f.disk().sharedFolders); await Promise.resolve();
	expect(f.backend.saveData).not.toHaveBeenCalled(); expect(f.disk().sharedFolders[0].path).toBe("Team");
});
