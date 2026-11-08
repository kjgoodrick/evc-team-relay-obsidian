// Token store wiring specific to the real-time (TeamRelayPlugin) client path.
import { CredentialCache, type CredentialEntry } from "./CredentialCache";
import type { Clock } from "./Clock";
import { AuthSession } from "./AuthSession";
import { namedLogger } from "./logging";
import type { DocumentGrant, FileGrant } from "./relay/TokenShapes";
import { VaultScopedMap } from "./VaultScopedMap";
import type { App } from "obsidian";
import { ResourceAddress, type ResourceAddressType, RemoteFileAddress } from "./ResourceAddress";
import { platformFetch } from "./platformFetch";
import { refresh as universalRefresh } from "./RelayCredentialRefresh";
import {
	RelayAccessDeniedError,
	RelayRestoreRequiredError,
	RelayTokenTimeoutError,
	type RelayOnPremTokenProvider,
} from "./auth/RelayOnPremTokenProvider";
import { AccessDeniedBackoff } from "./accessDeniedBackoff";
import { restoreMetadata, type RestoreBinding } from "./collaboration/RestoreGeneration";

declare const GIT_TAG: string;

// The JWT's own expiry field is what actually governs validity server-side —
// this getter just exposes it in the shape CredentialCache's generic cache expects.
function getJwtExpiryFromDocumentGrant(grant: DocumentGrant): number {
	return grant.expiryTime || 0;
}

/** Refusals are per share: every document of a folder share shares one entry. */
export function shareIdOf(documentId: string): string {
	try {
		const address = ResourceAddress.parse(documentId);
		return "folderGuid" in address ? address.folderGuid : documentId;
	} catch {
		return documentId;
	}
}

export class RelayCredentialCache extends CredentialCache<DocumentGrant> {
	// Multi-server: one RelayOnPremTokenProvider per configured on-prem
	// server, each bound to that server's own controlPlaneUrl + auth
	// provider (main.ts builds/maintains this). A single shared provider
	// used to be bound to the DEFAULT server only, so every on-prem share
	// -- regardless of which server it actually belonged to -- had its
	// /tokens/relay request routed to the default server's control plane.
	private relayOnPremProviders: Map<string, RelayOnPremTokenProvider> = new Map();
	// Fallback for documents with no recorded server (legacy folders
	// created before onpremServerId existed) -- preserves the old
	// single-provider behavior for that case instead of failing outright.
	private defaultRelayOnPremServerId?: string;
	private isRelayOnPremMode = false;
	// documentId -> filePath, needed by relay-onprem refresh (it has no other
	// way to recover the path once it's holding only a documentId).
	private filePathMap: Map<string, string> = new Map();
	// documentId -> onprem serverId, so refresh()/fetchFileTokenFromApi() can pick
	// the right provider out of relayOnPremProviders. Same outbound-parameter
	// pattern as filePathMap -- kept alongside the ResourceAddress-encoded
	// documentId rather than inside it, since relayId in that encoding is a
	// fixed "relay-onprem" marker, not a real server identifier.
	private documentServerMap: Map<string, string> = new Map();
	// Shares whose token the control plane refused (401/403): not asked again
	// until their backoff runs out, whichever path asks (reconnect gate,
	// background poller, editor open).
	private accessDenied = new AccessDeniedBackoff();
	// The one token request in flight for each share.
	private shareProbes = new Map<string, Promise<void>>();
	// Shares whose last token request timed out. That request cannot be
	// cancelled and may still be in flight, so the share is not asked again
	// until this backoff runs out.
	private stalled = new AccessDeniedBackoff();
	private accessListeners = new Set<(shareId: string) => void>();
	// File grants are bounded, memory-only and never enter the document-token
	// renewal queue or persisted cache. Every request dimension is part of the key.
	private fileTokens = new Map<string, CredentialEntry<FileGrant>>();
	private fileRequests = new Map<string, Promise<FileGrant>>();
	private fileContexts = new WeakMap<object, number>();
	private nextFileContext = 0;
	private fileCacheGeneration = 0;
	private fileCacheDestroyed = false;
	private restorePauses = new Set<string>();
	private restoreListeners = new Set<(documentId: string) => void>();
	private restoreKey(documentId: string, serverId?: string): string {
		return JSON.stringify([serverId ?? this.documentServerMap.get(documentId) ?? this.defaultRelayOnPremServerId ?? "legacy", documentId]);
	}
	isRestoreRequired(documentId: string, serverId?: string): boolean { return this.restorePauses.has(this.restoreKey(documentId, serverId)); }
	onRestoreRequired(listener: (documentId: string) => void): () => void { this.restoreListeners.add(listener); return () => this.restoreListeners.delete(listener); }
	markRestoreRequired(documentId: string, serverId?: string): void {
		if (this.fileCacheDestroyed) return;
		this.restorePauses.add(this.restoreKey(documentId, serverId));
		this.dropFromQueue(documentId);
		for (const listener of this.restoreListeners) listener(documentId);
	}

