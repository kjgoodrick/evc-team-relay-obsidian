"use strict";
import * as Y from "yjs";
import {
	YSweetProvider,
	type ConnectionState,
	type ConnectionIntent,
	type ConnectionStatus,
} from "./client/provider";
export type { ConnectionState, ConnectionIntent, ConnectionStatus };
import { Account } from "./Account";
import { Loggable } from "./logging";
import { AuthSession } from "./AuthSession";
import { RelayCredentialCache, shareIdOf } from "./RelayCredentialCache";
import type { DocumentGrant } from "./relay/TokenShapes";
import { ResourceAddress, type ResourceAddressType } from "./ResourceAddress";
import { currentToggles } from "./featureToggleState";
import { computeReconnectDelay } from "./reconnectThrottle";
import { RelayAccessDeniedError, RelayRestoreRequiredError } from "./auth/RelayOnPremTokenProvider";
import { createPermanentUserData } from "./permanentUserData";
import { safeAvatarUrl } from "./presenceAvatar";
import { decodeJwt } from "jose";
import type { NotePresenceSurface } from "./collaboration/presence/PresenceSettings";

const EMPTY_TOKEN: DocumentGrant = {
	token: "",
	url: "",
	docId: "-",
	expiryTime: 0,
} as DocumentGrant;

/** Do not reuse a token for a reconnect handshake with less than this left. */
const RECONNECT_TOKEN_MARGIN_MS = 15_000;

function presenceProfile(user: Account) {
	return {
		name: user.fullName,
		id: user.accountId,
		color: user.presenceColor.color,
		colorLight: user.presenceColor.light,
		avatarUrl: safeAvatarUrl(user.avatarUrl),
	};
}

function buildProvider(
	clientToken: DocumentGrant,
	ydoc: Y.Doc,
	beforeConnect?: () => boolean,
): YSweetProvider {
	const provider = new YSweetProvider(clientToken.url, clientToken.docId, ydoc, {
		connect: false,
		beforeConnect,
		params: { token: clientToken.token },
		disableBc: true,
		// no cap — see YSweetProvider's maxConnectionErrors default.
	});
	// Background sync never announces a viewing location. The foreground
	// controller alone activates a note after resolving its actual view binding.
	provider.awareness.setLocalState(null);
	return provider;
}

function seedDocIdentity(ydoc: Y.Doc, user?: Account): void {
	if (!user) {
		return;
	}
	const permanentUserData = createPermanentUserData(ydoc);
	permanentUserData.setUserMapping(ydoc, ydoc.clientID, user.accountId);
}

type Listener = (state: ConnectionState) => void;

/**
 * Small reconnect-attempt gate. Wraps a single pending window.setTimeout so a
 * caller-triggered reconnect can only ever be scheduled once, and enforces a
 * floor between attempts (see the note on `connectAfterError` below —
 * without this floor a fast-failing connection would hammer `bringOnline()` in
 * a tight loop with zero backoff).
 */
class ReconnectGate {
	private timer?: ReturnType<typeof setTimeout> | number;
	private lastFiredAt = 0;

	get pending(): boolean {
		return this.timer !== undefined;
	}

	schedule(maxBackoffMs: number, fire: () => void): void {
		if (this.pending) {
			return;
		}
		const delay = computeReconnectDelay(Date.now(), this.lastFiredAt, maxBackoffMs);
		this.timer = window.setTimeout(() => {
			this.timer = undefined;
			this.lastFiredAt = Date.now();
			fire();
		}, delay);
	}

	cancel(): void {
		if (this.timer !== undefined) {
			window.clearTimeout(this.timer as number);
			this.timer = undefined;
		}
	}
}

export class ProviderBacked extends Loggable {
	_liveProvider: YSweetProvider;
	/**
	 * Vault-relative path of the entry this provider is backing, where the
	 * subclass has one. Spelled the same as `SyncableEntry.entryPath` on
	 * purpose: `Document`/`CanvasDocument` assign that member and it must
	 * override this one rather than sit beside it — a base field named
	 * differently from the subclass's would leave every read of it
	 * permanently `undefined` while still compiling.
	 */
	entryPath?: string;
	crdtDoc: Y.Doc;
	issuedToken: DocumentGrant;
	_providerSynced: boolean = false;
	/** How long the latest bringOnline() waited for its token (relay probe). */
	lastTokenMs?: number;
	private stateListeners: Map<unknown, Listener> = new Map();
	private reconnectGate = new ReconnectGate();
	private detachConnectionError: () => void;
	private detachConnectionClose: () => void;
	private detachState: () => void;
	private detachAccess: () => void;
	private detachRestore?: () => void;
	private restorePaused = false;
	private detachAuthSession?: () => void;
	private detachProfileRefresh?: () => void;
	// accountId last used to seed awareness/doc-identity, so a later auth
	// notification can tell "still nothing to seed" apart from "the right
	// user just became resolvable" without re-running the seed on every
	// unrelated AuthSession notification.
	private seededAccountId?: string;
	private seededProfile?: string;
	private presenceSurface?: NotePresenceSurface;
	private presenceInstanceId?: string;

