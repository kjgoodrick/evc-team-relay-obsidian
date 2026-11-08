/**
 * Relay On-Premise Token Provider
 *
 * This provider fetches relay access tokens from the relay-onprem control plane.
 * It replaces the cloud-backend /token endpoint with relay-onprem /tokens/relay endpoint.
 */

import { platformFetch } from "../platformFetch";
import { decodeJwt } from "jose";
import { restoreMetadata, restoreContext, restoreGeneration, type RestoreBinding } from "../collaboration/RestoreGeneration";
import { namedLogger } from "../logging";
import type { DocumentGrant, FileGrant } from "../relay/TokenShapes";
import type { IAuthProvider } from "./IAuthProvider";
import { recordTokenWait, tokenRequestClass, type TokenRequestClass } from "./tokenRequestClass";

export interface RelayTokenRequest {
	share_id: string;
	doc_id: string;
	mode: "read" | "write";
	password?: string;
	file_path?: string; // For folder shares: path of file within folder
	client_version?: string; // Plugin manifest version — see RelayOnPremTokenConfig.clientVersion
}

export interface RelayTokenResponse {
	relay_url: string;
	token: string;
	expires_at: string;
	/** Lifetime in seconds; not sent by the current control-plane. */
	expires_in?: number;
	restore_guard?: boolean;
	restore_generation?: string | null;
}

export interface FileTokenRequest {
	path: string;
	sha256: string;
	content_type: string;
	content_length: number;
	read_only?: true;
}

export interface FileTokenApiResponse {
	token: string;
	base_url: string;
	expires_at: string;
	/** Lifetime in seconds; not sent by the current control-plane. */
	expires_in?: number;
	restore_guard?: boolean;
	restore_generation?: string | null;
	read_only?: boolean;
}

export interface RelayOnPremTokenConfig {
	controlPlaneUrl: string;
	authProvider: IAuthProvider;
	/**
	 * Plugin manifest version (this.manifest.version), sent to the control-plane
	 * with every token request so it can attribute a given auth outcome to a
	 * specific release. User-Agent alone can't do this — it carries the
	 * Obsidian/Electron app version, not the plugin's ( recurrence
	 * diagnosis, 2026-09-17). Optional so callers that don't have a manifest
	 * handy (e.g. tests) still compile.
	 */
	clientVersion?: string;
}

/**
 * Error thrown when the server returns HTTP 429 Too Many Requests.
 * Carries the recommended retry-after delay in milliseconds.
 */
export class RateLimitError extends Error {
	constructor(
		public readonly retryAfterMs: number,
		message?: string,
	) {
		super(message ?? `Rate limited — retry after ${retryAfterMs}ms`);
		this.name = "RateLimitError";
	}
}

/** Steady token-request rate per control plane. */
export const TOKEN_REQUESTS_PER_MINUTE = 120;
/** Requests that may go out back-to-back after a quiet spell. */
export const TOKEN_REQUEST_BURST = 10;
/** Rate after the control plane answered 429: the old 30/min server limit, with margin. */
export const TOKEN_REQUESTS_PER_MINUTE_LIMITED = 25;
/** How long the slower rate holds after a 429 (at least the Retry-After). */
export const TOKEN_RATE_LIMITED_HOLD_MS = 10 * 60_000;
/** A 429 soon after a hold ended doubles the next hold, up to this. */
export const TOKEN_RATE_LIMITED_MAX_HOLD_MS = 60 * 60_000;

/**
 * The control plane refused the token outright: 401, or 403 even for read.
 * Retrying soon gives the same answer, so callers back off (see
 * accessDeniedBackoff.ts). `retryAt` is set by RelayCredentialCache once the
 * refusal is recorded.
 */
export class RelayAccessDeniedError extends Error {
	retryAt?: number;

	constructor(
		public readonly status: number,
		message?: string,
	) {
		super(message ?? `Relay token refused: ${status}`);
		this.name = "RelayAccessDeniedError";
	}
}

/** Old document work requires review; logging in or retrying cannot rebind it. */
export class RelayRestoreRequiredError extends Error {
	constructor() {
		super("This share was restored. Document synchronization is paused; local edits and cached content are retained for restore review.");
		this.name = "RelayRestoreRequiredError";
	}
}

/** How long POST /v1/tokens/relay may take on the network before it counts as failed. */
export const RELAY_TOKEN_TIMEOUT_MS = 30_000;