	constructor(
		private authSession: AuthSession,
		timeProvider: Clock,
		vaultName: string,
		maxConnections = 5,
		relayOnPremProviders?: Map<string, RelayOnPremTokenProvider>,
		app?: App,
		defaultRelayOnPremServerId?: string,
	) {
		super(
			{
				logMessage: namedLogger("[RelayCredentialCache/store]", "debug"),
				getTokenExpiry: getJwtExpiryFromDocumentGrant,
				getClock: () => timeProvider,
				getPersistedTokens: app
					? () =>
							new VaultScopedMap<CredentialEntry<DocumentGrant>>(
								// Persisted storage key, not a class name: this string is
								// the vault-scoped local storage key under which cached
								// credentials already live on every existing install, and
								// it survives restarts. Changing it to match the class name
								// would orphan those entries and force everyone to log in
								// again. Renaming it needs a data migration, not an edit.
								"TokenStore/" + vaultName,
								app,
							)
					: undefined,
				refreshToken: (
					documentId: string,
					onSuccess: (grant: DocumentGrant) => void,
					onError: (err: Error) => void,
				) => void this.gatedRefresh(documentId, onSuccess, onError),
			},
			maxConnections,
		);

		if (relayOnPremProviders && relayOnPremProviders.size > 0) {
			this.relayOnPremProviders = relayOnPremProviders;
			this.isRelayOnPremMode = true;
			this.defaultRelayOnPremServerId = defaultRelayOnPremServerId;
		}
	}

	/**
	 * Resolve the provider for a document's OWN server, falling back to the
	 * default server's provider when the document's server is unknown, and
	 * to whichever provider exists when there's no default either --
	 * matches the pre-multi-server behavior of "there's exactly one
	 * provider" for callers that never recorded a serverId.
	 */
	private getRelayOnPremProvider(documentId: string): RelayOnPremTokenProvider | null {
		const serverId = this.documentServerMap.get(documentId);
		const provider =
			(serverId && this.relayOnPremProviders.get(serverId)) ||
			(this.defaultRelayOnPremServerId &&
				this.relayOnPremProviders.get(this.defaultRelayOnPremServerId)) ||
			this.relayOnPremProviders.values().next().value;
		return provider ?? null;
	}

	/** Relay-onprem mode can flip at runtime (settings change), unlike the
	 * constructor args, which are fixed for the plugin's lifetime. */
	setRelayOnPremMode(enabled: boolean) {
		this.isRelayOnPremMode = enabled;
	}

	/** Multi-server management, mirroring AuthSession's addServer/
	 * removeServer -- main.ts's settings-change watcher keeps this in sync
	 * with relayOnPremSettings.servers. */
	setRelayOnPremProvider(serverId: string, provider: RelayOnPremTokenProvider): void {
		// Destroy whatever provider (if any) this replaces -- callers pass a
		// freshly-constructed provider on a server URL/name edit, not a
		// mutation of the existing one, so the old instance's throttle timer
		// would otherwise leak.
		this.relayOnPremProviders.get(serverId)?.destroy();
		this.relayOnPremProviders.set(serverId, provider);
		this.isRelayOnPremMode = true;
	}

	removeRelayOnPremProvider(serverId: string): void {
		this.relayOnPremProviders.get(serverId)?.destroy();
		this.relayOnPremProviders.delete(serverId);
	}

