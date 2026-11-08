import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TFile, TFolder, type Plugin } from "obsidian";
import { BaseSyncHost } from "../../src/bases/BaseSyncHost";
import { AttachmentFile } from "../../src/AttachmentFile";
import { VaultShare, type ShareRegistry } from "../../src/VaultShare";
import type { AuthSession } from "../../src/AuthSession";
import { AttachmentSyncSettings } from "../../src/AttachmentSyncSettings";
import { Settings, type SettingsScope } from "../../src/SettingsPersistence";
import type { RelayOnPremSettings } from "../../src/RelayOnPremConfig";
import { KindRegistry, ItemKind } from "../../src/ItemKinds";
import { platformFetch } from "../../src/platformFetch";
import { sha256Hex } from "../../src/contentDigest";
import { decodeBaseBytes, encodeBaseBytes, type BaseSnapshot, type BaseRecord } from "../../src/bases/BaseContentProtocol";
import { isConflictCopyPath } from "../../src/conflictCopyPath";
import { same } from "../../src/client/managedRecovery";
import type { BaseRegistrySnapshot } from "../../src/bases/BaseRegistryProtocol";

jest.mock("obsidian", () => ({ ...jest.requireActual("../mocks/obsidian"),
	Component: class { register() {} registerEvent() {} registerDomEvent() {} registerInterval(timer: number) { clearInterval(timer); } },
}));
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
const fetchMock = platformFetch as jest.MockedFunction<typeof platformFetch>;
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytes = (value: string) => new TextEncoder().encode(value).buffer as ArrayBuffer;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const entryId = id(3), path = "Planning.base";
async function snap(value: string | null, version = 1): Promise<BaseSnapshot> {
	const data = value === null ? null : bytes(value);
	return { bytes: data, state: { path, generation: data === null ? null : id(9), content_version: data === null ? null : id(100 + version), record: {
		id: entryId, type: "file", version: 0, ...(data === null ? {} : { hash: await sha256Hex(data), mimetype: "application/yaml", synctime: version }) } } };
}
async function fixture(local = "views: []\n", remoteValue: string | null = local) {
	Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange }); fetchMock.mockReset();
	let remote = await snap(remoteValue), disk = local, account: string | undefined = id(1), authChanged = () => {}, version = 2;
	const flags = { bases: false, otherTypes: true }, configuration = { enabled: true, servers: [{ id: "server", controlPlaneUrl: "https://relay.fixture", name: "Fixture", isValidated: true }] };
	const node = Object.assign(Object.create(TFile.prototype) as TFile, { path: "Team/" + path, stat: { mtime: 1, ctime: 1, size: bytes(local).byteLength } });
	const nodes = new Map<string, TFile | TFolder>([[node.path, node]]), exports = new Map<string, string>();
	nodes.set("Team", Object.assign(Object.create(TFolder.prototype) as TFolder, { path: "Team" }));
	const events = new Map<string, (...args: unknown[]) => void>(); let beforeWrite = () => {};
	const vault = { on: (event: string, handler: (...args: unknown[]) => void) => { events.set(event, handler); },
		getAbstractFileByPath: (name: string) => nodes.get(name) ?? null,
		readBinary: jest.fn(async () => bytes(disk)),
		process: jest.fn(async (_file: TFile, action: (value: string) => string) => { beforeWrite(); disk = action(disk); node.stat.mtime++; return disk; }),
		create: jest.fn(async (name: string, value: string) => {
			if (nodes.has(name)) throw new Error("exists");
			const created = Object.assign(Object.create(TFile.prototype) as TFile, { path: name }); nodes.set(name, created); exports.set(name, value); return created;
		}),
		createFolder: jest.fn(async (name: string) => { if (nodes.has(name)) throw new Error("exists"); const created = Object.assign(Object.create(TFolder.prototype) as TFolder, { path: name }); nodes.set(name, created); return created; }),
	};
	const manifest = { owner: true, records: { [path]: remote.state.record } as Record<string, BaseRecord>, permissions: { [path]: "write" },
		base_content: { protocol_version: 1, enabled: true, recovery: true, versions: remote.state.content_version ? { [entryId]: remote.state.content_version } : {} as Record<string, string> } };
	const refresh = () => { manifest.records[path] = remote.state.record; if (remote.state.content_version) manifest.base_content.versions[entryId] = remote.state.content_version; };
	const index = { snapshot: manifest, flush: jest.fn(async () => refresh()), isBlocked: jest.fn(() => false),
		publishablePaths: jest.fn(async (paths: string[]) => new Set(paths)),
		registered: (name: string, entry: string) => manifest.records[name]?.id === entry,
		claim: jest.fn(async () => true), acknowledgeBaseContent: jest.fn(async () => refresh()) };
	const file = Object.create(AttachmentFile.prototype) as AttachmentFile;
	Object.assign(file, {
		path, _localGuid: entryId, guardedBase: false, vault,
		contentAddressedCache: { resolveHash: jest.fn(() => { throw new Error("legacy hash path used"); }) }, notifySubscribers: jest.fn(), log: jest.fn(),
	});
	const folder = { entityGuid: id(2), config: { onpremServerId: "server" }, wantsConnection: true, isOnline: true, isRecoveringStructure: false,
		trackedEntries: new Map([[entryId, file]]), _liveProvider: { managedIndex: index }, basesSync: undefined,
		attachmentSettings: { readValue: () => flags, subscribe: () => () => {} },
		folderIndex: { guidFor: (name: string) => name === file.path ? entryId : undefined },
		absolutePath: (name: string) => "Team/" + name, toVirtualPath: (name: string) => name.slice(5), isDeletePending: () => false,
		canWriteManagedPath: () => manifest.owner || manifest.permissions[path] === "write", usesBaseSync: VaultShare.prototype.usesBaseSync,
		blobs: { pushFile: jest.fn(), pullFile: jest.fn() } } as unknown as VaultShare;
	Object.assign(file, { _parent: folder });
	const shares = { toArray: () => [folder], on: () => () => {}, shareFor: () => folder };
	const auth = { getAuthProviderForServer: () => ({ isLoggedIn: () => !!account, getCurrentUser: () => account ? { id: account } : undefined, getValidToken: async () => "synthetic-token" }),
		on: (callback: () => void) => { authChanged = callback; return () => {}; }, onTokenRefreshed: () => () => {} };
	const settings = { readValue: () => configuration, subscribe: () => () => {} };
	const plugin = { app: { vault, workspace: { on: jest.fn() } } };
	fetchMock.mockImplementation(async (_url, init) => {
		if (init?.method === "PUT") {
			const payload = JSON.parse(init.body as string);
			if (!same(payload.expected, remote.state)) return reply(409, { detail: { code: "base_content_conflict" } });
			remote = await snap(new TextDecoder().decode(decodeBaseBytes(payload.content_base64)), version++);
			return reply(200, { protocol_version: 1, operation_id: payload.operation_id, state: remote.state });
		}
		return reply(200, { protocol_version: 1, state: remote.state, content_base64: remote.bytes === null ? null : encodeBaseBytes(remote.bytes) });
	});
	const host = new BaseSyncHost(plugin as unknown as Plugin, auth as unknown as AuthSession, shares as unknown as ShareRegistry,
		settings as unknown as SettingsScope<RelayOnPremSettings>, "fixture-vault");
	host.onload(); await host.rows(folder); flags.bases = true;
	return { host, file, folder, flags, manifest, index, vault, exports, node, disk: () => disk, remote: () => remote,
		removed: async () => {
			delete manifest.records[path]; Object.assign(manifest, { deleted: { [path]: [entryId] } }); Object.assign(manifest.base_content, { retired: { [entryId]: path } });
			index.flush.mockImplementation(async () => {}); authChanged();
			for (let count = 0; count < 100; count++) {
				if ((await host.rows(folder)).some(row => row.record.retirement)) return;
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			throw new Error("Retirement observation did not finish");
		},
		edit: (value: string) => { disk = value; node.stat.mtime++; node.stat.size = bytes(value).byteLength; },
		remoteEdit: async (value: string) => { remote = await snap(value, version++); refresh(); },
		beforeWrite: (callback: () => void) => { beforeWrite = callback; },
		account: (value?: string) => { account = value; authChanged(); }, close: () => host.onunload() };
}

