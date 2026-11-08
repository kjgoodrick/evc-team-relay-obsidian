// Token store wiring specific to the real-time (TeamRelayPlugin) client path.
import { CredentialCache, type CredentialEntry } from "./CredentialCache";
import type { Clock } from "./Clock";
import { AuthSession } from "./AuthSession";
import { namedLogger } from "./logging";
import type { DocumentGrant, FileGrant } from "./relay/TokenShapes";
import type { App } from "obsidian";
import { ResourceAddress, type ResourceAddressType, RemoteFileAddress, RemoteFolderAddress } from "./ResourceAddress";
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
import { assertSourceCacheBinding } from "./storage/source-document-cache";

interface DocumentCredentialContext {
	key: string; documentId: string; shareId: string; shareKey: string; probeKey: string; serverId: string;
	provider: RelayOnPremTokenProvider; binding: RestoreBinding; filePath?: string;
	check(): void;
}

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
	private documentDefaultGeneration = 0;
	private isRelayOnPremMode = false;
	// File-transfer provider selection. Document credentials instead retain an
	// immutable server/session context; identical resource IDs may exist on two servers.
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
	private documentContexts = new Map<string, DocumentCredentialContext>();
	private knownDocumentIdentities = new WeakSet<object>();
	private documentGrantContexts = new WeakMap<DocumentGrant, DocumentCredentialContext>();
	private deniedContextShares = new Map<string, { shareId: string; serverId: string }>();
	private restorePauses = new Set<string>();
	private restoreListeners = new Set<(documentId: string) => void>();
	private documentServer(serverId?: string): string | undefined {
		return serverId ?? this.defaultRelayOnPremServerId ?? this.relayOnPremProviders.keys().next().value;
	}
	assertDocumentSourceCache(metadata: string, documentId: string, serverId?: string, binding: RestoreBinding = {}): void {
		const selected = this.documentServer(serverId), provider = selected ? this.relayOnPremProviders.get(selected) : undefined;
		if (this.fileCacheDestroyed || !this.isRelayOnPremMode || !selected || !provider) throw new Error("The source cache server is unavailable. Local history is retained.");
		assertSourceCacheBinding(metadata, documentId, selected, provider.controlPlaneEndpoint, binding);
	}
	captureDocumentSourceContext(serverId?: string): { serverId: string; controlPlaneUrl: string; check: () => void } | undefined {
		const selected = this.documentServer(serverId), provider = selected ? this.relayOnPremProviders.get(selected) : undefined;
		if (this.fileCacheDestroyed || !this.isRelayOnPremMode || !selected || !provider) return;
		const identity = provider.getFileCredentialContext(), epoch = this.fileCacheGeneration, selection = this.documentDefaultGeneration;
		return { serverId: selected, controlPlaneUrl: provider.controlPlaneEndpoint, check: () => {
			if (this.fileCacheDestroyed || !this.isRelayOnPremMode || epoch !== this.fileCacheGeneration || this.relayOnPremProviders.get(selected) !== provider
				|| provider.getFileCredentialContext() !== identity || serverId === undefined && selection !== this.documentDefaultGeneration) {
				throw new Error("Source cache account or server changed. Local history is retained.");
			}
		} };
	}
	/** Recovery inspection never borrows a cached writer grant or subscribes
	 * for renewal. The explicit read grant and its context live only as long as
	 * the caller's short-lived source preview. */
	async requestSourceInspectionToken(documentId: string, filePath: string, serverId: string | undefined, binding: RestoreBinding, checkContext = () => {}): Promise<{ grant: DocumentGrant; check: () => void }> {
		binding = Object.freeze(restoreMetadata(binding));
		const address = ResourceAddress.parse(documentId), source = this.captureDocumentSourceContext(serverId);
		if (!source || !("relayGuid" in address) || !("folderGuid" in address)
			|| !("documentGuid" in address || "canvasGuid" in address) || ResourceAddress.serialize(address) !== documentId) {
			throw new Error("A managed source document and available server are required for inspection");
		}
		const provider = this.relayOnPremProviders.get(source.serverId)!;
		const check = () => { source.check(); checkContext(); };
		check();
		const id = "documentGuid" in address ? address.documentGuid : address.canvasGuid;
		const grant = await provider.requestToken(address.relayGuid, address.folderGuid, id, "read", filePath, binding, check);
		check();
		if (grant.authorization !== "read-only" || grant.docId !== id || (grant.restoreGeneration ?? null) !== (binding.restoreGeneration ?? null)) {
			throw new Error("The server did not return the requested read-only source context");
		}
		return { grant, check };
	}
	/** A recovery inventory refresh may read the selected generation, but must
	 * never borrow a writer grant or join the ordinary index refresh loop. */
	async requestInventoryInspectionToken(documentId: string, serverId: string | undefined, binding: RestoreBinding, checkContext = () => {}): Promise<{ grant: DocumentGrant; check: () => void }> {
		binding = Object.freeze(restoreMetadata(binding));
		const address = ResourceAddress.parse(documentId), source = this.captureDocumentSourceContext(serverId);
		if (!source || !(address instanceof RemoteFolderAddress) || ResourceAddress.serialize(address) !== documentId) {
			throw new Error("A managed folder and available server are required for inspection");
		}
		const provider = this.relayOnPremProviders.get(source.serverId)!;
		const check = () => { source.check(); checkContext(); };
		check();
		const grant = await provider.requestToken(address.relayGuid, address.folderGuid, address.folderGuid, "read", undefined, binding, check);
		check();
		if (grant.authorization !== "read-only" || grant.docId !== address.folderGuid || grant.folder !== address.folderGuid
			|| grant.restoreGuard !== true || (grant.restoreGeneration ?? null) !== (binding.restoreGeneration ?? null)
			|| !grant.token || !grant.expiryTime || grant.expiryTime <= Date.now()) {
			throw new Error("The server did not return the requested read-only inventory context");
		}
		return { grant, check };
	}
	/** Fresh inspection credentials cannot reuse or populate ordinary attachment
	 * grants. In particular, an owner's normal sync grant has upload authority. */
	async requestFileInspectionToken(documentId: string, fileHash: string, contentType: string, serverId: string | undefined, binding: RestoreBinding, checkContext = () => {}): Promise<{ grant: FileGrant; check: () => void }> {
		binding = Object.freeze(restoreMetadata(binding));
		const address = ResourceAddress.parse(documentId), source = this.captureDocumentSourceContext(serverId);
		if (!source || !(address instanceof RemoteFileAddress) || ResourceAddress.serialize(address) !== documentId
			|| !/^[a-f0-9]{64}$/.test(fileHash)) {
			throw new Error("A managed attachment, digest and available server are required for inspection");
		}
		const provider = this.relayOnPremProviders.get(source.serverId)!;
		const check = () => { source.check(); checkContext(); };
		check();
		const grant = await provider.requestFileToken(address.relayGuid, address.folderGuid, address.fileGuid,
			fileHash, contentType, 0, binding, { readOnly: true, check });
		check();
		if (grant.authorization !== "read-only" || grant.docId !== address.fileGuid || grant.folder !== address.folderGuid
			|| grant.restoreGuard !== true || (grant.restoreGeneration ?? null) !== (binding.restoreGeneration ?? null)
			|| grant.fileHash !== fileHash || !Number.isFinite(grant.expiryTime) || grant.expiryTime <= Date.now()) {
			throw new Error("The server did not return the requested read-only attachment context");
		}
		return { grant, check };
	}
	private restoreKey(documentId: string, serverId?: string, binding: RestoreBinding = {}): string {
		return JSON.stringify([this.documentServer(serverId) ?? "legacy", documentId, restoreMetadata(binding).restoreGeneration ?? null]);
	}
	isRestoreRequired(documentId: string, serverId?: string, binding: RestoreBinding = {}): boolean { return this.restorePauses.has(this.restoreKey(documentId, serverId, binding)); }
	onRestoreRequired(listener: (documentId: string) => void): () => void { this.restoreListeners.add(listener); return () => this.restoreListeners.delete(listener); }
	markRestoreRequired(documentId: string, serverId?: string, binding: RestoreBinding = {}): void {
		if (this.fileCacheDestroyed) return;
		this.restorePauses.add(this.restoreKey(documentId, serverId, binding));
		this.dropFromQueue(documentId, serverId, binding);
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
				// Short-lived document grants are memory-only. Old persisted grants
				// lack a proven server/session/lineage and must never seed this cache.
				refreshToken: (
					documentId: string,
					onSuccess: (grant: DocumentGrant) => void,
					onError: (err: Error) => void,
				) => void this.gatedRefresh(documentId, onSuccess, onError),
			},
			maxConnections,
		);
		// Keep the constructor's vault/app arguments for existing integrations.
		// Authentication itself remains in AuthSession, independently of this cache.
		void vaultName; void app;

		if (relayOnPremProviders && relayOnPremProviders.size > 0) {
			this.relayOnPremProviders = relayOnPremProviders;
			this.isRelayOnPremMode = true;
			this.defaultRelayOnPremServerId = defaultRelayOnPremServerId;
		}
	}

	/** File transfers may use the default only when no server was selected.
	 * An explicitly selected but unavailable server must not redirect credentials. */
	private getRelayOnPremProvider(documentId: string): RelayOnPremTokenProvider | null {
		const serverId = this.documentServerMap.get(documentId);
		if (serverId !== undefined) return this.relayOnPremProviders.get(serverId) ?? null;
		if (this.defaultRelayOnPremServerId !== undefined) return this.relayOnPremProviders.get(this.defaultRelayOnPremServerId) ?? null;
		return this.relayOnPremProviders.values().next().value ?? null;
	}

	/** Relay-onprem mode can flip at runtime (settings change), unlike the
	 * constructor args, which are fixed for the plugin's lifetime. */
	setRelayOnPremMode(enabled: boolean) {
		if (this.isRelayOnPremMode !== enabled) {
			this.fileCacheGeneration++; this.fileTokens.clear(); this.fileRequests.clear();
		}
		this.isRelayOnPremMode = enabled;
		this.pruneDocumentContexts();
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
		this.pruneDocumentContexts();
	}

	removeRelayOnPremProvider(serverId: string): void {
		this.relayOnPremProviders.get(serverId)?.destroy();
		this.relayOnPremProviders.delete(serverId);
		this.pruneDocumentContexts();
	}

	setDefaultRelayOnPremServerId(serverId: string | undefined): void {
		if (this.defaultRelayOnPremServerId !== serverId) this.documentDefaultGeneration++;
		this.defaultRelayOnPremServerId = serverId;
		this.pruneDocumentContexts();
	}

	private documentContext(documentId: string, serverId: string | undefined, binding: RestoreBinding, create: boolean): DocumentCredentialContext | undefined {
		if (this.fileCacheDestroyed || !this.isRelayOnPremMode) return;
		const selected = this.documentServer(serverId), provider = selected ? this.relayOnPremProviders.get(selected) : undefined;
		if (!selected || !provider) return;
		const identity = provider.getFileCredentialContext();
		if (create && !this.knownDocumentIdentities.has(identity)) {
			this.knownDocumentIdentities.add(identity); this.pruneDocumentContexts();
		}
		if (!this.fileContexts.has(identity)) {
			if (!create) return;
			this.fileContexts.set(identity, ++this.nextFileContext);
		}
		const contextId = this.fileContexts.get(identity), generation = this.fileCacheGeneration, defaultGeneration = this.documentDefaultGeneration;
		const key = JSON.stringify(["document", generation, selected, contextId, documentId, binding.restoreGeneration ?? null, serverId === undefined ? defaultGeneration : null]);
		const existing = this.documentContexts.get(key) ?? (!create ? this.documentContexts.get(JSON.stringify(
			["document", generation, selected, contextId, documentId, binding.restoreGeneration ?? null, serverId !== undefined ? defaultGeneration : null])) : undefined);
		if (existing || !create) return existing;
		const shareId = shareIdOf(documentId), shareKey = JSON.stringify([selected, contextId, binding.restoreGeneration ?? null, shareId]);
		const probeKey = JSON.stringify([shareKey, generation, serverId === undefined ? defaultGeneration : null]);
		const context: DocumentCredentialContext = { key, documentId, shareId, shareKey, probeKey, serverId: selected, provider, binding,
			check: () => {
				if (this.fileCacheDestroyed || !this.isRelayOnPremMode || generation !== this.fileCacheGeneration
					|| this.relayOnPremProviders.get(selected) !== provider || provider.getFileCredentialContext() !== identity
					|| serverId === undefined && (this.documentServer() !== selected || this.documentDefaultGeneration !== defaultGeneration)) throw new Error("Document account or server changed. Retry using the current connection.");
			} };
		this.documentContexts.set(key, context);
		return context;
	}

	private pruneDocumentContexts(): void {
		const currentShares = new Set<string>();
		for (const [key, context] of this.documentContexts) {
			try { context.check(); currentShares.add(context.shareKey); } catch {
				super.dropFromQueue(key); this.tokenEntries.delete(key);
				if (!this._inFlightPromises.has(key)) this.documentContexts.delete(key);
			}
		}
		for (const key of this.accessDenied.deniedShares()) if (!currentShares.has(key)) {
			this.accessDenied.clear(key); this.deniedContextShares.delete(key);
		}
		for (const key of this.stalled.deniedShares()) if (!currentShares.has(key)) this.stalled.clear(key);
	}

	override peekToken(documentId: string, serverId?: string, binding: RestoreBinding = {}): DocumentGrant | null | undefined {
		const context = this.documentContext(documentId, serverId, restoreMetadata(binding), false);
		if (!context) return;
		try { context.check(); } catch { return; }
		return super.peekToken(context.key);
	}

	isDocumentGrantCurrent(grant: DocumentGrant, documentId: string, serverId?: string, binding: RestoreBinding = {}): boolean {
		binding = restoreMetadata(binding);
		const context = this.documentGrantContexts.get(grant);
		if (!context || context.documentId !== documentId || context.serverId !== this.documentServer(serverId)
			|| (context.binding.restoreGeneration ?? null) !== (binding.restoreGeneration ?? null)) return false;
		if (this.documentContext(documentId, serverId, binding, true)?.key !== context.key) return false;
		try { context.check(); return true; } catch { return false; }
	}

	override dropFromQueue(documentId: string, serverId?: string, binding: RestoreBinding = {}): boolean {
		binding = restoreMetadata(binding);
		if (this.documentContexts.has(documentId)) return super.dropFromQueue(documentId);
		let removed = false;
		for (const context of this.documentContexts.values()) {
			if (context.documentId === documentId && (serverId === undefined || context.serverId === serverId)
				&& (context.binding.restoreGeneration ?? null) === (binding.restoreGeneration ?? null)) removed = super.dropFromQueue(context.key) || removed;
		}
		return removed;
	}

	async getToken(
		documentId: string,
		friendlyName: string,
		callback: (token: DocumentGrant) => void,
		onpremServerId?: string,
		binding: RestoreBinding = {},
	): Promise<DocumentGrant> {
		if (this.fileCacheDestroyed) throw new Error("Credential cache was destroyed");
		binding = restoreMetadata(binding);
		if (this.isRestoreRequired(documentId, onpremServerId, binding)) throw new RelayRestoreRequiredError();
		const context = this.documentContext(documentId, onpremServerId, binding, true);
		if (!context) throw new Error("No relay-onprem server configured for this document");
		if (friendlyName && friendlyName !== "unknown") context.filePath = friendlyName;
		try {
			const result = await super.acquireToken(context.key, friendlyName, grant => { context.check(); callback(grant); });
			context.check(); return result;
		} finally {
			try { context.check(); } catch {
				super.dropFromQueue(context.key); this.tokenEntries.delete(context.key); this.documentContexts.delete(context.key);
			}
		}
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
		const cacheKey = documentId, context = this.documentContexts.get(cacheKey);
		if (!context) { void Promise.resolve().then(() => onError(new Error("Document credential context expired"))); return; }
		const shareId = context.shareKey, filePath = context.filePath;
		documentId = context.documentId;
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
			const probe = this.shareProbes.get(context.probeKey);
			if (!probe) break;
			await probe;
		}
		try { context.check(); } catch (error) { void Promise.resolve().then(() => onError(error instanceof Error ? error : new Error(String(error)))); return; }
		if (this.fileCacheDestroyed) { onError(new Error("Credential cache was destroyed")); return; }
		const restoreKey = this.restoreKey(documentId, context.serverId, context.binding);
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
		this.shareProbes.set(context.probeKey, probe);
		const done = () => {
			if (this.shareProbes.get(context.probeKey) === probe) this.shareProbes.delete(context.probeKey);
			settle();
		};
		const current = () => {
			try { context.check(); return true; }
			catch (error) { done(); onError(error instanceof Error ? error : new Error(String(error))); return false; }
		};
		try {
			await universalRefresh(
				context.provider,
				this.isRelayOnPremMode,
				documentId,
				(grant) => {
					if (!current()) return;
					if (this.restorePauses.has(restoreKey)) { done(); onError(new RelayRestoreRequiredError()); return; }
					const wasDenied = this.accessDenied.isDenied(shareId);
					this.accessDenied.clear(shareId);
					this.deniedContextShares.delete(shareId);
					this.stalled.clear(shareId);
					done();
					if (wasDenied) this.notifyAccessChange(context.shareId);
					this.documentGrantContexts.set(grant, context);
					onSuccess(grant);
				},
				(err) => {
					if (!current()) return;
					if (err instanceof RelayRestoreRequiredError) {
						this.restorePauses.add(restoreKey);
						super.dropFromQueue(cacheKey);
						for (const listener of this.restoreListeners) listener(documentId);
					}
					if (err instanceof RelayAccessDeniedError) {
						this.deniedContextShares.set(shareId, { shareId: context.shareId, serverId: context.serverId });
						const wasDenied = this.accessDenied.isDenied(shareId);
						err.retryAt = this.accessDenied.recordDenied(shareId, Date.now());
						if (!wasDenied) this.notifyAccessChange(context.shareId);
					}
					if (err instanceof RelayTokenTimeoutError) this.stalled.recordDenied(shareId, Date.now());
					done();
					onError(err);
				},
				filePath, context.binding, context.check,
			);
		} catch (error) {
			onError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			done();
		}
	}

	/** True while the share of this document is refused by the control plane. */
	isAccessDenied(documentId: string, serverId?: string, binding: RestoreBinding = {}): boolean {
		const context = this.documentContext(documentId, serverId, restoreMetadata(binding), true);
		if (!context) return false;
		try { context.check(); return this.accessDenied.isDenied(context.shareKey); } catch { return false; }
	}

	/**
	 * Forget refusals: every share after a sign-in or token refresh, one
	 * share on its manual reconnect.
	 */
	clearAccessDenied(documentId?: string, serverId?: string): void {
		const shareId = documentId === undefined ? undefined : shareIdOf(documentId);
		const denied = this.accessDenied.deniedShares().filter(key => {
			const identity = this.deniedContextShares.get(key);
			return (shareId === undefined || identity?.shareId === shareId) && (serverId === undefined || identity?.serverId === serverId);
		});
		for (const key of denied) this.accessDenied.clear(key);
		for (const [id, provider] of this.relayOnPremProviders) {
			if (serverId === undefined || id === serverId) provider.clearRefused(shareId);
		}
		for (const key of denied) {
			const identity = this.deniedContextShares.get(key);
			if (identity) this.notifyAccessChange(identity.shareId);
			this.deniedContextShares.delete(key);
		}
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
		this.pruneDocumentContexts();
		if (!filter) {
			this.documentServerMap.clear();
			super.purge(filter);
			return;
		}
		super.purge(filter);
	}

	destroy() {
		this.restoreListeners.clear(); this.restorePauses.clear();
		this.fileCacheDestroyed = true;
		this.documentContexts.clear(); this.deniedContextShares.clear();
		this.fileCacheGeneration++; this.fileTokens.clear(); this.fileRequests.clear();
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
		if (this.isRelayOnPremMode) throw new Error("No relay-onprem server configured for this file");

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
