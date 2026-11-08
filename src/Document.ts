import { ItemKind } from "./ItemKinds";
import { LocalDocumentStore } from "./storage/local-document-store";
import type { SourceCacheDescriptor } from "./storage/source-document-cache";
import { trackNativeDocumentWrite } from "./storage/native-document-writes";
import * as Y from "yjs";
import { ProviderBacked } from "./ProviderBacked";
import { AuthSession } from "./AuthSession";
import { DocumentAddress, FolderAddress, ResourceAddress, RemoteDocumentAddress } from "./ResourceAddress";
import { VaultShare } from "./VaultShare";
import type { TFile, Vault, TFolder } from "obsidian";
import { debounce } from "obsidian";
import { UnsavedFile, UnsavedFileStore } from "./UnsavedFile";
import type { Unsubscriber } from "./notifiers/Notifier";
import { LazyValue } from "./asyncCache";
import { currentToggles, withToggle } from "./featureToggleState";
import { featureKey } from "./featureToggles";
import type { MimeTyped, SyncableEntry } from "./SyncableEntry";
import { mimeTypeForPath } from "./mimeLookup";
import { applyDiffToYText } from "./ytextDiff";

export function isDocument(file?: SyncableEntry): file is Document {
	return file instanceof Document;
}

interface ExtAndBase {
	extension: string;
	basename: string;
}

/** Split a `name` into its extension + basename (name minus that extension). */
function extAndBase(name: string): ExtAndBase {
	const extension = name.split(".").pop() || "";
	const basename = name.replace(`.${extension}`, "");
	return { extension, basename };
}

export class Document extends ProviderBacked implements SyncableEntry, MimeTyped {
	private _parent: VaultShare;
	private _indexeddbPersistence: LocalDocumentStore;
	firstSyncPromise: LazyValue<void> | null = null;
	isLocallyPersisted: boolean = false;
	_hasPendingCrdtUpdate?: boolean;
	syncedPromise?: LazyValue<Document>;
	entryPath: string;
	_obsidianFile: TFile | null;
	docLabel: string;
	editLock: boolean = false;
	docSuffix: string;
	docStem: string;
	obsidianVault: Vault;
	fileMetrics: {
		ctime: number;
		mtime: number;
		size: number;
	};
	_unsavedFile?: UnsavedFile;
	_unsavedFileStore?: UnsavedFileStore;
	private unsavedOperations: Promise<void> = Promise.resolve();
	private unsavedDirty = false;
	private unsavedPersistedText?: string | null;
	private unsavedClosed = false;
	_teardownCallbacks: Unsubscriber[] = [];
	queuedTextOps: ((data: string) => string)[] = [];
	private readonly sourceCache?: Readonly<SourceCacheDescriptor & { bufferKey: string }>;
	get recoverySourceCache(): Readonly<SourceCacheDescriptor> | undefined { return this.sourceCache; }
	private readonly selectedRestoreGeneration: string | null = null;
	private get bufferKey(): string { return this.sourceCache?.bufferKey ?? this.entityGuid; }

