import { platformFetch } from "../platformFetch";
import { OAuthCancelledError } from "./OAuthCancelledError";
import type { AuthResponse } from "./IAuthProvider";

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Browser-based OIDC handoff, using only APIs available on desktop and mobile. */
export class NativeOAuthHandler {
	private controller = new AbortController();

	constructor(private controlPlaneUrl: string) {}

	async completeOAuthFlow(provider: string, openBrowser: (url: string) => void, signal?: AbortSignal): Promise<AuthResponse> {
		const cancelled = () => this.controller.abort();
		signal?.addEventListener("abort", cancelled, { once: true });
		if (signal?.aborted) this.controller.abort();
		const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
		const base = this.controlPlaneUrl.replace(/\/+$/, "") + "/v1/auth/native";
		let id: string | undefined;
		let completed = false;
		const checkCancelled = () => {
			if (this.controller.signal.aborted) throw new OAuthCancelledError();
		};
		try {
			checkCancelled();
			const response = await platformFetch(base + "/start", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider, challenge }), signal: this.controller.signal,
			});
			if (!response.ok) throw new Error(`SSO could not start (${response.status}). This requires the fork's server and plugin.`);
			const flow = await response.json() as { id: string; authorize_url: string; expires_in: number; interval: number };
			id = flow.id;
			checkCancelled();
			const url = new URL(flow.authorize_url);
			if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
				throw new Error("SSO requires a secure browser URL");
			}
			openBrowser(flow.authorize_url);
			const deadline = Date.now() + Math.min(flow.expires_in, 300) * 1000;
			const interval = Math.max(2, Math.min(flow.interval, 10)) * 1000;
			while (Date.now() < deadline) {
				checkCancelled();
				let result: Response;
				try {
					result = await platformFetch(base + "/complete", {
						method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id, verifier }), signal: this.controller.signal,
					});
				} catch {
					checkCancelled();
					// A mobile OS may suspend networking while its browser is in
					// front. Resume polling on return, within the original deadline.
					await this.delay(interval);
					continue;
				}
				if (result.status === 202 || result.status === 429 || result.status >= 500) {
					await this.delay(interval);
					continue;
				}
				if (!result.ok) throw new Error(`SSO failed or expired (${result.status}). Please try signing in again.`);
				const data = await result.json() as {
					user_id: string; user_email: string; user_name?: string;
					access_token: string; refresh_token: string; expires_in: number;
				};
				checkCancelled();
				completed = true;
				return {
					user: { id: data.user_id, email: data.user_email, name: data.user_name ?? data.user_email },
					token: { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 },
					refreshToken: data.refresh_token,
				};
			}
			throw new Error("SSO timed out. Return to Obsidian after signing in and try again.");
		} catch (error) {
			checkCancelled();
			throw error;
		} finally {
			signal?.removeEventListener("abort", cancelled);
			if (id && !completed) {
				// Separate signal: cancellation of polling must still cancel the handoff.
				void platformFetch(base + "/cancel", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id, verifier }),
				}).catch(() => undefined);
			}
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const abort = () => { clearTimeout(timer); reject(new OAuthCancelledError()); };
			const timer = setTimeout(() => {
				this.controller.signal.removeEventListener("abort", abort);
				resolve();
			}, ms);
			this.controller.signal.addEventListener("abort", abort, { once: true });
			if (this.controller.signal.aborted) abort();
		});
	}

	destroy(): void { this.controller.abort(); }
}