	constructor(
		public entityGuid: string,
		private _resourceAddress: ResourceAddressType,
		public credentialCache: RelayCredentialCache,
		public authSession: AuthSession,
		// Multi-server relay-onprem: which server this doc/folder belongs to,
		// so the token layer can pick that server's provider instead of the
		// plugin-wide default. Undefined for folders/docs created before
		// VaultShareSettings.onpremServerId existed — RelayCredentialCache falls
		// back to the default provider in that case.
		public onpremServerId?: string,
	) {
		super();
		this.authSession = authSession;
		// Per-server, NOT the plugin-wide `authSession.currentUser` — that
		// field only ever reflects whichever server is `activeServerId`
		// (AuthSession.getCurrentUserForServer's own doc comment), so a doc
		// belonging to a different (e.g. self-host) server than the active
		// one would seed awareness with the wrong identity, or none at all,
		// even though this exact server IS logged in. This is what made
		// self-host live cursors silently never broadcast while sync (which
		// already threaded `onpremServerId` through the credential layer)
		// worked fine.
		const user = this.authSession?.getCurrentUserForServer(this.onpremServerId);

		this.crdtDoc = new Y.Doc();
		if (currentToggles().enableDocumentHistory) {
			this.crdtDoc.gc = false;
		}
		seedDocIdentity(this.crdtDoc, user);

		this.credentialCache = credentialCache;
		this.issuedToken =
			this.credentialCache.peekToken(ResourceAddress.serialize(this.resourceAddress)) || { ...EMPTY_TOKEN };

		this._liveProvider = buildProvider(
			this.issuedToken, this.crdtDoc, () => this.refreshStaleProviderToken(),
		);
		this.seededAccountId = user?.accountId;
		this.seededProfile = this.profileKey(user);

		this.detachConnectionError = this.attachConnectionErrorHandler();
		this.detachConnectionClose = this.attachConnectionCloseHandler();
		this.detachState = this.attachStateHandler();
		// The folder badge reads accessDenied; a refusal found by the renewal
		// sweep changes it without any connection event.
		const shareId = shareIdOf(ResourceAddress.serialize(this.resourceAddress));
		// Optional call: stand-in caches in tests may not implement it.
		this.detachAccess =
			credentialCache.onAccessDeniedChange?.((changed) => {
				if (changed !== shareId) return;
				// A cleared refusal leaves a retry waiting out the old backoff:
				// bring it forward to the ordinary reconnect floor.
				if (!this.accessDenied && this.reconnectGate.pending) {
					this.reconnectGate.cancel();
					this.reconnectGate.schedule(this._liveProvider.maxBackoffTime, () => {
						void this.bringOnline();
					});
				}
				this.broadcastState();
			}) ?? (() => {});
		// Belt-and-braces against any remaining startup-ordering race (this
		// provider built before its server's own restore/login resolved):
		// re-seed once the identity for THIS server actually changes, rather
		// than trusting it was already correct at construction time.
		this.detachAuthSession = this.authSession?.on(() => this.reseedIdentityIfChanged());
		this.detachProfileRefresh = this.authSession?.onTokenRefreshed?.((serverId) => {
			if (!this.onpremServerId || serverId === this.onpremServerId) this.reseedIdentityIfChanged();
		});
		this.detachRestore = credentialCache.onRestoreRequired?.(documentId => {
			if (documentId === ResourceAddress.serialize(this.resourceAddress) && this.restoreReviewRequired) this.pauseForRestore();
		});
	}

	get restoreReviewRequired(): boolean {
		return this.restorePaused || !!this.credentialCache?.isRestoreRequired?.(ResourceAddress.serialize(this.resourceAddress), this.getOnpremServerId());
	}
	protected pauseForRestore(): void {
		if (this.restorePaused) return;
		this.restorePaused = true; this.goOffline();
	}

