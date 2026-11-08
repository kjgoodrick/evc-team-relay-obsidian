"use strict";

import { decodeJwt } from "jose";
import type { Clock } from "./Clock";
import { instanceLabels } from "./logging";
import { RateLimitError } from "./auth/RelayOnPremTokenProvider";

interface CredentialCacheOptions<StorageToken, NetToken> {
	logMessage: (message: string) => void;
	refreshToken: (
		documentId: string,
		onSuccess: (token: NetToken) => void,
		onError: (err: Error) => void,
	) => void;
	getClock: () => Clock;
	getTokenExpiry?: (token: NetToken) => number;
	getPersistedTokens?: () => Map<string, StorageToken>;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function formatTime(milliseconds: number): string {
	if (milliseconds < 1000) return `${milliseconds}ms`;
	if (milliseconds < MINUTE_MS) return `${Math.round(milliseconds / 1000)}s`;
	if (milliseconds < HOUR_MS) return `${Math.round(milliseconds / MINUTE_MS)}m`;
	return `${Math.round(milliseconds / HOUR_MS)}h`;
}

interface TokenBearing {
	token: string;
}

function defaultJwtExpiry<TokenType>(token: TokenType & TokenBearing): number {
	// We only need the claims, not a trust decision, so skip signature checking here
	const decoded = decodeJwt(token.token);
	if (typeof decoded === "string") {
		return 0;
	}
	const exp = decoded?.exp;
	return exp ? exp * 1000 : 0; // Convert to milliseconds
}

/**
 * Backoff schedule for retrying a rate-limited refresh: server-suggested
 * `retryAfterMs` (or 2s) as the base, doubled per attempt, capped at 60s,
 * with ±20% jitter to avoid a thundering herd when many Documents retry
 * at once.
 */
function nextRetryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
	const CAP_MS = 60_000;
	const base = Math.min(retryAfterMs || 2_000, CAP_MS);
	const exponential = Math.min(base * 2 ** (attempt - 1), CAP_MS);
	const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
	return Math.round(exponential + jitter);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export interface CredentialEntry<Token> {
	friendlyName: string;
	token: Token | null;
	expiryTime: number;
	attempts: number;
}

export class CredentialCache<TokenType extends TokenBearing> {
	protected tokenEntries: Map<string, CredentialEntry<TokenType>>;
	protected subscriberCallbacks: Map<string, (token: TokenType) => void>;
	protected _inFlightPromises: Map<string, Promise<TokenType>>;

	private pendingQueue: Set<string>;
	private clock: Clock;
	private sweepTimerHandle: number | null;
	//: this used to be 5*MINUTE_MS, exactly equal to control-plane's
	// relay token TTL (relay_token_ttl_minutes, default 5 -- a deliberate H6
	// security bound, not something to touch here). needsRefresh() is
	// `now + renewalMargin > expiryTime`; with margin == TTL that collapses
	// to `now > issued_at`, true almost the instant a token is minted. The
	// once-a-minute sweep then re-issued + reconnected every open share on
	// literally every tick, forever -- a permanent storm, not a one-time
	// cold-start burst (measured live: ~18 open shares -> ~18 reconnects/min,
	// sustained 2h+). A margin well below the TTL means a share only needs
	// re-issuing roughly once per (TTL - margin) window instead.
	private readonly renewalMargin: number = 1 * MINUTE_MS;
	private liveConnections = 0;
	private connectionCap: number;
	protected resolveJwtExpiry: (token: TokenType) => number;
	private _logFn: (message: string) => void;
	private refreshFn: (
		documentId: string,
		onSuccess: (token: TokenType) => void,
		onError: (err: Error) => void,
	) => void;

