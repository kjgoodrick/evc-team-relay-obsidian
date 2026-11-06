import { afterEach, describe, expect, test } from "@jest/globals";
import { Account } from "../src/Account";
import type { AuthSession } from "../src/AuthSession";
import { ProviderBacked } from "../src/ProviderBacked";
import type { RelayCredentialCache } from "../src/RelayCredentialCache";
import { RemoteDocumentAddress } from "../src/ResourceAddress";
import { createPermanentUserData } from "../src/permanentUserData";

const SERVER_ID = "self-host";
const SHARE_ID = "00000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000002";
const providers: ProviderBacked[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) {
		provider.dismantle();
		provider.crdtDoc.destroy();
	}
});

function makeClient(documentId = DOCUMENT_ID) {
	let user: Account | undefined;
	const listeners = new Set<() => void>();
	const refreshListeners = new Set<(serverId: string) => void>();
	const auth = {
		getCurrentUserForServer: (serverId?: string) =>
			serverId === SERVER_ID ? user : undefined,
		on: (listener: () => void) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		onTokenRefreshed: (listener: (serverId: string) => void) => {
			refreshListeners.add(listener);
			return () => { refreshListeners.delete(listener); };
		},
	} as unknown as AuthSession;
	const credentials = { peekToken: () => undefined } as unknown as RelayCredentialCache;
	// Keep the real provider disconnected: this test exercises real awareness
	// and Yjs identity state without depending on a network connection.
	const provider = new ProviderBacked(
		documentId,
		new RemoteDocumentAddress("relay-onprem", SHARE_ID, documentId),
		credentials,
		auth,
		SERVER_ID,
	);
	providers.push(provider);
	return {
		provider,
		listeners,
		refreshListeners,
		refreshProfile(account: Account) {
			user = account;
			for (const listener of refreshListeners) listener(SERVER_ID);
		},
		restoreIdentity(account?: Account) {
			user = account;
			for (const listener of listeners) listener();
		},
	};
}