	setDefaultRelayOnPremServerId(serverId: string | undefined): void {
		this.defaultRelayOnPremServerId = serverId;
	}

	async getToken(
		documentId: string,
		friendlyName: string,
		callback: (token: DocumentGrant) => void,
		onpremServerId?: string,
	): Promise<DocumentGrant> {
		if (this.fileCacheDestroyed) throw new Error("Credential cache was destroyed");
		const havePath = this.isRelayOnPremMode && friendlyName && friendlyName !== "unknown";
		if (havePath) {
			this.filePathMap.set(documentId, friendlyName);
		}
		if (this.isRelayOnPremMode && onpremServerId) {
			this.documentServerMap.set(documentId, onpremServerId);
		}
		if (this.isRestoreRequired(documentId, onpremServerId)) throw new RelayRestoreRequiredError();
		return super.acquireToken(documentId, friendlyName, callback);
	}

	/**
	 * Every token request goes through here: a document reconnecting
	 * (getToken) and the periodic renewal sweep alike, so a refused share is
	 * backed off on both paths.
	 */
	private async gatedRefresh(
		documentId: string,
		onSuccess: (grant: DocumentGrant) => void,
		onError: (err: Error) => void,
	): Promise<void> {
		if (this.fileCacheDestroyed) { onError(new Error("Credential cache was destroyed")); return; }
		const shareId = shareIdOf(documentId);
		// A share's documents ask one at a time, so a share refused at any
		// point (first connect, after a sleep, mid-session) costs one request
		// per backoff window, not one per document asking at once. This
		// costs a working share no throughput: the throttle already spaces
		// token requests 500 ms apart, longer than the request takes
		// (control plane p99 about 230 ms, 27.10).
		// A request that times out on the network (RelayTokenTimeoutError)
		// may still be in flight, so its share is backed off below rather
		// than asked again at once, and the provider sends nothing for that
		// share until the old request has settled.
		for (;;) {
			const probe = this.shareProbes.get(shareId);
			if (!probe) break;
			await probe;
		}
		if (this.fileCacheDestroyed) { onError(new Error("Credential cache was destroyed")); return; }
		const restoreKey = this.restoreKey(documentId);
		if (this.restorePauses.has(restoreKey)) {
			void Promise.resolve().then(() => onError(new RelayRestoreRequiredError()));
			return;
		}
		const now = Date.now();
		const retryAt = this.accessDenied.retryAt(shareId, now);
		if (retryAt !== undefined) {
			const denied = new RelayAccessDeniedError(0, `Relay token refused for share ${shareId}; next try in ${Math.ceil((retryAt - now) / 1000)}s`);
			denied.retryAt = retryAt;
			// Not inline: the renewal queue calls the next refresh from this
			// callback, and a run of backed-off documents would recurse.
			void Promise.resolve().then(() => onError(denied));
			return;
		}
		const stalledUntil = this.stalled.retryAt(shareId, now);
		if (stalledUntil !== undefined) {
			const stalled = new Error(`Relay token request for share ${shareId} timed out; next try in ${Math.ceil((stalledUntil - now) / 1000)}s`);
			void Promise.resolve().then(() => onError(stalled));
			return;
		}
		let settle!: () => void;
		const probe = new Promise<void>((resolve) => (settle = resolve));
		this.shareProbes.set(shareId, probe);
		const done = () => {
			if (this.shareProbes.get(shareId) === probe) this.shareProbes.delete(shareId);
			settle();
		};
		try {
			await universalRefresh(
				this.getRelayOnPremProvider(documentId),
				this.isRelayOnPremMode,
				documentId,
				(grant) => {
					if (this.fileCacheDestroyed) { done(); onError(new Error("Credential cache was destroyed")); return; }
					if (this.restorePauses.has(restoreKey)) { done(); onError(new RelayRestoreRequiredError()); return; }
					const wasDenied = this.accessDenied.isDenied(shareId);
					this.accessDenied.clear(shareId);
					this.stalled.clear(shareId);
					done();
					if (wasDenied) this.notifyAccessChange(shareId);
					onSuccess(grant);
				},
				(err) => {
					if (this.fileCacheDestroyed) { done(); onError(err); return; }
					if (err instanceof RelayRestoreRequiredError) {
						this.restorePauses.add(restoreKey);
						this.dropFromQueue(documentId);
						for (const listener of this.restoreListeners) listener(documentId);
					}
					if (err instanceof RelayAccessDeniedError) {
						const wasDenied = this.accessDenied.isDenied(shareId);
						err.retryAt = this.accessDenied.recordDenied(shareId, Date.now());
						if (!wasDenied) this.notifyAccessChange(shareId);
					}
					if (err instanceof RelayTokenTimeoutError) this.stalled.recordDenied(shareId, Date.now());
					done();
					onError(err);
				},
				this.filePathMap.get(documentId),
			);
		} finally {
			done();
		}
	}