	/**
	 * Refresh active presence/doc identity if the resolved per-server user
	 * changed since the last seed (most commonly: went from unresolved to
	 * resolved, once this doc's own server finishes logging in/restoring
	 * after this provider was already constructed). A no-op on every
	 * AuthSession notification that doesn't actually change this doc's
	 * identity, so it's safe to wire to every notification rather than
	 * something narrower.
	 */
	private reseedIdentityIfChanged(): void {
		const user = this.authSession?.getCurrentUserForServer(this.getOnpremServerId());
		// A new login session for the same account can invalidate an old grant
		// even when its display profile has not changed.
		this.refreshPresence(user);
		const profile = this.profileKey(user);
		if (profile === this.seededProfile) {
			return;
		}
		if (user?.accountId !== this.seededAccountId) seedDocIdentity(this.crdtDoc, user);
		this.seededAccountId = user?.accountId;
		this.seededProfile = profile;
	}

	/** Only the shared foreground controller activates this ephemeral state. */
	setPresenceActive(surface?: NotePresenceSurface, instanceId?: string): void {
		this.presenceSurface = surface;
		this.presenceInstanceId = instanceId;
		this.refreshPresence(this.authSession?.getCurrentUserForServer(this.getOnpremServerId()));
	}

	private refreshPresence(user?: Account): void {
		const awareness = this._liveProvider.awareness, current = awareness.getLocalState();
		if (!this.presenceSurface || !user || !this.presenceGrantMatches(user)) {
			if (current !== null) awareness.setLocalState(null);
			return;
		}
		const profile = presenceProfile(user);
		if (current?.surface === this.presenceSurface && current?.instanceId === this.presenceInstanceId && JSON.stringify(current.user) === JSON.stringify(profile)) return;
		const preserve = current?.surface === this.presenceSurface && current?.user?.id === user.accountId;
		awareness.setLocalState({ user: profile, surface: this.presenceSurface, ...(this.presenceInstanceId ? { instanceId: this.presenceInstanceId } : {}),
			cursor: preserve ? current.cursor ?? null : null, viewport: preserve ? current.viewport ?? null : null,
			selection: preserve ? current.selection ?? null : null });
	}

	/** Local stale-account/session guard, not signature verification. The gateway
	 * remains authoritative. Never send a new account's location on an old grant. */
	hasCurrentPresenceAccount(): boolean {
		const user = this.authSession?.getCurrentUserForServer(this.getOnpremServerId());
		return !!user && this.presenceGrantMatches(user);
	}

	private presenceGrantMatches(user: Account): boolean {
		if (!this.issuedToken.url.includes("/v1/managed/")) return true;
		try {
			const grant = decodeJwt(this.issuedToken.token), session = decodeJwt(user.authToken);
			return grant.scope === "managed" && grant.sub === user.accountId && session.sub === user.accountId &&
				grant.doc_id === this.entityGuid && grant.session_id === session.session_id;
		} catch { return false; }
	}

	private profileKey(user?: Account): string | undefined {
		return user ? JSON.stringify([user.accountId, user.fullName, safeAvatarUrl(user.avatarUrl)]) : undefined;
	}

	private attachConnectionErrorHandler(): () => void {
		const handler = (event: Event) => {
			this.log(`${this.getVaultPath()}: connection dropped`, event);
			const canRetry = this._liveProvider.canReconnect();
			this.goOffline();
			if (canRetry && !this.restoreReviewRequired) {
				this.reconnectGate.schedule(this._liveProvider.maxBackoffTime, () => {
					void this.bringOnline();
				});
			}
		};
		this._liveProvider.on("connection-error", handler);
		return () => this._liveProvider.off("connection-error", handler);
	}

	/**
	 *: a socket only needs its token at the handshake, so an
	 * established connection can outlive the token it was opened with by
	 * hours. When such a connection drops without an "error" event
	 * (sleep/wake, server restart), _liveProvider's own onclose path reopens
	 * the socket against the URL it already has — an expired token, rejected
	 * by the relay every time. This runs before that path decides anything
	 * (connection-close is emitted ahead of its canReconnect() check): if the
	 * token can no longer be trusted, take the reconnect over and go through
	 * bringOnline(), which mints a fresh one first.
	 */
	private attachConnectionCloseHandler(): () => void {
		const handler = (event: CloseEvent) => {
			if (event?.code === 4412 && this.issuedToken.url.includes("/v1/managed/socket")) {
				this.credentialCache.markRestoreRequired?.(ResourceAddress.serialize(this.resourceAddress), this.getOnpremServerId());
				this.pauseForRestore();
				return;
			}
			this.refreshStaleProviderToken();
		};
		this._liveProvider.on("connection-close", handler);
		return () => this._liveProvider.off("connection-close", handler);
	}