	constructor(
		config: CredentialCacheOptions<CredentialEntry<TokenType>, TokenType>,
		maxConnections = 5,
	) {
		this._inFlightPromises = new Map();
		this.tokenEntries = config.getPersistedTokens
			? config.getPersistedTokens()
			: new Map<string, CredentialEntry<TokenType>>();
		this.subscriberCallbacks = new Map();

		this.pendingQueue = new Set();
		this._logFn = config.logMessage;
		this.refreshFn = config.refreshToken;
		this.clock = config.getClock();
		// XXX: the fallback assumes TokenType is string-shaped (decodable as a JWT).
		this.resolveJwtExpiry = config.getTokenExpiry ?? defaultJwtExpiry<TokenType>;
		this.connectionCap = maxConnections;
		this.sweepTimerHandle = null;

		instanceLabels.set(this, "CredentialCache base instance");
	}

	requestRefresh(documentId: string): Promise<TokenType> {
		if (this.destroyed) return Promise.reject(new Error("Credential cache was destroyed"));
		return new Promise<TokenType>((resolve, reject) => {
			this.refreshFn(
				documentId,
				(token) => this.destroyed ? reject(new Error("Credential cache was destroyed")) : resolve(token),
				(error) => {
					// A failed refresh must not unsubscribe: a retry may still succeed
					// and the doc is still in use. Only goOffline() unsubscribes.
					this.pendingQueue.delete(documentId);
					reject(error);
				},
			);
		});
	}

	startSweeping() {
		this.logLine("starting");
		this.summarize();
		this.sweepTimerHandle = this.clock.scheduleInterval(
			() => this.sweepExpiringTokens(),
			MINUTE_MS,
		); // Check every minute
		this.sweepExpiringTokens();
	}

	stopSweeping() {
		this.logLine("stopping");
		if (this.sweepTimerHandle) {
			this.clock.cancelInterval(this.sweepTimerHandle);
			this.sweepTimerHandle = null;
		}
	}

	private pruneInvalidTokens(): void {
		for (const [documentId, tokenInfo] of this.tokenEntries.entries()) {
			if (!this.tokenIsValid(tokenInfo)) {
				this.tokenEntries.delete(documentId);
			}
		}
	}

	private sweepExpiringTokens() {
		this.logLine("running the periodic expiry sweep");
		this.pruneInvalidTokens();
		for (const [documentId, tokenInfo] of this.tokenEntries.entries()) {
			if (this.subscriberCallbacks.has(documentId) && this.needsRefresh(tokenInfo)) {
				this.logLine("scheduling a refresh for it");
				this.dispatchOrEnqueue(documentId);
			}
		}
		this.logLine(this.summarize());
	}

	popQueued(): string | null {
		this.logLine("popping the next queued documentId");
		const next = this.pendingQueue.values().next();
		if (next.done) {
			return null;
		}
		this.pendingQueue.delete(next.value);
		return next.value;
	}

	/** Kick off an immediate refresh if under `maxConnections`, else queue it for later. */
	private dispatchOrEnqueue(documentId: string) {
		if (this.destroyed) return;
		if (this.liveConnections >= this.connectionCap) {
			this.logLine(`at max connections — queuing ${documentId} for later`);
			this.pendingQueue.add(documentId);
			return;
		}

		this.logLine(`under the connection cap — refreshing ${documentId} now`);
		this.liveConnections++;
		const advance = () => {
			this.liveConnections--;
			if (this.destroyed) return;
			const next = this.popQueued();
			if (next) {
				this.dispatchOrEnqueue(next);
			}
		};
		this.refreshFn(
			documentId,
			(newToken) => {
				this.handleTokenRefreshed(documentId, newToken);
				advance();
			},
			() => {
				this.handleRefreshFailure(documentId);
				advance();
			},
		);
	}

	/**
	 * Called when a doc goes offline: forget its pending refresh AND its
	 * subscriber, so the expiry sweep stops re-issuing a token nobody is using.
	 * acquireToken() re-subscribes when the doc comes back online.
	 */
	dropFromQueue(documentId: string) {
		this.logLine(`dropping ${documentId} from the pending refresh queue`);
		this.subscriberCallbacks.delete(documentId);
		return this.pendingQueue.delete(documentId);
	}

