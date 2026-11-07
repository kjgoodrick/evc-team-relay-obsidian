/** @jest-environment jsdom */
import type { Plugin } from "obsidian";
import { TFile } from "obsidian";
import type { AuthSession } from "../../src/AuthSession";
import type { ShareRegistry } from "../../src/VaultShare";
import type { SettingsScope } from "../../src/SettingsPersistence";
import type { RelayOnPremSettings } from "../../src/RelayOnPremConfig";
import { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { BaseTargetPicker } from "../../src/collaboration/ui/BaseTargetPicker";
import type { BaseSyncHost } from "../../src/bases/BaseSyncHost";
import type { NativeBasesSurface, NativeBaseHandle } from "../../src/bases/NativeBasesSurface";
import type { BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import type { BaseDefinitionCatalog } from "../../src/collaboration/BaseDefinitionProtocol";

const mockSessions: { close: jest.Mock; status: string }[] = [];
const mockCredentials: (() => Promise<unknown>)[] = [];
jest.mock("../../src/collaboration/ui/BaseTargetPicker", () => ({ BaseTargetPicker: jest.fn().mockImplementation(() => ({ open: jest.fn() })) }));
jest.mock("../../src/Document", () => ({ isDocument: (value: { isDocument?: boolean }) => value?.isDocument === true }));
jest.mock("../../src/AttachmentFile", () => ({ isAttachmentFile: (value: { isAttachment?: boolean }) => value?.isAttachment === true }));
jest.mock("obsidian", () => ({
	Component: class { register() {} registerEvent() {} registerDomEvent() {} addChild<T>(child: T): T { return child; } },
	MarkdownRenderChild: class {},
	ItemView: class {}, Modal: class {}, Notice: class {}, TFile: class { path = "Team/Note.md"; extension = "md"; },
}));
jest.mock("../../src/collaboration/DiscussionTransport", () => ({
	DiscussionTransport: class {
		constructor(readonly identity: unknown, credential: () => Promise<unknown>) { mockCredentials.push(credential); }
	},
}));
jest.mock("../../src/collaboration/DiscussionSession", () => ({
	DiscussionSession: class {
		status = "ready";
		close = jest.fn(() => { this.status = "closed"; return Promise.resolve(); });
		onChange() {} setForeground() {} start() { return Promise.resolve(); } refresh() { return Promise.resolve(); }
		trackLocal<T>(promise: Promise<T>) { return promise; }
		constructor(readonly store: DiscussionStore) { mockSessions.push(this); }
	},
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(bases?: BaseSyncHost) {
	mockSessions.length = 0; mockCredentials.length = 0;
	let accountId: string | undefined = id(1), authChanged!: () => void, settingsChanged!: () => void;
	const settings = { enabled: true, servers: [{ id: "server", controlPlaneUrl: "https://one.test", name: "One", isValidated: true }] };
	const provider = { getCurrentUser: () => accountId ? { id: accountId } : undefined, isLoggedIn: () => !!accountId,
		getValidToken: jest.fn().mockResolvedValue("synthetic-token") };
	const auth = { on: (fn: () => void) => { authChanged = fn; return () => {}; }, onTokenRefreshed: () => () => {}, getAuthProviderForServer: () => provider };
	const folder = { entityGuid: id(2), config: { onpremServerId: "server" }, folderIndex: { on: () => () => {}, recordFor: () => ({ id: id(3), type: "markdown" }) }, toVirtualPath: () => "Note.md" };
	const shares = { on: () => () => {}, toArray: () => [folder], shareFor: () => folder };
	const file = new TFile();
	const plugin = { registerView: jest.fn(), registerEditorExtension: jest.fn(), addCommand: jest.fn(), app: { workspace: { on: jest.fn(), getActiveFile: () => file }, vault: { on: jest.fn(), getFileByPath: () => file } } };
	const scope = { readValue: () => settings, subscribe: (fn: () => void) => { settingsChanged = fn; return () => {}; } };
	const store = { close: jest.fn(), preference: jest.fn().mockResolvedValue(undefined) };
	const opening = jest.spyOn(DiscussionStore, "open").mockResolvedValue(store as unknown as DiscussionStore);
	const host = new DiscussionHost(plugin as unknown as Plugin, auth as unknown as AuthSession, shares as unknown as ShareRegistry,
		 scope as unknown as SettingsScope<RelayOnPremSettings>, "vault", bases);
	return { host, opening, store, provider, settings, file, folder, plugin, start: async () => { host.onload(); await Promise.resolve(); await Promise.resolve(); },
		account: (value?: string) => { accountId = value; authChanged(); }, settingsChanged: () => settingsChanged(),
		close: () => { host.onunload(); opening.mockRestore(); } };
}

async function nativeBaseFixture() {
	const snapshot = { definition_id: id(6), entry_id: id(3), generation: id(7), revision: 1 };
	const bases = { cachedViews: jest.fn().mockResolvedValue({ snapshot }), refreshViews: jest.fn().mockResolvedValue({ snapshot }) };
	const s = fixture(bases as unknown as BaseSyncHost); await s.start();
	s.file.path = "Team/Plan.base"; s.file.extension = "base";
	const recordFile = Object.assign(new TFile(), { path: "Team/Note.md" }), record = { id: id(8), type: "markdown" };
	Object.assign(s.folder, { absolutePath: (path: string) => "Team/" + path, toVirtualPath: (path: string) => path.slice(5),
		trackedEntries: new Map([[id(3), { isAttachment: true }]]) });
	Object.assign(s.folder.folderIndex, { recordFor: (path: string) => path === "Plan.base" ? { id: id(3), type: "file" } : record,
		eachRecord: (fn: (record: { id: string; type: string }, path: string) => void) => { fn({ id: id(3), type: "file" }, "Plan.base"); fn(record, "Note.md"); } });
	Object.assign(s.plugin.app.vault, { getFileByPath: (path: string) => path === s.file.path ? s.file : path === recordFile.path ? recordFile : null, read: jest.fn().mockResolvedValue("saved bytes") });
	const stops: jest.Mock[] = [], scope = baseDiscussionScope(id(3), id(4)); let valid = true, read = true, comment = true;
	const session = Object.assign(mockSessions[0], { identity: { shareId: id(2) }, online: true,
		knownDocumentGeneration: () => id(7), permission: () => ({ read, comment }), canAnchorBase: () => true, canAnchorBaseRecord: (kind: string) => kind === "markdown",
		watch: jest.fn(() => { const stop = jest.fn(); stops.push(stop); return stop; }), refresh: jest.fn().mockResolvedValue(undefined), scopeReady: jest.fn().mockResolvedValue(undefined),
		readBaseContext: jest.fn().mockResolvedValue({ definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1, record_generation: id(9) }),
		readBaseDefinitions: jest.fn<Promise<BaseDefinitionCatalog>, []>().mockResolvedValue({ protocol_version: 1, entry_id: id(3), definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1, computed_values: false,
			targets: [{ id: id(10), kind: "formula", revision: 1, fingerprint: "a".repeat(64), property: { source: "formula", name: "total" } }] }),
		captureBaseTarget: jest.fn<Promise<BaseAnchor>, []>().mockResolvedValue({ version: 1, type: "base", definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1,
			target: { type: "cell", record_id: id(8), record_generation: id(9), property: { source: "note", name: "status" } } }),
	});
	const savedPreference = jest.fn().mockResolvedValue(undefined); Object.assign(s.store, { setPreference: savedPreference });
	const surface = { file: s.file, current: () => valid, activateView: jest.fn(() => true), bind: jest.fn(async (_snapshot, _entry, readFile: () => Promise<string>, current: () => boolean) => {
		await readFile(); return { snapshot, viewId: id(4), name: "Work", type: "table", current: () => valid && current() };
	}) };
	const handle: NativeBaseHandle = { target: { type: "cell", file: recordFile, property: { source: "note", name: "status" } }, element: document.createElement("div"), current: () => valid };
	return { ...s, bases, surface, session, stops, scope, record, handle, savedPreference,
		context: () => s.host.baseCommentContext(surface as unknown as NativeBasesSurface, () => valid),
		invalidate() { valid = false; }, revoke() { read = false; }, readOnly() { comment = false; } };
}

test("native Bases discovery does not pin the sidebar; explicit capture pins and saves the exact cell", async () => {
	const s = await nativeBaseFixture(); const saved = jest.spyOn(s.host, "saveCommentSelection").mockResolvedValue(true);
	try {
		const context = (await s.context())!; expect(context.current()).toBe(true);
		expect(s.host.current().entryId).toBeUndefined(); expect(s.savedPreference).not.toHaveBeenCalled();
		expect(context.selection(s.handle.target)).toEqual({ type: "cell", recordId: id(8), property: { source: "note", name: "status" } });
		expect(await s.host.commentBaseHandle(context, s.handle)).toBe(true);
		expect(s.host.current().entryId).toBe(s.scope);
		expect(saved).toHaveBeenCalledWith(expect.objectContaining({ entryId: s.scope, anchor: expect.objectContaining({ target: expect.objectContaining({ record_id: id(8) }) }) }));
		context.release(); context.release(); expect(s.stops[0]).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test("native formula cells and headers capture catalogue identities and refuse changed-definition placement", async () => {
	const s = await nativeBaseFixture(), saved = jest.spyOn(s.host, "saveCommentSelection").mockResolvedValue(true);
	try {
		if (s.handle.target.type !== "cell") throw new Error("fixture");
		const property = { source: "formula" as const, name: "total" };
		s.handle.target = { ...s.handle.target, property };
		const anchor: BaseAnchor = { ...await s.session.captureBaseTarget(), target: { type: "formula_cell", record_id: id(8), record_generation: id(9), definition_id: id(10), definition_revision: 1, property } };
		s.session.captureBaseTarget.mockResolvedValue(anchor);
		const context = (await s.context())!;
		expect(context.selection(s.handle.target)).toEqual({ type: "formula_cell", recordId: id(8), definitionId: id(10), definitionRevision: 1 });
		expect(context.selection({ type: "property", property })).toEqual({ type: "formula", definitionId: id(10), definitionRevision: 1 });
		expect(context.native(anchor)).toEqual(s.handle.target);
		expect(await s.host.commentBaseHandle(context, s.handle)).toBe(true);
		expect(saved).toHaveBeenCalledWith(expect.objectContaining({ anchor }));
		expect(await s.host.verifyBaseTarget(context, anchor)).toBe(true);
		const catalog = await s.session.readBaseDefinitions();
		s.session.readBaseDefinitions.mockResolvedValue({ ...catalog, registry_revision: 2, targets: catalog.targets.map(item => ({ ...item, revision: 2 })) });
		expect(await s.host.verifyBaseTarget(context, anchor)).toBe(false);
		context.release();
		const stale = (await s.context())!;
		expect(stale.selection(s.handle.target)).toBeUndefined();
		expect(stale.native(anchor)).toBeUndefined();
		expect(stale.selection({ type: "view" })).toEqual({ type: "view" }); stale.release();
	} finally { s.close(); }
});

test.each(["record", "registry", "account", "access"])("a %s change during native target capture cannot pin or save a stale draft", async change => {
	const s = await nativeBaseFixture(), saved = jest.spyOn(s.host, "saveCommentSelection").mockResolvedValue(true);
	try {
		const context = (await s.context())!, anchor = await s.session.captureBaseTarget();
		s.session.captureBaseTarget.mockImplementation(async () => {
			if (change === "record") s.record.id = id(90);
			if (change === "registry") return { ...anchor, registry_revision: 2 };
			if (change === "account") s.account(id(90));
			if (change === "access") s.revoke();
			return anchor;
		});
		expect(await s.host.commentBaseHandle(context, s.handle)).toBe(false);
		expect(saved).not.toHaveBeenCalled(); expect(s.savedPreference).not.toHaveBeenCalled(); context.release();
	} finally { s.close(); }
});

test("readers can map native targets but cannot create, and changed record lineage refuses navigation", async () => {
	const s = await nativeBaseFixture();
	try {
		s.readOnly(); const context = (await s.context())!;
		expect(context.selection(s.handle.target)).toBeDefined(); expect(context.canComment(s.handle.target)).toBe(false);
		expect(await s.host.commentBaseHandle(context, s.handle)).toBe(false);
		const anchor = await s.session.captureBaseTarget();
		expect(await s.host.verifyBaseTarget(context, anchor)).toBe(true);
		s.session.readBaseContext.mockResolvedValue({ ...await s.session.readBaseContext(), record_generation: id(90) });
		expect(await s.host.verifyBaseTarget(context, anchor)).toBe(false); context.release();
	} finally { s.close(); }
});

test("native discovery releases its subscription when server registry proof is stale", async () => {
	const s = await nativeBaseFixture();
	try {
		s.session.readBaseContext.mockResolvedValue({ ...await s.session.readBaseContext(), registry_revision: 2 });
		expect(await s.context()).toBeUndefined(); expect(s.stops[0]).toHaveBeenCalledTimes(1);
		expect(s.savedPreference).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("a target override cannot substitute another record or property for a native handle", async () => {
	const s = await nativeBaseFixture();
	try {
		const context = (await s.context())!;
		expect(await s.host.commentBaseHandle(context, s.handle, { type: "item", file: new TFile() })).toBe(false);
		expect(await s.host.commentBaseHandle(context, s.handle, { type: "property", property: { source: "note", name: "status" } })).toBe(false);
		expect(s.session.captureBaseTarget).not.toHaveBeenCalled(); context.release();
	} finally { s.close(); }
});

test("target navigation can leave an unvisited native view using the requested scope's verified authority", async () => {
	const s = await nativeBaseFixture();
	try {
		const original = s.surface.bind.getMockImplementation()!;
		s.surface.bind.mockImplementation(async (...args) => ({ ...await original(...args), viewId: id(5), name: "Unvisited cards" }));
		const anchor = await s.session.captureBaseTarget();
		expect(await s.host.activateBaseView(s.surface as unknown as NativeBasesSurface, s.session as unknown as DiscussionSession, s.scope, anchor, () => true)).toBe("changed");
		expect(s.surface.activateView).toHaveBeenCalledWith(id(4), expect.objectContaining({ viewId: id(5) }));
		expect(s.session.readBaseContext).toHaveBeenCalledWith(s.scope); expect(s.savedPreference).not.toHaveBeenCalled();
		s.revoke(); s.surface.activateView.mockClear();
		expect(await s.host.activateBaseView(s.surface as unknown as NativeBasesSurface, s.session as unknown as DiscussionSession, s.scope, anchor, () => true)).toBe("unavailable");
		expect(s.surface.activateView).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("direct-image read context stops on lost authentication while creation remains separately gated", async () => {
	const test = fixture();
	try {
		await test.start(); test.file.path = "Team/chart.png"; test.file.extension = "png";
		jest.spyOn(test.folder.folderIndex, "recordFor").mockReturnValue({ id: id(3), type: "image" });
		const session = Object.assign(mockSessions[0], { knownDocumentGeneration: () => id(4), canAnchorImageFiles: false,
			permission: () => ({ read: true, comment: true }) });
		expect(test.host.targetFor(test.file).kind).toBe("image");
		const read = test.host.imageFileContext(test.file, false); expect(read.current()).toBe(true);
		expect(() => test.host.imageFileContext(test.file)).toThrow("unavailable");
		session.canAnchorImageFiles = true; expect(test.host.imageFileContext(test.file).current()).toBe(true);
		session.status = "authentication_required"; expect(read.current()).toBe(false);
		expect(() => test.host.imageFileContext(test.file, false)).toThrow("unavailable");
	} finally { test.close(); }
});

test("saved-view restoration is scoped to the current account and does not carry an old selection across sign-in", async () => {
	const s = fixture(), flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
	try {
		await s.start(); s.file.path = "Team/Planning.base"; s.file.extension = "base";
		jest.spyOn(s.folder.folderIndex, "recordFor").mockReturnValue({ id: id(3), type: "file" });
		s.store.preference.mockResolvedValueOnce({ id: id(4), name: "Planning", type: "table", state: "active" });
		expect(s.host.current().entryId).toBeUndefined(); await flush();
		expect(s.host.current()).toMatchObject({ kind: "base", entryId: baseDiscussionScope(id(3), id(4)), baseViewName: "Planning" });
		s.account(id(9)); await flush();
		expect(s.host.current().entryId).toBeUndefined(); await flush();
		expect(s.host.current().entryId).toBeUndefined();
		expect(s.store.preference.mock.calls).toEqual([["activeBaseView:" + id(3)], ["activeBaseView:" + id(3)]]);
	} finally { s.close(); }
});

test.each(["markdown", "image", "audio", "video", "pdf", "canvas", "file"])("%s target labels follow managed record identity across renames and refuse ambiguous path associations", async kind => {
	const s = fixture();
	try {
		let paths = ["Example.md"];
		Object.assign(s.folder.folderIndex, { eachRecord: (visit: (record: { id: string; type: string }, path: string) => void) => {
			for (const path of paths) visit({ id: id(8), type: kind }, path);
		} });
		const session = { identity: { shareId: id(2) } } as DiscussionSession;
		const scope = baseDiscussionScope(id(3), id(4));
		const anchor = { type: "base" as const, version: 1 as const, definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1,
			target: { type: "cell" as const, record_id: id(8), record_generation: id(9), property: { source: "note" as const, name: "status" } } };
		expect(s.host.targetLabel(session, scope, anchor)).toBe("Cell: Example.md · note.status");
		paths = ["Renamed.md"]; expect(s.host.targetLabel(session, scope, anchor)).toBe("Cell: Renamed.md · note.status");
		paths.push("Duplicate.md"); expect(s.host.targetLabel(session, scope, anchor)).toContain("Unavailable record");
		expect(s.host.targetLabel(session, baseDiscussionScope(id(3), id(5)), anchor)).toBeUndefined();
	} finally { s.close(); }
});

test("native record selection respects negotiated types, excludes folders/local-only and duplicate IDs, and rechecks a changed record", async () => {
	const s = fixture(), flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
	try {
		await s.start(); s.file.path = "Team/Planning.base"; s.file.extension = "base";
		let records = [
			{ id: id(10), type: "markdown", path: "Note.md" }, { id: id(11), type: "image", path: "Chart.png" },
			{ id: id(12), type: "file", path: "Data.csv" }, { id: id(13), type: "folder", path: "Folder" },
			{ id: id(14), type: "audio", path: "Sound.mp3" }, { id: id(15), type: "image", path: "Missing.png" },
			{ id: id(16), type: "image", path: "Duplicate.png" }, { id: id(16), type: "folder", path: "Duplicate" },
		];
		Object.assign(s.folder, { absolutePath: (path: string) => "Team/" + path, toVirtualPath: (path: string) => path.slice(5) });
		Object.assign(s.folder.folderIndex, {
			recordFor: (path: string) => path === "Planning.base" ? { id: id(3), type: "file" } : records.find(record => record.path === path),
			eachRecord: (visit: (record: { id: string; type: string }, path: string) => void) => records.forEach(record => visit(record, record.path)),
		});
		const session = Object.assign(mockSessions[0], { permission: () => ({ read: true, comment: true }),
			canAnchorBase: () => true, canAnchorBaseRecord: (kind: string) => ["markdown", "image", "file"].includes(kind),
			captureBaseTarget: jest.fn().mockResolvedValue({ type: "base" }) }) as unknown as DiscussionSession;
		s.store.preference.mockResolvedValueOnce({ id: id(4), name: "Planning", type: "table", state: "active" });
		s.host.current(); await flush();
		// An inventory entry without a locally available file cannot be selected.
		const plugin = (s.host as unknown as { plugin: Plugin }).plugin;
		jest.spyOn(plugin.app.vault, "getFileByPath").mockImplementation(path => path === "Team/Missing.png" ? null : s.file);
		const saved = jest.spyOn(s.host, "saveCommentSelection").mockResolvedValue(true);
		await s.host.commentCurrentBase(session, baseDiscussionScope(id(3), id(4)));
		const [, , search, properties, choose] = jest.mocked(BaseTargetPicker).mock.calls.at(-1)!;
		expect(search("").records.map(record => record.path)).toEqual(["Chart.png", "Data.csv", "Note.md"]);
		expect(search("chart").records).toEqual([{ id: id(11), path: "Chart.png", kind: "image" }]);
		expect(properties(id(11))).toEqual([]);
		await expect(choose({ type: "cell", recordId: id(11), property: { source: "note", name: "name" } })).rejects.toThrow("changed");
		expect(await choose({ type: "cell", recordId: id(11), property: { source: "file", name: "size" } })).toBe(true);
		expect(saved).toHaveBeenCalledTimes(1);
		records = records.filter(record => record.id !== id(11));
		await expect(choose({ type: "item", recordId: id(11) })).rejects.toThrow("changed");
		expect(session.captureBaseTarget).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test("switching accounts closes the old session synchronously and uses a distinct cache identity", async () => {
	const test = fixture();
	try {
		await test.start(); const old = mockSessions[0]; expect(test.host.current().entryId).toBe(id(3));
		test.account(id(9)); expect(old.close).toHaveBeenCalledTimes(1); expect(old.status).toBe("closed");
		await Promise.resolve(); await Promise.resolve();
		expect(test.opening.mock.calls.map(([identity]) => identity.accountId)).toEqual([id(1), id(9)]);
		test.account(); expect(test.host.current().session).toBeUndefined(); expect(test.host.current().message).toContain("Sign in");
	} finally { test.close(); }
});

test("a token refresh finishing after logout or endpoint replacement cannot return credentials", async () => {
	const test = fixture();
	try {
		await test.start(); let release!: (value: string) => void;
		test.provider.getValidToken.mockImplementation(() => new Promise(resolve => { release = resolve; }));
		const oldCredential = mockCredentials[0], pending = oldCredential();
		test.settings.servers[0].controlPlaneUrl = "https://two.test"; test.settingsChanged();
		release("old-token"); expect(await pending).toBeUndefined();
		expect(await oldCredential()).toBeUndefined();
		await Promise.resolve(); await Promise.resolve();
		expect(test.opening.mock.calls[1][0].serverId).toBe("https://two.test");
	} finally { test.close(); }
});

test("a local database opening after logout is closed without constructing a session", async () => {
	const test = fixture();
	try {
		let release!: (store: DiscussionStore) => void;
		test.opening.mockImplementation(() => new Promise(resolve => { release = resolve; }));
		await test.start(); test.account(); release(test.store as unknown as DiscussionStore);
		await Promise.resolve(); await Promise.resolve();
		expect(test.store.close).toHaveBeenCalledTimes(1); expect(mockSessions).toHaveLength(0);
	} finally { test.close(); }
});