/**
 * POST /v1/tokens/relay did not answer within RELAY_TOKEN_TIMEOUT_MS.
 * requestUrl cannot be cancelled, so the request may still be in flight and
 * may still reach the control plane; callers keep the share off the network
 * for a while instead of asking again at once.
 */
export class RelayTokenTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RelayTokenTimeoutError";
	}
}

/**
 * Token bucket in front of POST /v1/tokens/relay: up to `burst` requests at
 * once, then `perMinute`, served FIFO, except that background requests (see
 * tokenRequestClass.ts) go after every other waiting request.
 *
 * The control plane allows 300 req/min per user and share. This used to be
 * a fixed 25/min queue sized for the old 30/min limit, and under a bulk sync
 * it became the bottleneck: measured on a two-client stand, both clients sat
 * at the ceiling and each new connection queued ~47s for its token. A server
 * that still has the old limit answers 429; `slowDown()` then drops to the
 * old rate for a while, longer each time the server keeps answering 429.
 */
export class TokenRequestThrottle {
	private tokens: number;
	private refilledAt = Date.now();
	private limitedUntil = 0;
	private holdMs = TOKEN_RATE_LIMITED_HOLD_MS;
	private destroyed = false;
	private queue: Array<{ cls: TokenRequestClass; queuedAt: number; resolve: () => void }> = [];
	private timer: number | null = null;
	private log = namedLogger("[TokenRequestThrottle]", "debug");

	constructor(
		private readonly perMinute = TOKEN_REQUESTS_PER_MINUTE,
		private readonly burst = TOKEN_REQUEST_BURST,
	) {
		this.tokens = burst;
	}

	/**
	 * Resolves when it is this caller's turn to make a network request. The
	 * class of `docId` is taken here and kept: a background pull that gave up
	 * leaves its request queued, and it must not jump ahead of newer edits
	 * once the hold is gone. (An open that joins such a request in flight
	 * keeps its place too, behind the ordinary requests only.)
	 */
	acquire(docId?: string): Promise<void> {
		if (this.destroyed) return Promise.resolve();
		return new Promise((resolve) => {
			this.queue.push({ cls: tokenRequestClass(docId), queuedAt: Date.now(), resolve });
			if (this.timer === null) this.dispatch();
		});
	}

	/**
	 * The server answered 429: hold the old rate, with no burst, for at least
	 * `minHoldMs`. A 429 within one hold of the previous hold ending means the
	 * server really has the old limit, so the hold doubles (up to an hour).
	 */
	slowDown(minHoldMs = TOKEN_RATE_LIMITED_HOLD_MS): void {
		this.refill();
		const now = Date.now();
		if (now >= this.limitedUntil) {
			const sinceHold = now - this.limitedUntil;
			this.holdMs =
				this.limitedUntil > 0 && sinceHold < this.holdMs
					? Math.min(this.holdMs * 2, TOKEN_RATE_LIMITED_MAX_HOLD_MS)
					: TOKEN_RATE_LIMITED_HOLD_MS;
		}
		this.limitedUntil = Math.max(this.limitedUntil, now + Math.max(minHoldMs, this.holdMs));
		this.tokens = Math.min(this.tokens, 0);
		this.log(`rate limited by the server; ${TOKEN_REQUESTS_PER_MINUTE_LIMITED}/min until ${this.limitedUntil}`);
	}

	private limited(at = Date.now()): boolean {
		return at < this.limitedUntil;
	}

	private intervalMs(at = Date.now()): number {
		return Math.ceil(60_000 / (this.limited(at) ? TOKEN_REQUESTS_PER_MINUTE_LIMITED : this.perMinute));
	}

	/** Credits the time since the last refill, at the rate that applied to each part of it. */
	private refill(): void {
		const now = Date.now();
		// A clock stepped back credits nothing (instead of a huge debt).
		const from = Math.min(this.refilledAt, now);
		const holdEnd = Math.min(Math.max(this.limitedUntil, from), now);
		const limitedSpan = holdEnd - from;
		const freeSpan = now - holdEnd;
		if (limitedSpan > 0) {
			this.tokens = Math.min(1, this.tokens + limitedSpan / Math.ceil(60_000 / TOKEN_REQUESTS_PER_MINUTE_LIMITED));
		}
		if (freeSpan > 0 || !this.limited(now)) {
			const capacity = this.limited(now) ? 1 : this.burst;
			this.tokens = Math.min(capacity, this.tokens + freeSpan / Math.ceil(60_000 / this.perMinute));
		}
		this.refilledAt = now;
	}

