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

function makeClient() {
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
		DOCUMENT_ID,
		new RemoteDocumentAddress("relay-onprem", SHARE_ID, DOCUMENT_ID),
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
	test("a later server login seeds both presence and the document user mapping", () => {
		const { provider, restoreIdentity } = makeClient();
		const permanentUsers = createPermanentUserData(provider.crdtDoc);
		expect(provider._liveProvider.awareness.getLocalState()?.user).toBeUndefined();
		expect(permanentUsers.getUserByClientId(provider.crdtDoc.clientID)).toBeNull();

		const account = new Account("local-user", "Local User", "user@example.com", "", "");
		restoreIdentity(account);

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
		expect(provider._liveProvider.awareness.getLocalState()?.user.avatarUrl).toBe(account.avatarUrl);
		const changed = jest.fn();
		provider.crdtDoc.on("update", changed);
		refreshProfile(new Account(account.accountId, "Updated Name", account.emailAddress, "https://id.example/two.png", ""));
		expect(provider._liveProvider.awareness.getLocalState()?.user).toMatchObject({ name: "Updated Name", avatarUrl: "https://id.example/two.png" });
		expect(changed).not.toHaveBeenCalled();
		refreshProfile(new Account(account.accountId, "Updated Name", account.emailAddress, "", ""));
		expect(provider._liveProvider.awareness.getLocalState()?.user.avatarUrl).toBeUndefined();
		restoreIdentity(undefined);
		expect(provider._liveProvider.awareness.getLocalState()?.user).toBeNull();
	});

	test("disposing a provider removes its authentication listener", () => {
		const { provider, listeners, refreshListeners } = makeClient();
		expect(listeners.size).toBe(1);
		provider.dismantle();
		expect(listeners.size).toBe(0);
		expect(refreshListeners.size).toBe(0);
	});
});