	constructor(
		path: string,
		guid: string,
		loginManager: AuthSession,
		parent: VaultShare,
	) {
		const s3rn = parent.workspaceId
			? new RemoteDocumentAddress(parent.workspaceId, parent.entityGuid, guid)
			: new DocumentAddress(parent.entityGuid, guid);
		parent.sourceSelection?.assertFolder(parent.hostAppId, parent.config.onpremServerId, ResourceAddress.serialize(parent.resourceAddress));
		const sourceCache = parent.sourceSelection?.document(ResourceAddress.serialize(s3rn));
		super(guid, s3rn, parent.credentialCache, loginManager, parent.config.onpremServerId, parent.sourceSelection?.binding, parent.sourceSelection);
		this.sourceCache = sourceCache;
		this.selectedRestoreGeneration = parent.sourceSelection?.binding?.restoreGeneration ?? null;

		this._parent = parent;
		this.entryPath = path;
		// NB: unlike relocate() below, the CRDT display label carries a "[CRDT] "
		// prefix here, and docSuffix/docStem are derived FROM that prefixed
		// label (matches the original's behavior — the prefix ends up folded
		// into `docStem` too; preserved as-is rather than "fixed").
		this.docLabel = "[CRDT] " + (path.split("/").pop() || "");
		({ extension: this.docSuffix, basename: this.docStem } = extAndBase(this.docLabel));
		this.setLoggers(this.docLabel);
		this.obsidianVault = this._parent.vaultApi;
		this.fileMetrics = { ctime: Date.now(), mtime: Date.now(), size: 0 };
		this._unsavedFileStore = this.vaultShare.unsavedStore;
		this._obsidianFile = null;

		this.watchParentDisconnect();

		this.setLoggers(`[SharedDoc](${this.entryPath})`);
		this._indexeddbPersistence = this.openPersistence();
		this.retainRestoreReviewIn(this._indexeddbPersistence);

		void this.awaitFirstSync().then(() => this.bootstrapAfterSync()).catch(error => this.warn("Document startup paused", error));
		withToggle(featureKey.enableDeltaLogging, () => this.attachDeltaLogger());
	}

	/** Read live rather than the value captured at construction — see the
	 * base-class doc comment for why. */
	protected override getOnpremServerId(): string | undefined {
		return this._parent?.config.onpremServerId ?? this.onpremServerId;
	}
	get restoreReviewRequired(): boolean {
		const index = this._parent?._liveProvider?.managedIndex;
		const generation = index?.snapshot?.restore_generation;
		const selected = this.selectedRestoreGeneration ?? null;
		return !!index?.restoreReview || generation !== undefined && generation !== selected || super.restoreReviewRequired;
	}

	private openPersistence(): LocalDocumentStore {
		try {
			const key = this.sourceCache?.name ?? `${this.vaultShare.hostAppId}-relay-doc-${this.entityGuid}`;
			return new LocalDocumentStore(key, this.crdtDoc, this.sourceCache?.identity);
		} catch (e: unknown) {
			this.warn("Unable to open persistence.", this.entityGuid);
			console.error(e);
			throw e;
		}
	}

	/**
	 * Disconnect this document's provider when the parent VaultShare is
	 * intentionally offline (user disabled connection in settings), but not
	 * during transient reconnections. VaultShare._wantsConnection comes from
	 * user settings and stays true during connection-error → disconnect →
	 * reconnect cycles.
	 * Without this check, transient parent disconnects kill all child
	 * Document WS connections permanently (provider.shouldConnect=false
	 * prevents auto-reconnect, deadlocking the download pipeline).
	 */
	private watchParentDisconnect(): void {
		this._teardownCallbacks.push(
			this._parent.subscribe(this.entryPath, (state) => {
				if (this.restoreReviewRequired) { this.pauseForRestore(); return; }
				if (state.intent === "disconnected" && !this._parent.wantsConnection) {
					this.goOffline();
				}
			}),
		);
	}

	private attachStatsObserver(): void {
		const statsObserver = (event: Y.YTextEvent) => {
			const origin: unknown = event.transaction.origin;
			if (event.changes.keys.size === 0) return;
			if (origin == this) return;
			this.refreshFileStats();
		};
		this.crdtText.observe(statsObserver);
		this._teardownCallbacks.push(() => this.crdtText?.unobserve(statsObserver));
	}

	/**
	 * Announces this client's own text changes on the folder's activity map
	 * so receivers with this note closed pull it first instead of waiting for
	 * their sweep to reach it (docActivity.ts). `transaction.local`
	 * is false for updates applied from the relay or from IndexedDB, so only
	 * changes made here -- editor input, a closed-file upload applying the
	 * vault diff -- are announced.
	 */
	private attachActivityObserver(): void {
		const activityObserver = (event: Y.YTextEvent) => {
			if (!event.transaction.local) return;
			this._parent?.docActivity?.noteLocalEdit(this.entityGuid, () => this.crdtText.toString());
		};
		this.crdtText.observe(activityObserver);
		this._teardownCallbacks.push(() => this.crdtText?.unobserve(activityObserver));
	}