	/** A queued reconnect may run after sleep, long after the close-time check. */
	private refreshStaleProviderToken(): boolean {
		if (this.restoreReviewRequired) { this.pauseForRestore(); return false; }
		if (!this._liveProvider.shouldConnect) return false;
		if (this.hasUsableProviderToken()) return true;
		this.log(`${this.getVaultPath()}: stale token, refreshing before reconnect`);
		this.goOffline();
		this.reconnectGate.schedule(this._liveProvider.maxBackoffTime, () => {
			void this.bringOnline();
		});
		return false;
	}

	private attachStateHandler(): () => void {
		const handler = (_state: ConnectionState) => this.broadcastState();
		this._liveProvider.on("status", handler);
		return () => this._liveProvider.off("status", handler);
	}

	public get resourceAddress(): ResourceAddressType {
		return this._resourceAddress;
	}

	public set resourceAddress(value: ResourceAddressType) {
		this._resourceAddress = value;
		this.applyRefreshedToken(this.issuedToken);
	}

	broadcastState(): void {
		this.debug("provider-state-changed", this.getVaultPath(), this.connectionState);
		for (const listener of this.stateListeners.values()) {
			listener(this.connectionState);
		}
	}

	subscribe(el: unknown, listener: Listener): () => void {
		this.stateListeners.set(el, listener);
		return () => this.removeListener(el);
	}

	removeListener(el: unknown): void {
		this.stateListeners.delete(el);
	}

	/**
	 * Get the full vault path for this provider.
	 * For documents in shared folders, this includes the folder path prefix.
	 * Override in subclasses that need to provide full vault paths.
	 */
	getVaultPath(): string {
		return this.entryPath || "unknown";
	}

	/**
	 * Which on-prem server this doc/folder belongs to, read fresh at call
	 * time. Default returns the value captured at construction; VaultShare
	 * overrides this to read config.onpremServerId live instead, since
	 * onpremServerId is set AFTER construction at every share-creation call
	 * site (createShare() succeeds -> VaultShare constructed -> THEN
	 * config.onpremServerId assigned) — the constructor-captured value
	 * would otherwise be permanently stale (undefined) for any folder
	 * created in the current session.
	 */
	protected getOnpremServerId(): string | undefined {
		return this.onpremServerId;
	}

	async requestProviderToken(): Promise<DocumentGrant> {
		if (this.restoreReviewRequired) throw new RelayRestoreRequiredError();
		this.log("requesting a provider token");
		return this.credentialCache.getToken(
			ResourceAddress.serialize(this.resourceAddress),
			this.getVaultPath(),
			this.applyRefreshedToken.bind(this),
			this.getOnpremServerId(),
		);
	}

	hasFreshProviderToken(): boolean {
		if (this.restoreReviewRequired) return false;
		if (!this.issuedToken) {
			return false;
		}
		const hasCurrentUrl = this._liveProvider.hasUrl(this.issuedToken.url);
		const notExpired = Date.now() <= (this.issuedToken?.expiryTime || 0);
		return hasCurrentUrl && notExpired;
	}

	/**
	 * Whether the token the live provider was last pointed at can still open
	 * a new handshake. Deliberately expiry-only, with a margin: one with a
	 * second left can expire in flight. (hasFreshProviderToken() also compares
	 * URLs, which is the wrong question here — the provider was pointed at
	 * this grant by applyRefreshedToken() already.)
	 */
	private hasUsableProviderToken(): boolean {
		if (this.restoreReviewRequired) return false;
		const expiry = this.issuedToken?.expiryTime ?? 0;
		return !!this.issuedToken?.token && Date.now() + RECONNECT_TOKEN_MARGIN_MS <= expiry;
	}

	applyRefreshedToken(clientToken: DocumentGrant): void {
		if (this.restoreReviewRequired) return;
		// point the live provider connection at the freshly-issued token
		this.issuedToken = clientToken;

		if (!this._liveProvider) {
			throw new Error("no underlying provider to refresh");
		}

		const result = this._liveProvider.refreshToken(
			clientToken.url,
			clientToken.docId,
			clientToken.token,
		);
		this.refreshPresence(this.authSession?.getCurrentUserForServer(this.getOnpremServerId()));

		if (result.urlChanged) {
			const maskedUrl = result.newUrl.replace(/token=[^&]+/, "token=[REDACTED]");
			this.log(`token refresh changed the provider URL -> ${maskedUrl}`);
		}
	}

