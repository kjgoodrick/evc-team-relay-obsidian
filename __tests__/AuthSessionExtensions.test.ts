/**
 * Unit tests: AuthSessionExtensions.loginWithOAuth2
 *
 * The bug: OAuth login call sites (RelayOnPremLoginModal, RelayOnPremServerList)
 * used to call `authProvider.loginWithOAuth2()` directly, bypassing AuthSession
 * entirely — AuthSession.currentUser was never set and notifySubscribers() was never
 * called, so main.ts's login listener (which gates _onLogin()/
 * loadRelayOnPremShares() on loginManager.isAuthenticated) never fired. Shares/live-sync
 * only started after a plugin reload happened to re-run the "already logged in"
 * restore path.
 *
 * AuthSession itself can't be unit-tested in this repo (it imports `pocketbase`,
 * an ESM-only package Jest can't parse under the current config — same wall
 * hit for Document.ts, see checkStale's fix). This module
 * (AuthSessionExtensions.ts) has no such dependency, so the actual new logic —
 * turning an OAuth AuthResponse into an Account the same way the password path
 * does — is fully testable here with a mock IAuthProvider.
 */

import { describe, test, expect, jest } from "@jest/globals";
import { loginWithOAuth2, resolveUserAfterFailedLogin, resolveCurrentUserForServer } from "../src/AuthSessionExtensions";
import type { IAuthProvider, AuthResponse } from "../src/auth/IAuthProvider";
import { Account } from "../src/Account";

function makeAuthProvider(authResponse: AuthResponse): IAuthProvider {
	return {
		isLoggedIn: jest.fn(() => true),
		getCurrentUser: jest.fn(() => authResponse.user),
		getToken: jest.fn(() => authResponse.token.token),
		getValidToken: jest.fn(async () => authResponse.token.token),
		loginWithPassword: jest.fn(),
		loginWithOAuth2: jest.fn(async () => authResponse),
		refreshToken: jest.fn(),
		logout: jest.fn(),
		isTokenValid: jest.fn(() => true),
	} as unknown as IAuthProvider;
}

describe("loginWithOAuth2", () => {
	test("builds an Account from the provider's AuthResponse", async () => {
		const authProvider = makeAuthProvider({
			user: { id: "u1", email: "dev@example.com", name: "Dev Account", picture: "https://x/y.png" },
			token: { token: "jwt-abc", expiresAt: 999999 },
		});

		const user = await loginWithOAuth2(authProvider, "github");

		expect(authProvider.loginWithOAuth2).toHaveBeenCalledWith("github", undefined);
		expect(user.accountId).toBe("u1");
		expect(user.fullName).toBe("Dev Account");
		expect(user.emailAddress).toBe("dev@example.com");
		expect(user.avatarUrl).toBe("https://x/y.png");
		expect(user.authToken).toBe("jwt-abc");
	});

	test("falls back to email when the provider gives no display name", async () => {
		const authProvider = makeAuthProvider({
			user: { id: "u2", email: "noname@example.com" },
			token: { token: "jwt-xyz", expiresAt: 999999 },
		});

		const user = await loginWithOAuth2(authProvider, "google");

		expect(user.fullName).toBe("noname@example.com");
		expect(user.avatarUrl).toBe("");
	});

	test("propagates a rejected OAuth attempt instead of returning a partial user", async () => {
		const authProvider: IAuthProvider = {
			isLoggedIn: jest.fn(() => false),
			getCurrentUser: jest.fn(() => undefined),
			getToken: jest.fn(() => undefined),
			getValidToken: jest.fn(async () => undefined),
			loginWithPassword: jest.fn(),
			loginWithOAuth2: jest.fn(async () => {
				throw new Error("popup closed");
			}),
			refreshToken: jest.fn(),
			logout: jest.fn(),
			isTokenValid: jest.fn(() => false),
		} as unknown as IAuthProvider;

		await expect(loginWithOAuth2(authProvider, "github")).rejects.toThrow(
			"popup closed",
		);
	});
});

/**
 * Unit tests: resolveUserAfterFailedLogin (analog for
 * AuthSession.loginWithEmailAndPassword, follow-up to
 *).
 *
 * The bug: loginWithEmailAndPassword's catch block unconditionally set
 * `this.currentUser = undefined` on ANY login failure — including a failed
 * RE-login attempted while already logged in (e.g. a typo'd password),
 * which silently logged the user out of a session that was working fine.
 * AuthSession itself can't be unit-tested in this repo (imports
 * `pocketbase`, an ESM-only package that breaks ts-jest parsing — same
 * wall documented above for loginWithOAuth2), so this tests the extracted
 * pure decision function directly, same approach as 's
 * preserveBeforeTrash.ts extraction.
 */