	logLine(text: string) {
		this._logFn(text);
	}

	private handleTokenRefreshed(documentId: string, token: TokenType) {
		if (this.destroyed || !this.tokenEntries.has(documentId)) {
			return;
		}
		const existing = this.tokenEntries.get(documentId) as CredentialEntry<TokenType>;
		const callback = this.subscriberCallbacks.get(documentId);
		const expiryTime = this.resolveJwtExpiry(token);
		this.logLine(`recorded new expiry: ${expiryTime}`);
		this.tokenEntries.set(documentId, { ...existing, token, expiryTime });
		callback?.(token);
		this.logLine(`refresh complete for ${existing.friendlyName} (${documentId})`);
	}

	private handleRefreshFailure(documentId: string) {
		if (this.destroyed) return;
		const existing = this.tokenEntries.get(documentId);
		// A purge/context invalidation may have removed this entry while the
		// request was in flight. Its failure must not recreate a stale cache slot.
		if (!existing) return;
		const attempts = (existing?.attempts ?? 0) + 1;
		const MAX_ATTEMPTS = 3;
		if (attempts <= MAX_ATTEMPTS) {
			this.tokenEntries.set(documentId, {
				...existing,
				attempts,
			});
		} else {
			this.tokenEntries.delete(documentId);
		}
	}

	tokenIsValid(token: CredentialEntry<TokenType>): boolean {
		return this.clock.now() < token.expiryTime;
	}

	needsRefresh(token: CredentialEntry<TokenType>): boolean {
		return this.clock.now() + this.renewalMargin > token.expiryTime;
	}

	peekToken(documentId: string) {
		return this.tokenEntries?.get(documentId)?.token;
	}