	/** True while the share of this document is refused by the control plane. */
	isAccessDenied(documentId: string): boolean {
		return this.accessDenied.isDenied(shareIdOf(documentId));
	}

	/**
	 * Forget refusals: every share after a sign-in or token refresh, one
	 * share on its manual reconnect.
	 */
	clearAccessDenied(documentId?: string): void {
		const shareId = documentId === undefined ? undefined : shareIdOf(documentId);
		const denied = this.accessDenied.deniedShares().filter((id) => shareId === undefined || id === shareId);
		this.accessDenied.clear(shareId);
		for (const provider of this.relayOnPremProviders.values()) {
			provider.clearRefused(shareId);
		}
		for (const id of denied) this.notifyAccessChange(id);
	}

	/** Called with a share id whenever that share becomes refused or stops being refused. */
	onAccessDeniedChange(listener: (shareId: string) => void): () => void {
		this.accessListeners.add(listener);
		return () => this.accessListeners.delete(listener);
	}

	private notifyAccessChange(shareId: string): void {
		for (const listener of this.accessListeners) listener(shareId);
	}

	clear(filter?: (token: CredentialEntry<DocumentGrant>) => boolean) {
		this.fileCacheGeneration++; this.fileTokens.clear(); this.fileRequests.clear();
		if (!filter) {
			this.filePathMap.clear();
			this.documentServerMap.clear();
			super.purge(filter);
			return;
		}
		this.tokenEntries?.forEach((value, key) => {
			if (filter(value)) {
				this.filePathMap.delete(key);
				this.documentServerMap.delete(key);
			}
		});
		super.purge(filter);
	}

	destroy() {
		this.restoreListeners.clear(); this.restorePauses.clear();
		this.fileCacheDestroyed = true;
		this.fileCacheGeneration++; this.fileTokens.clear(); this.fileRequests.clear();
		this.filePathMap.clear();
		this.documentServerMap.clear();
		for (const provider of this.relayOnPremProviders.values()) {
			provider.destroy();
		}
		this.relayOnPremProviders.clear();
		super.teardown();
	}

