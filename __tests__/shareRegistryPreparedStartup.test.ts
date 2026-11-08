import "fake-indexeddb/auto";
import { TFolder, type Vault } from "obsidian";
import { ShareRegistry, type VaultShare, type VaultShareSettings, type FolderSourceRequest } from "../src/VaultShare";
import type { SettingsScope } from "../src/SettingsPersistence";
import type { RelayRegistry } from "../src/RelayRegistry";
import { SourceSelectionContext } from "../src/storage/source-selection-context";
import { SourceSelectionJournal } from "../src/storage/source-selection-journal";
import { admitSourceStartup } from "../src/storage/source-startup-admission";
import { RemoteFolderAddress, ResourceAddress } from "../src/ResourceAddress";
import { RECOVERY_FOLDER } from "../src/conflictCopyPath";

const id = () => crypto.randomUUID();
const registries: ShareRegistry[] = [];
function deferred() { let finish!: () => void; return { promise: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() }; }
function fixture(initial: VaultShareSettings[] = []) {
	let settings = initial.map(value => ({ ...value })); const hostAppId = id();
	const roots = new Map<string, TFolder>();
	const getRoot = (path: string) => { if (!roots.has(path)) roots.set(path, Object.assign(Object.create(TFolder.prototype) as TFolder, { path })); return roots.get(path)!; };
	const vault = { getAbstractFileByPath: getRoot, getRoot: () => getRoot("/") };
	const scope = (guid: string) => ({ hostAppId, serverId: "fixture", controlPlaneUrl: "https://fixture.test", s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", guid)) });
	const settingsScope = { readValue: () => settings, readPersistedValue: jest.fn(async () => structuredClone(settings)),
		mutateValue: jest.fn(async (update: (current: VaultShareSettings[]) => VaultShareSettings[]) => { settings = update(settings); }) };
	const prepare = jest.fn(async (request: Readonly<FolderSourceRequest>) => admitSourceStartup(vault, request.path, scope(request.guid), { check: () => {} }));
	const factory = jest.fn((path: string, guid: string, workspaceId?: string, _pending?: boolean, _restore?: boolean, _fresh?: boolean, sourceSelection?: SourceSelectionContext) => {
		const folder = { path, entityGuid: guid, workspaceId, sourceSelection, dismantle: jest.fn(() => sourceSelection?.close()), goOffline: jest.fn() };
		if (!settings.some(value => value.guid === guid)) settings.push({ path, guid, relay: workspaceId, onpremServerId: "fixture" });
		return folder as unknown as VaultShare;
	});
	const registry = new ShareRegistry({} as RelayRegistry, vault as unknown as Vault, factory, settingsScope as unknown as SettingsScope<VaultShareSettings[]>, prepare);
	registries.push(registry);
	return { registry, prepare, factory, scope, settingsScope, settings: () => settings };
}
afterEach(() => { registries.splice(0).forEach(registry => registry.destroy()); jest.restoreAllMocks(); });

async function selectRestored(s: ReturnType<typeof fixture>, guid: string, destinationRoot = "Restored Team") {
	const journal = await SourceSelectionJournal.open(s.scope(guid)), reviewId = id();
	try {
		let state = await journal.apply({ type: "begin", expectedRevision: (await journal.read()).revision, operationId: id(), reviewId, restoreGeneration: id() });
		state = await journal.apply({ type: "prepare", expectedRevision: state.revision, operationId: id(), reviewId,
			preparation: { archive: { path: `${RECOVERY_FOLDER}/fixture`, manifestSha256: "a".repeat(64) }, plan: { id: id(), sha256: "b".repeat(64) } } });
		state = await journal.apply({ type: "start", expectedRevision: state.revision, operationId: id(), reviewId });
		await journal.apply({ type: "commit", expectedRevision: state.revision, operationId: id(), reviewId, destinationRoot });
		await s.settingsScope.mutateValue(rows => rows.map(row => row.guid === guid ? { ...row, path: destinationRoot } : row));
	} finally { journal.close(); }
}

test("restoring a committed new mapping retires the original instance before constructing a fresh selected source", async () => {
	const s = fixture(), guid = id(), old = await s.registry.newPrepared("Team", guid, "relay-onprem", undefined, undefined, "fixture");
	await selectRestored(s, guid); const prepare = s.prepare.getMockImplementation()!;
	s.prepare.mockImplementationOnce(async request => { expect(old.dismantle).toHaveBeenCalledTimes(1); return prepare(request); });
	await s.registry.restorePrepared(); const restored = s.registry.toArray()[0];
	expect(restored).not.toBe(old); expect(restored.path).toBe("Restored Team"); expect(restored.entityGuid).toBe(guid);
	expect(restored.sourceSelection!.choice.kind).toBe("source"); expect(restored.sourceSelection!.nativeRoot).toBe("Restored Team");
	expect(s.registry.startupFailures).toEqual([]); expect(s.settings()).toHaveLength(1);
	await s.registry.restorePrepared(); expect(s.registry.toArray()).toEqual([restored]); expect(old.dismantle).toHaveBeenCalledTimes(1);
});

test.each(["legacy", "pending", "different root", "disk mapping", "server", "overlap"])("an unverified %s relocation cannot retire or reuse the original instance", async kind => {
	const s = fixture(), guid = id(), old = await s.registry.newPrepared("Team", guid, "relay-onprem", undefined, undefined, "fixture");
	if (kind !== "legacy" && kind !== "pending") await selectRestored(s, guid, kind === "overlap" ? "Team/Restored" : "Restored Team");
	else {
		if (kind === "pending") {
			const journal = await SourceSelectionJournal.open(s.scope(guid));
			try { await journal.apply({ type: "begin", expectedRevision: null, operationId: id(), reviewId: id(), restoreGeneration: id() }); } finally { journal.close(); }
		}
		await s.settingsScope.mutateValue(rows => rows.map(row => ({ ...row, path: "Restored Team" })));
	}
	if (kind === "different root") await s.settingsScope.mutateValue(rows => rows.map(row => ({ ...row, path: "Unexpected" })));
	if (kind === "server") await s.settingsScope.mutateValue(rows => rows.map(row => ({ ...row, onpremServerId: "other" })));
	if (kind === "disk mapping") s.settingsScope.readPersistedValue.mockResolvedValueOnce(s.settings().map(row => ({ ...row, path: "Team" })));
	s.factory.mockClear(); await s.registry.restorePrepared();
	expect(old.dismantle).not.toHaveBeenCalled(); expect(s.factory).not.toHaveBeenCalled(); expect(s.registry.toArray()).toEqual([old]);
	expect(old.goOffline).toHaveBeenCalled(); expect(s.registry.startupFailures).toHaveLength(1);
});

test("an interrupted relocation keeps the new mapping and retry creates a fresh selected instance", async () => {
	const s = fixture(), guid = id(), old = await s.registry.newPrepared("Team", guid, "relay-onprem", undefined, undefined, "fixture");
	await selectRestored(s, guid); s.prepare.mockRejectedValueOnce(new Error("Synthetic source outage"));
	await s.registry.restorePrepared(); expect(s.registry.toArray()).toEqual([]); expect(s.settings()[0].path).toBe("Restored Team");
	expect(s.registry.startupFailures[0].message).toContain("outage");
	const restored = await s.registry.retryStartup(guid); expect(restored.path).toBe("Restored Team"); expect(restored.sourceSelection!.choice.kind).toBe("source");
	expect(old.dismantle).toHaveBeenCalledTimes(1); expect(s.registry.startupFailures).toEqual([]);
});

test("a new review while relocation admission waits prevents construction and preserves the saved destination", async () => {
	const s = fixture(), guid = id(), old = await s.registry.newPrepared("Team", guid, "relay-onprem", undefined, undefined, "fixture");
	await selectRestored(s, guid); const prepare = s.prepare.getMockImplementation()!; let candidate: SourceSelectionContext | undefined;
	s.prepare.mockImplementationOnce(async request => {
		candidate = await prepare(request);
		const journal = await SourceSelectionJournal.open(s.scope(guid));
		try { await journal.apply({ type: "begin", operationId: id(), expectedRevision: candidate.revision, reviewId: id(), restoreGeneration: id() }); }
		finally { journal.close(); }
		return candidate;
	});
	s.factory.mockClear(); await s.registry.restorePrepared();
	expect(s.factory).not.toHaveBeenCalled(); expect(old.dismantle).toHaveBeenCalledTimes(1); expect(() => candidate!.check()).toThrow("closed");
	expect(s.settings()[0].path).toBe("Restored Team"); expect(s.registry.startupFailures).toHaveLength(1);
});

test("a prepared registry refuses synchronous construction and passes the journal context to its awaited factory", async () => {
	const s = fixture(), guid = id();
	expect(() => s.registry.new("Team", guid, "relay-onprem")).toThrow("awaited"); expect(() => s.registry.restore()).toThrow("awaited");
	const folder = await s.registry.newPrepared("Team", guid, "relay-onprem", true, false, "fixture");
	expect(s.factory).toHaveBeenCalledWith("Team", guid, "relay-onprem", true, undefined, false, folder.sourceSelection);
	await folder.sourceSelection!.assertCurrent(); expect(s.registry.toArray()).toEqual([folder]); expect(s.registry.startupFailures).toEqual([]);
});

test("duplicate concurrent requests construct once and overlapping mounts are checked again after preparation", async () => {
	const s = fixture(), guid = id(), pending = deferred(), prepare = s.prepare.getMockImplementation()!;
	s.prepare.mockImplementationOnce(async request => { await pending.promise; return prepare(request); });
	const first = s.registry.newPrepared("Team", guid, "relay-onprem"), second = s.registry.newPrepared("Team", guid, "relay-onprem");
	const nested = s.registry.newPrepared("Team/Nested", id(), "relay-onprem");
	pending.finish(); expect(await first).toBe(await second); await expect(nested).rejects.toThrow("nested");
	expect(s.prepare).toHaveBeenCalledTimes(1); expect(s.factory).toHaveBeenCalledTimes(1);
});

test("pending source recovery retains its settings and does not prevent an unrelated folder restoring", async () => {
	const blocked = id(), allowed = id(), initial = [ { path: "Team", guid: blocked, relay: "relay-onprem", onpremServerId: "fixture" },
		{ path: "Other", guid: allowed, relay: "relay-onprem", onpremServerId: "fixture" } ];
	const s = fixture(initial), journal = await SourceSelectionJournal.open(s.scope(blocked));
	try {
		await journal.apply({ type: "begin", expectedRevision: null, operationId: id(), reviewId: id(), restoreGeneration: id() });
		await s.registry.restorePrepared(); expect(s.registry.toArray().map(folder => folder.entityGuid)).toEqual([allowed]);
		expect(s.settings()).toEqual(initial); expect(s.registry.startupFailures).toEqual([{ guid: blocked, path: "Team", message: expect.stringContaining("awaiting recovery") }]);
		expect(s.factory.mock.calls[0][4]).toBe(true);
	} finally { journal.close(); }
});

test("replacement stops old writers before preparation and retains their settings when it fails", async () => {
	const oldId = id(), s = fixture([{ path: "Team", guid: oldId, relay: "relay-onprem" }]);
	const old = await s.registry.newPrepared("Team", oldId, "relay-onprem"), next = id(); s.factory.mockClear();
	s.prepare.mockImplementationOnce(async () => { expect(old.dismantle).toHaveBeenCalledTimes(1); throw new Error("journal unavailable"); });
	await expect(s.registry.newPrepared("Team", next, "relay-onprem", true, false, "fixture", old)).rejects.toThrow("unavailable");
	expect(s.registry.toArray()).toEqual([]); expect(s.factory).not.toHaveBeenCalled();
	expect(s.settings().map(value => value.guid)).toEqual([oldId]);
	const replacement = await s.registry.retryStartup(next);
	expect(s.registry.toArray()).toEqual([replacement]); expect(s.settings().map(value => value.guid)).toEqual([next]);
	expect(old.dismantle).toHaveBeenCalledTimes(1); expect(s.registry.startupFailures).toEqual([]);
});

test("replacement checks for a competing mount after its asynchronous preparation", async () => {
	const s = fixture(), old = await s.registry.newPrepared("Team", id(), "relay-onprem"), prepare = s.prepare.getMockImplementation()!;
	const competitor = s.factory("Team", id(), "relay-onprem");
	let candidate: SourceSelectionContext | undefined;
	s.prepare.mockImplementationOnce(async request => { candidate = await prepare(request); s.registry.include(competitor); return candidate; });
	await expect(s.registry.newPrepared("Team", id(), "relay-onprem", true, false, "fixture", old)).rejects.toThrow("already");
	expect(old.dismantle).toHaveBeenCalledTimes(1); expect(s.registry.toArray()).toEqual([competitor]); expect(() => candidate!.check()).toThrow("closed");
});

test("factory failure closes its prepared context and retains the previous connection settings for restart", async () => {
	const s = fixture(), oldId = id(), old = await s.registry.newPrepared("Team", oldId, "relay-onprem"), prepare = s.prepare.getMockImplementation()!;
	let candidate: SourceSelectionContext | undefined;
	s.prepare.mockImplementationOnce(async request => { candidate = await prepare(request); return candidate; });
	s.factory.mockImplementationOnce(() => { throw new Error("constructor failed"); });
	await expect(s.registry.newPrepared("Team", id(), "relay-onprem", true, false, "fixture", old)).rejects.toThrow("constructor failed");
	expect(s.settings().map(value => value.guid)).toEqual([oldId]); expect(() => candidate!.check()).toThrow("closed");
	expect(s.registry.startupFailures).toHaveLength(1);
});

test("unload while preparation is waiting closes the late context without constructing a folder", async () => {
	const s = fixture(), pending = deferred(), prepare = s.prepare.getMockImplementation()!;
	let candidate: SourceSelectionContext | undefined;
	s.prepare.mockImplementationOnce(async request => { candidate = await prepare(request); await pending.promise; return candidate; });
	const opening = s.registry.newPrepared("Team", id(), "relay-onprem");
	for (let attempts = 0; attempts < 100 && !candidate; attempts++) await new Promise(resolve => setTimeout(resolve, 0));
	expect(candidate).toBeDefined(); s.registry.destroy(); registries.splice(registries.indexOf(s.registry), 1); pending.finish();
	await expect(opening).rejects.toThrow("closed"); expect(s.factory).not.toHaveBeenCalled(); expect(() => candidate!.check()).toThrow("closed");
});

test("a completed replacement removes old metadata only after successful construction", async () => {
	const s = fixture(), oldId = id(), old = await s.registry.newPrepared("Team", oldId, "relay-onprem"), next = id();
	const replacement = await s.registry.newPrepared("Team", next, "relay-onprem", true, false, "fixture", old);
	expect(old.dismantle).toHaveBeenCalledTimes(1); expect(s.registry.toArray()).toEqual([replacement]); expect(s.settings().map(value => value.guid)).toEqual([next]);
});

test("a failed metadata cleanup pauses the constructed replacement and preserves its local history context", async () => {
	const s = fixture(), old = await s.registry.newPrepared("Team", id(), "relay-onprem"), next = id();
	s.settingsScope.mutateValue.mockRejectedValueOnce(new Error("settings quota"));
	await expect(s.registry.newPrepared("Team", next, "relay-onprem", true, false, "fixture", old)).rejects.toThrow("settings quota");
	const replacement = s.registry.toArray()[0]; expect(replacement.entityGuid).toBe(next); expect(replacement.goOffline).toHaveBeenCalled();
	expect(() => replacement.sourceSelection!.check()).toThrow("closed"); expect(s.registry.startupFailures[0].message).toContain("quota");
	// A login-triggered restore must resume the replacement instead of
	// reopening the old settings row left behind by the failed cleanup.
	await s.registry.restorePrepared(); const retry = s.registry.toArray()[0]; await retry.sourceSelection!.assertCurrent();
	expect(replacement.dismantle).toHaveBeenCalledTimes(1); expect(s.registry.toArray()).toEqual([retry]);
	expect(s.settings().map(value => value.guid)).toEqual([next]); expect(s.registry.startupFailures).toEqual([]);
});

test("a rejected replacement cannot later erase settings for a mount it never retired", async () => {
	const s = fixture(), old = await s.registry.newPrepared("Other", id(), "relay-onprem"), next = id();
	await expect(s.registry.newPrepared("Team", next, "relay-onprem", true, false, "fixture", old)).rejects.toThrow("changed during");
	await expect(s.registry.retryStartup(next)).rejects.toThrow("changed during");
	expect(old.dismantle).not.toHaveBeenCalled(); expect(s.settings().map(value => value.guid)).toEqual([old.entityGuid]);
});

test("a changed recovery journal disconnects an existing session during login restore", async () => {
	const s = fixture(), guid = id(), folder = await s.registry.newPrepared("Team", guid, "relay-onprem"), journal = await SourceSelectionJournal.open(s.scope(guid));
	try {
		const pending = await journal.apply({ type: "begin", operationId: id(), expectedRevision: null, reviewId: id(), restoreGeneration: id() });
		await s.registry.restorePrepared(); expect(folder.goOffline).toHaveBeenCalledTimes(1); expect(() => folder.sourceSelection!.check()).toThrow("closed");
		expect(s.registry.startupFailures).toHaveLength(1);
		await journal.apply({ type: "cancel", operationId: id(), expectedRevision: pending.revision, reviewId: pending.pending!.reviewId });
		const fresh = await s.registry.retryStartup(guid); expect(fresh).not.toBe(folder); await fresh.sourceSelection!.assertCurrent();
	} finally { journal.close(); }
});
