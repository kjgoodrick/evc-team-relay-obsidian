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

const mockSessions: { close: jest.Mock; status: string }[] = [];
const mockCredentials: (() => Promise<unknown>)[] = [];
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
function fixture() {
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
		scope as unknown as SettingsScope<RelayOnPremSettings>, "vault");
	return { host, opening, store, provider, settings, file, folder, start: async () => { host.onload(); await Promise.resolve(); await Promise.resolve(); },
		account: (value?: string) => { accountId = value; authChanged(); }, settingsChanged: () => settingsChanged(),
		close: () => { host.onunload(); opening.mockRestore(); } };
}

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

test("target labels follow managed record identity across renames and refuse ambiguous path associations", async () => {
	const s = fixture();
	try {
		let paths = ["Example.md"];
		Object.assign(s.folder.folderIndex, { eachRecord: (visit: (record: { id: string; type: string }, path: string) => void) => {
			for (const path of paths) visit({ id: id(8), type: "markdown" }, path);
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