	public get isOnline(): boolean {
		return this.connectionState.status === "connected";
	}

	/**
	 * this.bringOnline() here refreshes the auth token before retrying
	 * (unlike _liveProvider's own onclose-driven reconnect, which just recreates
	 * the WebSocket against its existing, possibly-now-stale, URL) — needed
	 * so a token-expiry-caused disconnect can actually recover instead of
	 * retrying forever with a dead token. That's still required.
	 *
	 * What's NOT still required is calling it with zero delay: this handler
	 * used to be implicitly throttled by the same wsUnsuccessfulReconnects/
	 * maxConnectionErrors counter capping reconnection out at 3 attempts
	 * total. Now that _liveProvider retries forever, this path needs
	 * its OWN floor (ReconnectGate above) — otherwise a fast-failing
	 * connection (e.g. DNS refusal, immediate server rejection) fires
	 * bringOnline() in a tight, un-backed-off loop on every single attempt,
	 * forever. Throttle to at most once per _liveProvider.maxBackoffTime,
	 * matching the steady-state rate _liveProvider's own retry loop settles
	 * into.
	 */
	async bringOnline(): Promise<boolean> {
		if (this.restoreReviewRequired) { this.pauseForRestore(); return false; }
		if (this.isOnline) {
			return true;
		}
		const tokenFrom = Date.now();
		this.lastTokenMs = undefined;
		const offlineCalls = this.offlineCalls;
		try {
			const clientToken = await this.requestProviderToken();
			this.lastTokenMs = Date.now() - tokenFrom;
			// goOffline() ran while the token was on its way (a caller that
			// stopped waiting for this connect released it): connecting now
			// would leave a socket nobody owns.
			if (this.offlineCalls !== offlineCalls || this.restoreReviewRequired) return false;
			this.applyRefreshedToken(clientToken); // re-check: token may already be current at this point
			this._liveProvider.connect();
			// A retry left by an earlier failure is not needed any more.
			this.reconnectGate.cancel();
			this.broadcastState();
			return true;
		} catch (e) {
			if (e instanceof RelayRestoreRequiredError) { this.pauseForRestore(); return false; }
			this.warn("bringOnline() failed:", e instanceof Error ? e.message : e);
			// Cancelled by goOffline() while the token was on its way: the
			// explicit "disconnected" intent stands, no retry behind it.
			if (this.offlineCalls !== offlineCalls) return false;
			// A rejected requestProviderToken() means _liveProvider.connect() above was
			// NEVER called, so _liveProvider never emits "connection-error" and the
			// reconnectGate.schedule() in attachConnectionErrorHandler() never
			// fires — the one automatic retry path this class has is wired to
			// an event that, on THIS failure, physically cannot happen. Without
			// this, any transient failure on the very first bringOnline() attempt
			// (a wrong-host 404 while multi-server routing is still catching
			// up, a 500, a network blip) leaves the folder disconnected until
			// Obsidian restarts. Reuse the same gate — same floor,
			// same cancel-on-dismantle() — so this path composes with the
			// existing one instead of adding a second, differently-throttled
			// retry loop.
			// A refused share (401/403) is not retried on the reconnect floor:
			// wait out its backoff, which RelayCredentialCache keeps per share.
			const retryAt = e instanceof RelayAccessDeniedError ? e.retryAt : undefined;
			// A retry that was already waiting may belong to a window a reset
			// has since cleared; the window this refusal returned decides.
			if (retryAt !== undefined) this.reconnectGate.cancel();
			const floor = Math.max(this._liveProvider.maxBackoffTime, (retryAt ?? 0) - Date.now());
			this.reconnectGate.schedule(floor, () => {
				void this.bringOnline();
			});
			this.broadcastState();
			return false;
		}
	}

	/** Ask for this share's token on the next connect instead of after its backoff. */
	clearAccessDenied(): void {
		this.credentialCache.clearAccessDenied(ResourceAddress.serialize(this.resourceAddress));
	}

	/** The control plane refuses this share's token (401/403); retries are backed off. */
	get accessDenied(): boolean {
		return this.credentialCache.isAccessDenied(ResourceAddress.serialize(this.resourceAddress));
	}