	private dispatch(): void {
		this.refill();
		while (this.queue.length > 0 && this.tokens >= 1) {
			this.tokens -= 1;
			const first = this.queue.findIndex((waiter) => waiter.cls === "normal");
			const [next] = this.queue.splice(first === -1 ? 0 : first, 1);
			recordTokenWait(next.cls, Date.now() - next.queuedAt);
			this.log(`dispatching token request (queue remaining: ${this.queue.length})`);
			next.resolve();
		}
		if (this.queue.length === 0) return;
		const delay = Math.max(0, Math.ceil((1 - this.tokens) * this.intervalMs()));
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.dispatch();
		}, delay);
	}

	destroy() {
		this.destroyed = true;
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		// Drain any waiters so they are not leaked
		for (const waiter of this.queue) {
			waiter.resolve();
		}
		this.queue = [];
	}
}

/**
 * Re-anchor a server-issued `expires_at` on the local clock.
 *
 * `expires_at` is an absolute server time, but every consumer
 * (CredentialCache.needsRefresh/tokenIsValid, ProviderBacked) compares it with
 * the client's own Date.now(). A client clock lagging the server by more than
 * the 60s renewal margin kept a dead relay token "live" and dialled the WS
 * handshake with it (401 expired). Keeping only the granted lifetime
 * (expires_at - server Date header) and adding it to the local receive time
 * makes the skew irrelevant. The Date header has whole-second resolution, so
 * one second is shaved off to stay on the safe side. An explicit `expires_in`
 * (seconds) wins over the header when the server sends one. Without either the
 * server's absolute expiry is used, as before.
 */
export function localExpiryTime(
	expiresAt: string,
	serverDate: string | null,
	expiresInSec?: number,
): number {
	if (typeof expiresInSec === "number" && Number.isFinite(expiresInSec) && expiresInSec >= 0) {
		return Date.now() + expiresInSec * 1000 - 1000;
	}
	const serverExpiry = new Date(expiresAt).getTime();
	const serverNow = serverDate ? Date.parse(serverDate) : NaN;
	if (Number.isNaN(serverExpiry) || Number.isNaN(serverNow)) {
		return serverExpiry;
	}
	return Date.now() + (serverExpiry - serverNow) - 1000;
}

export class RelayOnPremTokenProvider {
	private log = namedLogger("[RelayOnPremTokenProvider]");
	private normalizedUrl: string;
	private destroyed = false;
	/** Shared throttle — all token requests for this provider share one queue */
	private throttle: TokenRequestThrottle;
	/**
	 * Shares refused even for read. Their next probe asks for read only, so a
	 * refused share costs one request per backoff window instead of two
	 * (write -> 403 -> read -> 403). Any granted token removes the share, and
	 * the next refresh asks for write again.
	 */
	private refusedShares = new Set<string>();
	/**
	 * Token requests still on the network, by share. A request that timed out
	 * stays here until requestUrl itself settles, so the share's next request
	 * cannot overlap it however long the backoff in front of it is.
	 */
	private sharesOnNetwork = new Map<string, Promise<Response>>();

	/** Forget which shares (or this one share) refused a write token, so the next request asks for write again. */
	clearRefused(folderId?: string): void {
		if (folderId === undefined) {
			this.refusedShares.clear();
		} else {
			this.refusedShares.delete(folderId);
		}
	}

	constructor(private config: RelayOnPremTokenConfig) {
		// Normalize URL - remove trailing slashes to prevent double-slash issues
		this.normalizedUrl = config.controlPlaneUrl.replace(/\/+$/, "");
		this.throttle = new TokenRequestThrottle();
	}

	/**
	 * Repoint this provider at a new control-plane URL — e.g. when the
	 * user edits the default server's URL in settings. The provider is
	 * otherwise long-lived (held by RelayCredentialCache for the plugin's lifetime),
	 * so without this the old URL stays baked into `normalizedUrl` until reload.
	 */
	get controlPlaneEndpoint(): string { return this.normalizedUrl; }

	updateControlPlaneUrl(controlPlaneUrl: string): void {
		const normalized = controlPlaneUrl.replace(/\/+$/, "");
		if (normalized !== this.normalizedUrl) {
			this.fileContext = {}; this.refusedShares.clear(); this.sharesOnNetwork.clear();
		}
		this.config.controlPlaneUrl = controlPlaneUrl;
		this.normalizedUrl = normalized;
	}