	private attachDeltaLogger(): void {
		const logObserver = (event: Y.YTextEvent) => {
			const originCtor = (
				event.transaction.origin as { constructor?: { name?: string } } | null | undefined
			)?.constructor?.name;
			let log = `Transaction origin: ${String(event.transaction.origin)} ${originCtor ?? ""}\n`;
			for (const delta of event.changes.delta) {
				log += `insert: ${String(delta.insert)}\n\nretain: ${delta.retain}\n\ndelete: ${delta.delete}\n`;
			}
			this.debug(log);
		};
		this.crdtText.observe(logObserver);
		this._teardownCallbacks.push(() => this.crdtText.unobserve(logObserver));
	}

	private recordPersistenceMetadata(): void {
		try {
			void this._indexeddbPersistence.set("path", this.entryPath);
			void this._indexeddbPersistence.set("relay", this.vaultShare.workspaceId || "");
			void this._indexeddbPersistence.set("appId", this.vaultShare.hostAppId);
			void this._indexeddbPersistence.set("s3rn", ResourceAddress.serialize(this.resourceAddress));
		} catch {
			// pass
		}
	}

	private async bootstrapAfterSync(): Promise<void> {
		this.attachStatsObserver();
		this.attachActivityObserver();
		this.refreshFileStats();
		this.recordPersistenceMetadata();
		if (this.restoreReviewRequired) return;

		const serverSynced = await this.getServerAcked();
		if (!serverSynced) {
			await this.onceEverSynced();
			await this.markServerAcked();
		}
		void this.vaultShare.noteUploaded(this).catch(error => this.warn("Document metadata was not acknowledged", error));
	}

	relocate(newPath: string, vaultShare: VaultShare) {
		this.entryPath = newPath;
		this._parent = vaultShare;
		this.docLabel = newPath.split("/").pop() || "";
		({ extension: this.docSuffix, basename: this.docStem } = extAndBase(this.docLabel));
		this.refreshFileStats();
	}

	applyQueuedOps(fn: (data: string) => string) {
		if (this.obsidianFile && currentToggles().enableAutomaticDiffResolution) {
			this.queuedTextOps.push(fn);
		}
	}

	public get parentFolder(): TFolder | null {
		return this.obsidianFile?.parent || null;
	}

	public get vaultShare(): VaultShare {
		return this._parent;
	}

	/**
	 * Get the full vault path for this document (shared folder path + relative path).
	 * Combines the shared folder path with the document's relative path.
	 * Used for relay-onprem token requests that need full vault paths.
	 */
	override getVaultPath(): string {
		if (this._parent && this.entryPath) {
			return `${this._parent.path}/${this.entryPath}`;
		}
		return this.entryPath || "unknown";
	}

	override async requestProviderToken() {
		await this.vaultShare.ensureManagedEntry?.(this.entryPath, { id: this.entityGuid, version: 0, type: ItemKind.Document });
		return super.requestProviderToken();
	}

	public get obsidianFile(): TFile | null {
		if (!this._obsidianFile) {
			this._obsidianFile = this.getObsidianFile();
		}
		return this._obsidianFile;
	}

	getObsidianFile(): TFile | null {
		return this._parent?.toVaultFile(this);
	}

	public get crdtText(): Y.Text {
		return this.crdtDoc.getText("contents");
	}

	public get content(): string {
		return this.crdtText ? this.crdtText.toJSON() : "";
	}

	public async unsavedFile(read = false): Promise<TFile> {
		return this.queueUnsaved(async () => {
			this.checkUnsavedOpen();
			if (this._unsavedFile && (!read || this.unsavedDirty)) {
				if (this.unsavedDirty) await this.persistUnsavedFile(this._unsavedFile);
				return this._unsavedFile;
			}
			const storedContents = await this._unsavedFileStore!.readUnsaved(this.bufferKey);
			this.checkUnsavedOpen();
			this.unsavedPersistedText = storedContents;
			const fileContents =
				storedContents !== null
					? storedContents
					: await this._parent.readContents(this);
			this.checkUnsavedOpen();
			if (storedContents !== null) {
				const contents = storedContents.replace(/\r\n/g, "\n");
				if (!this._unsavedFile || this._unsavedFile.unsavedText !== contents) this._unsavedFile = this.createUnsavedFile(contents);
				return this._unsavedFile;
			}
			return this.updateUnsavedFile(fileContents.replace(/\r\n/g, "\n"));
		});
	}