	public get connectionState(): ConnectionState {
		return this._liveProvider.connectionState;
	}

	get connectionIntent(): ConnectionIntent {
		return this._liveProvider.intent;
	}

	public get isSynced(): boolean {
		return this._providerSynced;
	}

	/** Counts goOffline() calls, so a connect still awaiting its token can tell it was cancelled. */
	private offlineCalls = 0;

	goOffline(): void {
		this.offlineCalls++;
		// A retry scheduled by a failed bringOnline() would otherwise reconnect
		// against this explicit "disconnected" intent -- e.g. a background
		// pull whose token request failed would leave the document connected
		// for good, outside any lane's accounting. Callers that
		// want a retry after going offline (the connection-error handlers
		// above) schedule it AFTER calling this.
		this.reconnectGate.cancel();
		this._liveProvider.disconnect();
		this.credentialCache.dropFromQueue(ResourceAddress.serialize(this.resourceAddress));
		this.broadcastState();
	}

	public ensureActiveProvider<T extends ProviderBacked>(this: T): Promise<T> {
		if (this.hasFreshProviderToken()) {
			return Promise.resolve(this);
		}
		return this.requestProviderToken().then(() => this);
	}

	onceOnline(): Promise<void> {
		if (this.isOnline) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const onStatus = (state: ConnectionState) => {
				if (state.status === "connected") {
					resolve();
				}
			};
			// no removal here on purpose -- dismantle() owns tearing this down
			this._liveProvider.on("status", onStatus);
			// Check again after registering — connection may have completed
			// between the initial check and listener registration
			if (this.isOnline) {
				resolve();
			}
		});
	}

	onceEverSynced(): Promise<void> {
		// Check if already synced: either provider reports synced, or we previously
		// synced (e.g., via uploadDocumentViaSocket) and then disconnected.
		// Without the _providerSynced check, Documents that were briefly connected
		// and synced during background sync would hang forever after disconnect
		// (provider.synced resets to false on disconnect).
		if (this._providerSynced || this._liveProvider.synced) {
			this._providerSynced = true;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this._liveProvider.once("synced", () => {
				this._providerSynced = true;
				resolve();
			});
			// Double-check after registering listener (event may have fired between check and registration)
			if (this._liveProvider.synced) {
				this._providerSynced = true;
				resolve();
			}
		});
	}

	/**
	 * Like onceEverSynced(), but ignores its sticky "ever synced, at any
	 * point in this object's lifetime" history and only resolves on a
	 * synced state that is genuinely current: either the provider reports
	 * synced RIGHT NOW, or a fresh "synced" event arrives after this call.
	 *
	 * onceEverSynced()'s stickiness (see its own doc comment) means a
	 * SECOND call on an object that already synced once and then
	 * disconnected resolves immediately, without waiting for the CURRENT
	 * connection attempt's own round trip to land -- confirmed live to fire
	 * with the underlying provider reporting NOT synced at call time
	 *. For VaultShare's own bootstrap gate (_onReady/
	 * refreshFromServer()), that means adoptLocalFiles() can run against local state
	 * whose folderIndex hasn't actually caught up with the shared folder's
	 * metadata yet -- "not in the index" and "index hasn't arrived yet" read
	 * as the same false, so a file that's already tracked under a shared
	 * guid gets treated as brand new and re-minted under a fresh one.
	 *
	 * Use this wherever the real question is "has a fresh sync landed for
	 * what I'm about to do", not "did this object ever sync at some point".
	 */
	onceFreshlySynced(): Promise<void> {
		if (this._liveProvider.synced) {
			this._providerSynced = true;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this._liveProvider.once("synced", () => {
				this._providerSynced = true;
				resolve();
			});
			// Double-check after registering listener (event may have fired between check and registration)
			if (this._liveProvider.synced) {
				this._providerSynced = true;
				resolve();
			}
		});
	}

	resetConnection(): void {
		this.goOffline();
		this.issuedToken = { ...EMPTY_TOKEN };
	}

	dismantle(): void {
		this.detachRestore?.();
		this.reconnectGate.cancel();
		this.detachAccess();
		this.detachConnectionError?.();
		this.detachConnectionClose?.();
		this.detachState?.();
		this.detachAuthSession?.();
		this.detachProfileRefresh?.();
		this._liveProvider?.destroy();
		this.authSession = null as unknown as AuthSession;
	}
}