test("all attachment entry points use guarded Bases sync and unchanged inventory avoids repeated HTTP", async () => {
	const s = await fixture(); try {
		expect((await s.host.rows(s.folder))[0].message).toBe("Waiting for first Bases sync");
		await s.file.runSync(); const count = fetchMock.mock.calls.length;
		await s.file.pushToRemote(true); await s.file.pullFromRemote();
		expect(fetchMock.mock.calls.length).toBe(count); expect(s.folder.blobs.pushFile).not.toHaveBeenCalled(); expect(s.folder.blobs.pullFile).not.toHaveBeenCalled();
		expect((await s.host.rows(s.folder))[0].record.baseline?.bytes).toEqual(bytes(s.disk()));
	} finally { s.close(); }
});

test("editing a native Bases file publishes conditional content and acknowledges managed inventory", async () => {
	const s = await fixture(); try {
		await s.file.runSync(); s.edit("views: []\n# edited\n"); await s.file.pushToRemote();
		expect(new TextDecoder().decode(s.remote().bytes!)).toContain("edited"); expect(s.index.acknowledgeBaseContent).toHaveBeenCalledTimes(1);
		expect(s.folder.blobs.pushFile).not.toHaveBeenCalled(); expect(s.file.lastUploadError).toBeUndefined();
	} finally { s.close(); }
});