	/**
	 * Request a relay token for document access.
	 * Requests go through the shared TokenRequestThrottle and throw
	 * RateLimitError on HTTP 429, which also slows the throttle down.
	 */
	async requestToken(
		relayId: string,
		folderId: string,
		docId: string,
		mode: "read" | "write" = "read",
		filePath?: string,
		binding: RestoreBinding = {},
		checkContext?: () => void,
	): Promise<DocumentGrant> {
		if (this.destroyed) throw new Error("Token provider was destroyed");
		binding = restoreMetadata(binding);
		const identity = this.getFileCredentialContext(), endpoint = this.normalizedUrl;
		const checkIdentity = () => {
			if (this.destroyed || identity !== this.getFileCredentialContext()) throw new Error("Document login or server changed. Retry using the current connection.");
			checkContext?.();
		};
		checkIdentity();
		const token = await this.config.authProvider.getValidToken();
		checkIdentity();

		if (!token) {
			throw new Error("Not authenticated");
		}

		if (mode === "write" && this.refusedShares.has(folderId)) {
			mode = "read";
		}

		this.log(`Requesting relay token for doc ${docId} in folder ${folderId}${filePath ? ` (file: ${filePath})` : ""}`);

		const request: RelayTokenRequest = {
			share_id: folderId, // In relay-onprem, folder maps to share
			doc_id: docId,
			mode,
		};

		// Include file_path for folder shares if provided
		if (filePath) {
			request.file_path = filePath;
		}

		if (this.config.clientVersion) {
			request.client_version = this.config.clientVersion;
		}

		// Wait for our slot in the throttle queue before hitting the network
		await this.throttle.acquire(docId);

		try {
			checkIdentity();
			if (this.sharesOnNetwork.has(folderId)) {
				throw new RelayTokenTimeoutError(
					`Token request for doc ${docId} not sent: an earlier request for share ${folderId} is still in flight`,
				);
			}
			const fetched = platformFetch(
				`${endpoint}/v1/tokens/relay`,
				{
					sensitive: true,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
						...(binding.restoreGeneration ? { "X-Relay-Restore-Generation": binding.restoreGeneration } : {}),
					},
					body: JSON.stringify(request),
				}
			);
			// The share stays off the network until this request itself settles,
			// however long that takes: a timeout below only ends the wait for it.
			this.sharesOnNetwork.set(folderId, fetched);
			const offNetwork = () => {
				if (this.sharesOnNetwork.get(folderId) === fetched) this.sharesOnNetwork.delete(folderId);
			};
			fetched.then(offNetwork, offNetwork);
			// Timed from here, not from the throttle wait above: only the
			// network may stall the request.
			let timer: number | undefined;
			const response = await Promise.race([
				fetched,
				new Promise<never>((_, reject) => {
					timer = window.setTimeout(() => reject(new RelayTokenTimeoutError(
						`Token request for doc ${docId} got no answer in ${RELAY_TOKEN_TIMEOUT_MS / 1000}s`,
					)), RELAY_TOKEN_TIMEOUT_MS);
				}),
			]).finally(() => window.clearTimeout(timer));
			// Settled: clear now, before the read retry below asks again.
			offNetwork();
			checkIdentity();

			if (response.status === 429) {
				// Parse Retry-After header (seconds) if present, default 60 s
				const retryAfterSec = parseInt(response.headers.get("Retry-After") ?? "60", 10);
				const retryAfterMs = (isNaN(retryAfterSec) ? 60 : retryAfterSec) * 1000;
				const errorText = await response.text().catch(() => "");
				checkIdentity();
				console.warn(
					`[DIAG][RelayOnPremTokenProvider] 429 rate limited for doc ${docId}. retryAfter=${retryAfterMs}ms body=${errorText}`
				);
				this.throttle.slowDown(retryAfterMs);
				throw new RateLimitError(retryAfterMs, `Token request rate limited for doc ${docId}`);
			}

			if (response.status === 403 && mode === "write") {
				// The caller always requests "write" regardless of the member's actual
				// share role (see RelayCredentialRefresh.ts) — the control-plane correctly
				// 403s a viewer's write request (ensure_write_access), but without this
				// fallback that 403 propagated as a hard connection failure, leaving
				// viewer-role members unable to open onprem relay shares at all (U3).
				this.log(
					`Write access denied for doc ${docId} — retrying as read-only (viewer role)`
				);
				return this.requestToken(relayId, folderId, docId, "read", filePath, binding, checkContext);
			}

			if (response.status === 401 || response.status === 403) {
				if (response.headers.get("X-Relay-Managed") === "true" && docId !== folderId) {
					throw new Error(`Access to this file was revoked (${response.status})`);
				}
				const errorText = await response.text().catch(() => "");
				checkIdentity();
				this.refusedShares.add(folderId);
				throw new RelayAccessDeniedError(
					response.status,
					`Token request failed: ${response.status} - ${errorText}`,
				);
			}

			if (!response.ok) {
				const errorText = await response.text();
				checkIdentity();
				if (response.status === 409) {
					let detail: { detail?: { code?: string }; error?: { message?: { code?: string } } } | undefined;
					try { detail = JSON.parse(errorText) as typeof detail; } catch { /* Other conflicts retain their ordinary error. */ }
					if ((detail?.detail ?? detail?.error?.message)?.code === "restore_generation_changed") throw new RelayRestoreRequiredError();
				}
				throw new Error(`Token request failed: ${response.status} - ${errorText}`);
			}

			const data = await response.json() as RelayTokenResponse;
			checkIdentity();
			const context = restoreContext(data.restore_guard, data.restore_generation);
			if (docId !== folderId && (restoreGeneration(context?.generation) !== restoreGeneration(binding.restoreGeneration)
				|| (binding.restoreGeneration && !context?.supported))) throw new RelayRestoreRequiredError();
			this.refusedShares.delete(folderId);

			// Convert to DocumentGrant format expected by the plugin
			const expiryTime = localExpiryTime(data.expires_at, response.headers.get("Date"), data.expires_in);
			const clientToken: DocumentGrant = {
				token: data.token,
				url: data.relay_url,
				docId: docId,
				folder: folderId,
				expiryTime,
				authorization: mode === "write" ? "full" : "read-only",
				...(context ? { restoreGuard: context.supported, restoreGeneration: context.generation } : {}),
			};

			this.log(`Successfully obtained relay token, expires at ${data.expires_at}`);

			return clientToken;
		} catch (error: unknown) {
			checkIdentity();
			this.log("Token request error:", error);
			throw error;
		}
	}

	/**
	 * Request a file token for attachment (BlobClient) access — HEAD/download-url/
	 * upload-url on POST /shares/{id}/file-token's response. Unlike
	 * requestToken (relay-token for the WebSocket doc connection), this
	 * mints a presigned-URL-flavored token: BlobClient.ts reads only `baseUrl` and
	 * `token` off the result and does HEAD/GET/POST against
	 * `baseUrl` (+ "/download-url" | "/upload-url"). See BlobClient.ts for the
	 * exact three-call contract this token is consumed by.
	 *
	 * Requests one token per operation without stating read/write intent
	 * (same call shape for verify/readFile/writeFile) — the backend
	 * independently re-checks read vs write access at each of the three
	 * consuming routes, so this mint only needs read access to succeed.
	 *
	 * Storage key is `fileId` (the RemoteFileAddress UUID), not the vault path:
	 * BlobClient.ts's call chain (AttachmentFile -> resolveFileToken(documentId, ...)) never
	 * threads the vault-relative path down to this layer, and re-deriving it
	 * would mean changing BlobClient.ts's own call signature. fileId is already
	 * available (decoded from documentId one layer up in fetchFileTokenFromApi),
	 * stable across renames, and unique per attachment within a share — a
	 * better storage key than a path would be anyway.
	 */
	private fileIdentity?: string;
	private fileContext: object = {};
	/** Opaque in-memory cache namespace; changes on login, endpoint and teardown changes.
	 * Routine JWT refresh within one session retains the namespace. */
	getFileCredentialContext(): object {
		const token = this.config.authProvider.getToken();
		let identity = token;
		if (token) {
			try {
				const claims = decodeJwt(token);
				if (typeof claims.sub === "string" && typeof claims.session_id === "string") identity = JSON.stringify([claims.sub, claims.session_id]);
			} catch { /* Legacy credentials are scoped to their exact token. */ }
		}
		if (identity !== this.fileIdentity) {
			this.fileIdentity = identity; this.fileContext = {};
			this.refusedShares.clear(); this.sharesOnNetwork.clear();
		}
		return this.fileContext;
	}

	async requestFileToken(
		relayId: string,
		folderId: string,
		fileId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
		binding: RestoreBinding = {},
		options: { readOnly?: boolean; check?: () => void } = {},
	): Promise<FileGrant> {
		if (this.destroyed) throw new Error("Token provider was destroyed");
		binding = restoreMetadata(binding);
		const readOnly = options.readOnly === true, check = options.check;
		const identity = this.getFileCredentialContext(), endpoint = this.normalizedUrl;
		const checkIdentity = () => {
			if (this.destroyed || identity !== this.getFileCredentialContext()) throw new Error("Attachment login changed or server changed. Retry using the current connection.");
			check?.();
		};
		checkIdentity();
		const token = await this.config.authProvider.getValidToken();
		checkIdentity();

		if (!token) {
			throw new Error("Not authenticated");
		}

		this.log(`Requesting file token for ${fileId} in folder ${folderId}`);

		const request: FileTokenRequest = {
			path: fileId,
			sha256: fileHash,
			content_type: contentType,
			content_length: contentLength,
			...(readOnly ? { read_only: true as const } : {}),
		};

		// Deliberately NOT routed through this.throttle: POST /file-token has no
		// control-plane rate limit (the 30/min ceiling applies to doc tokens), and
		// sharing the 25/min queue made attachment tokens the bulk of initial-sync
		// lane time. A 429 still surfaces as RateLimitError and is retried by the caller.
		try {
			const response = await platformFetch(
				`${endpoint}/v1/shares/${folderId}/file-token`,
				{
					...(readOnly ? { sensitive: true } : {}),
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
						...(binding.restoreGeneration ? { "X-Relay-Restore-Generation": binding.restoreGeneration } : {}),
					},
					body: JSON.stringify(request),
				}
			);
			checkIdentity();

			if (response.status === 429) {
				const retryAfterSec = parseInt(response.headers.get("Retry-After") ?? "60", 10);
				const retryAfterMs = (isNaN(retryAfterSec) ? 60 : retryAfterSec) * 1000;
				if (readOnly) throw new RateLimitError(retryAfterMs, "Attachment inspection is rate limited");
				const errorText = await response.text().catch(() => "");
				checkIdentity();
				console.warn(
					`[DIAG][RelayOnPremTokenProvider] 429 rate limited for file-token ${fileId}. retryAfter=${retryAfterMs}ms body=${errorText}`
				);
				throw new RateLimitError(
					retryAfterMs,
					`File token request rate limited for ${fileId}`
				);
			}

			if (!response.ok) {
				if (readOnly) throw new Error(`Attachment inspection grant refused (${response.status})`);
				const errorText = await response.text();
				checkIdentity();
				throw new Error(`File token request failed: ${response.status} - ${errorText}`);
			}

			const data = (await response.json()) as FileTokenApiResponse;
			checkIdentity();
			const context = restoreContext(data.restore_guard, data.restore_generation);
			const expiryTime = localExpiryTime(data.expires_at, response.headers.get("Date"), data.expires_in);
			if (readOnly && (data.read_only !== true || context?.supported !== true
				|| context.generation !== (binding.restoreGeneration ?? null)
				|| typeof data.token !== "string" || !data.token || typeof data.base_url !== "string" || !data.base_url
				|| !Number.isFinite(expiryTime) || expiryTime <= Date.now())) {
				throw new Error("The server did not return the requested read-only attachment context");
			}

			const fileToken: FileGrant = {
				token: data.token,
				// BlobClient.ts does `token.baseUrl!` then platformFetch(baseUrl, ...) —
				// must be populated, `url` is unused by BlobClient.ts but required by
				// the DocumentGrant shape, reuse the same value rather than "".
				baseUrl: data.base_url,
				url: data.base_url,
				docId: fileId,
				folder: folderId,
				expiryTime,
				// Not read by BlobClient.ts (verified) — real read/write enforcement
				// happens server-side per-route, not via this cached label.
				authorization: readOnly ? "read-only" : "full",
				contentType,
				contentLength,
				fileHash,
				...(context ? { restoreGuard: context.supported, restoreGeneration: context.generation } : {}),
			};

			this.log(`Successfully obtained file token for ${fileId}, expires at ${data.expires_at}`);

			return fileToken;
		} catch (error: unknown) {
			checkIdentity();
			if (readOnly) {
				if (error instanceof RateLimitError) throw error;
				throw new Error("Could not obtain a read-only attachment grant for the requested source");
			}
			this.log("File token request error:", error);
			throw error;
		}
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true; this.fileContext = {}; this.refusedShares.clear(); this.sharesOnNetwork.clear();
		this.throttle.destroy();
	}
}
