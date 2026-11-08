import "fake-indexeddb/auto";
import { TFolder, type Vault } from "obsidian";
import { Settings, SettingsScope } from "../src/SettingsPersistence";
import type { VaultShareSettings } from "../src/VaultShare";
import { prepareFolderSource, type FolderPreparationHost } from "../src/storage/prepare-folder-source";
import { SourceSelectionJournal } from "../src/storage/source-selection-journal";
import { RemoteFolderAddress, ResourceAddress } from "../src/ResourceAddress";
import { trackNativeDocumentWrite } from "../src/storage/native-document-writes";
import { RECOVERY_FOLDER } from "../src/conflictCopyPath";

const id = () => crypto.randomUUID();
function deferred() { let finish!: () => void; return { promise: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() }; }
async function fixture(path = "Team") {
	const request = { path, guid: id(), workspaceId: "relay-onprem", serverId: "fixture" };
	const root = Object.assign(Object.create(TFolder.prototype) as TFolder, { path: path || "/" });
	const vault = { getRoot: () => root, getAbstractFileByPath: (value: string) => value === root.path ? root : null } as unknown as Vault;
	let data = { sharedFolders: [] as VaultShareSettings[] }, enabled = true, current = true;
	const backend = { loadData: jest.fn(async () => structuredClone(data)), saveData: jest.fn(async (next: typeof data) => { data = structuredClone(next); }) };
	const settings = new Settings(backend, data); await settings.hydrate();
	const scope = new SettingsScope<VaultShareSettings[]>(settings as unknown as Settings<unknown>, "sharedFolders");
	const credentials = { captureDocumentSourceContext: jest.fn((_server?: string) => ({ serverId: "fixture", controlPlaneUrl: "https://fixture.test/", check: () => { if (!current) throw new Error("account changed"); } })) };
	const host: FolderPreparationHost = { vault, hostAppId: id(), credentials, settings: scope, onpremEnabled: () => enabled, check: () => {} };
	const identity = { hostAppId: host.hostAppId, serverId: request.serverId, controlPlaneUrl: "https://fixture.test", s3rn: ResourceAddress.serialize(new RemoteFolderAddress(request.workspaceId, request.guid)) };
	return { host, request, root, backend, scope, credentials, identity, mode: (value: boolean) => { enabled = value; }, changeAccount: () => { current = false; } };
}
const write = (host: FolderPreparationHost, path = "Team/Note.md") => trackNativeDocumentWrite(host.vault, path, async () => {});

test.each(["saved", "missing", "disk changed"])("committed-source startup verifies a %s mapping without rewriting it", async kind => {
	const s = await fixture("Restored Team"), journal = await SourceSelectionJournal.open(s.identity), reviewId = id();
	try {
		let state = await journal.apply({ type: "begin", operationId: id(), expectedRevision: null, reviewId, restoreGeneration: id() });
		state = await journal.apply({ type: "prepare", operationId: id(), expectedRevision: state.revision, reviewId,
			preparation: { archive: { path: `${RECOVERY_FOLDER}/fixture`, manifestSha256: "a".repeat(64) }, plan: { id: id(), sha256: "b".repeat(64) } } });
		state = await journal.apply({ type: "start", operationId: id(), expectedRevision: state.revision, reviewId });
		await journal.apply({ type: "commit", operationId: id(), expectedRevision: state.revision, reviewId, destinationRoot: "Restored Team" });
		if (kind !== "missing") await s.scope.mutateValue(() => [{ path: s.request.path, guid: s.request.guid, relay: s.request.workspaceId, onpremServerId: s.request.serverId }]);
		if (kind === "disk changed") {
			const disk = await s.backend.loadData(); disk.sharedFolders[0].path = "Team"; await s.backend.saveData(disk);
		}
		s.backend.saveData.mockClear();
		if (kind === "saved") { const context = await prepareFolderSource(s.host, s.request); expect(context!.nativeRoot).toBe("Restored Team"); context!.close(); }
		else { await expect(prepareFolderSource(s.host, s.request)).rejects.toThrow("mapping"); await expect(write(s.host, "Restored Team/Note.md")).rejects.toThrow("paused"); }
		expect(s.backend.saveData).not.toHaveBeenCalled();
	} finally { journal.close(); s.scope.destroy(); }
});

