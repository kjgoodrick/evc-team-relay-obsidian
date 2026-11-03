/**
 * Relay On-Premise Authentication Provider
 *
 * This provider implements authentication against the relay-onprem control plane.
 * It replaces PocketBase authentication with custom JWT-based authentication.
 * Supports multiple servers with independent authentication state.
 */

import { platformFetch } from "../platformFetch";
import { namedLogger } from "../logging";
import type { IAuthProvider, AuthUser, AuthResponse } from "./IAuthProvider";
import { getAuthStore, type RelayOnPremAuthStore } from "./RelayOnPremAuthStore";

interface LoginRequest {
	email: string;
	password: string;
}

interface LoginResponse {
	access_token: string;
	token_type: "bearer";
	refresh_token?: string;
	expires_in?: number;
}

interface RefreshTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

interface MeResponse {
	id: string;
	email: string;
	name?: string;
	is_admin: boolean;
	created_at: string;
}

export interface RelayOnPremAuthConfig {
	controlPlaneUrl: string;
	appId: string;
	serverId: string;
	/**
	 * called when a background token refresh discovers the refresh
	 * token itself was rejected (401/403) — the session is truly dead, not
	 * just momentarily network-flaky. This provider only owns its own
	 * internal auth state; it has no visibility into AuthSession's
	 * separate `user` field or its listeners, so the owner (AuthSession,
	 * via MultiServerAuthManager) must be told explicitly to reset and
	 * surface a re-login prompt instead of silently going stale.
	 */
	onSessionExpired?: () => void;
	/** Called after a background refresh renewed this server's session. */
	onTokenRefreshed?: () => void;
}

export class RelayOnPremAuthProvider implements IAuthProvider {
	private log = namedLogger("[RelayOnPremAuth]");
	private user?: AuthUser;
	private token?: string;
	private tokenExpiresAt: number = 0;
	private storedRefreshToken?: string;
	private authStore: RelayOnPremAuthStore;
	private serverId: string;
	private restorePromise?: Promise<void>;
	private normalizedUrl: string;
	private refreshInProgress?: Promise<void>;
	private _restored = false;

	constructor(private config: RelayOnPremAuthConfig) {
		this.serverId = config.serverId;
		// Normalize URL - remove trailing slashes to prevent double-slash issues
		this.normalizedUrl = config.controlPlaneUrl.replace(/\/+$/, "");
		// Use singleton AuthStore to prevent race conditions
		this.authStore = getAuthStore(config.appId);
		// Try to restore auth from local storage on init
		// Store promise so callers can await if needed
		this.restorePromise = this.restoreAuth();
	}

	/**
	 * Wait for auth restoration to complete.
	 * Useful for callers that need to ensure auth state is loaded before checking.
	 */
	async waitForRestore(): Promise<void> {
		if (this.restorePromise) {
			await this.restorePromise;
		}
	}

	/**
	 * Get the server ID this provider is associated with
	 */
	getServerId(): string {
		return this.serverId;
	}

	/**
	 * Get the normalized control-plane URL this provider is configured for.
	 */
	getControlPlaneUrl(): string {
		return this.normalizedUrl;
	}

	/**
	 * Restore authentication from local storage if available.
	 * If the token is expired but we have a refresh token, attempt to refresh.
	 * IMPORTANT: Never clear auth on refresh failure — keep refresh token for retry.
	 */
	private async restoreAuth(): Promise<void> {
		try {
			this.log(`restoreAuth: serverId=${this.serverId}, appId=${this.config.appId}`);

			const authData = this.authStore.load(this.serverId);
			this.log(`restoreAuth: authData exists=${!!authData}`);

			if (!authData) {
				this.log(`restoreAuth: no stored auth data found`);
				return;
			}

			this.log(`restoreAuth: user=${authData.user?.email}, expiresAt=${authData.expiresAt}, now=${Date.now()}, hasRefreshToken=${!!authData.refreshToken}`);

			this.user = authData.user;
			this.token = authData.token;
			this.tokenExpiresAt = authData.expiresAt;
			this.storedRefreshToken = authData.refreshToken;

			// Check if token is still valid
			if (this.isTokenValid()) {
				this.log(`restoreAuth: token is valid, restored auth for ${this.user?.email} on server ${this.serverId}`);
				return;
			}

			this.log(`restoreAuth: token expired for server ${this.serverId}`);

			// Token expired - try to refresh if we have a refresh token
			if (this.storedRefreshToken) {
				this.log(`restoreAuth: attempting token refresh...`);
				try {
					await this.refreshToken();
					this.log(`restoreAuth: token refresh successful for ${this.user?.email}`);
					return;
				} catch (e: unknown) {
					this.log(`restoreAuth: token refresh failed: ${e instanceof Error ? e.message : String(e)}`);
					// Keep user and refresh token — will retry on next getToken() call.
					// Do NOT clear auth here. The user is still "logged in" with a
					// valid refresh token, just the access token needs refreshing.
					this.log(`restoreAuth: keeping auth state for later refresh retry`);
				}
			} else {
				// No refresh token at all — truly expired session, clear auth
				this.log(`restoreAuth: no refresh token, clearing auth`);
				this.authStore.evict(this.serverId);
				this.user = undefined;
				this.token = undefined;
				this.tokenExpiresAt = 0;
			}
		} finally {
			this._restored = true;
		}
	}