describe("ProviderBacked identity restoration", () => {
	test("background notes stay silent through login and profile updates", () => {
		const { provider, restoreIdentity, refreshProfile } = makeClient();
		restoreIdentity(new Account("local-user", "Local User", "user@example.com", "", ""));
		expect(provider._liveProvider.awareness.getLocalState()).toBeNull();
		refreshProfile(new Account("local-user", "Updated Name", "user@example.com", "", ""));
		expect(provider._liveProvider.awareness.getLocalState()).toBeNull();
		provider.setPresenceActive("reading");
		expect(provider._liveProvider.awareness.getLocalState()).toMatchObject({ surface: "reading", cursor: null, user: { name: "Updated Name" } });
		provider.setPresenceActive();
		refreshProfile(new Account("local-user", "Another Name", "user@example.com", "", ""));
		expect(provider._liveProvider.awareness.getLocalState()).toBeNull();
	});

	test("a new account or login session cannot publish over the previous managed grant", () => {
		const { provider, restoreIdentity, refreshProfile } = makeClient();
		const jwt = (claims: object) => Buffer.from('{"alg":"HS256"}').toString("base64url") + "." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".synthetic";
		const account = (sub: string, session_id: string) => new Account(sub, "Member", "member@example.com", "", jwt({ sub, session_id }));
		const grant = (sub: string, session_id: string) => ({ url: "ws://localhost/v1/managed/ws", docId: DOCUMENT_ID, folder: SHARE_ID,
			token: jwt({ sub, session_id, scope: "managed", doc_id: DOCUMENT_ID }), expiryTime: Date.now() + 300000 });
		restoreIdentity(account("first", "one")); provider.applyRefreshedToken(grant("first", "one")); provider.setPresenceActive("editor");
		provider._liveProvider.awareness.setLocalStateField("cursor", { private: "old selection" });
		refreshProfile(account("first", "two"));
		expect(provider._liveProvider.awareness.getLocalState()).toBeNull();
		provider.applyRefreshedToken(grant("first", "two"));
		expect(provider._liveProvider.awareness.getLocalState()?.cursor).toBeNull();
		restoreIdentity(account("second", "three"));
		expect(provider._liveProvider.awareness.getLocalState()).toBeNull();
		provider.applyRefreshedToken(grant("first", "two")); // A late token response is still unusable for presence.
		expect(provider._liveProvider.awareness.getLocalState()).toBeNull();
		provider.applyRefreshedToken(grant("second", "three"));
		expect(provider._liveProvider.awareness.getLocalState()?.user.id).toBe("second");
	});
	test("independent notes advertise the same color after account restoration and profile refresh", () => {
		const first = makeClient();
		const second = makeClient("00000000-0000-4000-8000-000000000003");
		first.restoreIdentity(new Account("local-user", "Local User", "user@example.com", "", ""));
		second.restoreIdentity(new Account("local-user", "Local User", "user@example.com", "", ""));
		first.provider.setPresenceActive("editor"); second.provider.setPresenceActive("editor");
		const color = first.provider._liveProvider.awareness.getLocalState()?.user.color;
		expect(second.provider._liveProvider.awareness.getLocalState()?.user.color).toBe(color);
		const changed = jest.fn();
		second.provider.crdtDoc.on("update", changed);
		second.refreshProfile(new Account("local-user", "New Name", "user@example.com", "https://id.example/new.png", "new-token"));
		expect(second.provider._liveProvider.awareness.getLocalState()?.user.color).toBe(color);
		expect(changed).not.toHaveBeenCalled();
	});

	test("a later server login seeds both presence and the document user mapping", () => {
		const { provider, restoreIdentity } = makeClient();
		const permanentUsers = createPermanentUserData(provider.crdtDoc);
		expect(provider._liveProvider.awareness.getLocalState()?.user).toBeUndefined();
		expect(permanentUsers.getUserByClientId(provider.crdtDoc.clientID)).toBeNull();

		const account = new Account("local-user", "Local User", "user@example.com", "", "");
		restoreIdentity(account);
		expect(provider._liveProvider.awareness.getLocalState()).toBeNull();
		provider.setPresenceActive("editor");

		expect(provider._liveProvider.awareness.getLocalState()?.user).toEqual({
			id: account.accountId,
			name: account.fullName,
			color: account.presenceColor.color,
			colorLight: account.presenceColor.light,
			avatarUrl: undefined,
		});
		expect(permanentUsers.getUserByClientId(provider.crdtDoc.clientID)).toBe(account.accountId);
	});

	test("profile changes refresh live awareness without altering document history", () => {
		const { provider, restoreIdentity, refreshProfile } = makeClient();
		const account = new Account("local-user", "Local User", "user@example.com", "https://id.example/one.png", "");
		restoreIdentity(account);
		const instance = "a8c90563-f8dd-466c-aeaa-87493d018754";
		provider.setPresenceActive("editor", instance);
		expect(provider._liveProvider.awareness.getLocalState()?.user.avatarUrl).toBe(account.avatarUrl);
		const changed = jest.fn();
		provider.crdtDoc.on("update", changed);
		refreshProfile(new Account(account.accountId, "Updated Name", account.emailAddress, "https://id.example/two.png", ""));
		expect(provider._liveProvider.awareness.getLocalState()?.user).toMatchObject({ name: "Updated Name", avatarUrl: "https://id.example/two.png" });
		expect(provider._liveProvider.awareness.getLocalState()?.instanceId).toBe(instance);
		expect(changed).not.toHaveBeenCalled();
		refreshProfile(new Account(account.accountId, "Updated Name", account.emailAddress, "", ""));
		expect(provider._liveProvider.awareness.getLocalState()?.user.avatarUrl).toBeUndefined();
		restoreIdentity(undefined);
		expect(provider._liveProvider.awareness.getLocalState()).toBeNull();
	});

	test("disposing a provider removes its authentication listener", () => {
		const { provider, listeners, refreshListeners } = makeClient();
		expect(listeners.size).toBe(1);
		provider.dismantle();
		expect(listeners.size).toBe(0);
		expect(refreshListeners.size).toBe(0);
	});
});