test.each(["Team", ""])("folder preparation persists attribution before releasing native admission for %s", async path => {
	const s = await fixture(path), waiting = deferred(), reached = deferred(), save = s.backend.saveData.getMockImplementation()!;
	s.backend.saveData.mockImplementationOnce(async next => { reached.finish(); await waiting.promise; await save(next); });
	const opening = prepareFolderSource(s.host, s.request); await reached.promise;
	const nativePath = path ? path + "/Note.md" : "Note.md";
	await expect(write(s.host, nativePath)).rejects.toThrow("paused");
	waiting.finish(); const context = await opening;
	try {
		expect(s.scope.readValue()).toEqual([expect.objectContaining({ path, guid: s.request.guid, onpremServerId: "fixture", relay: "relay-onprem" })]);
		expect(context!.scope).toEqual(s.identity); await context!.assertCurrent(); await write(s.host, nativePath);
	} finally { context?.close(); }
});

test("a pending recovery is rejected before settings are changed", async () => {
	const s = await fixture(), journal = await SourceSelectionJournal.open(s.identity);
	try {
		await journal.apply({ type: "begin", operationId: id(), expectedRevision: null, reviewId: id(), restoreGeneration: id() });
		await expect(prepareFolderSource(s.host, s.request)).rejects.toThrow("awaiting recovery");
		expect(s.scope.readValue()).toEqual([]); expect(s.backend.saveData).not.toHaveBeenCalled(); await expect(write(s.host)).rejects.toThrow("paused");
	} finally { journal.close(); }
});

test("a failed settings save retains the hold; retry persists the same source and releases it", async () => {
	const s = await fixture(); s.backend.saveData.mockRejectedValueOnce(new Error("settings quota"));
	await expect(prepareFolderSource(s.host, s.request)).rejects.toThrow("quota"); await expect(write(s.host)).rejects.toThrow("paused");
	const context = await prepareFolderSource(s.host, s.request);
	try { expect(s.backend.saveData).toHaveBeenCalledTimes(2); expect(s.scope.readValue()).toHaveLength(1); await write(s.host); }
	finally { context?.close(); }
});

test.each(["folder", "account", "mode", "unload"])("a changed %s while settings persist cannot release startup admission", async changed => {
	const s = await fixture(), save = s.backend.saveData.getMockImplementation()!;
	s.backend.saveData.mockImplementationOnce(async next => {
		await save(next);
		if (changed === "folder") s.root.path = "Moved";
		if (changed === "account") s.changeAccount();
		if (changed === "mode") s.mode(false);
		if (changed === "unload") s.host.check = () => { throw new Error("closed"); };
	});
	await expect(prepareFolderSource(s.host, s.request)).rejects.toThrow(); await expect(write(s.host)).rejects.toThrow("paused");
});

test("an unavailable configured server cannot silently use legacy startup", async () => {
	const s = await fixture(); s.credentials.captureDocumentSourceContext.mockReturnValueOnce(undefined as never);
	await expect(prepareFolderSource(s.host, s.request)).rejects.toThrow("server is unavailable");
	expect(s.backend.saveData).not.toHaveBeenCalled();
});

test("legacy mode still persists settings without requiring an on-prem source", async () => {
	const s = await fixture(); s.mode(false);
	expect(await prepareFolderSource(s.host, s.request)).toBeUndefined(); expect(s.credentials.captureDocumentSourceContext).not.toHaveBeenCalled();
	expect(s.scope.readValue()[0]).toMatchObject({ path: "Team", guid: s.request.guid, relay: "relay-onprem" });
});