test("a cached file removed from local tracking is not reported as up to date or automatically restored", async () => {
	const s = await fixture(); try {
		await s.file.runSync(); s.folder.trackedEntries.delete(entryId); fetchMock.mockClear();
		const row = (await s.host.rows(s.folder)).find(row => row.entryId === entryId)!;
		expect(row.file).toBeUndefined(); expect(row.message).toContain("File unavailable on this device");
		expect(row.record.baseline?.bytes).toEqual(bytes(s.disk()));
		expect(fetchMock).not.toHaveBeenCalled(); expect(s.vault.create).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("synchronized Bases allow read-only view inspection and export without modifying native bytes", async () => {
	const s = await fixture(); try {
		await s.file.runSync(); s.manifest.owner = false; s.manifest.permissions[path] = "read";
		const snapshot: BaseRegistrySnapshot = { protocol_version: 1, definition_id: id(40), entry_id: entryId, generation: s.remote().state.generation!, revision: 1,
			content_sha256: s.remote().state.record.hash!, views: [{ slot: 0, id: id(41), name: "Planning", type: "table", descriptor_sha256: "a".repeat(64) }], unmatched: { views: [], has_more: false, next_after: null } };
		fetchMock.mockImplementation(async (url, init) => {
			expect(url).toContain("/bases/inspect"); expect(init?.method).toBe("POST"); return reply(200, snapshot);
		});
		expect((await s.host.refreshViews(s.folder, s.file)).snapshot).toEqual(snapshot);
		expect((await s.host.cachedViews(s.folder, s.file)).snapshot).toEqual(snapshot);
		const identity = { serverId: "https://relay.fixture", accountId: id(1), vaultId: "fixture-vault", shareId: id(2) };
		const provider = s.folder._liveProvider;
		Object.assign(s.folder, { _liveProvider: undefined }); fetchMock.mockClear();
		await expect(s.host.cachedViews(s.folder, s.file)).rejects.toThrow("base_context_changed");
		expect((await s.host.cachedViews(s.folder, s.file, { identity, readable: () => true })).snapshot).toEqual(snapshot);
		await expect(s.host.cachedViews(s.folder, s.file, { identity: { ...identity, accountId: id(99) }, readable: () => true })).rejects.toThrow("base_context_changed");
		await expect(s.host.cachedViews(s.folder, s.file, { identity, readable: () => false })).rejects.toThrow("base_context_changed");
		expect(fetchMock).not.toHaveBeenCalled();
		Object.assign(s.folder, { _liveProvider: provider }); s.manifest.permissions[path] = "none";
		await expect(s.host.cachedViews(s.folder, s.file, { identity, readable: () => true })).rejects.toThrow("base_context_changed");
		s.manifest.permissions[path] = "read";
		await expect(s.host.repairViews(s.folder, s.file, snapshot, [{ slot: 0, view_id: null }], [])).rejects.toThrow("base_editor_required");
		const destination = await s.host.export(s.folder, entryId);
		expect([...s.exports].find(([name]) => name.startsWith(destination) && name.includes("saved-views"))?.[1]).toContain(snapshot.definition_id);
		expect(s.vault.process).not.toHaveBeenCalled(); expect(s.disk()).toBe("views: []\n");
	} finally { s.close(); }
});

test("dirty native bytes and permissions lost after inventory refresh block saved-view inspection", async () => {
	const s = await fixture(); try {
		await s.file.runSync(); fetchMock.mockClear(); s.edit("views: []\n# unsynchronized");
		await expect(s.host.refreshViews(s.folder, s.file)).rejects.toThrow("local changes"); expect(fetchMock).not.toHaveBeenCalled();
		s.edit("views: []\n"); s.manifest.owner = false; s.manifest.permissions[path] = "none";
		await expect(s.host.refreshViews(s.folder, s.file)).rejects.toThrow(); await expect(s.host.cachedViews(s.folder, s.file)).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("an account change while inspecting views never delivers the previous account's response", async () => {
	const s = await fixture(); try {
		await s.file.runSync();
		fetchMock.mockImplementation(async () => { s.account(); return reply(200, {}); });
		await expect(s.host.refreshViews(s.folder, s.file)).rejects.toThrow();
		await expect(s.host.cachedViews(s.folder, s.file)).rejects.toThrow("Sign in");
	} finally { s.close(); }
});

test("remote configuration changes use atomic native replacement, preserving a racing local edit", async () => {
	const s = await fixture(); try {
		await s.file.runSync(); await s.remoteEdit("views: []\n# remote\n");
		s.beforeWrite(() => s.edit("views: []\n# concurrent local\n")); await s.file.pullFromRemote();
		expect(s.disk()).toContain("concurrent local"); expect(s.vault.process).toHaveBeenCalledTimes(1);
		expect((await s.host.rows(s.folder))[0].record.conflict).toBeDefined(); expect(s.file.statusTag).toContain("review");
	} finally { s.close(); }
});

test("read-only edits remain reviewable and can restore the reviewed server copy", async () => {
	const s = await fixture(); try {
		await s.file.runSync(); s.manifest.owner = false; s.manifest.permissions[path] = "read"; s.edit("local edits"); await s.file.runSync();
		const review = await s.host.review(s.folder, s.file);
		await expect(s.host.resolve(s.folder, s.file, review, "local")).rejects.toThrow("base_editor_required");
		await s.host.resolve(s.folder, s.file, review, "server"); expect(s.disk()).toBe("views: []\n");
		expect(fetchMock.mock.calls.filter(call => call[1]?.method === "PUT")).toHaveLength(0);
	} finally { s.close(); }
});

test("disabled setting or incompatible server cannot fall through to a legacy upload", async () => {
	const s = await fixture(); try {
		s.flags.bases = false; await s.file.runSync(); expect(fetchMock).not.toHaveBeenCalled();
		s.flags.bases = true; s.manifest.base_content.enabled = false; await s.file.pushToRemote(true);
		expect(s.file.lastUploadError).toContain("not enabled"); expect(fetchMock).not.toHaveBeenCalled(); expect(s.folder.blobs.pushFile).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("new hashless claims initialize configuration without generic metadata publication", async () => {
	const s = await fixture("views: []\n", null); try {
		await s.file.runSync(); expect(s.index.claim).toHaveBeenCalledWith(path, { id: entryId, type: "file", version: 0 });
		expect(s.remote().bytes).toEqual(bytes("views: []\n")); expect(s.folder.blobs.pushFile).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("late old-account responses cannot replace local contents or populate the next account cache", async () => {
	const s = await fixture(); try {
		await s.file.runSync(); await s.remoteEdit("remote edit");
		const fetch = fetchMock.getMockImplementation()!;
		fetchMock.mockImplementationOnce(async (...args) => { const response = await fetch(...args); s.account(); return response; });
		await s.file.pullFromRemote(); expect(s.disk()).toBe("views: []\n"); expect(s.vault.process).not.toHaveBeenCalled();
		await expect(s.host.rows(s.folder)).rejects.toThrow("Sign in");
	} finally { s.close(); }
});

test("network retries are bounded while explicit retry is immediately actionable", async () => {
	const s = await fixture(); try {
		fetchMock.mockRejectedValueOnce(new Error("offline")); await s.file.runSync(); const count = fetchMock.mock.calls.length;
		await s.file.runSync(); expect(fetchMock.mock.calls.length).toBe(count);
		await s.host.retry(s.folder, s.file); expect(fetchMock.mock.calls.length).toBe(count + 1); expect(s.file.lastUploadError).toBeUndefined();
	} finally { s.close(); }
});

test.each(["before", "during"])("an explicit tombstone %s inventory refresh cannot reclaim or upload its old identity", async timing => {
	const s = await fixture(); try {
		await s.file.runSync(); fetchMock.mockClear();
		const remove = () => {
			delete s.manifest.records[path];
			Object.assign(s.manifest, { deleted: { [path]: [entryId] } });
			Object.assign(s.manifest.base_content, { retired: { [entryId]: path } });
		};
		if (timing === "before") remove(); else s.index.flush.mockImplementationOnce(async () => remove());
		await s.host.retry(s.folder, s.file);
		expect(s.index.claim).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
		expect(s.file.lastUploadError).toContain("removed on the server");
	} finally { s.close(); }
});

test("retired guards cover renamed-away files but do not classify a replacement identity at the same path", async () => {
	const s = await fixture(); try {
		Object.assign(s.manifest, { deleted: { "Former.txt": [entryId] } });
		Object.assign(s.manifest.base_content, { retired: { [entryId]: "Former.txt" } });
		expect(s.folder.usesBaseSync("Former.txt")).toBe(true);
		s.manifest.records["Former.txt"] = { id: id(88), version: 0, type: "file" };
		expect(s.folder.usesBaseSync("Former.txt", id(88))).toBe(false);
	} finally { s.close(); }
});

test("local recovery export includes exact copies and stays outside synchronization", async () => {
	const s = await fixture("local", "server"); try {
		await s.file.runSync(); await s.host.resolve(s.folder, s.file, await s.host.review(s.folder, s.file), "server");
		const exported = await s.host.export(s.folder, entryId);
		expect(isConflictCopyPath(exported)).toBe(true); expect(s.exports.size).toBe(3);
		const values = [...s.exports.values()].join("\n"); expect(values).toContain(encodeBaseBytes(bytes("local"))); expect(values).not.toContain("synthetic-token");
	} finally { s.close(); }
});

test("native host restoration creates a separate local file, retains the retired identity and never claims server delivery", async () => {
	const s = await fixture(); try {
		await s.file.runSync(); await s.removed(); fetchMock.mockClear();
		const review = await s.host.reviewRestore(s.folder, entryId); await s.host.restore(s.folder, entryId, review, "baseline", "Restored.base");
		expect(s.exports.get("Team/Restored.base")).toBe("views: []\n"); expect(s.disk()).toBe("views: []\n");
		const row = (await s.host.rows(s.folder))[0]; expect(row.record.restore?.state).toBe("created");
		expect(row.message).toContain("Check that file’s sync status"); expect(s.index.claim).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test.each(["permission", "occupied", "account"])("native host restore rejects %s changes before creating a file", async kind => {
	const s = await fixture(); try {
		await s.file.runSync(); await s.removed(); const review = await s.host.reviewRestore(s.folder, entryId);
		if (kind === "permission") s.index.publishablePaths.mockResolvedValueOnce(new Set());
		if (kind === "occupied") s.manifest.records["RESTORED.BASE"] = { id: id(99), version: 0, type: "file" };
		if (kind === "account") s.index.publishablePaths.mockImplementationOnce(async () => { s.account(); return new Set(["Restored.base"]); });
		await expect(s.host.restore(s.folder, entryId, review, "baseline", "Restored.base")).rejects.toThrow();
		expect(s.vault.create).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("a replacement at the former path cannot be read as the retired file's restore source", async () => {
	const s = await fixture(); try {
		await s.file.runSync(); await s.removed(); s.manifest.records[path] = { id: id(99), version: 0, type: "file" }; s.vault.readBinary.mockClear();
		const review = await s.host.reviewRestore(s.folder, entryId);
		expect(review.copies.map(copy => copy.key)).toEqual(["removed", "baseline"]); expect(s.vault.readBinary).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("Bases settings are independent of other files while the shared file wire type remains compatible", async () => {
	let saved: Record<string, unknown> = {};
	const settings = new Settings({ loadData: async () => saved, saveData: async data => { saved = data; } }, {});
	await settings.hydrate(); const scope = new AttachmentSyncSettings(settings as unknown as Settings<unknown>, "sync");
	const kinds = new KindRegistry(scope); try {
		await scope.setCategoryEnabled("otherTypes", true); expect(scope.isFileTypeAllowed("Planning.base")).toBe(false); expect(kinds.supportsSync("Planning.base")).toBe(false);
		await scope.setCategoryEnabled("otherTypes", false); await scope.setCategoryEnabled("bases", true);
		expect(scope.isFileTypeAllowed("Planning.BASE")).toBe(true); expect(kinds.supportsSync("Planning.base")).toBe(true);
		expect(kinds.kindForPath("Planning.base")).toBe(ItemKind.File); expect(kinds.enabledSyncKinds()).toContain(ItemKind.File); expect(kinds.supportsSync("Other.bin")).toBe(false);
	} finally { kinds.destroy(); scope.destroy(); settings.destroy(); }
});