	/** Auth header set shared by every request this store makes — bearer JWT
	 * plus the version pin the relay server uses for compat checks. */
	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.authSession.currentUser?.authToken}`,
			"Relay-Version": GIT_TAG,
			"Content-Type": "application/json",
		};
	}

	private async parseFileTokenResponse(
		response: Response,
		debug: (...args: unknown[]) => void,
	): Promise<FileGrant> {
		if (!response.ok) {
			debug(response.status, await response.text());
			const body = (await response.json()) as { error?: string };
			throw new Error(body.error ?? "Unknown error");
		}
		return (await response.json()) as FileGrant;
	}

	async fetchFileTokenFromApi(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
		binding: RestoreBinding = {},
	): Promise<FileGrant> {
		const debug = namedLogger("[RelayCredentialCache/fetchFileTokenFromApi]", "debug");
		debug(`requesting file token for ${documentId}`);

		const entity: ResourceAddressType = ResourceAddress.parse(documentId);
		if (!(entity instanceof RemoteFileAddress)) {
			throw new Error(`${documentId} does not resolve to a remote file`);
		}

		// mirror universalRefresh's isRelayOnPremMode/tokenProvider branch
		// (RelayCredentialRefresh.ts) — this method previously always hit the
		// cloud-backend API regardless of mode, so BlobClient.ts's verify/readFile/writeFile
		// silently used an empty API URL in relay-onprem builds.
		const relayOnPremProvider = this.getRelayOnPremProvider(documentId);
		if (this.isRelayOnPremMode && relayOnPremProvider) {
			return relayOnPremProvider.requestFileToken(
				entity.relayGuid,
				entity.folderGuid,
				entity.fileGuid,
				fileHash,
				contentType,
				contentLength,
				binding,
			);
		}

		if (!this.authSession.isAuthenticated) {
			throw new Error("cannot fetch a file token while logged out");
		}

		const apiUrl = this.authSession.resolveTenantRegistry().resolveApiUrl();
		const response = await platformFetch(`${apiUrl}/file-token`, {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify({
				docId: entity.fileGuid,
				relay: entity.relayGuid,
				folder: entity.folderGuid,
				hash: fileHash,
				contentType,
				contentLength,
			}),
		});

		return this.parseFileTokenResponse(response, debug);
	}

	captureFileContext(documentId: string, onpremServerId?: string): () => void {
		if (this.isRelayOnPremMode && onpremServerId) this.documentServerMap.set(documentId, onpremServerId);
		const provider = this.isRelayOnPremMode ? this.getRelayOnPremProvider(documentId) : null;
		const context = provider?.getFileCredentialContext(), generation = this.fileCacheGeneration;
		const cloudToken = provider ? undefined : this.authSession.currentUser?.authToken;
		return () => {
			const currentProvider = this.isRelayOnPremMode ? this.getRelayOnPremProvider(documentId) : null;
			if (this.fileCacheDestroyed || generation !== this.fileCacheGeneration || currentProvider !== provider
				|| (provider ? provider.getFileCredentialContext() !== context : this.authSession.currentUser?.authToken !== cloudToken)) {
				throw new Error("Attachment account or server changed. Local content is retained.");
			}
		};
	}

	async resolveFileToken(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
		onpremServerId?: string,
		binding: RestoreBinding = {},
	): Promise<FileGrant> {
		if (this.fileCacheDestroyed) throw new Error("Attachment credentials are closed");
		binding = restoreMetadata(binding);
		if (this.isRelayOnPremMode && onpremServerId) this.documentServerMap.set(documentId, onpremServerId);
		const provider = this.isRelayOnPremMode ? this.getRelayOnPremProvider(documentId) : null;
		// Cloud/legacy auth has no session-scoped provider namespace. Do not reuse
		// a credential there across a possible account transition.
		if (!provider) return this.fetchFileTokenFromApi(documentId, fileHash, contentType, contentLength, binding);
		const context = provider.getFileCredentialContext(), generation = this.fileCacheGeneration;
		if (!this.fileContexts.has(context)) this.fileContexts.set(context, ++this.nextFileContext);
		const key = JSON.stringify([this.fileContexts.get(context), documentId, fileHash, contentType, contentLength, binding.restoreGeneration ?? null]);
		const check = () => {
			if (generation !== this.fileCacheGeneration || this.fileCacheDestroyed || !this.isRelayOnPremMode
				|| this.getRelayOnPremProvider(documentId) !== provider || provider.getFileCredentialContext() !== context) {
				throw new Error("Attachment account or server changed. Retry using the current connection.");
			}
		};
		for (const [cachedKey, entry] of this.fileTokens) if (!this.tokenIsValid(entry)) this.fileTokens.delete(cachedKey);
		const cached = this.fileTokens.get(key);
		if (cached?.token) { check(); return cached.token; }
		const inFlight = this.fileRequests.get(key);
		if (inFlight) return inFlight;
		const request = this.fetchFileTokenFromApi(documentId, fileHash, contentType, contentLength, binding).then(token => {
			check();
			this.fileTokens.set(key, { token, expiryTime: this.resolveJwtExpiry(token), attempts: 0, friendlyName: documentId });
			while (this.fileTokens.size > 256) this.fileTokens.delete(this.fileTokens.keys().next().value!);
			return token;
		}).finally(() => { if (this.fileRequests.get(key) === request) this.fileRequests.delete(key); });
		this.fileRequests.set(key, request);
		return request;
	}
}
