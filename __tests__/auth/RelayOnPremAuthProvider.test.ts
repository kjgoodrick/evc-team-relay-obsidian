/**
 * Tests for RelayOnPremAuthProvider
 *
 * Tests authentication provider with mocked fetch and localStorage.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { RelayOnPremAuthProvider } from "../../src/auth/RelayOnPremAuthProvider";
import { getAuthStore } from "../../src/auth/RelayOnPremAuthStore";
import type { AuthResponse } from "../../src/auth/IAuthProvider";

// Mock dependencies
jest.mock("../../src/logging", () => ({
	namedLogger: () => jest.fn(),
	Loggable: class Loggable {
		protected debug = jest.fn();
		protected log = jest.fn();
		protected warn = jest.fn();
		protected error = jest.fn();
	},
}));

jest.mock("../../src/platformFetch");
import { platformFetch } from "../../src/platformFetch";
const mockFetch = platformFetch as jest.MockedFunction<typeof platformFetch>;

jest.mock("../../src/auth/NativeOAuthHandler");
import { NativeOAuthHandler } from "../../src/auth/NativeOAuthHandler";
import { testGlobal } from "../mocks/testGlobal";
import { createAuthStorageShim } from "../mocks/authStorageShim";
const MockNativeOAuthHandler = NativeOAuthHandler as jest.MockedClass<typeof NativeOAuthHandler>;

const mockStorage = createAuthStorageShim("test-app-id");
Object.defineProperty(testGlobal, "window", {
	value: { open: jest.fn() },
	writable: true,
});

// Helper to create mock fetch response
function mockFetchResponse(status: number, data: any, ok = true) {
	return Promise.resolve({
		ok: ok !== false && status < 400,
		status,
		text: async () => JSON.stringify(data),
		json: async () => data,
		arrayBuffer: new ArrayBuffer(0),
		headers: new Headers(),
	} as Response);
}

describe("RelayOnPremAuthProvider", () => {
	const CONTROL_PLANE_URL = "https://cp.example.com";
	const APP_ID = "test-app-id";
	const SERVER_ID = "server-123";

	let provider: RelayOnPremAuthProvider;

	beforeEach(async () => {
		jest.clearAllMocks();
		mockStorage.clear();

		// getAuthStore(appId) is a module-level singleton (by design —
		// RelayOnPremAuthStore.ts's own docs: "prevent race conditions when
		// multiple providers access storage simultaneously"). It keeps an
		// in-memory memoryFallback cache alongside every successful write
		// as a resilience backup, and _readStorage migrates that fallback
		// back into localStorage whenever the real store reads empty — so
		// clearing only `mockStorage` (the fake localStorage) is NOT enough
		// test isolation: a previous test's successful login can leak
		// forward into this one via the singleton's fallback cache. Clear
		// it explicitly, same APP_ID every test reuses.
		getAuthStore(APP_ID).clearAll();

		provider = new RelayOnPremAuthProvider({
			controlPlaneUrl: CONTROL_PLANE_URL,
			appId: APP_ID,
			serverId: SERVER_ID,
		});

		// Wait for restore to complete
		await provider.waitForRestore();
	});

	describe("loginWithPassword()", () => {
		test("P16: Success flow", async () => {
			const loginData = {
				access_token: "test_access_token",
				token_type: "bearer" as const,
				refresh_token: "test_refresh_token",
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				name: "Test Account",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, loginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			const result = await provider.loginWithPassword(
				"test@example.com",
				"password123",
			);

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/v1/auth/login`,
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						email: "test@example.com",
						password: "password123",
					}),
				}),
			);

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/v1/auth/me`,
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						Authorization: `Bearer ${loginData.access_token}`,
					}),
				}),
			);

			expect(result.user.email).toBe("test@example.com");
			expect(result.token.token).toBe("test_access_token");
			expect(provider.isLoggedIn()).toBe(true);
		});

		test("P17: Error clears auth", async () => {
			mockFetch.mockResolvedValue(
				await mockFetchResponse(401, { error: "Invalid credentials" }, false),
			);

			await expect(
				provider.loginWithPassword("test@example.com", "wrong_password"),
			).rejects.toThrow("Login failed");

			expect(provider.isLoggedIn()).toBe(false);
			expect(provider.getCurrentUser()).toBeUndefined();
			expect(provider.getToken()).toBeUndefined();
		});

		test("A failed re-login while already logged in does NOT clear the existing valid session", async () => {
			// First, a real successful login.
			const loginData = {
				access_token: "original_token",
				token_type: "bearer" as const,
				refresh_token: "original_refresh_token",
				expires_in: 3600,
			};
			const userData = {
				id: "user-123",
				email: "test@example.com",
				name: "Test Account",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};
			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, loginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			await provider.loginWithPassword("test@example.com", "correct_password");
			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getToken()).toBe("original_token");

			// Now a re-login attempt with a typo'd password fails.
			mockFetch.mockResolvedValue(
				await mockFetchResponse(401, { error: "Invalid credentials" }, false),
			);

			await expect(
				provider.loginWithPassword("test@example.com", "typo'd_password"),
			).rejects.toThrow("Login failed");

			// The ORIGINAL session must still be intact — not logged out.
			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getCurrentUser()?.email).toBe("test@example.com");
			expect(provider.getToken()).toBe("original_token");
		});

		test("a re-login that fails AFTER step 1 (login) but at step 2 (fetch user info) restores the exact prior token, not a partial mix", async () => {
			// A boolean "don't clear" guard alone isn't enough here: step 1
			// (POST /auth/login) can succeed and mutate this.token/
			// storedRefreshToken/tokenExpiresAt before step 2 (GET /auth/me)
			// fails — leaving the OLD user identity paired with a NEW
			// (different-identity) token if the catch only skips the clear
			// instead of restoring the exact snapshot.
			const originalLoginData = {
				access_token: "original_token",
				token_type: "bearer" as const,
				refresh_token: "original_refresh_token",
				expires_in: 3600,
			};
			const originalUserData = {
				id: "user-A",
				email: "userA@example.com",
				name: "Account A",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};
			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, originalLoginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, originalUserData));

			await provider.loginWithPassword("userA@example.com", "correct_password");
			expect(provider.getToken()).toBe("original_token");

			// Re-login as a DIFFERENT user: step 1 succeeds (new token
			// issued), step 2 (/auth/me) then fails.
			const partialLoginData = {
				access_token: "userB_token",
				token_type: "bearer" as const,
				refresh_token: "userB_refresh_token",
				expires_in: 3600,
			};
			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, partialLoginData))
				.mockResolvedValueOnce(
					await mockFetchResponse(500, { error: "server error" }, false),
				);

			await expect(
				provider.loginWithPassword("userB@example.com", "password"),
			).rejects.toThrow("Failed to fetch user info");

			// Must be the ORIGINAL user paired with the ORIGINAL token — never
			// userA's identity paired with userB's token.
			expect(provider.getCurrentUser()?.email).toBe("userA@example.com");
			expect(provider.getToken()).toBe("original_token");
			expect(provider.isLoggedIn()).toBe(true);
		});

		test("Saves auth to localStorage on success", async () => {
			const loginData = {
				access_token: "token",
				token_type: "bearer" as const,
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, loginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			await provider.loginWithPassword("test@example.com", "password123");

			const storageKey = `evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`;
			const stored = mockStorage.get(storageKey);
			expect(stored).toBeDefined();

			const parsed = JSON.parse(stored!);
			expect(parsed.user.email).toBe("test@example.com");
			expect(parsed.token).toBe("token");
		});
	});

	describe("loginWithOAuth2()", () => {
		test("P18: Stores refresh_token (regression test)", async () => {
			const mockNativeOAuthHandler = {
				completeOAuthFlow: jest.fn(),
				destroy: jest.fn(),
			};

			MockNativeOAuthHandler.mockImplementation(() => mockNativeOAuthHandler as any);

			const mockAuthResponse: AuthResponse = {
				user: {
					id: "oauth-user-123",
					email: "oauth@example.com",
					name: "OAuth Account",
				},
				token: {
					token: "oauth_access_token",
					expiresAt: Date.now() + 3600000,
				},
				refreshToken: "oauth_refresh_token",
			};

			mockNativeOAuthHandler.completeOAuthFlow.mockResolvedValue(mockAuthResponse);

			const result = await provider.loginWithOAuth2("casdoor");

			expect(result).toEqual(mockAuthResponse);
			expect(provider.isLoggedIn()).toBe(true);

			// Check localStorage for refresh token
			const storageKey = `evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`;
			const stored = mockStorage.get(storageKey);
			expect(stored).toBeDefined();

			const parsed = JSON.parse(stored!);
			expect(parsed.refreshToken).toBe("oauth_refresh_token");
			expect(mockNativeOAuthHandler.destroy).toHaveBeenCalled();
		});

		test("P19: Error clears auth", async () => {
			const mockNativeOAuthHandler = {
				completeOAuthFlow: jest.fn(),
				destroy: jest.fn(),
			};

			MockNativeOAuthHandler.mockImplementation(() => mockNativeOAuthHandler as any);

			mockNativeOAuthHandler.completeOAuthFlow.mockRejectedValue(
				new Error("OAuth flow failed"),
			);

			await expect(provider.loginWithOAuth2("casdoor")).rejects.toThrow(
				"OAuth flow failed",
			);

			expect(provider.isLoggedIn()).toBe(false);
			expect(mockNativeOAuthHandler.destroy).toHaveBeenCalled();
		});

		test("A failed OAuth2 re-login while already logged in does NOT clear the existing valid session", async () => {
			const successfulNativeOAuthHandler = {
				completeOAuthFlow: jest.fn(),
				destroy: jest.fn(),
			};
			MockNativeOAuthHandler.mockImplementation(() => successfulNativeOAuthHandler as any);

			const mockAuthResponse: AuthResponse = {
				user: {
					id: "oauth-user-123",
					email: "oauth@example.com",
					name: "OAuth Account",
				},
				token: {
					token: "original_oauth_token",
					expiresAt: Date.now() + 3600000,
				},
				refreshToken: "original_oauth_refresh_token",
			};
			successfulNativeOAuthHandler.completeOAuthFlow.mockResolvedValue(mockAuthResponse);

			await provider.loginWithOAuth2("casdoor");
			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getToken()).toBe("original_oauth_token");

			// A second OAuth attempt (e.g. re-triggered for some other reason)
			// fails — the original session must survive it.
			const failingNativeOAuthHandler = {
				completeOAuthFlow: jest.fn(),
				destroy: jest.fn(),
			};
			MockNativeOAuthHandler.mockImplementation(() => failingNativeOAuthHandler as any);
			failingNativeOAuthHandler.completeOAuthFlow.mockRejectedValue(
				new Error("OAuth flow failed"),
			);

			await expect(provider.loginWithOAuth2("casdoor")).rejects.toThrow(
				"OAuth flow failed",
			);

			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getCurrentUser()?.email).toBe("oauth@example.com");
			expect(provider.getToken()).toBe("original_oauth_token");
		});

		test("Opens browser with window.open", async () => {
			const mockNativeOAuthHandler = {
				completeOAuthFlow: jest.fn(),
				destroy: jest.fn(),
			};

			MockNativeOAuthHandler.mockImplementation(() => mockNativeOAuthHandler as any);

			const mockAuthResponse: AuthResponse = {
				user: {
					id: "user-123",
					email: "test@example.com",
				},
				token: {
					token: "token",
					expiresAt: Date.now() + 3600000,
				},
			};

			mockNativeOAuthHandler.completeOAuthFlow.mockImplementation(
				async (provider, openBrowser) => {
					openBrowser("https://auth.example.com/authorize");
					return mockAuthResponse;
				},
			);

			await provider.loginWithOAuth2("casdoor");

			expect(window.open).toHaveBeenCalledWith(
				"https://auth.example.com/authorize",
				"_blank",
			);
		});
	});

	describe("refreshToken()", () => {
		test("P20: Refresh with refresh_token", async () => {
			// Set up initial auth with refresh token
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "old_token",
					expiresAt: Date.now() + 3600000,
					refreshToken: "refresh_token_xyz",
				}),
			);

			// Recreate provider to load from storage
			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			const refreshData = {
				access_token: "new_access_token",
				refresh_token: "new_refresh_token",
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, refreshData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			const result = await provider.refreshToken();

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/v1/auth/refresh`,
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						refresh_token: "refresh_token_xyz",
					}),
				}),
			);

			expect(result.token.token).toBe("new_access_token");
			expect(provider.isLoggedIn()).toBe(true);
		});

		test("P21: Refresh without refresh_token (legacy)", async () => {
			// Set up initial auth WITHOUT refresh token
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "current_token",
					expiresAt: Date.now() + 3600000,
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			const userData = {
				id: "user-123",
				email: "test@example.com",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch.mockResolvedValue(await mockFetchResponse(200, userData));

			const result = await provider.refreshToken();

			// Should call /auth/me to verify token
			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/v1/auth/me`,
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						Authorization: "Bearer current_token",
					}),
				}),
			);

			expect(result.user.email).toBe("test@example.com");
			expect(provider.isLoggedIn()).toBe(true);
		});

		test("P22: Error clears auth", async () => {
			// Set up initial auth
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
					refreshToken: "refresh_token",
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			mockFetch.mockResolvedValue(
				await mockFetchResponse(401, { error: "Invalid refresh token" }, false),
			);

			await expect(provider.refreshToken()).rejects.toThrow("Token refresh failed");

			expect(provider.isLoggedIn()).toBe(false);
			expect(provider.getCurrentUser()).toBeUndefined();
		});

		test("calls onSessionExpired when the refresh token is rejected (401/403)", async () => {
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
					refreshToken: "refresh_token",
				}),
			);

			const onSessionExpired = jest.fn();
			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
				onSessionExpired,
			});
			await provider.waitForRestore();

			mockFetch.mockResolvedValue(
				await mockFetchResponse(401, { error: "Invalid refresh token" }, false),
			);

			await expect(provider.refreshToken()).rejects.toThrow("Token refresh failed");

			expect(onSessionExpired).toHaveBeenCalledTimes(1);
		});

		test("does NOT call onSessionExpired on a network/server error (auth stays valid for retry)", async () => {
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
					refreshToken: "refresh_token",
				}),
			);

			const onSessionExpired = jest.fn();
			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
				onSessionExpired,
			});
			await provider.waitForRestore();

			mockFetch.mockResolvedValue(
				await mockFetchResponse(500, { error: "Internal server error" }, false),
			);

			await expect(provider.refreshToken()).rejects.toThrow();

			expect(onSessionExpired).not.toHaveBeenCalled();
			// Auth kept for retry — the whole point of the network/server-error branch.
			expect(provider.getCurrentUser()).toBeDefined();
		});

		test.each([[200, 1], [500, 0]])("a refresh answered %i calls onTokenRefreshed %i time(s), so refused shares are retried", async (status, calls) => {
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
					refreshToken: "refresh_token",
				}),
			);

			const onTokenRefreshed = jest.fn();
			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
				onTokenRefreshed,
			});
			await provider.waitForRestore();

			mockFetch.mockResolvedValueOnce(await mockFetchResponse(status, { access_token: "new", refresh_token: "r2", expires_in: 3600 }, status === 200));
			if (status === 200) mockFetch.mockResolvedValueOnce(await mockFetchResponse(200, { id: "user-123", email: "test@example.com" }));

			await provider.refreshToken().catch(() => undefined);

			expect(onTokenRefreshed).toHaveBeenCalledTimes(calls);
		});

		test("Throws if no active session", async () => {
			await expect(provider.refreshToken()).rejects.toThrow(
				"No active session to refresh",
			);
		});
	});

	describe("restoreAuth()", () => {
		test("P23: Restore with valid token", async () => {
			const expiresAt = Date.now() + 3600000;
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "restored@example.com" },
					token: "stored_token",
					expiresAt,
					refreshToken: "refresh_token",
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getCurrentUser()?.email).toBe("restored@example.com");
			expect(provider.getToken()).toBe("stored_token");
		});

		test("P24: Restore with expired token + refresh", async () => {
			const expiredAt = Date.now() - 1000; // Expired 1 second ago
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "expired_token",
					expiresAt: expiredAt,
					refreshToken: "refresh_token_xyz",
				}),
			);

			const refreshData = {
				access_token: "new_token",
				refresh_token: "new_refresh",
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, refreshData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getToken()).toBe("new_token");
		});

		test("P25: Restore with expired + no refresh clears", async () => {
			const expiredAt = Date.now() - 1000;
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "expired_token",
					expiresAt: expiredAt,
					// No refreshToken
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isLoggedIn()).toBe(false);
			expect(provider.getCurrentUser()).toBeUndefined();
		});

		test("P26: Restore with corrupted data", async () => {
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				"invalid json{",
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isLoggedIn()).toBe(false);
		});
	});

	describe("isTokenValid()", () => {
		test("P27: 5-minute buffer", async () => {
			const now = Date.now();

			// Token expires in 4 minutes (less than 5-minute buffer)
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: now + 4 * 60 * 1000,
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isTokenValid()).toBe(false);

			// Token expires in 6 minutes (more than 5-minute buffer)
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: now + 6 * 60 * 1000,
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isTokenValid()).toBe(true);
		});

		test("Returns false if no token", () => {
			expect(provider.isTokenValid()).toBe(false);
		});
	});

	describe("logout()", () => {
		test("P28: Success", async () => {
			// Set up logged in state
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			mockFetch.mockResolvedValue(await mockFetchResponse(200, {}));

			await provider.logout();

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/v1/auth/logout`,
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						Authorization: "Bearer token",
					}),
				}),
			);

			expect(provider.isLoggedIn()).toBe(false);
			expect(provider.getCurrentUser()).toBeUndefined();
			expect(provider.getToken()).toBeUndefined();
		});

		test("P29: Network error still clears local state", async () => {
			mockStorage.set(
				`evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			mockFetch.mockRejectedValue(new Error("Network error"));

			await expect(provider.logout()).resolves.toBeUndefined();

			expect(provider.isLoggedIn()).toBe(false);
		});
	});

	describe("persistAuth()", () => {
		test("P30: Saves correctly", async () => {
			const loginData = {
				access_token: "test_token",
				token_type: "bearer" as const,
				refresh_token: "refresh",
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				name: "Test Account",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, loginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			await provider.loginWithPassword("test@example.com", "password");

			const storageKey = `evc-team-relay_onprem_auth_${APP_ID}_${SERVER_ID}`;
			const stored = mockStorage.get(storageKey);
			expect(stored).toBeDefined();

			const parsed = JSON.parse(stored!);
			expect(parsed.user.id).toBe("user-123");
			expect(parsed.user.email).toBe("test@example.com");
			expect(parsed.user.name).toBe("Test Account");
			expect(parsed.token).toBe("test_token");
			expect(parsed.refreshToken).toBe("refresh");
			expect(parsed.expiresAt).toBeGreaterThan(Date.now());
		});
	});

	describe("URL normalization", () => {
		test("Handles trailing slashes in control plane URL", async () => {
			const providerWithSlash = new RelayOnPremAuthProvider({
				controlPlaneUrl: "https://cp.example.com/",
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await providerWithSlash.waitForRestore();

			const loginData = {
				access_token: "token",
				token_type: "bearer" as const,
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, loginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			await providerWithSlash.loginWithPassword("test@example.com", "password");

			expect(mockFetch).toHaveBeenCalledWith(
				"https://cp.example.com/v1/auth/login",
				expect.anything(),
			);
		});
	});
});