	private queueUnsaved<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.unsavedOperations.then(operation);
		this.unsavedOperations = result.then(() => {}, () => {});
		return result;
	}
	private checkUnsavedOpen(): void {
		if (this.unsavedClosed || !this._unsavedFileStore || !this._parent) throw new Error("This document buffer is closed. Reopen the document before continuing.");
	}
	private async persistUnsavedFile(file: UnsavedFile): Promise<void> {
		const contents = file.unsavedText;
		this.unsavedDirty = true;
		const store = this._unsavedFileStore!;
		if (this.unsavedPersistedText === undefined) {
			this.unsavedPersistedText = await store.readUnsaved(this.bufferKey); this.checkUnsavedOpen();
		}
		if (!await store.persistUnsavedIfContents(this.bufferKey, this.unsavedPersistedText, contents)) throw new Error("Another session saved a newer local buffer. Both copies are retained; review them before continuing.");
		this.checkUnsavedOpen();
		this.unsavedPersistedText = contents; this.unsavedDirty = false;
	}
	private async updateUnsavedFile(contents: string): Promise<TFile> {
		this.checkUnsavedOpen();
		if (!this._unsavedFile || this._unsavedFile.unsavedText !== contents) {
			this._unsavedFile = this.createUnsavedFile(contents);
		}
		await this.persistUnsavedFile(this._unsavedFile);
		return this._unsavedFile;
	}
	private createUnsavedFile(contents: string): UnsavedFile {
		const file = new UnsavedFile(this._parent.vaultApi, "local disk", contents, next => this.queueUnsaved(async () => {
			this.checkUnsavedOpen();
			if (file !== this._unsavedFile) throw new Error("The local buffer changed. Reopen the merge review before editing it.");
			file.unsavedText = next;
			await this.persistUnsavedFile(file);
		}));
		return file;
	}
	setUnsavedFile(contents: string): Promise<TFile> {
		return this.queueUnsaved(() => this.updateUnsavedFile(contents));
	}

	async clearUnsavedFile(expected = this._unsavedFile): Promise<void> {
		await this.queueUnsaved(async () => {
			this.checkUnsavedOpen();
			if (!expected) return;
			if (expected !== this._unsavedFile || this.unsavedDirty || typeof this.unsavedPersistedText !== "string") throw new Error("The local buffer changed or has not been saved. Review it again before clearing it.");
			const removed = await this._unsavedFileStore!.discardUnsavedIfContents(this.bufferKey, this.unsavedPersistedText);
			if (!removed) throw new Error("The saved buffer changed in another session. Review it again before clearing it.");
			this._unsavedFile = undefined; this.unsavedPersistedText = undefined;
		});
	}

	/**
	 * Compare the on-disk buffer against the live CRDT text and, where
	 * possible, resolve the drift via any queued diff-patch ops.
	 */
	public async refreshIfStale(): Promise<boolean> {
		await this.awaitFirstSync();
		const diskBuffer = await this.unsavedFile(true);
		const contents = (diskBuffer as UnsavedFile).unsavedText;

		// Relay-linked docs (relayId is set for ANY doc belonging to a Team
		// Relay workspace — hosted or self-hosted on-prem, not just genuinely
		// self-hosted installs; see ): they never use the HTTP
		// `as-update` endpoint (TransferQueue.fetchDocument skips it) —
		// WebSocket sync is authoritative instead, so this.crdtDoc/this.content is
		// already kept current by the live WS connection. Skip the doomed
		// HTTP re-fetch, but still run the real staleness comparison below
		// using what's already synced.
		//
		// this used to `return false` unconditionally
		// before any comparison ran, making the entire conflict-detection UI
		// (merge banner / differ) dead code on tr.entire.vc, the only prod
		// auth mode — it never triggered for any relay-linked doc.
		if (!this.vaultShare.workspaceId) {
			const response = await this.vaultShare.transfers.fetchItem(this);
			Y.applyUpdate(this.crdtDoc, new Uint8Array(response.arrayBuffer));
		}

		const beforePatch = this.content;
		const stale = beforePatch !== contents;

		let candidate = beforePatch;
		for (const fn of this.queuedTextOps) {
			candidate = fn(candidate);
			if (candidate !== contents) continue;

			if (beforePatch !== this.content) {
				if (currentToggles().enableDeltaLogging) {
					this.warn(
						"applyDiffToYText solution is stale an cannot be applied",
						candidate,
						this.content,
					);
				} else {
					this.log("applyDiffToYText solution is stale an cannot be applied");
				}
				return true;
			}
			applyDiffToYText(this.crdtDoc, candidate, this);
			await this.clearUnsavedFile(diskBuffer as UnsavedFile);
			this.queuedTextOps = [];
			return true;
		}

		this.queuedTextOps = [];
		if (!stale) {
			await this.clearUnsavedFile(diskBuffer as UnsavedFile);
		}
		return stale;
	}

	async bringOnline(): Promise<boolean> {
		if (!this.vaultShare) {
			// dismantle() already detached this entry from its shared folder; a
			// retry/reconnect that fires afterwards has nothing to connect to.
			return false;
		}
		if (this.vaultShare.resourceAddress instanceof FolderAddress) {
			// Local only
			return false;
		}
		if (this.resourceAddress instanceof DocumentAddress) {
			// convert to remote document
			this.resourceAddress = this.vaultShare.workspaceId
				? new RemoteDocumentAddress(
						this.vaultShare.workspaceId,
						this.vaultShare.entityGuid,
						this.entityGuid,
					)
				: new DocumentAddress(this.vaultShare.entityGuid, this.entityGuid);
		}
		if (!this.vaultShare.wantsConnection) {
			return false;
		}
		await this.vaultShare.bringOnline();
		return super.bringOnline();
	}

	public get synced(): boolean {
		return this._indexeddbPersistence.canRender(super.isSynced);
	}

	hasLocalPersistence(): boolean {
		return this._indexeddbPersistence.serverSyncKnown || this._indexeddbPersistence.holdsContent();
	}

	async hasPendingCrdtUpdate(): Promise<boolean> {
		await this.awaitFirstSync();
		await this.getServerAcked();
		if (!this._hasPendingCrdtUpdate) {
			return false;
		}
		this._hasPendingCrdtUpdate = !this.hasLocalPersistence();
		return this._hasPendingCrdtUpdate;
	}

	async awaitFullyConnected(): Promise<Document> {
		const promiseFn = async (): Promise<Document> => {
			if (await this.hasPendingCrdtUpdate()) {
				// If this is a brand new shared folder, we want to wait for a connection before we start reserving new guids for local files.
				this.log("awaiting updates");
				void this.bringOnline();
				await this.onceOnline();
				this.log("connected");
				await this.onceEverSynced();
				this.log("synced");
			}
			return this;
		};
		this.syncedPromise ??= new LazyValue<Document>(promiseFn, () => [this.synced, this]);
		return this.syncedPromise.value();
	}

	awaitFirstSync(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			await this.vaultShare.awaitSynced();
			if (this.isLocallyPersisted) {
				return;
			}
			return new Promise<void>((resolve) => {
				this._indexeddbPersistence.once("synced", () => {
					this.isLocallyPersisted = true;
					resolve();
				});
			});
		};
		this.firstSyncPromise ??= new LazyValue<void>(promiseFn, () => [
			this.isLocallyPersisted,
			undefined,
		]);
		return this.firstSyncPromise.value();
	}

	async hasActivePeers(): Promise<boolean> {
		await this.awaitFirstSync();
		return this.hasLocalPersistence();
	}

	public get mimeType(): string {
		return mimeTypeForPath(this.entryPath);
	}

	async syncToVault(): Promise<void> {
		const file = this.obsidianFile;
		if (!file || this.restoreReviewRequired) return;
		try {
			const check = this.vaultShare.captureDocumentWrite(this), content = this.content;
			await this.assertNoRestoreReview(); check();
			if (this.obsidianFile !== file || this.content !== content) return;
			await trackNativeDocumentWrite(this.obsidianVault, file.path, () => this.obsidianVault.modify(file, content));
			this.warn("file saved", this.entryPath);
		} catch (error) { this.warn("Document save paused; local cached content is retained", error); }
	}

	scheduleSave = debounce(() => this.syncToVault(), 2000);

	async markSyncOrigin(origin: "local" | "remote"): Promise<void> {
		await this._indexeddbPersistence.rememberOrigin(origin);
	}

	async getSyncOrigin(): Promise<"local" | "remote" | undefined> {
		return this._indexeddbPersistence.loadOrigin();
	}

	async markServerAcked(): Promise<void> {
		await this.assertNoRestoreReview();
		await this._indexeddbPersistence.rememberServerSync();
	}

	async getServerAcked(): Promise<boolean> {
		return this._indexeddbPersistence.loadServerSyncFlag();
	}

	/**
	 * The content this document's Y.Doc and the relay were last confirmed to
	 * agree on -- i.e. what `this.content` held right after the most recent
	 * successful `TransferQueue.uploadDocumentViaSocket()` cycle. Lets that
	 * reconcile step tell "only this client edited since we last agreed"
	 * (safe to apply directly) apart from "the relay moved too" (needs a
	 * conflict copy) -- see `TransferQueue.reconcileRelayContent`.
	 *
	 * Persisted via this Document's own LocalDocumentStore, same as
	 * `markServerAcked()`/`markSyncOrigin()` above -- survives this
	 * short-lived instance being recreated on the next `enqueueUpload` for a
	 * doc with no live editor binding, unlike an in-memory field would.
	 * Reads come from the store's in-memory copy once it is open.
	 */
	async getSyncBase(): Promise<string | undefined> {
		return this._indexeddbPersistence.loadSyncBase();
	}

	async setSyncBase(text: string): Promise<void> {
		await this._indexeddbPersistence.rememberSyncBase(text);
	}

	static matchesTrackedExtension(this: void, vpath: string): boolean {
		return vpath.endsWith(".md");
	}

	dismantle() {
		this.unsavedClosed = true;
		this._teardownCallbacks.forEach((unsubscribe) => unsubscribe());
		super.dismantle();
		this.crdtDoc.destroy();
		// A merge pane may still hold this buffer. Never blank its text on
		// teardown, especially when a failed save left it only in memory.
		if (!this.unsavedDirty) this._unsavedFile = undefined;
		this._unsavedFileStore = null as unknown as UnsavedFileStore | undefined;
		this.firstSyncPromise?.destroy();
		this.firstSyncPromise = null;
		this.syncedPromise?.destroy();
		this.syncedPromise = null as unknown as LazyValue<Document> | undefined;
		this._parent = null as unknown as VaultShare;
	}

	public readContent(): string {
		return this.content;
	}

	public dispose(): void {
		const store = this._unsavedFileStore, key = this.bufferKey;
		void this.queueUnsaved(async () => { await store?.discardUnsaved(key); })
			.catch(error => this.warn("Unable to remove document buffer; retained for recovery", error));
	}

	// Helper method to update file stats
	private refreshFileStats(): void {
		this.fileMetrics.mtime = Date.now();
		this.fileMetrics.size = this.content.length;
	}

	// Additional methods that might be useful
	public replaceContent(content: string): void {
		this.crdtText.delete(0, this.crdtText.length);
		this.crdtText.insert(0, content);
		this.refreshFileStats();
	}

	public appendContent(content: string): void {
		this.crdtText.insert(this.crdtText.length, content);
		this.refreshFileStats();
	}
}