	/**
	 * Attempt a single token refresh via `requestRefresh`.  If the server
	 * returns HTTP 429 (surfaced as `RateLimitError`) the call is retried
	 * with exponential backoff + jitter up to `maxRetries` times (see
	 * `nextRetryDelayMs`).
	 */
	private async refreshWithRetry(documentId: string, maxRetries = 5): Promise<TokenType> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.requestRefresh(documentId);
			} catch (err: unknown) {
				if (!(err instanceof RateLimitError) || attempt >= maxRetries) {
					throw err;
				}
				const delay = nextRetryDelayMs(attempt + 1, err.retryAfterMs);
				console.warn(
					`[DIAG][CredentialCache] 429 rate limit for ${documentId}. attempt=${attempt + 1}/${maxRetries} retrying in ${delay}ms`,
				);
				await sleep(delay);
			}
		}
	}

	private fetchTokenFromNetwork(
		documentId: string,
		friendlyName: string,
		callback: (token: TokenType) => void,
	) {
		const existingActive = this._inFlightPromises.get(documentId);
		if (existingActive) {
			// Re-subscribe: the doc may have gone offline (subscriber dropped)
			// while this refresh was in flight and is now being reacquired.
			this.subscriberCallbacks.set(documentId, callback);
			return existingActive;
		}

		const existing = this.tokenEntries.get(documentId);
		this.tokenEntries.set(documentId, {
			token: null,
			friendlyName,
			expiryTime: 0,
			attempts: existing?.attempts ?? 0,
		});
		this.subscriberCallbacks.set(documentId, callback);

		const sharedPromise = this.refreshWithRetry(documentId)
			.then((newToken) => {
				this.handleTokenRefreshed(documentId, newToken);
				this._inFlightPromises.delete(documentId);
				return newToken;
			})
			.catch((err: unknown) => {
				this.handleRefreshFailure(documentId);
				this._inFlightPromises.delete(documentId);
				throw err;
			});
		this._inFlightPromises.set(documentId, sharedPromise);
		return sharedPromise;
	}

	async acquireToken(
		documentId: string,
		friendlyName: string,
		callback: (token: TokenType) => void,
	): Promise<TokenType> {
		this.logLine(`resolving a token for ${friendlyName}`);
		if (this.destroyed) throw new Error("Credential cache was destroyed");

		const tokenInfo = this.tokenEntries.get(documentId);
		//: `tokenIsValid` alone is a literal-expiry check -- a token
		// with 1s left on its clock still passes it. A reconnect (bringOnline())
		// racing that boundary would get served this almost-dead token, dial
		// the WS handshake with it, and lose the race against expiry in
		// transit -- exactly the residual invalid_token failures's
		// resolved-self closure never actually explained (an untested
		// throttle-saturation hypothesis). `needsRefresh` is the same margin
		// the sweep uses to refresh proactively; honoring it here too means a
		// caller never gets handed a token the sweep would already consider
		// due for renewal, even in the up-to-60s gap before the next sweep tick.
		if (tokenInfo?.token && this.tokenIsValid(tokenInfo) && !this.needsRefresh(tokenInfo)) {
			this.subscriberCallbacks.set(documentId, callback);
			tokenInfo.friendlyName = friendlyName;
			callback(tokenInfo.token);
			this.logLine("existing token still valid — served from cache");
			this._inFlightPromises.delete(documentId);
			return tokenInfo.token;
		}

		return this.fetchTokenFromNetwork(documentId, friendlyName, callback);
	}

	private linesFor(filter: (documentId: string) => boolean): string[] {
		const lines: string[] = [];
		const currentTime = this.clock.now();
		const sorted = Array.from(this.tokenEntries.entries()).sort(
			(a, b) => a[1].expiryTime - b[1].expiryTime,
		);
		for (const [documentId, { friendlyName, expiryTime, attempts }] of sorted) {
			if (!filter(documentId)) continue;
			const timeUntilExpiry = expiryTime - currentTime;
			const timeReport =
				timeUntilExpiry > 0
					? `expires in ${formatTime(timeUntilExpiry - this.renewalMargin)}`
					: "expired";
			lines.push(`${documentId} (${friendlyName}): ${attempts} attempts, (${timeReport})`);
		}
		return lines;
	}

	summarize(): string {
		return [
			"Token Store Report:",
			`Expiry Margin: ${formatTime(this.renewalMargin)}`,
			"Active Tokens:",
			...this.linesFor((documentId) => this.subscriberCallbacks.has(documentId)),
			"Stale Tokens:",
			...this.linesFor((documentId) => !this.subscriberCallbacks.has(documentId)),
			`Queue size: ${this.pendingQueue.size}`,
		].join("\n");
	}

	async awaitQueueDrain(): Promise<void> {
		return new Promise((resolve) => {
			window.setInterval(() => {
				if (this.pendingQueue.size == 0) {
					return resolve();
				}
			}, 100);
		});
	}

	resetState() {
		this.pendingQueue.clear();
		for (const [documentId, tokenInfo] of this.tokenEntries.entries()) {
			if (this.tokenIsValid(tokenInfo)) {
				this.tokenEntries.set(documentId, { ...tokenInfo, attempts: 0 });
			} else {
				this.tokenEntries.delete(documentId);
			}
		}
	}

	purge(filter?: (token: CredentialEntry<TokenType>) => boolean) {
		if (!filter) {
			this.tokenEntries.clear();
			this.pendingQueue.clear();
			return;
		}
		this.tokenEntries.forEach((value, key) => {
			if (filter(value)) {
				this.tokenEntries.delete(key);
				this.pendingQueue.delete(key);
			}
		});
	}

	private destroyed = false;
	teardown() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.purge();
		this.clock.teardown();
		this.clock = null as unknown as Clock;
		this.refreshFn = null as unknown as (
			documentId: string,
			onSuccess: (token: TokenType) => void,
			onError: (err: Error) => void,
		) => void;
		this.subscriberCallbacks.clear();
		this._inFlightPromises.clear();
		// In-flight callbacks still need these empty containers to settle their
		// callers after unload. The destroyed guard prevents late adoption.
	}
}