	/**
	 * Persist current authentication to local storage
	 */
	private persistAuth(): void {
		if (this.user && this.token && this.tokenExpiresAt) {
			this.authStore.persist(this.serverId, {
				user: this.user,
				token: this.token,
				expiresAt: this.tokenExpiresAt,
				refreshToken: this.storedRefreshToken,
			});
		}
	}

	isLoggedIn(): boolean {
		// Account is "logged in" if we have user info AND either a valid token
		// or a refresh token we can use to get a new access token.
		return !!this.user && (this.isTokenValid() || !!this.storedRefreshToken);
	}

	/**
	 * Whether the auth restore from local storage has completed.
	 */
	get restored(): boolean {
		return this._restored;
	}

	getCurrentUser(): AuthUser | undefined {
		return this.user;
	}

	getToken(): string | undefined {
		// If token expired but we have refresh token, trigger async refresh.
		// Return the expired token for now — the caller should handle 401 gracefully.
		if (this.token && !this.isTokenValid() && this.storedRefreshToken && !this.refreshInProgress) {
			this.log("getToken: access token expired, triggering background refresh");
			void this.ensureTokenRefreshed();
		}
		return this.token;
	}

	/**
	 * Get a valid token, refreshing if needed. Awaitable version of getToken().
	 */
	async getValidToken(): Promise<string | undefined> {
		if (this.token && this.isTokenValid()) {
			return this.token;
		}
		if (this.storedRefreshToken) {
			try {
				await this.ensureTokenRefreshed();
				return this.token;
			} catch {
				return this.token; // Return expired token as fallback
			}
		}
		return this.token;
	}

	/**
	 * Ensure token is refreshed. Deduplicates concurrent refresh calls.
	 * Retries up to 3 times with backoff for transient network failures.
	 */
	private async ensureTokenRefreshed(): Promise<void> {
		if (!this.refreshInProgress) {
			this.refreshInProgress = this.refreshTokenWithRetry()
				.finally(() => { this.refreshInProgress = undefined; });
		}
		try {
			await this.refreshInProgress;
		} catch {
			// Refresh failed but don't propagate — caller handles stale token
		}
	}

	private async refreshTokenWithRetry(): Promise<void> {
		const delays = [0, 1000, 3000]; // immediate, 1s, 3s
		for (let attempt = 0; attempt < delays.length; attempt++) {
			if (attempt > 0) {
				this.log(`Token refresh retry ${attempt}/${delays.length - 1} after ${delays[attempt]}ms`);
				await new Promise(r => window.setTimeout(r, delays[attempt]));
			}
			try {
				await this.refreshToken();
				return;
			} catch (error: unknown) {
				const statusCode = (error as { statusCode?: number })?.statusCode;
				// Don't retry auth errors (401/403) — token is truly invalid
				if (statusCode === 401 || statusCode === 403) {
					throw error;
				}
				if (attempt === delays.length - 1) {
					throw error;
				}
				this.log(`Token refresh attempt ${attempt + 1} failed:`, error);
			}
		}
	}

	/**
	 * Decode JWT token to get expiration time
	 */
	private decodeToken(token: string): { exp?: number; sub?: string } {
		try {
			const [, payload] = token.split(".");
			const decoded = JSON.parse(atob(payload)) as { exp?: number; sub?: string };
			return decoded;
		} catch (error: unknown) {
			this.log("Failed to decode token:", error);
			return {};
		}
	}

