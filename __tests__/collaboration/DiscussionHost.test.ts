/** @jest-environment jsdom */
import type { Plugin } from "obsidian";
import { TFile } from "obsidian";
import type { AuthSession } from "../../src/AuthSession";
import type { ShareRegistry } from "../../src/VaultShare";
import type { SettingsScope } from "../../src/SettingsPersistence";
import type { RelayOnPremSettings } from "../../src/RelayOnPremConfig";
import { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";

const mockSessions: { close: jest.Mock; status: string }[] = [];
const mockCredentials: (() => Promise<unknown>)[] = [];
jest.mock("obsidian", () => ({
	Component: class { register() {} registerEvent() {} registerDomEvent() {} },
	ItemView: class {}, Modal: class {}, TFile: class { path = "Team/Note.md"; extension = "md"; },
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
		constructor() { mockSessions.push(this); }
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
	const plugin = { registerView: jest.fn(), addCommand: jest.fn(), app: { workspace: { on: jest.fn(), getActiveFile: () => file }, vault: { on: jest.fn() } } };
	const scope = { readValue: () => settings, subscribe: (fn: () => void) => { settingsChanged = fn; return () => {}; } };
	const store = { close: jest.fn() };
	const opening = jest.spyOn(DiscussionStore, "open").mockResolvedValue(store as unknown as DiscussionStore);
	const host = new DiscussionHost(plugin as unknown as Plugin, auth as unknown as AuthSession, shares as unknown as ShareRegistry,
		scope as unknown as SettingsScope<RelayOnPremSettings>, "vault");
	return { host, opening, store, provider, settings, start: async () => { host.onload(); await Promise.resolve(); await Promise.resolve(); },
		account: (value?: string) => { accountId = value; authChanged(); }, settingsChanged: () => settingsChanged(),
		close: () => { host.onunload(); opening.mockRestore(); } };
}

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