describe("resolveUserAfterFailedLogin", () => {
	test("analog: a failed re-login while already logged in restores the existing user, not undefined", () => {
		const existingUser = { id: "u1", email: "a@example.com" };
		expect(resolveUserAfterFailedLogin(existingUser)).toBe(existingUser);
	});

	test("no prior session — stays undefined (matches pre-fix behavior for this case)", () => {
		expect(resolveUserAfterFailedLogin(undefined)).toBeUndefined();
	});
});

/**
 * Unit tests: resolveCurrentUserForServer ( — self-host cursors
 * silently never broadcast, awareness identity resolved from the wrong
 * server).
 *
 * The bug: ProviderBacked seeded awareness/doc-identity from
 * `authSession.currentUser`, a SINGLE global field that only ever reflects
 * whichever server is `activeServerId` — never a specific OTHER server's
 * login, even though ProviderBacked's own constructor already receives
 * `onpremServerId` (threaded through correctly for the CREDENTIAL/token
 * layer, per its own doc comment) and simply never used it for identity.
 * A doc whose server differs from the active one (or a doc built before its
 * own server's restore/login resolved) got `user=undefined` forever —
 * `seedAwareness` no-ops on that, so this client's cursor was never
 * computed or sent for the rest of its lifetime (RemoteSelections.ts's
 * `if (localAwarenessState != null)` guard).
 */
describe("resolveCurrentUserForServer", () => {
	const globalUser = new Account("global-id", "Global User", "global@example.com", "", "tok-g");
	const serverUser = new Account("server-id", "Server User", "server@example.com", "", "tok-s");

	function providerFor(user: Account | undefined): IAuthProvider {
		return {
			isLoggedIn: jest.fn(() => user !== undefined),
			getCurrentUser: jest.fn(() =>
				user ? { id: user.accountId, name: user.fullName, email: user.emailAddress, picture: user.avatarUrl } : null,
			),
			getToken: jest.fn(() => user?.authToken ?? null),
			getValidToken: jest.fn(async () => user?.authToken),
			loginWithPassword: jest.fn(),
			loginWithOAuth2: jest.fn(),
			refreshToken: jest.fn(),
			logout: jest.fn(),
			isTokenValid: jest.fn(() => true),
		} as unknown as IAuthProvider;
	}

	test("no serverId (legacy doc/folder pre-dating onpremServerId) — falls back to the global currentUser", () => {
		expect(resolveCurrentUserForServer(globalUser, providerFor(serverUser), undefined)).toBe(
			globalUser,
		);
	});

	test("known serverId, THAT server IS logged in — resolves ITS user, not the global one", () => {
		// This is the actual bug fix: previously this case returned
		// `globalUser` regardless (the code only ever read `currentUser`),
		// which is wrong whenever this doc's server isn't the active one.
		// getCurrentUserFromProvider always builds a FRESH Account, so
		// compare identity fields, not object/reference
		// equality — resolveCurrentUserForServer's own contract is "the
		// right account", not "the exact same instance".
		const resolved = resolveCurrentUserForServer(globalUser, providerFor(serverUser), "srv-1");
		expect(resolved?.accountId).toBe(serverUser.accountId);
		expect(resolved?.emailAddress).toBe(serverUser.emailAddress);
		expect(resolved?.accountId).not.toBe(globalUser.accountId);
	});

	test("known serverId, THAT server is NOT logged in — undefined, never borrows the global user", () => {
		// The dangerous alternative would be falling back to `globalUser`
		// here: that misattributes this document's identity/cursor to a
		// DIFFERENT, unrelated account instead of just leaving it unseeded.
		expect(
			resolveCurrentUserForServer(globalUser, providerFor(undefined), "srv-1"),
		).toBeUndefined();
	});

	test("unknown serverId (no provider found at all) — legacy fallback to the global currentUser", () => {
		expect(resolveCurrentUserForServer(globalUser, undefined, "srv-does-not-exist")).toBe(
			globalUser,
		);
	});

	test("no global user AND no per-server provider — stays undefined either way", () => {
		expect(resolveCurrentUserForServer(undefined, undefined, undefined)).toBeUndefined();
		expect(resolveCurrentUserForServer(undefined, providerFor(undefined), "srv-1")).toBeUndefined();
	});
});