	async loginWithPassword(email: string, password: string): Promise<AuthResponse> {
		this.log(`Logging in as ${email} to server ${this.serverId}`);

		// Snapshot the full pre-existing session state BEFORE attempting this
		// login — not just whether one exists. A failed re-login (e.g. a
		// typo'd password re-entered while already logged in, for whatever
		// reason) must not clear a session that was working fine. A boolean
		// alone isn't enough: step 1 below mutates this.token/
		// storedRefreshToken/tokenExpiresAt as soon as the login call
		// succeeds, BEFORE step 2 (fetching user info) can still fail — so
		// on that partial-failure path the catch must restore the exact
		// prior values, not just skip clearing, or the old user identity
		// ends up paired with a new (different-identity) token (//).
		const hadValidSession = this.isLoggedIn();
		const previousUser = this.user;
		const previousToken = this.token;
		const previousTokenExpiresAt = this.tokenExpiresAt;
		const previousRefreshToken = this.storedRefreshToken;

		const loginRequest: LoginRequest = {
			email,
			password,
		};

		try {
			// Step 1: Login and get access token
			const loginResponse = await platformFetch(`${this.normalizedUrl}/v1/auth/login`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(loginRequest),
			});

			if (!loginResponse.ok) {
				const errorText = await loginResponse.text();
				throw new Error(`Login failed: ${loginResponse.status} - ${errorText}`);
			}

			const loginData = await loginResponse.json() as LoginResponse;
			this.token = loginData.access_token;
			this.storedRefreshToken = loginData.refresh_token;

			// Decode token to get expiration, or use expires_in from response
			const tokenPayload = this.decodeToken(this.token);
			if (tokenPayload.exp) {
				this.tokenExpiresAt = tokenPayload.exp * 1000; // Convert to milliseconds
			} else if (loginData.expires_in) {
				this.tokenExpiresAt = Date.now() + loginData.expires_in * 1000;
			} else {
				// Default to 1 hour
				this.tokenExpiresAt = Date.now() + 3600 * 1000;
			}

			// Step 2: Get user information
			const meResponse = await platformFetch(`${this.normalizedUrl}/v1/auth/me`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.token}`,
				},
			});

			if (!meResponse.ok) {
				throw new Error(`Failed to fetch user info: ${meResponse.status}`);
			}

			const userData = await meResponse.json() as MeResponse;

			this.user = {
				id: userData.id,
				email: userData.email,
				name: userData.name || userData.email,
			};

			// Persist auth to local storage
			this.persistAuth();

			this.log(`Successfully logged in as ${this.user.email} to server ${this.serverId}`);

			return {
				user: this.user,
				token: {
					token: this.token,
					expiresAt: this.tokenExpiresAt,
				},
			};
		} catch (error: unknown) {
			this.log("Login error:", error);
			if (hadValidSession) {
				// Restore exactly what was there before this attempt — step 1
				// may have already mutated token/refreshToken/expiry.
				this.user = previousUser;
				this.token = previousToken;
				this.tokenExpiresAt = previousTokenExpiresAt;
				this.storedRefreshToken = previousRefreshToken;
			} else {
				this.user = undefined;
				this.token = undefined;
				this.tokenExpiresAt = 0;
				this.authStore.evict(this.serverId);
			}
			throw error;
		}
	}

	async loginWithOAuth2(provider: string, signal?: AbortSignal): Promise<AuthResponse> {
		// Same reasoning as loginWithPassword above: don't clear a
		// pre-existing valid session just because a re-authentication
		// attempt (e.g. re-triggering OAuth for some other reason, or the
		// user cancelling/failing the browser flow) didn't succeed. Snapshot
		// BEFORE the dynamic import/await below yields a turn of the event
		// loop — a concurrent background token refresh or a second login
		// call could otherwise mutate state between snapshot and use.
		const hadValidSession = this.isLoggedIn();
		const previousUser = this.user;
		const previousToken = this.token;
		const previousTokenExpiresAt = this.tokenExpiresAt;
		const previousRefreshToken = this.storedRefreshToken;

		// Import dynamically to avoid circular dependencies
		const { NativeOAuthHandler } = await import("./NativeOAuthHandler");

		this.log(`Starting OAuth2 login with provider: ${provider}`);

		const oauthHandler = new NativeOAuthHandler(this.normalizedUrl);

		try {
			// Prepare OAuth flow and open browser
			const authResponse = await oauthHandler.completeOAuthFlow(provider, (url: string) => {
				// Use window.open to open browser
				if (typeof window !== "undefined" && window.open) {
					window.open(url, "_blank");
				} else {
					throw new Error("Cannot open browser - window.open not available");
				}
			}, signal);

			// Store auth data
			this.user = authResponse.user;
			this.token = authResponse.token.token;
			this.tokenExpiresAt = authResponse.token.expiresAt;
			this.storedRefreshToken = authResponse.refreshToken;

			// Persist auth
			this.persistAuth();

			this.log(`OAuth2 login successful for ${this.user.email}`);

			return authResponse;
		} catch (error: unknown) {
			this.log("OAuth2 login error:", error);
			if (hadValidSession) {
				this.user = previousUser;
				this.token = previousToken;
				this.tokenExpiresAt = previousTokenExpiresAt;
				this.storedRefreshToken = previousRefreshToken;
			} else {
				this.user = undefined;
				this.token = undefined;
				this.tokenExpiresAt = 0;
				this.storedRefreshToken = undefined;
				this.authStore.evict(this.serverId);
			}
			throw error;
		} finally {
			oauthHandler.destroy();
		}
	}

	async refreshToken(): Promise<AuthResponse> {
		if (!this.token || !this.user) {
			throw new Error("No active session to refresh");
		}

		this.log(`Refreshing token for server ${this.serverId}...`);

		try {
			// If we have a refresh token, use the refresh endpoint
			if (this.storedRefreshToken) {
				this.log("Using refresh token to get new access token");

				const refreshResponse = await platformFetch(
					`${this.normalizedUrl}/v1/auth/refresh`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							refresh_token: this.storedRefreshToken,
						}),
					},
				);

				if (!refreshResponse.ok) {
					const err = new Error(`Token refresh failed: ${refreshResponse.status}`) as Error & { statusCode?: number };
					err.statusCode = refreshResponse.status;
					throw err;
				}

				const refreshData = await refreshResponse.json() as RefreshTokenResponse;

				// Update tokens
				this.token = refreshData.access_token;
				this.storedRefreshToken = refreshData.refresh_token;
				this.tokenExpiresAt = Date.now() + refreshData.expires_in * 1000;

				// Fetch updated user info
				const meResponse = await platformFetch(`${this.normalizedUrl}/v1/auth/me`, {
					method: "GET",
					headers: {
						Authorization: `Bearer ${this.token}`,
					},
				});

				if (meResponse.ok) {
					const userData = await meResponse.json() as MeResponse;
					this.user = {
						id: userData.id,
						email: userData.email,
						name: userData.name || userData.email,
					};
				}

				// Persist refreshed auth
				this.persistAuth();

				this.log("Token refreshed successfully with refresh token");
				this.config.onTokenRefreshed?.();

				return {
					user: this.user,
					token: {
						token: this.token,
						expiresAt: this.tokenExpiresAt,
					},
				};
			} else {
				// Legacy mode: just verify the current token is still valid
				this.log("No refresh token available, verifying current token");

				const meResponse = await platformFetch(`${this.normalizedUrl}/v1/auth/me`, {
					method: "GET",
					headers: {
						Authorization: `Bearer ${this.token}`,
					},
				});

				if (!meResponse.ok) {
					throw new Error(`Token verification failed: ${meResponse.status}`);
				}

				const userData = await meResponse.json() as MeResponse;

				this.user = {
					id: userData.id,
					email: userData.email,
					name: userData.name || userData.email,
				};

				// Persist refreshed auth
				this.persistAuth();

				this.log("Token verified successfully");
				this.config.onTokenRefreshed?.();

				return {
					user: this.user,
					token: {
						token: this.token,
						expiresAt: this.tokenExpiresAt,
					},
				};
			}
		} catch (error: unknown) {
			this.log("Token refresh error:", error);
			// Only clear auth if the refresh token itself is invalid (401/403).
			// For network errors or server issues, keep auth for retry.
			const statusCode = (error as { statusCode?: number })?.statusCode;
			const isAuthError = statusCode === 401 || statusCode === 403;
			if (isAuthError) {
				this.log("Refresh token rejected by server, clearing auth");
				this.user = undefined;
				this.token = undefined;
				this.tokenExpiresAt = 0;
				this.storedRefreshToken = undefined;
				this.authStore.evict(this.serverId);
				// this class's own state is now cleared, but the owner
				// (AuthSession) has a separate `user` field that only this
				// callback can reach — without it, AuthSession keeps reporting
				// loggedIn=true forever while every request silently 401s.
				this.config.onSessionExpired?.();
			} else {
				this.log("Refresh failed (network/server error), keeping auth for retry");
			}
			throw error;
		}
	}

	async logout(): Promise<void> {
		this.log(`Logging out from server ${this.serverId}...`);

		if (this.token) {
			try {
				// Call logout endpoint
				await platformFetch(`${this.normalizedUrl}/v1/auth/logout`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.token}`,
					},
				});
			} catch (error: unknown) {
				this.log("Logout error:", error);
				// Continue with local logout even if remote logout fails
			}
		}

		this.user = undefined;
		this.token = undefined;
		this.tokenExpiresAt = 0;
		this.storedRefreshToken = undefined;
		this.authStore.evict(this.serverId);

		this.log("Logged out successfully");
	}

	isTokenValid(): boolean {
		if (!this.token) {
			return false;
		}

		const now = Date.now();
		// Add 5-minute buffer before expiration
		const buffer = 5 * 60 * 1000;
		return now < this.tokenExpiresAt - buffer;
	}
}
