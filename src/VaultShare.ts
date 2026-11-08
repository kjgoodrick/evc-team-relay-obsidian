"use strict";

// Obsidian host API
import {
	App,
	Notice,
	FileManager,
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	debounce,
	normalizePath,
} from "obsidian";

// Path utilities (Node-shim for the Obsidian sandbox)
import { dirname, join, sep } from "path-browserify";

import * as Y from "yjs";
import { CONFLICTS, select, touches, type Records, type StructuralConflict } from "./client/managedRecovery";
import type { ManagedRestoreReview, ManagedRestoreInspection } from "./client/ManagedIndexTransport";
import { assertCompleteComparisonSource, requireRestoreRelativePath, type ManagedRestoreText, type RestoreLocalText } from "./client/ManagedRestoreText";
import { readManagedSource } from "./client/readManagedSource";
import { restoreMetadata } from "./collaboration/RestoreGeneration";
import { prepareRecoveryBackup, sameCapture, type RecoveryCapture, type RecoveryIO } from "./ManagedRecoveryBackup";
import { ManagedConflictsModal } from "./ui/ManagedConflictsModal";

// Sync primitives / CRDT plumbing
import { LocalDocumentStore } from "./storage/local-document-store";
import type { SourceSelectionContext } from "./storage/source-selection-context";
import { trackNativeSourceMutation, waitForNativeDocumentWrites } from "./storage/native-document-writes";
import { readDocumentComparisonSnapshot, readDocumentRecoverySnapshot } from "./storage/document-recovery-snapshot";
import { encodeDocumentRecoveryMetadata } from "./storage/document-recovery-metadata";
import { discoverDocumentRecovery, type DiscoveredRecoveryDocument } from "./storage/discover-document-recovery";
import { discoverSourceRecovery, type SourceRecoveryDiscovery } from "./storage/discover-source-recovery";
import { SOURCE_CACHE_IDENTITY } from "./storage/document-cache-binding";
import { ProviderBacked, type ConnectionIntent } from "./ProviderBacked";
import { RelayRestoreRequiredError } from "./auth/RelayOnPremTokenProvider";
import { SingleFlight, LazyValue, warnIfSlow } from "./asyncCache";
import { FolderAddress, ResourceAddress, RemoteFolderAddress, RemoteDocumentAddress, RemoteCanvasAddress } from "./ResourceAddress";

// Synced entry types this folder can mint/host
import { Document, isDocument } from "./Document";
import { CanvasDocument, isCanvasDocument } from "./CanvasDocument";
import { TrackedFolder, isTrackedFolder } from "./TrackedFolder";
import { FileHashCache, AttachmentFile, isAttachmentFile } from "./AttachmentFile";
import type { SyncableEntry } from "./SyncableEntry";

// Metadata / folder-index contract
import { FolderIndex } from "./FolderIndex";
import {
	ItemKind,
	makeCanvasRecord,
	makeDocumentRecord,
	makeFileRecord,
	makeFolderRecord,
	isFolderRecord,
	isFileRecord,
	isCanvasRecord,
	type FileRecord,
	type ItemRecord,
	type AttachmentKind,
} from "./ItemKinds";

// Supporting collaborators
import { NotifierSet } from "./notifiers/NotifierSet";
import { AuthSession } from "./AuthSession";
import { RelayCredentialCache } from "./RelayCredentialCache";
import type { RemoteFolderRecord } from "./RelayModel";
import { RelayRegistry } from "./RelayRegistry";
import type { Unsubscriber } from "svelte/store";
import { UnsavedFileStore } from "./UnsavedFile";
import { TransferQueue } from "./TransferQueue";
import type { SettingsScope } from "./SettingsPersistence";
import { instanceLabels } from "./logging";
import { VaultScopedMap } from "./VaultScopedMap";
import { withRootRelativePaths } from "./rootRelativeProxy";
import { BlobClient } from "./BlobClient";
import type { AttachmentUpload } from "./BlobClient";
import { AttachmentSyncSettings, type AttachmentToggles } from "./AttachmentSyncSettings";
import type { BaseSyncDelegate } from "./bases/BaseSyncHost";
import { retiredBaseEntries } from "./bases/BaseContentProtocol";
import { currentToggles } from "./featureToggleState";
import { findNestingConflictPath } from "./vaultShareNesting";
import { isRootSharePath, resolveShareFolder } from "./vaultRootPath";
import { buildConflictCopyPath, isConflictCopyPath, RECOVERY_FOLDER } from "./conflictCopyPath";
import { partitionByKnownGuid } from "./mintGate";
import { DocActivityChannel } from "./docActivity";
import {
	findServerMoves,
	findStructuralMoves,
	isUnderSkippedPath,
	takeRecordSnapshot,
	type RecordSnapshot,
	type ServerMove,
} from "./serverRelocation";
import {
	findByPath,
	hasHistoryGap,
	hasUnsyncedEdit,
	hasUnsyncedCanvasEdit,
} from "./preserveBeforeTrash";
import { LostClaimSettler, preserveThenAdopt, settleLostClaim } from "./lostClaimWinner";
import type { CanvasData } from "./HostCanvasView";
import {
	claimVpathIfUnclaimed,
	awaitVpathClaimSettled,
	wonVpathClaim,
} from "./uploadClaim";

export interface VaultShareSettings {
	guid: string;
	path: string;
	relay?: string;
	connect?: boolean;
	sync?: AttachmentToggles;
	/**
	 * Server ID for relay-onprem multi-server mode
	 * Indicates which server owns this share
	 */
	onpremServerId?: string;
}

// Discriminated "sync op" shapes, all sharing the same {kind,filePath,completion}
// skeleton -- applyServerRecord()/pruneUntrackedFiles() emit these,
// scanFileTree() waits on and reports them.
type SyncOpKind = "create" | "rename" | "delete" | "update" | "upgrade" | "noop";

interface SyncOpBase<K extends SyncOpKind = SyncOpKind> {
	kind: K;
	filePath: string;
	completion: Promise<void> | Promise<SyncableEntry>;
}

interface CreateOp extends SyncOpBase<"create"> {
	completion: Promise<SyncableEntry>;
}

interface RenameOp extends SyncOpBase<"rename"> {
	oldPath: string;
	newPath: string;
	completion: Promise<void>;
}

interface DeleteOp extends SyncOpBase<"delete"> {
	completion: Promise<void>;
}

interface UpdateOp extends SyncOpBase<"update"> {
	completion: Promise<void>;
}

interface UpgradeOp extends SyncOpBase<"upgrade"> {
	completion: Promise<void>;
}

interface NoopOp extends SyncOpBase<"noop"> {
	completion: Promise<void>;
}

type SyncOp = CreateOp | RenameOp | DeleteOp | UpdateOp | UpgradeOp | NoopOp;

class FileSet extends NotifierSet<SyncableEntry> {
	// Rapid file-tree churn on startup fires many notifySubscribers() calls in
	// a burst; batch them with a debounce instead of re-rendering per file.
	notifySubscribers = debounce(super.notifySubscribers.bind(this), 100);

	update() {
		this.notifySubscribers();
	}

	include(item: SyncableEntry, update = true): NotifierSet<SyncableEntry> {
		const collision = this.locate((file) => file.entityGuid === item.entityGuid);
		if (collision && collision !== item) {
			this.error("duplicate guid", collision, item);
			this.backing.delete(collision);
		}
		this.backing.add(item);
		if (!update) {
			return this;
		}
		this.notifySubscribers();
		return this;
	}
}

export class VaultShare extends ProviderBacked {
	// -- Identity / vault placement --
	/**
	 * The share's own folder path. Deliberately NOT `ProviderBacked.entryPath`:
	 * that member is the *entry* path a `SyncableEntry` exposes, and a
	 * VaultShare is the container those entries are addressed relative to, not
	 * one of them. `getVaultPath()` is overridden below so the base class still
	 * reports something meaningful for a share.
	 */
	path: string;
	workspaceId?: string;
	isTornDown: boolean = false;
	public vaultApi: Vault;

	// -- File table --
	trackedEntries: Map<string, SyncableEntry>; // Maps guids to SharedDocs
	pathSet: FileSet;
	private awaitingDelete: Set<string> = new Set();
	/** Paths a remote-delete cleanup is already trashing (overlapping tree scans). */
	private trashingPaths?: Set<string>;
	/** Prevent an upload already in flight from republishing a discarded entry. */
	private deletedEntries: WeakSet<SyncableEntry> = new WeakSet();
	private folderCreations = new Map<string, Set<Promise<TFolder>>>();
	private discardedFolderNodes = new WeakSet<TAbstractFile>();
	private deletedEntryRoots = new WeakMap<SyncableEntry, string>();
	private uploadClaims: VaultScopedMap<string>;

	// -- Remote / connection state --
	_linked?: RemoteFolderRecord;
	_wantsConnection: boolean;
	private _serverId?: string;
	private relayRegistry: RelayRegistry;
	private teardowns: Unsubscriber[] = [];

	// -- Sync bookkeeping --
	folderIndex: FolderIndex;
	/** Per-document change markers -- see docActivity.ts. */
	docActivity: DocActivityChannel;
	attachmentSettings: AttachmentSyncSettings;
	basesSync?: BaseSyncDelegate;

	usesBaseSync(path: string, entryId?: string): boolean {
		const tracked = entryId ? this.trackedEntries?.get(entryId) : undefined;
		const manifest = this._liveProvider?.managedIndex?.snapshot;
		return path.toLowerCase().endsWith(".base") || !!(tracked && isAttachmentFile(tracked) && tracked.guardedBase) ||
			!!(entryId && manifest?.base_content?.versions?.[entryId]) || !!(manifest && !manifest.records[path] &&
				retiredBaseEntries(manifest).some(([id, oldPath]) => oldPath === path && (!entryId || id === entryId)));
	}
	private isAuthority: boolean;
	// Narrower than isAuthority (which the "migrate" recreate path in
	// loadRelayOnPremShares() also sets true, for its own unrelated
	// hasPendingUpdates()/awaitReady() reasons -- that path can legitimately
	// be reconciling a share ANOTHER client already published under a
	// different guid, so it must NOT get this bypass). True
	// only at the exact call sites that construct a VaultShare moments after
	// this client's own createShare() call minted a guid nobody else could
	// yet know about.
	private freshlyCreated: boolean;
	private resyncRequested: boolean = false;
	private treeScanInFlight: SingleFlight<void> | null = null;
	private initialFolderSync: Promise<boolean> | null = null;
	private cancelInitialFolderSync: (() => void) | null = null;

	// -- Readiness / persistence promises (memoized -- see awaitReady/awaitSynced) --
	private readyValue: LazyValue<VaultShare> | null = null;
	private syncedValue: LazyValue<void> | null = null;
	private localDbLoaded: boolean = false;
	private _localDb: LocalDocumentStore;

	// -- Collaborators --
	private fileOps: FileManager;
	unsavedStore: UnsavedFileStore;
	rootRelative: VaultShare;
	blobs: BlobClient;

	constructor(
		// Identity
		public hostAppId: string,
		guid: string,
		path: string,
		// Obsidian host handles
		loginManager: AuthSession,
		vaultApi: Vault,
		fileOps: FileManager,
		// Sync/network collaborators
		tokenStore: RelayCredentialCache,
		relayRegistry: RelayRegistry,
		private hashCache: FileHashCache,
		public transfers: TransferQueue,
		// Namespaced settings + Obsidian App handle
		private _config: SettingsScope<VaultShareSettings>,
		private obsidianApp: App,
		workspaceId?: string,
		hasPendingUpdates: boolean = true,
		// True only when ShareRegistry.restore() is restoring this folder from
		// settings persisted in a prior session — see the auto-connect gate
		// below.
		isRestore: boolean = false,
		// True only immediately after THIS client's own createShare() call
		// minted this guid (CreateShareView.svelte, ShareManagementModal's
		// createLocalVaultShare, QuickShareModal) -- see the field's own
		// comment above for why this must stay separate from isAuthority.
		freshlyCreated: boolean = false,
		public readonly sourceSelection?: SourceSelectionContext,
	) {
		const s3rn = workspaceId
			? new RemoteFolderAddress(workspaceId, guid)
			: new FolderAddress(guid);

		sourceSelection?.assertFolder(hostAppId, _config.readValue().onpremServerId, ResourceAddress.serialize(s3rn));
		super(guid, s3rn, tokenStore, loginManager, _config.readValue().onpremServerId, sourceSelection?.binding, sourceSelection);
		this.freshlyCreated = freshlyCreated;
		this.path = path;
		this.setLoggers(`[VaultShare](${this.path})`);
		this.fileOps = fileOps;
		this.vaultApi = vaultApi;
		this.trackedEntries = new Map();
		this.pathSet = new FileSet();
		this.uploadClaims = new VaultScopedMap<string>(
			sourceSelection?.pendingUploadsKey ?? `${hostAppId}-evc-team-relay/folders/${this.entityGuid}/pendingUploads`,
			this.obsidianApp,
		);
		this._pruneStalePendingUploads();

		this.relayRegistry = relayRegistry;
		this.workspaceId = workspaceId;
		this.unsavedStore = new UnsavedFileStore();
		this._wantsConnection = this.config.connect ?? true;

		this.isAuthority = !hasPendingUpdates;

		this.attachmentSettings = this._buildSyncSettingsManager();
		this.folderIndex = this._buildSyncStore();
		this._wireSyncStoreListener();
		let notifiedCount = 0;
		this.crdtDoc.getMap(CONFLICTS).observe(() => {
			const count = this.crdtDoc.getMap(CONFLICTS).size;
			if (count > notifiedCount) {
				const message = document.createDocumentFragment();
				message.appendText(`${count} file conflict(s) in ${this.path || "this vault"}. Local edits are retained. `);
				message.createEl("button", { text: "Review conflicts" }).onclick = () => this.openManagedConflicts();
				new Notice(message, 15000);
			}
			notifiedCount = count;
		});
		this.docActivity = new DocActivityChannel(this.crdtDoc);

		this.rootRelative = withRootRelativePaths(this, this.path, (globalPath: string) => {
			return this.toVirtualPath(globalPath);
		});

		this._localDb = this._openPersistence();
		if (sourceSelection) this.retainRestoreReviewIn(this._localDb);
		// Read the stored records the moment they load, before any server
		// change can reach the index (bringOnline() waits for the same load).
		if (!this.freshlyCreated) void this.recordsBeforeSync();

		// TR-multi-server: `loginManager.isAuthenticated` only reflects the single
		// legacy/active-server session. A relay-onprem folder knows which
		// server it belongs to via config.onpremServerId (set by every
		// share-creation call site) — check THAT server's login state when
		// known, so a folder on a logged-in non-active on-prem server still
		// auto-connects.
		//
		// The legacy-featureKey fallback below is ONLY safe for a restored folder
		// (isRestore=true): its settings node, if it ever had an
		// onpremServerId, was written in a PRIOR session, so `undefined` here
		// genuinely means "predates the field, use the old single-server
		// assumption" (managed EVC relay, or an on-prem folder created before
		// multi-server support existed). For a freshly-created folder
		// (isRestore=false), `undefined` instead means "the caller's
		// setOnpremServerId() call hasn't landed yet" — every such caller
		// writes the field and calls bringOnline() explicitly moments after
		// this constructor returns, so auto-connecting on the legacy featureKey
		// races that write and, on the wrong server, sends the first token
		// request to the default control-plane instead of this folder's own
		// (: fixed the ordering here; bringOnline's own retry-on-
		// failure in ProviderBacked is the second, independent half of that fix
		// — a genuinely transient failure on either path must not be
		// terminal).
		const onpremServerId = this.config.onpremServerId;
		const isLoggedInForThisFolder = onpremServerId
			? loginManager.isLoggedInToServer(onpremServerId)
			: isRestore
				? loginManager.isAuthenticated
				: false;
		if (isLoggedInForThisFolder) {
			void this.bringOnline();
		}

		this.blobs = new BlobClient(this);

		// Three independent lifecycle sequences kicked off from the
		// constructor -- each named method below is the exact body that
		// used to live inline here. Order and trigger conditions
		// (awaitReady()/awaitSynced() resolving) are unchanged.
		void this.awaitReady().then(() => this._onReady());
		void this.awaitSynced().then(() => this._onSynced());
		void this._ensureServerSyncMarked();

		instanceLabels.set(this, this.path);
	}

	private _pruneStalePendingUploads(): void {
		this.uploadClaims.forEach((guid, vpath) => {
			if (!this.hasFileSync(vpath)) {
				this.warn(
					"file behind this pending-upload record is gone, dropping it:",
					vpath,
					guid,
				);
				this.uploadClaims.delete(vpath);
			}
		});
	}

	private _buildSyncSettingsManager(): AttachmentSyncSettings {
		return this._config.childScope<
			Record<keyof AttachmentToggles, boolean>,
			AttachmentSyncSettings
		>("sync", (config, path) => new AttachmentSyncSettings(config, path));
	}

	private _buildSyncStore(): FolderIndex {
		return new FolderIndex(
			this.crdtDoc,
			this.path,
			this.uploadClaims,
			this.attachmentSettings,
		);
	}

	/** Retain the original source-transfer context across native and network waits. */
	captureAttachmentContext(file: AttachmentFile) {
		const provider = this._liveProvider, index = provider?.managedIndex;
		const context = index?.captureContentContext(file.entryPath, file.entityGuid);
		const path = file.entryPath, id = file.entityGuid, server = this.config.onpremServerId;
		const sharePath = this.path, shareId = this.entityGuid;
		const check = () => {
			this.sourceSelection?.check();
			if (this.isTornDown || this._liveProvider !== provider || this._liveProvider?.managedIndex !== index || this.path !== sharePath || this.entityGuid !== shareId
				|| file.vaultShare !== this || file.entryPath !== path
				|| file.entityGuid !== id || this.config.onpremServerId !== server || this.isRecoveringStructure
				|| this.deletedEntries.has(file) || this.isDeletePending(path)) throw new Error("Attachment context changed. Local content is retained.");
			context?.check();
		};
		check();
		return { binding: context?.binding ?? {}, managed: !!index, check };
	}

	/** Keep a document write tied to the source selected before an asynchronous read. */
	captureDocumentWrite(doc: Document | CanvasDocument): () => void {
		const path = doc.entryPath, id = doc.entityGuid, sharePath = this.path, shareId = this.entityGuid;
		const server = this.config.onpremServerId, provider = this._liveProvider, crdt = doc.crdtDoc;
		const checkAuth = this.credentialCache.captureFileContext?.(ResourceAddress.serialize(doc.resourceAddress), server);
		const check = () => {
			this.sourceSelection?.check();
			if (doc.restoreReviewRequired) throw new RelayRestoreRequiredError();
			if (this.isTornDown || this.isRecoveringStructure || this.path !== sharePath || this.entityGuid !== shareId
				|| this.config.onpremServerId !== server || this._liveProvider !== provider || doc.vaultShare !== this
				|| doc.entryPath !== path || doc.entityGuid !== id || doc.crdtDoc !== crdt || crdt.isDestroyed
				|| this.deletedEntries.has(doc) || this.isDeletePending(path)) throw new Error("Document context changed. Local content is retained.");
			checkAuth?.();
		};
		check(); return check;
	}

	/** Reserve the file identity in the server inventory before asking for content access. */
	async ensureManagedEntry(path: string, record: ItemRecord): Promise<void> {
		if (this.usesBaseSync(path, record.id)) throw new Error("Use Bases sync to publish this file. Local edits are retained.");
		const index = this._liveProvider.managedIndex;
		if (!index) return;
		if (index.isBlocked(path, record.id)) throw new Error("Resolve the file conflict before publishing. Local edits are retained.");
		if (!index.registered(path, record.id)) {
			if (!await index.claim(path, record)) {
				this.folderIndex.clearPendingUpload(path);
				throw new Error("Another client created this file first. Local content is retained; wait for the shared copy to sync.");
			}
		}
		this.folderIndex.ensureMeta(path, record);
		await index.flush();
	}

	canWriteManagedPath(path: string): boolean {
		if (this._liveProvider?.managedIndex?.isBlocked(path)) return false;
		const snapshot = this.crdtDoc.getMap<{ owner: boolean; permissions: Record<string, string> }>("managed_base_v1").get("snapshot");
		if (snapshot) return snapshot.owner || snapshot.permissions[path] === "write";
		return !this._liveProvider.managedIndex;
	}

	public isRecoveringStructure = false;
	private recoveryMoves = new Map<string, string>();

	isRecoveryMove(from: string, to: string): boolean {
		return [...(this.recoveryMoves ?? [])].some(([source, target]) =>
			(from === source && to === target) || (from.startsWith(source + "/") && to === target + from.slice(source.length)));
	}

	openManagedConflicts(): void { new ManagedConflictsModal(this.obsidianApp, this).open(); }

	async inspectManagedRestore(): Promise<ManagedRestoreInspection> {
		const provider = this._liveProvider, index = provider?.managedIndex;
		if (!index) throw new Error("Connect this shared folder to load its server inventory");
		const credentials = this.credentialCache, server = this.config.onpremServerId, sharePath = this.path;
		const address = ResourceAddress.serialize(this.resourceAddress), checkAuth = credentials.captureFileContext(address, server);
		const source = credentials.captureDocumentSourceContext?.(server);
		if (!source) throw new Error("The selected server is unavailable. Reconnect it before reading the current inventory.");
		const check = () => {
			if (this.isTornDown || this.isRecoveringStructure || this._liveProvider !== provider || provider.managedIndex !== index
				|| this.credentialCache !== credentials || this.config.onpremServerId !== server || this.path !== sharePath
				|| ResourceAddress.serialize(this.resourceAddress) !== address) throw new Error("The shared folder changed. Refresh the restore comparison.");
			checkAuth(); source.check();
		};
		check(); return index.inspectRestore(check);
	}

	/** Compare point-in-time text snapshots only. No source state is imported,
	 * no document wrapper is opened and no native file is modified. */
	async inspectManagedRestoreText(inspection: ManagedRestoreInspection, entryId: string, signal?: AbortSignal): Promise<ManagedRestoreText> {
		const parent = this.resourceAddress, serverId = this.config.onpremServerId, host = this.hostAppId, sharePath = this.path;
		if (!inspection.check || !("relayGuid" in parent) || !("folderGuid" in parent)) throw new Error("Refresh the server inventory before comparing source text");
		const serverEntries = Object.entries(inspection.server.records).filter(([, record]) => record.id === entryId);
		const localEntries = Object.entries(inspection.local).filter(([, record]) => record.id === entryId);
		if (serverEntries.length !== 1 || localEntries.length > 1) throw new Error("This entry has an ambiguous location. Review its inventory first.");
		const [serverPath, record] = serverEntries[0], kind = record.type;
		if (record.type !== ItemKind.Document && record.type !== ItemKind.Canvas) throw new Error("Inline source comparison is available for notes and canvas source text");
		if (localEntries.some(([, local]) => local.type !== record.type)) throw new Error("This entry changed type. Review its inventory first.");
		requireRestoreRelativePath(serverPath); if (localEntries.length) requireRestoreRelativePath(localEntries[0][0]);
		const address = ResourceAddress.serialize(kind === ItemKind.Canvas ? new RemoteCanvasAddress(parent.relayGuid, parent.folderGuid, entryId)
			: new RemoteDocumentAddress(parent.relayGuid, parent.folderGuid, entryId));
		const parentAddress = ResourceAddress.serialize(parent), binding = restoreMetadata({ restoreGeneration: inspection.server.restore_generation ?? null });
		const scope = () => JSON.stringify([inspection.reviewId, inspection.server.restore_guard, inspection.server.restore_generation,
			Object.entries(inspection.server.records).filter(([, item]) => item.id === entryId), Object.entries(inspection.local).filter(([, item]) => item.id === entryId)]);
		const selectedScope = scope();
		const check = () => {
			if (signal?.aborted) throw Object.assign(new Error("Source comparison was cancelled"), { name: "AbortError" });
			inspection.check!();
			if (this.hostAppId !== host || this.path !== sharePath || this.config.onpremServerId !== serverId
				|| ResourceAddress.serialize(this.resourceAddress) !== parentAddress || scope() !== selectedScope) throw new Error("The shared folder changed. Refresh the source comparison.");
		};
		check(); const local: RestoreLocalText[] = [];
		if (localEntries.length) {
			const cacheName = `${host}-relay-${kind === ItemKind.Canvas ? "canvas" : "doc"}-${entryId}`;
			const stored = await readDocumentComparisonSnapshot(cacheName, { check, signal }); check();
			const { appId, s3rn } = stored;
			if (stored.exists && (appId !== undefined && appId !== host || s3rn !== undefined && s3rn !== address)) {
				throw new Error("The retained history has a different association. Save a recovery copy before continuing.");
			}
			const retained = new Y.Doc({ gc: false }), live = this.trackedEntries.get(entryId);
			try {
				Y.applyUpdate(retained, stored.update);
				if (isDocument(live) || isCanvasDocument(live)) {
					if (live.vaultShare !== this || live.entityGuid !== entryId || (isCanvasDocument(live) ? ItemKind.Canvas : ItemKind.Document) !== kind) throw new Error("The local document association changed");
					Y.applyUpdate(retained, Y.encodeStateAsUpdate(live.crdtDoc));
				} else if (live) throw new Error("The local entry changed type");
				assertCompleteComparisonSource(retained, "The retained editing history");
				if (stored.exists || live) local.push({ label: "Local editing history", text: kind === ItemKind.Canvas ? JSON.stringify(CanvasDocument.exportData(retained), null, 2) : retained.getText("contents").toString() });
				const unsaved = isDocument(live) && live._unsavedFile ? live._unsavedFile.unsavedText : await this.unsavedStore.readUnsaved(entryId); check();
				if (unsaved !== null && unsaved !== undefined) local.push({ label: "Local unsaved buffer", text: unsaved });
			} finally { retained.destroy(); }
			const path = sharePath ? `${sharePath}/${localEntries[0][0]}` : localEntries[0][0];
			await waitForNativeDocumentWrites(this.vaultApi, path, { check, signal }); check();
			const file = this.vaultApi.getAllLoadedFiles().find(file => file instanceof TFile && file.path === path);
			if (file instanceof TFile) {
				if (file.stat?.size > 2 * 1024 * 1024) throw new Error("The local file is too large for an inline comparison. Save a recovery copy instead.");
				const bytes = await this.vaultApi.readBinary(file); check();
				if (file.path !== path) throw new Error("The local file moved. Refresh the source comparison.");
				if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("The local file is too large for an inline comparison. Save a recovery copy instead.");
				local.push({ label: "Local file on disk", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) });
			}
		}
		if (local.some(source => source.text.length > 2 * 1024 * 1024)) throw new Error("The retained text is too large for an inline comparison. Save a recovery copy instead.");
		const snapshot = await readManagedSource(this.credentialCache, address, sharePath ? `${sharePath}/${serverPath}` : serverPath, serverId, binding, { signal, check });
		check(); const doc = new Y.Doc({ gc: false });
		try {
			Y.applyUpdate(doc, snapshot.update);
			assertCompleteComparisonSource(doc, "The restored source");
			const serverText = kind === ItemKind.Canvas ? JSON.stringify(CanvasDocument.exportData(doc), null, 2) : doc.getText("contents").toString();
			if (serverText.length > 2 * 1024 * 1024) throw new Error("The server text is too large for an inline comparison.");
			return { entryId, serverPath, serverText, local, capturedAt: snapshot.downloadedAt, check: snapshot.check };
		} finally { doc.destroy(); }
	}

	private async captureRecoveryDocuments(records: Pick<ItemRecord, "id" | "type">[], check = () => {}, discovered: DiscoveredRecoveryDocument[] = []): Promise<RecoveryCapture["documents"]> {
		const documents: RecoveryCapture["documents"] = [], kinds = new Map<string, ItemKind>();
		const associations = new Map(discovered.map(record => [record.id, record]));
		for (const record of records) {
			if (record.type !== ItemKind.Document && record.type !== ItemKind.Canvas) continue;
			const previous = kinds.get(record.id);
			if (previous && previous !== record.type) throw new Error("A retained document has conflicting types. Local work is unchanged.");
			kinds.set(record.id, record.type);
		}
		for (const [id, kind] of kinds) {
			check();
			const doc = new Y.Doc({ gc: false });
			try {
				const cacheName = `${this.hostAppId}-relay-${kind === ItemKind.Canvas ? "canvas" : "doc"}-${id}`;
				const stored = await readDocumentRecoverySnapshot(cacheName); check();
				const expected = associations.get(id);
				if (expected && (!stored.exists || expected.cacheName !== cacheName
					|| stored.custom.find(item => item.key === "appId")?.value !== expected.appId
					|| stored.custom.find(item => item.key === "s3rn")?.value !== expected.s3rn)) {
					throw new Error("A document cache association changed during recovery capture. Local work is retained; review and retry.");
				}
				Y.applyUpdate(doc, stored.update);
				const live = this.trackedEntries.get(id);
				if (isDocument(live) || isCanvasDocument(live)) Y.applyUpdate(doc, Y.encodeStateAsUpdate(live.crdtDoc));
				const unsaved = isDocument(live) && live._unsavedFile ? live._unsavedFile.unsavedText : await this.unsavedStore.readUnsaved(id); check();
				documents.push({ id, unsaved, cacheMetadata: encodeDocumentRecoveryMetadata(cacheName, stored), update: Y.encodeStateAsUpdate(doc),
					text: kind === ItemKind.Canvas ? JSON.stringify(CanvasDocument.exportData(doc), null, 2) : doc.getText("contents").toString() });
			} finally { doc.destroy(); }
		}
		return documents;
	}

	private recoveryIO(check = () => {}): RecoveryIO {
		return {
			mkdir: async path => {
				let parent = "";
				for (const part of path.split("/")) {
					parent = parent ? `${parent}/${part}` : part; check();
					const exists = await this.vaultApi.adapter.exists(parent); check();
					if (!exists) { await this.mutateNativeSource([parent], () => this.vaultApi.createFolder(parent)); check(); }
				}
			},
			write: async (path, text) => { check(); await this.mutateNativeSource([path], () => this.vaultApi.adapter.write(path, text)); check(); },
			writeBinary: async (path, bytes) => { check(); await this.mutateNativeSource([path], () => this.vaultApi.adapter.writeBinary(path, bytes)); check(); },
			readBinary: async path => { check(); const bytes = await this.vaultApi.adapter.readBinary(path); check(); return bytes; },
		};
	}

	private savingRestoreCopy = false;
	/** Save retained source work offline. This never adopts a generation, moves
	 * originals, clears review or resumes any network operation. */
	async saveManagedRestoreRecoveryCopy(): Promise<string> {
		if (this.savingRestoreCopy) throw new Error("A local recovery copy is already being saved.");
		const crdt = this.crdtDoc, review = crdt.getMap<ManagedRestoreReview>("managed_base_v1").get("restoreReview");
		if (!review) throw new Error("This shared folder has no restore review to export.");
		const reviewText = JSON.stringify(review), shareId = this.entityGuid, sharePath = this.path;
		const server = this.config.onpremServerId, provider = this._liveProvider, host = this.hostAppId;
		const address = ResourceAddress.serialize(this.resourceAddress), credentials = this.credentialCache, vault = this.vaultApi;
		const checkAuth = credentials.captureFileContext(address, server);
		const sourceContext = credentials.captureDocumentSourceContext?.(server);
		const staging = () => JSON.stringify({ writes: [...(this.folderIndex.stagedWrites ?? [])], deletes: [...(this.folderIndex.stagedDeletes ?? [])],
			aliases: [...(this.folderIndex.aliases ?? [])], claims: [...(this.uploadClaims ?? [])] });
		const stagedText = staging();
		const check = () => {
			if (this.isTornDown || this.isRecoveringStructure || this.crdtDoc !== crdt || crdt.isDestroyed || this.entityGuid !== shareId
				|| this.path !== sharePath || this.config.onpremServerId !== server || this._liveProvider !== provider || this.hostAppId !== host
				|| this.vaultApi !== vault || this.credentialCache !== credentials || ResourceAddress.serialize(this.resourceAddress) !== address
				|| JSON.stringify(crdt.getMap("managed_base_v1").get("restoreReview")) !== reviewText || staging() !== stagedText) {
				throw new Error("The shared folder changed while saving recovery files. Local work is retained; review and retry.");
			}
			checkAuth();
			sourceContext?.check();
		};
		check(); this.savingRestoreCopy = true;
		try {
			const discovery = await discoverDocumentRecovery(host, this.resourceAddress, check); check();
			const sourceDiscovery: SourceRecoveryDiscovery = sourceContext
				? await discoverSourceRecovery({ hostAppId: host, share: this.resourceAddress, ...sourceContext }, check)
				: { status: "unavailable", documents: [], inventories: [], unassociated: 0, unreadable: 0 };
			check();
			const capture = async (): Promise<RecoveryCapture> => {
				check();
				if (sourceContext) {
					const current = await discoverSourceRecovery({ hostAppId: host, share: this.resourceAddress, ...sourceContext }, check); check();
					if (current.status !== sourceDiscovery.status || JSON.stringify(current.documents) !== JSON.stringify(sourceDiscovery.documents)
						|| JSON.stringify(current.inventories) !== JSON.stringify(sourceDiscovery.inventories)) {
						throw new Error("The retained source cache inventory changed during recovery capture. Local history is retained; review and retry.");
					}
				}
				const files: RecoveryCapture["files"] = [];
				for (const file of this.vaultApi.getAllLoadedFiles()) {
					if (!(file instanceof TFile) || !this.containsPath(file.path) || file.path.split("/").includes(RECOVERY_FOLDER)) continue;
					const path = file.path, bytes = await this.vaultApi.readBinary(file); check();
					if (file.path !== path) throw new Error("A local file moved during recovery capture. Review and retry.");
					files.push({ path, bytes });
				}
				const records: Pick<ItemRecord, "id" | "type">[] = [
					...discovery.documents,
					...Object.values(review.before?.records ?? {}), ...Object.values(review.observed.records), ...Object.values(review.local),
					...crdt.getMap<ItemRecord>("filemeta_v0").values(), ...(this.folderIndex.stagedWrites?.values() ?? []),
				];
				for (const conflict of crdt.getMap<StructuralConflict>(CONFLICTS).values()) records.push(...Object.values(conflict.base), ...Object.values(conflict.local));
				for (const live of this.trackedEntries.values()) {
					if (isDocument(live) || isCanvasDocument(live)) records.push({ id: live.entityGuid, type: isCanvasDocument(live) ? ItemKind.Canvas : ItemKind.Document });
				}
				const known = new Set(records.map(record => record.id));
				for (const id of crdt.getMap<string>("docs").values()) if (!known.has(id)) records.push({ id, type: ItemKind.Document });
				const documents = await this.captureRecoveryDocuments(records, check, discovery.documents); check();
				for (const source of sourceDiscovery.documents) {
					const stored = await readDocumentRecoverySnapshot(source.cacheName); check();
					if (!stored.exists || stored.custom.find(item => item.key === SOURCE_CACHE_IDENTITY)?.value !== source.sourceIdentity) {
						throw new Error("A source cache association changed during recovery capture. Local history is retained; review and retry.");
					}
					const doc = new Y.Doc({ gc: false });
					try {
						Y.applyUpdate(doc, stored.update);
						const unsaved = await this.unsavedStore.readUnsaved(source.cacheName); check();
						documents.push({ id: source.id, cacheKey: source.cacheName, update: stored.update, unsaved,
							cacheMetadata: encodeDocumentRecoveryMetadata(source.cacheName, stored),
							text: source.type === ItemKind.Canvas ? JSON.stringify(CanvasDocument.exportData(doc), null, 2) : doc.getText("contents").toString() });
					} finally { doc.destroy(); }
				}
				const inventories: NonNullable<RecoveryCapture["inventories"]> = [];
				for (const inventory of sourceDiscovery.inventories) {
					const stored = await readDocumentRecoverySnapshot(inventory.cacheName); check();
					if (!stored.exists || stored.custom.find(item => item.key === SOURCE_CACHE_IDENTITY)?.value !== inventory.sourceIdentity) {
						throw new Error("An inventory cache association changed during recovery capture. Local history is retained; review and retry.");
					}
					inventories.push({ cacheKey: inventory.cacheName, update: stored.update, cacheMetadata: encodeDocumentRecoveryMetadata(inventory.cacheName, stored) });
				}
				return { files, documents, inventories, index: Y.encodeStateAsUpdate(crdt) };
			};
			const backup = await prepareRecoveryBackup(this.recoveryIO(check), capture, {
				kind: "managed-restore-source-copy", version: 1, shareId, sharePath, serverId: server ?? null, hostAppId: host,
				review: JSON.parse(reviewText), stagedInventory: JSON.parse(stagedText), cacheDiscovery: discovery, sourceCacheDiscovery: sourceDiscovery,
				coverage: { nativeFiles: "loaded files within the shared folder, excluding recovery directories",
					documentCaches: "known legacy histories plus separately retained source generations with matching vault/server/endpoint/share/document identity",
					inventoryCaches: "separately retained inventory generations with matching vault/server/endpoint/share identity",
					excluded: ["unassociated or other-device caches", "discussion drafts and outbox", "Bases request queues and registry", "previous recovery directories"],
					authorizesResume: false },
			});
			await backup.verify(); check();
			return backup.path;
		} finally { this.savingRestoreCopy = false; }
	}

	async resolveManagedConflict(id: string, choice: "server" | "local", reviewed: Records): Promise<string> {
		const index = this._liveProvider.managedIndex;
		if (!index) throw new Error("Reconnect the share to load its conflicts.");
		let backupPath = "";
		await index.resolve(id, choice, reviewed, async (conflict, server) => {
			const involved = { ...conflict, paths: [...new Set([...conflict.paths, ...Object.keys(select(server.records, conflict))])] };
			const records = [...Object.values(conflict.base), ...Object.values(conflict.local), ...Object.values(select(server.records, conflict))];
			const affectedFiles = () => this.vaultApi.getAllLoadedFiles().filter(file => this.containsPath(file.path)
				&& !isConflictCopyPath(file.path) && touches(involved, this.toVirtualPath(file.path)));
			const capture = async (): Promise<RecoveryCapture> => {
				const files = [];
				for (const file of affectedFiles()) if (file instanceof TFile) files.push({ path: file.path, bytes: await this.vaultApi.readBinary(file) });
				const documents = await this.captureRecoveryDocuments(records);
				return { files, documents, index: Y.encodeStateAsUpdate(this.crdtDoc) };
			};
			const io = this.recoveryIO(), mkdir = io.mkdir;
			const backup = await prepareRecoveryBackup(io, capture,
				{ shareId: this.entityGuid, sharePath: this.path, choice, conflict, server: select(server.records, conflict) });
			backupPath = backup.path;
			return async () => {
				await backup.verify();
				if (choice === "local") return;
				const before = backup.initial;
				this.isRecoveringStructure = true;
				try {
					// Rename originals, never delete them. A crash or partial move leaves
					// both the completed backup and any moved originals recoverable.
					const candidates = affectedFiles().sort((a, b) => a.path.length - b.path.length);
					const roots = candidates.filter(file => !candidates.some(parent => parent !== file && file.path.startsWith(parent.path + "/")));
					for (const file of roots) {
						const target = `${backup.path}/originals/${file.path}`;
						await mkdir(target.slice(0, target.lastIndexOf("/")));
						await this.mutateNativeSource([file.path, target], () => {
							(this.recoveryMoves ??= new Map()).set(file.path, target);
							return this.vaultApi.rename(file, target);
						});
					}
					// Catch editor changes during disk operations before tearing down any
					// live document. On failure its IndexedDB history is still intact.
					const after = await capture();
					// IndexedDB reads above yield. Recheck every live editor synchronously
					// at the final boundary so an edit to an earlier document cannot be
					// missed while a later document's persistence is being read.
					for (const saved of after.documents) {
						const live = this.trackedEntries.get(saved.id);
						if (!isDocument(live) && !isCanvasDocument(live)) continue;
						const merged = new Y.Doc({ gc: false });
						Y.applyUpdate(merged, saved.update); Y.applyUpdate(merged, Y.encodeStateAsUpdate(live.crdtDoc));
						saved.update = Y.encodeStateAsUpdate(merged);
						if (isDocument(live) && live._unsavedFile) saved.unsaved = live._unsavedFile.unsavedText;
						merged.destroy();
					}
					after.index = Y.encodeStateAsUpdate(this.crdtDoc);
					if (!sameCapture({ ...before, files: [] }, { ...after, files: [] })) throw new Error("Editing continued during recovery. Originals are in the recovery folder; local editing history is retained. Review and retry.");
					for (const entry of [...this.trackedEntries.values()]) {
						if (!touches(involved, entry.entryPath, { id: entry.entityGuid } as ItemRecord)) continue;
						this._teardownDeletedFile(entry);
						this.pathSet.delete(entry); this.trackedEntries.delete(entry.entityGuid);
					}
				} finally { this.isRecoveringStructure = false; }
			};
		});
		await this.scanFileTree(this.folderIndex);
		return backupPath;
	}

	private _wireSyncStoreListener(): void {
		this.folderIndex.on(() => {
			void this.scanFileTree(this.folderIndex);
		});
	}

	private _openPersistence(): LocalDocumentStore {
		try {
			const descriptor = this.sourceSelection?.inventory;
			return new LocalDocumentStore(descriptor?.name ?? this.entityGuid, this.crdtDoc, descriptor?.identity);
		} catch (e: unknown) {
			this.warn("IndexedDB persistence layer failed to open:", this.entityGuid);
			console.error(e);
			throw e;
		}
	}

	/**
	 * Body of `awaitReady().then(...)` from the constructor -- runs once this
	 * folder's readiness gate resolves. Ensures IDB + provider sync have
	 * both landed before the first local<->remote reconciliation pass.
	 */
	private async _onReady(): Promise<void> {
		if (!this.isTornDown) {
			await this.awaitSynced(); // Ensure the persisted document has loaded.

			// Always wait for a FRESH provider sync before processing files --
			// onceProviderSynced() is deliberately NOT used here: its sticky
			// "ever synced" featureKey can resolve immediately off a stale prior
			// connection, letting adoptLocalFiles() run against local state whose
			// folderIndex hasn't actually received this connection's own folder
			// metadata yet -- "not tracked" and "not synced yet" then read as
			// the same false, so an already-shared file gets a freshly-minted,
			// disjoint guid instead of the one everyone else uses.
			// For the owner: ensures Y.Map writes propagate to the relay.
			// For the member: ensures we receive file metadata from the relay
			// (fixes stale serverSynced=true in IDB causing immediate resolve).
			//
			// The catch below used to just log and fall through to
			// adoptLocalFiles() unconditionally -- a timeout meant "proceed as if
			// synced", which is the failure this gate exists to prevent
			//: 30s of silence read as "no metadata for this vpath
			// anywhere", so a file another client already shares got minted a
			// fresh, disjoint guid instead of waiting to learn the real one.
			// `freshlySynced` threads that outcome into adoptLocalFiles() so it
			// can tell "genuinely new" from "not confirmed yet" for files this
			// client doesn't already have a guid for.
			let freshlySynced = true;
			if (this._wantsConnection) {
				try {
					await Promise.race([
						this.onceFreshlySynced(),
						new Promise<void>((_, reject) =>
							window.setTimeout(
								() => reject(new Error("provider sync timeout")),
								30000,
							),
						),
					]);
				} catch (e: unknown) {
					freshlySynced = false;
					console.warn(
						`[VaultShare] ${this.path}: ${e instanceof Error ? e.message : String(e)}, proceeding with already-known trackedEntries only -- not minting guids for anything syncNow hasn't confirmed yet`,
					);
				}
			}

			// A freshlyCreated share (this client's own createShare() call,
			// moments ago) can never collide with another client's
			// not-yet-received guid for this exact folder: nobody else knew
			// this share existed before that call minted it. The
			// sync-timeout gate above exists to stop a MEMBER client from
			// minting a disjoint guid while it's still learning about guids
			// the authority already published -- that race
			// cannot happen to the client that JUST created the share, so it
			// must always be allowed to mint even when onceFreshlySynced()
			// didn't confirm in time. Without this, a freshly created
			// share's own files are deferred forever unless a later
			// reconnect happens to land inside the 30s window, or the user
			// manually runs "Relay: sync" -- exactly the observed symptom of
			// a new folder share whose content never leaves the vault
			//.
			//
			// Deliberately NOT `this.isAuthority`: loadRelayOnPremShares()'s
			// "migrate" recreate path also sets isAuthority=true (for its
			// own, unrelated hasPendingUpdates()/awaitReady() reasons) when
			// reconciling a LOCAL record whose guid or workspaceId is stale
			// -- a share that may have been published elsewhere by another
			// client under a guid this device hasn't learned yet. Bypassing
			// the mint gate for that path would reopen exactly the
			// race this gate exists to prevent.
			const allowMint = freshlySynced || this.freshlyCreated;
			console.debug(
				`[VaultShare] isPrepared to syncNow: path=${this.path}, synced=${this.isSynced}, isAuthority=${this.isAuthority}, freshlyCreated=${this.freshlyCreated}, allowMint=${allowMint}`,
			);
			// Local renames for server-side moves must land before adoption.
			if (freshlySynced && this._wantsConnection) await this.awaitFolderTreeReady();
			await this.adoptLocalFiles(allowMint);
			void this.scanFileTree(this.folderIndex);
		}
	}

	/** Body of `awaitSynced().then(...)` from the constructor. */
	private _onSynced(): void {
		// Observing docs before the fresh sync can migrate stale legacy paths
		// into newly minted folders that the server's old tombstones cannot delete.
		void this.awaitFolderTreeReady().then((ready) => {
			if (ready && !this.isTornDown) this.folderIndex.observe();
		});
		try {
			void this._localDb.set("path", this.path);
			void this._localDb.set("relay", this.workspaceId || "");
			void this._localDb.set("appId", this.hostAppId);
			void this._localDb.set("s3rn", ResourceAddress.serialize(this.resourceAddress));
		} catch {
			// pass
		}
	}

	/** One startup barrier for observers, manual sync, and automatic tree scans. */
	/** Old paths of server moves whose destination already exists locally. */
	private followedMoveSkips = new Set<string>();
	private lostClaimSettler = new LostClaimSettler((vpath, e) =>
		this.warn(`Failed to settle the lost upload claim on ${vpath}`, e),
	);
	/** Paths this client had synced before this start's first fresh sync. */
	private knownBeforeSync?: Set<string>;
	private recordsBeforeSyncTaken?: Promise<RecordSnapshot>;

	/**
	 * Persisted records, taken once the local store has loaded and before the
	 * server's changes land: the only place an offline client can still see
	 * old paths. Started from the constructor, and the folder connects only
	 * after the same load (bringOnline()), so a large stored history cannot
	 * lose that race. Memoized, so startup uploads and the tree scan share
	 * one view.
	 */
	private recordsBeforeSync(): Promise<RecordSnapshot> {
		return (this.recordsBeforeSyncTaken ??= this.awaitSynced().then(() => {
			const persisted = takeRecordSnapshot(this.folderIndex);
			this.knownBeforeSync = new Set(persisted.keys());
			return persisted;
		}));
	}

	private awaitFolderTreeReady(): Promise<boolean> {
		if (this.isTornDown) return Promise.resolve(false);
		if (!this.initialFolderSync) {
			const cancelled = new Promise<boolean>((resolve) => {
				this.cancelInitialFolderSync = () => resolve(false);
			});
			this.initialFolderSync = Promise.race([
				(async () => {
					await this.awaitSynced();
					if (!this.freshlyCreated && !this.isTornDown) {
						const persisted = await this.recordsBeforeSync();
						await this.onceFreshlySynced();
						await this.applyServerMoves(persisted);
					}
					return !this.isTornDown;
				})(),
				cancelled,
			]);
		}
		return this.initialFolderSync;
	}

	/**
	 * Renames local folders/files the server moved while this client was
	 * offline (relocate-artifacts), so adoptLocalFiles() finds them at their
	 * new, already-tracked path instead of publishing the old one again.
	 * Never overwrites: if the destination already exists locally, the old
	 * path is left alone.
	 */
	private async applyServerMoves(persisted: RecordSnapshot): Promise<void> {
		if (this.isTornDown) return;
		const synced = takeRecordSnapshot(this.folderIndex);
		const moves: ServerMove[] = findServerMoves(persisted, synced);
		// IndexedDB may be empty or already hold the post-move state (a client
		// that connected before this instance existed), so also recognise the
		// move from what is on disk versus what the share tracks.
		let localRoots: string[] = [];
		try {
			localRoots = this.vaultFilesInScope()
				.filter((file) => file instanceof TFolder)
				.map((folder) => this.toVirtualPath(folder.path))
				.filter((vpath) => !vpath.includes("/"));
		} catch {
			// No on-disk folder yet: nothing local to match against.
		}
		for (const move of findStructuralMoves(localRoots, synced)) {
			if (!moves.some((known) => known.from === move.from)) moves.push(move);
		}
		for (const { from, to } of moves) {
			if (this._liveProvider?.managedIndex?.isBlocked(from) || this._liveProvider?.managedIndex?.isBlocked(to)) continue;
			try {
				const source = this.vaultApi.getAbstractFileByPath(this.absolutePath(from));
				if (!source) continue;
				if (this.vaultApi.getAbstractFileByPath(this.absolutePath(to))) {
					// Keep the old copy on disk, but never publish it again.
					this.followedMoveSkips.add(from);
					await this.trashDuplicatesOfMovedRoot(from, to);
					continue;
				}
				await this.ensureParentDir(to);
				const target = normalizePath(this.absolutePath(to));
				await this.mutateNativeSource([source.path, target], () => this.fileOps.renameFile(source, target));
				console.debug(`[VaultShare] ${this.path}: followed server move ${from} -> ${to}`);
			} catch (e: unknown) {
				// The move failed, so the old root is still on disk: keep it out of adoption.
				this.followedMoveSkips.add(from);
				console.warn(`[VaultShare] ${this.path}: could not follow server move ${from} -> ${to}`, e);
			}
		}
	}

	/**
	 * The destination copy already exists on disk, so the old root is a stale
	 * duplicate: send files whose content is byte-identical to their twin to the
	 * trash (recoverable), then any folder that ends up empty. Anything that
	 * differs or has no twin stays, and stays unpublished via followedMoveSkips.
	 */
	private async trashDuplicatesOfMovedRoot(from: string, to: string): Promise<void> {
		try {
			const prefix = `${this.absolutePath(from)}/`;
			const adapter = this.vaultApi.adapter;
			const inside = this.vaultFilesInScope().filter((file) => file.path.startsWith(prefix));
			for (const file of inside) {
				if (!(file instanceof TFile)) continue;
				const twin = normalizePath(this.absolutePath(`${to}/${file.path.slice(prefix.length)}`));
				if (!(await adapter.exists(twin))) continue;
				const [a, b] = await Promise.all([adapter.readBinary(file.path), adapter.readBinary(twin)]);
				if (a.byteLength !== b.byteLength) continue;
				const x = new Uint8Array(a);
				const y = new Uint8Array(b);
				if (x.some((byte, i) => byte !== y[i])) continue;
				await this.trashFile(file);
			}
			const folders = inside
				.filter((file): file is TFolder => file instanceof TFolder)
				.sort((l, r) => r.path.length - l.path.length);
			const root = this.vaultApi.getAbstractFileByPath(this.absolutePath(from));
			if (root instanceof TFolder) folders.push(root);
			for (const folder of folders) {
				const live = this.vaultApi.getAbstractFileByPath(folder.path);
				if (live instanceof TFolder && live.children.length === 0) {
					await this.trashFile(live);
				}
			}
		} catch (e: unknown) {
			console.warn(`[VaultShare] ${this.path}: could not clean up the stale copy of ${from}`, e);
		}
	}

	/** Body of the fire-and-forget IIFE from the constructor. */
	private async _ensureServerSyncMarked(): Promise<void> {
		const serverSynced = await this.readServerSynced();
		if (!serverSynced) {
			await this.onceEverSynced();
			await this.noteSynced();
		}
	}

	/**
	 * A peer deleted `vpath` while this client was away, and the local file is
	 * this client's old synced copy rather than a new note: publishing it again
	 * would bring the note back everywhere. pruneUntrackedFiles() removes it.
	 */
	private removedWhileAway(vpath: string): boolean {
		return this.knownBeforeSync?.has(vpath) === true && this.folderIndex.wasRemoved(vpath);
	}

	/**
	 * @param allowMint Whether a local file with no existing folderIndex entry
	 * may be minted a fresh guid this round. Pass `false` when the caller
	 * couldn't confirm a fresh sync landed first (`_onReady()`'s 30s timeout,
	 *): files this client already knows about (owner's own prior
	 * publish, or metadata that arrived before the timeout) are processed
	 * exactly as before -- only files this client has NEVER seen a guid for
	 * are skipped entirely rather than minted, since that's precisely the
	 * state a not-yet-synced client can't distinguish from "another client
	 * already shares this path, I just haven't heard about it yet". Skipped
	 * files stay ordinary on-disk files (never touched, never at risk from
	 * pruneUntrackedFiles(), which requires a confirmed-synced provider
	 * before it deletes anything) and get resolved on the next connect that
	 * actually confirms a fresh sync, or a manual "Relay: sync" (refreshFromServer(),
	 * which calls this with the default `true` after its own unconditional,
	 * non-timing-out wait for a fresh sync).
	 */
	private adoptLocalFiles = async (allowMint = true) => {
		let syncTFiles = this.vaultFilesInScope().filter(
			(tfile) => !this.removedWhileAway(this.toVirtualPath(tfile.path)),
		);
		if (this.followedMoveSkips.size > 0) {
			syncTFiles = syncTFiles.filter(
				(tfile) => !isUnderSkippedPath(this.toVirtualPath(tfile.path), this.followedMoveSkips),
			);
		}
		if (!allowMint) {
			const { known, unknown } = partitionByKnownGuid(
				syncTFiles,
				(tfile) => this.toVirtualPath(tfile.path),
				(vpath) => this.folderIndex.tracks(vpath),
			);
			if (unknown.length > 0) {
				console.warn(
					`[VaultShare] ${this.path}: deferring ${unknown.length} file(s) with no known guid until syncNow is confirmed fresh: ${unknown.map((f) => f.path).join(", ")}`,
				);
			}
			syncTFiles = known;
		}
		if (this._liveProvider.managedIndex) {
			const allowed = await this._liveProvider.managedIndex.publishablePaths(syncTFiles.map(file => this.toVirtualPath(file.path)));
			syncTFiles = syncTFiles.filter(file => allowed.has(this.toVirtualPath(file.path)));
		}
		const newPaths = this.claimPaths(syncTFiles);

		// Among the freshly-minted paths, Document/CanvasDocument vpaths can race: two
		// clients discovering the SAME brand-new vpath at once (e.g. both
		// connecting to a brand-new shared folder that already has matching
		// local files) each minted a DIFFERENT guid above -- claimPaths()'s
		// FolderIndex.new() is a random uuidv4() into per-device VaultScopedMap,
		// never seen by the other client, before either publishes to the
		// shared meta map. Claim the vpath itself (there isn't a shared guid
		// to claim yet) so only the winner's guid actually gets
		// published/uploaded; the loser adopts the winner's guid instead of
		// publishing its own orphan. CanvasDocument
		// vpaths are excluded when canvas sync is disabled -- they fall
		// through to the generic syncAttachment path below, same as before, which
		// this claim doesn't cover.
		const raceable = this._raceableNewPaths(newPaths);
		const { lost } = await this.claimUploadPaths(raceable);
		const lostPaths = new Set(lost);

		// Ensure all local files have Y.Map metadata entries.
		// This is critical: noteUploaded() only runs after background sync completes,
		// but if individual doc syncs hang (e.g., onceProviderSynced race condition),
		// the Y.Map never gets entries and the relay stays empty. Vpaths this
		// client lost the upload claim on are skipped here -- publishing their
		// locally-minted guid would race the winner's own publish on the same
		// key (see claimUploadPaths).
		this.ensureFileMetadata(syncTFiles, lostPaths);

		const trackedEntries: SyncableEntry[] = [];
		for (const tfile of syncTFiles) {
			const file = await this._resolveLocalDoc(tfile, newPaths, lostPaths);
			if (file) {
				trackedEntries.push(file);
			}
		}
		if (trackedEntries.length > 0) {
			this.pathSet.update();
		}
	};

	private _raceableNewPaths(newPaths: string[]): string[] {
		return newPaths.filter((vpath) => {
			if (Document.matchesTrackedExtension(vpath)) return true;
			if (CanvasDocument.matchesTrackedExtension(vpath)) return currentToggles().enableCanvasSync;
			return false;
		});
	}

	/**
	 * Resolves (mints, uploads, downloads, or adopts) the single `SyncableEntry` a
	 * local vault entry should end up as. One iteration of `adoptLocalFiles`'s
	 * per-file loop, extracted so the fallthrough between the CanvasDocument and
	 * generic-AttachmentFile cases stays easy to follow: when a `.canvas` file
	 * can't be resolved as an actual CanvasDocument (upload with canvas sync off,
	 * or a plain lookup miss), execution intentionally continues down to
	 * the `canSync` check below rather than returning.
	 */
	private async _resolveLocalDoc(
		tfile: TAbstractFile,
		newPaths: string[],
		lostPaths: Set<string>,
	): Promise<SyncableEntry | null> {
		const vpath = this.toVirtualPath(tfile.path);
		const upload = newPaths.contains(vpath) && !lostPaths.has(vpath);

		// Check if file already exists with correct type based on metadata
		const existingFile = this.entryFor(tfile, false);
		if (existingFile) {
			return existingFile;
		}

		if (tfile instanceof TFolder) {
			return this.folderAt(vpath, false);
		}

		if (Document.matchesTrackedExtension(vpath)) {
			if (upload) return this.publishDoc(vpath, false);
			if (lostPaths.has(vpath)) return this.adoptWinnerDoc(vpath);
			return this.docAt(vpath, false);
		}

		if (CanvasDocument.matchesTrackedExtension(vpath)) {
			if (upload) {
				if (currentToggles().enableCanvasSync) {
					return this.publishCanvas(vpath, false);
				}
				// CanvasDocument sync is off -- fall through to the generic AttachmentFile
				// path below instead of minting a CanvasDocument.
			} else if (lostPaths.has(vpath) && currentToggles().enableCanvasSync) {
				return this.adoptWinnerCanvas(vpath);
			} else {
				const asKnownType = this.entryFor(tfile, false);
				if (asKnownType) {
					return asKnownType;
				}
				// Not resolvable yet -- fall through.
			}
		}

		if (this.folderIndex.isSyncable(vpath)) {
			return upload
				? this.publishAttachment(vpath, false)
				: this.syncAttachment(vpath, false);
		}
		return null;
	}

	/**
	 * Runs the claim/settle/decide protocol (uploadClaim.ts) for each
	 * candidate vpath in parallel and returns which ones this client won vs.
	 * lost. A no-op (empty won/lost) for the common single-client case where
	 * `vpaths` is empty.
	 */
	private async claimUploadPaths(
		vpaths: string[],
	): Promise<{ won: string[]; lost: string[] }> {
		if (this._liveProvider.managedIndex) {
			const won: string[] = [], lost: string[] = [];
			// Reserve sequentially so a refresh cannot overwrite an in-flight claim.
			for (const path of vpaths) {
				const id = this.folderIndex.guidFor(path)!;
				const record = path.endsWith(".canvas") ? makeCanvasRecord(id) : makeDocumentRecord(id);
				if (await this._liveProvider.managedIndex.claim(path, record)) won.push(path);
				else { this.folderIndex.clearPendingUpload(path); lost.push(path); }
			}
			return { won, lost };
		}
		if (vpaths.length === 0) {
			return { won: [], lost: [] };
		}
		const results = await Promise.all(
			vpaths.map(async (vpath) => {
				claimVpathIfUnclaimed(this.crdtDoc, vpath, this._liveProvider.awareness);
				await awaitVpathClaimSettled(this.crdtDoc, vpath, {
					socket: this._liveProvider.ws,
				});
				return { vpath, won: wonVpathClaim(this.crdtDoc, vpath) };
			}),
		);
		return {
			won: results.filter((r) => r.won).map((r) => r.vpath),
			lost: results.filter((r) => !r.won).map((r) => r.vpath),
		};
	}

	/**
	 * Shared reconciliation for a Document or CanvasDocument vpath this client LOST
	 * the upload claim on -- another client is (or will shortly be)
	 * canonical for it. Discards the guid this client would otherwise have
	 * minted for it (never published), waits for the winner's guid to sync
	 * in and its content to arrive (awaitDocSynced), then makes the
	 * winner's content canonical locally too.
	 *
	 * Winner-wins, not vault-file-wins (chosen over an earlier vault-file-wins design): the
	 * winner's content is ALREADY published to the relay and may already be
	 * visible to other peers, so overwriting it would propagate to
	 * everyone; a diverging loser's local content is still purely local, so
	 * archiving it stays confined to this one device. It's also
	 * deterministic with more than two racing clients -- with N losers,
	 * each makes exactly one local conflict-copy instead of a chain of
	 * overwrites (one per loser, in arbitrary arrival order) that
	 * vault-file-wins would produce, re-opening the same class of race this
	 * whole fix chain exists to close.
	 *
	 * Never mutates doc.crdtDoc/the relay at all -- only the local vault file.
	 * This is what makes "every peer, including this loser, converges on
	 * the winner's content" true BY CONSTRUCTION rather than something a
	 * separate propagation step has to achieve: awaitDocSynced already
	 * waited for the winner's synced state before this method ever reads
	 * the synced content, so the canonical Y.Doc content is never touched,
	 * and the only write here is bringing the LOCAL FILE in line with it.
	 *
	 * `mint` resolves (or creates) the live Document/CanvasDocument for `vpath`;
	 * `winnerContent`/`flushContent` read the now-synced canonical content
	 * (kept as two separate callbacks because adoptWinnerCanvas's original
	 * code compared against `CanvasDocument.exportData` but flushed
	 * `canvas.json` -- preserved here rather than "simplified" away);
	 * `diverged` is the type-appropriate comparison (plain-text equality
	 * for Documents, deep-object equality for CanvasDocument JSON);
	 * `winnerEmpty` tells a winner whose text hasn't been uploaded yet apart
	 * from real content (see lostClaimWinner.ts).
	 */
	private async _reconcileLostUploadClaim<T extends Document | CanvasDocument, S>(
		vpath: string,
		mint: (vpath: string) => T,
		winnerContent: (item: T) => S,
		flushContent: (item: T) => string,
		diverged: (local: string, winner: S) => boolean,
		winnerEmpty: (winner: S) => boolean,
	): Promise<T> {
		this.folderIndex.clearPendingUpload(vpath);
		await this.awaitVpathResolved(vpath);

		const item = mint(vpath);
		await this.awaitDocSynced(item);

		// The winner's guid can arrive well before its text (its upload lane
		// may be hundreds of files deep), so the comparison waits for the text
		// to land -- detached, so the files after this one in adoptLocalFiles
		// don't queue behind it, and on CRDT updates of the doc, which stays
		// online until then (the background pull skips online docs).
		const isAlive = () =>
			!this.isTornDown && !this.deletedEntries.has(item) && !item.crdtDoc.isDestroyed;
		this.lostClaimSettler.start(vpath, (signal) =>
			settleLostClaim<S>({
				read: () => winnerContent(item),
				isEmpty: winnerEmpty,
				subscribe: (onChange, onGone) => {
					item.crdtDoc.on("update", onChange);
					item.crdtDoc.on("destroy", onGone);
					return () => {
						item.crdtDoc.off("update", onChange);
						item.crdtDoc.off("destroy", onGone);
					};
				},
				signal,
				readLocal: () => this.readContents(item),
				diverged,
				preserveAndAdopt: (local) =>
					this._preserveAndAdoptWinner(item, local, flushContent, isAlive),
				isAlive,
			}),
		);
		return item;
	}

	private async _preserveAndAdoptWinner<T extends Document | CanvasDocument>(
		item: T,
		localContent: string,
		flushContent: (item: T) => string,
		isAlive: () => boolean,
	): Promise<void> {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		try {
			const conflictPath = await preserveThenAdopt({
				writeCopy: () =>
					this.writeConflictCopy(item, localContent, `upload race ${timestamp}`),
				writeOriginal: () => this.writeContents(item, flushContent(item)),
				isAlive,
			});
			if (conflictPath === undefined) return;
			this.log(
				`[${item.entryPath}] Lost the upload-claim race and had different local content -- ` +
					`adopted the winner's content, preserved ours at ${conflictPath}`,
			);
		} catch (e: unknown) {
			this.warn(
				`Failed to preserve local content for ${item.entryPath} before adopting the upload-claim winner's content -- skipping to avoid silent data loss`,
				e,
			);
		}
	}

	/** @see _reconcileLostUploadClaim */
	private async adoptWinnerDoc(vpath: string): Promise<Document> {
		return this._reconcileLostUploadClaim<Document, string>(
			vpath,
			(v) => this.docAt(v, false),
			(doc) => doc.content,
			(doc) => doc.content,
			hasUnsyncedEdit,
			(text) => text === "",
		);
	}

	/** @see _reconcileLostUploadClaim -- CanvasDocument equivalent. */
	private async adoptWinnerCanvas(vpath: string): Promise<CanvasDocument> {
		return this._reconcileLostUploadClaim<CanvasDocument, CanvasData>(
			vpath,
			(v) => this.canvasAt(v, false),
			(canvas) => CanvasDocument.exportData(canvas.crdtDoc),
			(canvas) => canvas.canvasJson,
			hasUnsyncedCanvasEdit,
			(data) => (data.nodes?.length ?? 0) === 0 && (data.edges?.length ?? 0) === 0,
		);
	}

	/**
	 * Waits until `vpath` resolves in the synced meta map (the winner's
	 * publish has arrived) or `maxWaitMs` elapses. In the common case this
	 * returns almost immediately -- awaitVpathClaimSettled already waited out
	 * a quiet period on the SAME channel the winner's publish travels over.
	 * A timeout (winner crashed after claiming, before publishing) is not
	 * treated as fatal: the caller's subsequent docAt()/canvasAt() call
	 * will itself mint a fresh guid via its own internal claimPaths() if the
	 * vpath still isn't known, self-healing at the cost of bypassing this
	 * claim for that rare double-failure case.
	 */
	private async awaitVpathResolved(
		vpath: string,
		maxWaitMs = 5000,
	): Promise<boolean> {
		const deadline = Date.now() + maxWaitMs;
		while (!this.folderIndex.tracks(vpath) && Date.now() < deadline) {
			await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
		}
		return this.folderIndex.tracks(vpath);
	}

	/**
	 * Waits for `doc`'s own websocket provider to report a real, authoritative
	 * synced state (bounded by `maxWaitMs`) before the caller trusts its
	 * content -- used by adoptWinnerDoc/adoptWinnerCanvas instead of
	 * TransferQueue.enqueueFetch().
	 *
	 * Deliberately does NOT use enqueueFetch() here: its underlying
	 * getDocument() has a "server contains uninitialized doc" retry
	 * (TransferQueue.ts) that reschedules itself via a DETACHED
	 * `clock.scheduleTimeout`, never chained into the promise
	 * enqueueFetch returns -- so that promise resolves while doc.crdtDoc is
	 * still empty, exactly in the timing window this method is called in
	 * (right after the upload-claim settles, when the winner's own publish
	 * may not have landed on the relay yet). Reconciling against
	 * still-empty content would write a conflict-copy that doesn't actually
	 * capture the winner's content, then apply this device's local content
	 * on top -- and when the real winner content arrives moments later via
	 * ordinary sync, Yjs merges it against this device's already-applied
	 * diff-patch ops as two independent edit histories, reintroducing the
	 * exact interleaved/duplicated-text failure this whole fix chain exists
	 * to prevent, just in a narrower timing window.
	 *
	 * `onceProviderSynced()` is the websocket-based signal VaultShare's
	 * own constructor and TransferQueue.uploadDocumentViaSocket already rely
	 * on for the same "wait for real synced state" need, and doesn't share
	 * that gap -- it resolves off the live provider connection, not a
	 * one-shot HTTP download with a detached retry.
	 */
	private async awaitDocSynced(
		doc: Document | CanvasDocument,
		maxWaitMs = 30000,
	): Promise<void> {
		const synced = doc.onceEverSynced();
		const connected = await doc.bringOnline();
		if (!connected) {
			this.warn(
				`Connect failed for ${doc.entryPath} while adopting the upload-claim winner's content`,
			);
			return;
		}
		await Promise.race([
			synced,
			new Promise<void>((resolve) => window.setTimeout(resolve, maxWaitMs)),
		]);
	}

	/**
	 * Ensure all local files have Y.Map metadata entries (filemeta_v0).
	 * Without this, the relay has no file metadata and other devices
	 * can't see the file list.
	 *
	 * `skip` excludes vpaths this client lost the upload-claim race on
	 * -- their locally-minted guid must never be
	 * published, since the winner is publishing their own guid for the same
	 * vpath and both writing to `meta` would silently re-introduce the exact
	 * divergent-guid race this method's caller (adoptLocalFiles) claims against.
	 */
	private ensureFileMetadata(syncTFiles: TAbstractFile[], skip?: Set<string>) {
		let written = 0;
		this.crdtDoc.transact(() => {
			for (const file of syncTFiles) {
				if (file instanceof TFolder) continue;
				const vpath = this.toVirtualPath(file.path);
				if (skip?.has(vpath)) continue;
				const guid = this.folderIndex.guidFor(vpath);
				if (!guid) continue;

				// Skip if Y.Map already has this entry
				if (this.folderIndex.hasYMapEntry(vpath)) continue;

				// Write metadata based on file type
				if (Document.matchesTrackedExtension(vpath)) {
					this.folderIndex.ensureMeta(vpath, makeDocumentRecord(guid));
					written++;
				} else if (CanvasDocument.matchesTrackedExtension(vpath)) {
					this.folderIndex.ensureMeta(vpath, makeCanvasRecord(guid));
					written++;
				}
				// AttachmentFile types need hash/mimetype - they'll be written by noteUploaded()
			}
		}, this);
		if (written > 0) {
			console.debug(
				`[VaultShare] ensureFileMetadata: wrote ${written} Y.Map entries for ${this.path}`,
			);
		}
	}

	public get serverId(): string | undefined {
		return this._serverId;
	}

	public set serverId(value: string | undefined) {
		if (value === this._serverId) {
			return;
		}
		this.warn("relay server endpoint changed, rebuilding every connection");
		const shouldReconnect = this.wantsConnection;
		const previouslyConnected = this._resetAllProviders();
		this.credentialCache.clear((token) => {
			return token.token?.folder === this.entityGuid;
		});
		if (shouldReconnect) {
			void this.bringOnline();
			previouslyConnected.forEach((file) => {
				void file.bringOnline();
			});
		}
		this._serverId = value;
	}

	/** Resets this folder's own connection plus every file's, returning the
	 * subset of files that were connected before the reset (so the caller
	 * can decide whether to reconnect them). */
	private _resetAllProviders(): ProviderBacked[] {
		this.resetConnection();
		const reconnect: ProviderBacked[] = [];
		this.pathSet.each((file) => {
			if (file instanceof ProviderBacked) {
				if (file.isOnline) {
					reconnect.push(file);
				}
				file.resetConnection();
			}
		});
		return reconnect;
	}

	private lookupTFolder(errorMessage: string): TFolder {
		const folder = resolveShareFolder(this.vaultApi, this.path);
		if (folder) {
			return folder;
		}
		throw new Error(errorMessage);
	}

	public get vaultFolder(): TFolder {
		return this.lookupTFolder("vaultFolder is not a folder");
	}

	public isSyncableVaultFile(tfile: TAbstractFile): boolean {
		if (isConflictCopyPath(tfile.path)) return false;
		const inFolder = this.containsPath(tfile.path);
		const vpath = this.toVirtualPath(tfile.path);
		if (tfile instanceof TFile && this.usesBaseSync(vpath, this.folderIndex.guidFor(vpath))) return inFolder && this.attachmentSettings.readValue().bases === true;
		const isSupportedFileType = this.folderIndex.isSyncable(vpath);
		if (!inFolder || !isSupportedFileType) {
			return false;
		}
		// Extension preferences don't apply to folders -- only the sync
		// store's own support check above matters for them.
		if (tfile instanceof TFolder) {
			return true;
		}
		// Local recovery copies stay local (GH #4).
		if (isConflictCopyPath(tfile.path)) {
			return false;
		}
		return this.attachmentSettings.isFileTypeAllowed(vpath);
	}

	private vaultFilesInScope(): TAbstractFile[] {
		const folder = this.lookupTFolder(
			`no on-disk folder backs this shared folder at ${this.path}`,
		);
		const descendants: TAbstractFile[] = [];
		Vault.recurseChildren(folder, (candidate: TAbstractFile) => {
			if (candidate === folder) {
				return;
			}
			descendants.push(candidate);
		});
		return descendants.filter((tfile) => this.isSyncableVaultFile(tfile));
	}

	public get wantsConnection(): boolean {
		return this._wantsConnection;
	}

	public set wantsConnection(connect: boolean) {
		void this._config.mutateValue((current) => ({
			...current,
			connect,
		}));
		this._wantsConnection = connect;
	}

	async refreshFromServer() {
		await this.awaitReady();
		// Wait for a FRESH provider sync (not onceProviderSynced()'s sticky
		// "ever synced" featureKey, see its own doc comment) before reconciling.
		// Without this, pruneUntrackedFiles may see incomplete remote state
		// and delete files that exist on the server but haven't been received
		// yet -- or, on a folder that already synced once earlier in this
		// session and is now being manually re-synced, adoptLocalFiles() below
		// can run before this reconnect's own metadata has landed, minting a
		// disjoint guid for an already-shared file.
		await this.onceFreshlySynced();
		// Must complete before scanFileTree: scanFileTree reads folderIndex's
		// Y.Map metadata to compute remotePaths, then calls
		// pruneUntrackedFiles() against it. If adoptLocalFiles (which
		// registers newly-added local files into that same metadata) hasn't
		// finished, scanFileTree can read it mid-registration and delete
		// files adoptLocalFiles was still in the process of adding.
		await this.adoptLocalFiles();
		await this.scanFileTree(this.folderIndex);
		this.transfers.enqueueShareUpload(this);
	}

	public get config(): VaultShareSettings {
		return this._config.readValue();
	}

	/** Read live rather than the value captured at construction — see the
	 * base-class doc comment for why. */
	protected override getOnpremServerId(): string | undefined {
		return this.config.onpremServerId;
	}

	/**
	 * The only correct way to persist which on-prem server this folder
	 * belongs to. `config` is a getter — `vaultShare.config.x = y`
	 * mutates whatever object it happened to return (a freshly-materialized
	 * `{}` when the underlying settings node doesn't exist yet) and never
	 * reaches storage: no `save()`, no `notifyListeners()`. Callers MUST
	 * `await` this before relying on `getOnpremServerId()`/`bringOnline()`
	 * seeing the new value — see ``.
	 */
	async setOnpremServerId(serverId: string): Promise<void> {
		await this._config.mutateValue((current) => ({
			...current,
			onpremServerId: serverId,
		}));
	}

	async syncNow() {
		await this.scanFileTree(this.folderIndex);
	}

	async bringOnline(): Promise<boolean> {
		if (!this.mayConnect()) return false;
		// A server delete that lands before the stored records load hides the
		// path from recordsBeforeSync(), and the old local copy is shared again.
		await this.awaitSynced();
		if (this.isTornDown || !this.mayConnect()) return false;
		return super.bringOnline();
	}

	private mayConnect(): boolean {
		return (
			this.resourceAddress instanceof RemoteFolderAddress &&
			(this.isOnline || this.wantsConnection)
		);
	}

	public get folderLabel(): string {
		return this.path.split("/").pop() || "";
	}

	// Renamed off "vaultPath" (2026-08, W15+W18 gate-4 integration): ProviderBacked's
	// own `path` field was independently renamed to `vaultPath` (W18), which would
	// otherwise collide with this getter (TS2611: property/accessor override
	// mismatch) -- these are different concepts (this is the CONTAINING directory,
	// not the folder's own path) that only coincidentally shared a name.
	public get parentFolderPath(): string {
		return this.path.split("/").slice(0, -1).join("/");
	}

	public get linked(): RemoteFolderRecord | undefined {
		try {
			// FIXME: this getter can race a still-in-flight notifyListener update
			// because VaultShare doesn't route through postie like other collections do.
			void this._linked?.workspace;
		} catch {
			return undefined;
		}
		return this._linked;
	}

	public set linked(value: RemoteFolderRecord | undefined) {
		if (this._linked === value) {
			return;
		}
		this._linked = value;
		this.workspaceId = value?.workspace?.workspaceGuid;
		this.resourceAddress = this.workspaceId
			? new RemoteFolderAddress(this.workspaceId, this.entityGuid)
			: new FolderAddress(this.entityGuid);
		void this._config.mutateValue((current) => ({ ...current, relay: this.workspaceId }));

		if (value) {
			this._serverId = value.workspace.signingProviderId;
			const stopWatchingRelay = value.workspace.subscribe((relay) => {
				if (relay.workspaceGuid !== this.workspaceId) {
					return;
				}
				this.serverId = relay.signingProviderId;
			});
			this.teardowns.push(stopWatchingRelay);
		}

		this.serverId = value?.workspace.signingProviderId;
		this.broadcastState();
	}

	/** True once persistence has caught up AND (we own the data OR the server has, OR we're live-synced). */
	public get isPrepared(): boolean {
		if (!this.localDbLoaded) {
			return false;
		}
		return this.isAuthority || this._localDb.serverSyncKnown || this.isSynced;
	}

	/** Tell the local persistence layer the server has this folder's state. */
	async noteSynced(): Promise<void> {
		await this._localDb.rememberServerSync();
	}

	/** Has the server ever acknowledged sync for this folder? */
	async readServerSynced(): Promise<boolean> {
		return this._localDb.loadServerSyncFlag();
	}

	/** Does the on-disk IndexedDB persistence already hold user data? */
	private hasLocalDb(): boolean {
		return this._localDb.holdsContent();
	}

	async hasPendingUpdates(): Promise<boolean> {
		await this.awaitSynced();
		const hasLocal = this.hasLocalDb();
		const serverSynced = await this.readServerSynced();
		console.debug(
			`[VaultShare] hasPendingUpdates: isAuthority=${this.isAuthority}, serverSynced=${serverSynced}, hasLocalDb=${hasLocal}, path=${this.path}`,
		);
		if (this.isAuthority) {
			return false;
		}
		if (serverSynced) {
			return false;
		}
		return !hasLocal;
	}

	// awaitReady() and awaitSynced() both memoize their LazyValue on a
	// per-instance field the first time they're called, then keep returning
	// that same LazyValue's promise on every subsequent call. Factored out
	// so the two call sites don't repeat the "existing ?? construct" idiom.
	private static getOrInitDependency<T>(
		existing: LazyValue<T> | null,
		run: () => Promise<T>,
		peek: () => [boolean, T],
	): LazyValue<T> {
		return existing || new LazyValue<T>(run, peek);
	}

	awaitReady(): Promise<VaultShare> {
		const promiseFn = async (): Promise<VaultShare> => {
			const hasPendingUpdates = await this.hasPendingUpdates();
			console.debug(`[VaultShare] awaitReady: hasPendingUpdates=${hasPendingUpdates}, path=${this.path}, isAuthority=${this.isAuthority}`);
			if (hasPendingUpdates) {
				// A freshly-created folder needs a live connection first, otherwise
				// locally-reserved guids risk colliding with ones already on the server.
				void this.bringOnline();

				// Timeout after 30s to prevent silent hangs
				const timeout = new Promise<never>((_, reject) =>
					window.setTimeout(() => reject(new Error("awaitReady timeout: server sync took too long")), 30000)
				);

				try {
					await Promise.race([
						(async () => {
							await this.onceOnline();
							console.debug(`[VaultShare] awaitReady: onceConnected resolved`);
							await this.onceEverSynced();
							console.debug(`[VaultShare] awaitReady: onceProviderSynced resolved`);
						})(),
						timeout
					]);
				} catch (e: unknown) {
					console.warn(`[VaultShare] awaitReady: ${e instanceof Error ? e.message : String(e)}`);
					// Fall through — allow scanFileTree to run with whatever state we have
				}

				return this;
			}
			// Already has local edits pending -- treat it the same as being offline.
			console.debug(`[VaultShare] awaitReady: NOT awaiting updates, resolving immediately`);
			return this;
		};
		this.readyValue = VaultShare.getOrInitDependency(
			this.readyValue,
			promiseFn,
			(): [boolean, VaultShare] => [this.isPrepared, this],
		);
		return this.readyValue.value();
	}

	awaitSynced(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			// Short-circuit if a previous call already observed a synced state.
			if (this._localDb.synced) {
				this.localDbLoaded = true;
				return;
			}

			return new Promise<void>((resolve) => {
				this._localDb.once("synced", () => {
					this.localDbLoaded = true;
					resolve();
				});
			});
		};

		this.syncedValue = VaultShare.getOrInitDependency(
			this.syncedValue,
			promiseFn,
			(): [boolean, void] => {
				if (this._localDb.synced) {
					this.localDbLoaded = true;
				}
				return [this.localDbLoaded, undefined];
			},
		);
		return this.syncedValue.value();
	}

	public get intent(): ConnectionIntent {
		return this.wantsConnection ? "connected" : "disconnected";
	}

	async _onServerRename(
		doc: SyncableEntry,
		path: string,
		file: TAbstractFile,
		diffLog?: string[],
	): Promise<void> {
		const check = this.captureNativeSource(); check();
		// Applies a rename the server already committed to our local copy.
		diffLog?.push(`renamed ${file.path} -> ${this.absolutePath(path)} per serverId state`);
		if (file instanceof TFile) {
			await this.ensureParentDir(path, diffLog);
		}
		const target = normalizePath(this.absolutePath(path));
		check();
		await this.mutateNativeSource([file.path, target], () => this.fileOps.renameFile(file, target));
		check(); doc.relocate(path, this);
	}

	/** Creates `vpath`'s parent folder if it's missing. */
	async ensureParentDir(
		vpath: string,
		diffLog?: string[],
	): Promise<void> {
		const dir = dirname(vpath);
		if (!this.hasFileSync(dir)) {
			await this.makeFolder(dir);
			diffLog?.push(`made missing parent directory ${dir}`);
		}
	}

	async _onServerCreate(
		vpath: string,
		meta: ItemRecord,
		diffLog?: string[],
	): Promise<SyncableEntry> {
		console.debug(`[VaultShare] _onServerCreate: vpath=${vpath}, type=${meta.type}, id=${meta.id?.slice(0,8)}`);
		await this.ensureParentDir(vpath, diffLog);

		switch (meta.type) {
			case ItemKind.Document:
				diffLog?.push(`pulled down new markdown doc ${vpath}`);
				return this.pullDoc(vpath, false);
			case ItemKind.Canvas:
				diffLog?.push(
					`pulled down new canvas ${vpath}`,
				);
				return this.pullCanvas(vpath, false);
			case ItemKind.Folder:
				diffLog?.push(`mirrored new linked folder ${vpath} locally`);
				return this.folderAt(vpath, false);
			default:
				if (this.folderIndex.isSyncable(vpath) || this.usesBaseSync(vpath, meta.id) && this.attachmentSettings.readValue().bases === true) {
					diffLog?.push(`pulled down new file ${vpath}`);
					return this.pullAttachment(vpath, false);
				}
				throw new Error(
					`${vpath}: can't handle file type ${meta.type} (${meta.mimetype})`,
				);
		}
	}

	private _requireInScope(path: string) {
		// A path that resolves outside this shared folder's own namespace can't
		// be tracked here anymore, so drop it from the folder index.
		try {
			this.requirePath(this.absolutePath(path));
		} catch {
			this.error("path escaped its shared folder, dropping the tracked doc:", path);
			this.folderIndex.delete(path);
			return;
		}
	}

	private applyServerRecord(
		guid: string,
		path: string,
		knownGuids: Set<string>,
		diffLog: string[],
	): SyncOp {
		if (this.isRecoveringStructure || this._liveProvider?.managedIndex?.isBlocked(path, guid)) return this._noop(path);
		// Skip files that are being locally deleted — prevents race condition
		// where scanFileTree runs between disk deletion and folderIndex removal
		if (this.isDeletePending(path)) {
			return this._noop(path);
		}

		// Recovery copies are local-only: copies already registered in the
		// shared index by an earlier version must not be pulled onto other
		// clients (that is how they nested).
		if (isConflictCopyPath(path)) {
			return this._noop(path);
		}

		const file = this.trackedEntries.get(guid);
		const meta = this.folderIndex.recordFor(path);
		if (!meta) {
			this.warn("no folder-index metadata for tracked path", path);
			return this._noop(path);
		}

		if (this.hasFileSync(path)) {
			return this._reconcileExistingLocalFile(guid, path, file, meta, diffLog);
		}

		if (knownGuids.has(guid) && file) {
			const renamed = this._maybeHandleServerRename(file, path, diffLog);
			if (renamed) {
				return renamed;
			}
		}

		// A plain write here would trigger Obsidian's `create` event, which
		// defaults to reading the file back off disk -- register it in `docs`
		// first so that path is short-circuited.
		const promise = this._onServerCreate(path, meta, diffLog);
		return { kind: "create", filePath: path, completion: promise };
	}

	private _noop(path: string): NoopOp {
		return { kind: "noop", filePath: path, completion: Promise.resolve() };
	}

	private _reconcileExistingLocalFile(
		guid: string,
		path: string,
		file: SyncableEntry | undefined,
		meta: ItemRecord,
		diffLog: string[],
	): SyncOp {
		// A local AttachmentFile whose remote metadata now describes a CanvasDocument needs
		// an in-place type upgrade before any other reconciliation can happen.
		if (file && isAttachmentFile(file) && isCanvasRecord(meta)) {
			const promise = this._promoteToCanvas(file, guid, path, diffLog);
			return { kind: "upgrade", filePath: path, completion: promise };
		}

		// XXX narrows ItemRecord to FileRecord by hand -- isAttachmentFile(file) already implies it
		if (file && isAttachmentFile(file) && file.needsPull(meta as FileRecord)) {
			return { kind: "update", filePath: path, completion: file.pullFromRemote() };
		}

		if (file || !isFileRecord(meta)) {
			return this._noop(path);
		}

		// No local file at this path, but the remote guid may already be
		// bound to a DIFFERENT local path -- that's a rename we haven't
		// caught yet, not a brand new file. Remap it if content matches.
		const localGuid = this.folderIndex.guidFor(path);
		const localFile = localGuid ? this.trackedEntries.get(localGuid) : null;
		if (!localGuid || !localFile || !isAttachmentFile(localFile)) {
			return this._noop(path);
		}
		const promise = this.remapByHash(localFile, localGuid, guid, path, meta);
		return { kind: "update", filePath: path, completion: promise };
	}

	private _maybeHandleServerRename(
		file: SyncableEntry,
		path: string,
		diffLog: string[],
	): RenameOp | null {
		const oldPath = this.absolutePath(file.entryPath);
		const tfile = this.vaultApi.getAbstractFileByPath(oldPath);
		if (!tfile) {
			return null;
		}
		const promise = this._onServerRename(file, path, tfile, diffLog);
		return { kind: "rename", filePath: path, oldPath, newPath: path, completion: promise };
	}

	private async remapByHash(
		localFile: AttachmentFile,
		localGuid: string,
		remoteGuid: string,
		path: string,
		remoteMeta: ItemRecord,
	): Promise<void> {
		try {
			const localHash = await localFile.contentAddressedCache.resolveHash();
			if (localHash === remoteMeta.hash) {
				// Identical bytes on both sides -- adopt the server's guid instead of uploading.
				this.trackedEntries.delete(localGuid);
				this.uploadClaims.delete(path);
				this.trackedEntries.set(remoteGuid, localFile);
				localFile.entityGuid = remoteGuid;
				this.log(
					`swapped local guid ${localGuid} for serverId guid ${remoteGuid} on ${path}`,
				);
			}
		} catch (error: unknown) {
			this.error("guid remap attempt threw:", error);
			throw error;
		}
	}

	private _promoteToCanvas(
		syncAttachment: AttachmentFile,
		remoteGuid: string,
		path: string,
		diffLog?: string[],
	): Promise<void> {
		try {
			// Tear down the stale AttachmentFile wrapper before the CanvasDocument one takes its place.
			const localGuid = syncAttachment.entityGuid;
			this.trackedEntries.delete(localGuid);
			this.pathSet.delete(syncAttachment);
			syncAttachment.dismantle();

			diffLog?.push(`re-typed ${path} from a plain AttachmentFile to a CanvasDocument`);
			this.log(
				`re-typing ${path} as CanvasDocument (guid ${localGuid} -> ${remoteGuid})`,
			);

			// pullCanvas re-registers the path into both `trackedEntries` and `pathSet` itself.
			this.pullCanvas(path, false);
			this.log(`${path} is now tracked as a CanvasDocument`);
			return Promise.resolve();
		} catch (error: unknown) {
			this.error("Canvas re-typing attempt threw:", error);
			throw error;
		}
	}

	private pruneUntrackedFiles(
		remotePaths: string[],
		diffLog: string[],
	): DeleteOp[] {
		// Build the FULL set of known remote paths from the folderIndex.
		// This is safer than using the ops-based remotePaths which only contains
		// paths that had operations, and may be incomplete during partial sync.
		const allRemotePaths = new Set<string>(remotePaths);
		this.folderIndex.eachRecord((meta, path) => {
			allRemotePaths.add(path);
		});

		// An empty remote is either a first sync (local files are still to be
		// uploaded, never delete them) or a peer deleting the last entries.
		// Only the second leaves tombstones in the index, so with an empty
		// remote delete just the paths it confirms were removed.
		const confirmedOnly = allRemotePaths.size === 0;
		if (confirmedOnly && !this.folderIndex.hasRemovedRecords()) {
			return [];
		}

		// Additional safety: require provider+persistence to be synced
		const synced = this._liveProvider?.synced && this._localDb?.synced;
		if (!synced) {
			this.log("pruneUntrackedFiles: skipping — provider/persistence not synced");
			return [];
		}

		// Sweep every locally-tracked file/folder and drop whatever the server no longer shares.
		const ffiles = this.vaultFilesInScope();
		const folders = ffiles.filter((file) => file instanceof TFolder);
		const trackedEntries = ffiles.filter((file) => file instanceof TFile);

		const deletes: DeleteOp[] = [];
		for (const file of [...trackedEntries, ...folders]) {
			if (confirmedOnly && !this.folderIndex.wasRemoved(this.toVirtualPath(file.path))) {
				continue;
			}
			const op = this._maybeDeleteOrphanedFile(file, allRemotePaths, diffLog);
			if (op) {
				deletes.push(op);
			}
		}
		return deletes;
	}

	private _maybeDeleteOrphanedFile(
		file: TAbstractFile,
		allRemotePaths: Set<string>,
		diffLog: string[],
	): DeleteOp | null {
		const basePath = this.toVirtualPath(file.path);
		const guarded = [...(this.trackedEntries?.values() ?? [])].find(entry => entry.entryPath === basePath && isAttachmentFile(entry) && entry.guardedBase);
		if (file instanceof TFile && (this.usesBaseSync(basePath, this.folderIndex.guidFor(basePath)) || guarded)) {
			// Bases deletion review must preserve unsent disk edits as well as the
			// outbox. Never use the generic attachment/document trash fallback.
			if (guarded && !allRemotePaths.has(basePath)) (guarded as AttachmentFile).lastUploadError = "This Bases file is unavailable on the server. The local copy is retained for recovery.";
			return null;
		}
		if (this.isRecoveringStructure || this._liveProvider?.managedIndex?.isBlocked(this.toVirtualPath(file.path))) return null;
		if (this._liveProvider.managedIndex) {
			// Revocation is not deletion. Trash only an explicit tombstone for
			// the same local file identity; preserve unknown/unshared local data.
			const removed = this.crdtDoc.getMap<{ deleted?: Record<string, string[]> }>("managed_base_v1").get("snapshot")?.deleted;
			const ids = removed?.[this.toVirtualPath(file.path)] ?? [];
			if (!ids.some(id => this.trackedEntries.has(id))) return null;
			if (file instanceof TFolder && file.children.length > 0) return null;
		}
		const isSyncableFile = this.isSyncableVaultFile(file);
		const fileInFolder = this.containsPath(file.path);
		const vpath = this.toVirtualPath(file.path);
		const fileInMap = allRemotePaths.has(vpath);
		const filePending = this.uploadClaims.has(vpath);
		if (!(fileInFolder && isSyncableFile && !fileInMap && !filePending)) {
			return null;
		}
		const trashing = (this.trashingPaths ??= new Set());
		if (trashing.has(vpath)) return null;
		trashing.add(vpath);

		diffLog.push(`removed local copy of ${vpath} -- serverId no longer shares it`);
		// A remote delete races with an offline local edit the same way
		// 's reconcile did — the difference is this path destroys
		// the file outright instead of overwriting it. Preserve any
		// unsynced edit as a conflict-copy first;
		// folders have no content of their own to preserve. Fail
		// CLOSED like 's reconcileWithConflictCopy: if we can't
		// positively confirm it's safe (nothing to preserve, or the
		// preserve step actually succeeded), skip the trash this
		// cycle rather than risk destroying an edit we couldn't check.
		const safeToTrashPromise =
			file instanceof TFile
				? CanvasDocument.matchesTrackedExtension(vpath)
					? this.preserveUnsyncedCanvasBeforeTrash(vpath)
					: this.preserveUnsyncedDocumentBeforeTrash(vpath)
				: Promise.resolve(true);

		const promise = safeToTrashPromise.then((safeToTrash) => {
			if (!safeToTrash) {
				diffLog.push(
					`skipped trashing ${vpath} — could not confirm no unsynced edits`,
				);
				return;
			}
			return this.vaultApi.adapter.trashLocal(file.path).then(() => {
				this.knownBeforeSync?.delete(vpath);
			});
		}).finally(() => {
			trashing.delete(vpath);
		});

		return { kind: "delete", filePath: vpath, completion: promise };
	}

	/**
	 * Shared implementation behind preserveUnsyncedDocumentBeforeTrash and
	 * preserveUnsyncedCanvasBeforeTrash (CanvasDocument follow-up
	 *): before a remote-delete cleanup trashes a local
	 * file, check whether it has unsynced edits and preserve them as a
	 * conflict-copy instead of letting `trashLocal` silently discard them.
	 *
	 * By the time pruneUntrackedFiles runs, the remote deletion has
	 * already removed this path's folderIndex entry (a CRDT map removal),
	 * so there's no "last known synced hash" left to compare against for
	 * that path. The one thing that CAN still hold the last-synced content
	 * is a live Document/CanvasDocument object in `this.trackedEntries` — nothing clears it
	 * in response to a remote delete, so for an entry whose session hasn't
	 * restarted since it was last synced, its in-memory content still
	 * reflects that state. Comparing the on-disk file against it is the
	 * same technique 's reconcileWithConflictCopy uses, applied to the
	 * delete path.
	 *
	 * `find` resolves the live Document/CanvasDocument for `vpath` (or undefined if
	 * none is tracked); `syncedContent` reads its last-known-synced
	 * content; `diverged` is the type-appropriate comparison (plain-text
	 * equality for Documents, deep-object equality via
	 * `hasUnsyncedCanvasEdit` for CanvasDocument JSON, since on-disk JSON is
	 * pretty-printed while the exported Y.Doc state isn't).
	 *
	 * Returns whether it's safe to proceed with the trash. Fails CLOSED,
	 * matching 's reconcileWithConflictCopy: any step we can't
	 * positively confirm (couldn't read the file, couldn't write the
	 * conflict-copy) returns false rather than falling through to trash —
	 * an orphaned local file left behind for the next cleanup pass to
	 * retry is strictly safer than destroying content we couldn't verify.
	 *
	 * Known gaps (not fixed here, scoped out for this P3 fix):
	 * - If the app restarted between the last sync and the remote delete,
	 *   `this.trackedEntries` has no entry for this path — nothing left to safely
	 *   compare against, so this falls back to the existing trash behavior.
	 * - `this.trackedEntries` is keyed by GUID and never pruned on a remote delete,
	 *   so a path that's been deleted-then-recreated more than once in the
	 *   same session could have more than one entry matching `vpath`.
	 *   `findByPath` returns the LAST match by iteration order (Map
	 *   iteration = insertion order), which is the most-recently-created —
	 *   i.e. the live one — but an old orphaned entry at the same path is
	 *   still possible in principle; this doesn't attempt to prune it.
	 * - An entry rebuilt from a local history with a gap in it (an offline
	 *   restart, the gap only fills from the server) reads as empty. It is not
	 *   the synced state, so a document compares against its stored sync base
	 *   instead. Without one (and for canvases, which keep none) the empty read
	 *   still differs from disk and a copy is kept: unsure means preserve.
	 */
	private async _preserveUnsyncedBeforeTrash<T extends Document | CanvasDocument, S>(
		vpath: string,
		find: (candidates: IterableIterator<SyncableEntry>, vpath: string) => T | undefined,
		syncedContent: (item: T) => S | Promise<S>,
		diverged: (onDisk: string, synced: S) => boolean,
	): Promise<boolean> {
		const item = find(this.trackedEntries.values(), vpath);
		if (!item) {
			return true;
		}
		const synced = await syncedContent(item);

		let onDiskContent: string;
		try {
			onDiskContent = await this.readContents(item);
		} catch (e: unknown) {
			this.warn(`Could not readContents ${vpath} before trashing`, e);
			return false;
		}

		if (!diverged(onDiskContent, synced)) {
			return true; // matches the last known synced content — nothing to preserve
		}

		try {
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const conflictPath = await this.writeConflictCopy(
				item,
				onDiskContent,
				`relay deleted ${timestamp}`,
			);
			this.log(
				`Preserved unsynced edits to ${vpath} at ${conflictPath} before linked-delete cleanup`,
			);
			return true;
		} catch (e: unknown) {
			this.warn(`Failed to write conflict copy for ${vpath} before trashing`, e);
			return false;
		}
	}

	/** @see _preserveUnsyncedBeforeTrash */
	private async preserveUnsyncedDocumentBeforeTrash(
		vpath: string,
	): Promise<boolean> {
		return this._preserveUnsyncedBeforeTrash<Document, string>(
			vpath,
			(candidates, v) =>
				findByPath(candidates, v, isDocument) as Document | undefined,
			async (doc) => (hasHistoryGap(doc.crdtDoc) ? await doc.getSyncBase() : undefined) ?? doc.content,
			hasUnsyncedEdit,
		);
	}

	/** @see _preserveUnsyncedBeforeTrash -- CanvasDocument equivalent. */
	private async preserveUnsyncedCanvasBeforeTrash(
		vpath: string,
	): Promise<boolean> {
		return this._preserveUnsyncedBeforeTrash<CanvasDocument, CanvasData>(
			vpath,
			(candidates, v) =>
				findByPath(candidates, v, isCanvasDocument) as CanvasDocument | undefined,
			(canvas) => CanvasDocument.exportData(canvas.crdtDoc),
			hasUnsyncedCanvasEdit,
		);
	}

	syncKind(
		folderIndex: FolderIndex,
		diffLog: string[],
		ops: SyncOpBase[],
		types: ItemKind[],
	) {
		folderIndex.eachRecord((meta, path) => {
			this._requireInScope(path);
			const supported = meta.type !== ItemKind.Folder && this.usesBaseSync(path, meta.id)
				? this.attachmentSettings.readValue().bases === true && meta.type === ItemKind.File && meta.version === 0
				: meta.type !== ItemKind.File || folderIndex.isSyncable(path);
			if (types.contains(meta.type) && supported) {
				this._requireInScope(path);
				ops.push(
					this.applyServerRecord(meta.id, path, folderIndex.knownGuids, diffLog),
				);
			}
		});
	}

	async scanFileTree(folderIndex: FolderIndex): Promise<void> {
		// Do not start SingleFlight's stall timer while waiting for the first
		// connection; offline startup may legitimately wait indefinitely.
		if (!(await this.awaitFolderTreeReady()) || this.isTornDown) return;
		// A sync is already in flight -- queue a follow-up pass instead of overlapping.
		if (this.treeScanInFlight) {
			this.resyncRequested = true;
			const promise = this.treeScanInFlight.getPromise();
			void promise.then(() => {
				if (this.resyncRequested) {
					this.resyncRequested = false;
					return this.scanFileTree(folderIndex);
				}
			});
			return promise;
		}

		const promiseFn = async (): Promise<void> => {
			try {
				const ops: SyncOpBase[] = [];
				const diffLog: string[] = [];

				this._logSyncFileTreeStart(folderIndex);

				void this.crdtDoc.transact(() => {
					// Folders go first -- a folder rename/move can shift where its files live too.
					this.folderIndex.upgradeLegacy();
					this.syncKind(folderIndex, diffLog, ops, [ItemKind.Folder]);
				}, this);
				await Promise.all(ops.map((op) => op.completion));
				void this.crdtDoc.transact(() => {
					this.syncKind(
						folderIndex,
						diffLog,
						ops,
						this.folderIndex.kinds.enabledSyncKinds(),
					);
					this.folderIndex.applyStaged();
				}, this);

				const creates = ops.filter((op): op is CreateOp => op.kind === "create");
				const renames = ops.filter((op): op is RenameOp => op.kind === "rename");
				// Compile-time-only proof the predicates above actually narrow
				// (not just a boolean filter): RenameOp.oldPath/.newPath aren't on
				// the SyncOp base, so this indexed-access type errors if the `op is
				// RenameOp` annotations regress to a plain predicate. Erased --
				// zero runtime cost, no logic change.
				// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-only proof, deliberately unreferenced
				type _RenamesNarrowedProof = Pick<(typeof renames)[number], "oldPath" | "newPath">;
				const remotePaths = ops.map((op) => op.filePath);

				// Deletion-detection needs the fresh file list, so wait for these first.
				await Promise.all(
					[...creates, ...renames].map((op) =>
						warnIfSlow<SyncableEntry | void>(op.completion, op),
					),
				);

				const deletes = this.pruneUntrackedFiles(remotePaths, diffLog);
				this._logSyncFileTreeResult(ops, deletes, diffLog, remotePaths);

				if (renames.length > 0 || creates.length > 0 || deletes.length > 0) {
					this.pathSet.update();
				}
			} finally {
				// Clear the in-flight marker whether this pass succeeded or threw.
				this.treeScanInFlight = null;
			}
		};

		this.treeScanInFlight = new SingleFlight<void>(promiseFn);

		return this.treeScanInFlight.getPromise();
	}

	private _logSyncFileTreeStart(folderIndex: FolderIndex): void {
		const metaEntries: string[] = [];
		folderIndex.eachRecord((meta, path) => metaEntries.push(`${path}(${meta.type}:${meta.id?.slice(0,8)})`));
		const legacyEntries: string[] = [];
		try {
			(this.folderIndex as unknown as Record<string, { forEach?: (cb: (guid: string, path: string) => void) => void }>).flatIdMap?.forEach?.((guid: string, path: string) => legacyEntries.push(`${path}=${guid?.slice(0,8)}`));
		} catch {
			/* ignore */
		}
		console.debug(`[VaultShare] scanFileTree START: meta=${metaEntries.length}, legacy=${legacyEntries.length}, path=${this.path}`);
		if (metaEntries.length > 0) console.debug(`[VaultShare] scanFileTree meta entries:`, metaEntries.slice(0, 20));
		if (legacyEntries.length > 0) console.debug(`[VaultShare] scanFileTree legacy entries:`, legacyEntries.slice(0, 20));
	}

	private _logSyncFileTreeResult(
		ops: SyncOpBase[],
		deletes: DeleteOp[],
		diffLog: string[],
		remotePaths: string[],
	): void {
		if ([...ops, ...deletes].every((op) => op.kind === "noop")) {
			this.debug("sync pass produced no changes");
		} else {
			this.log("paths seen from the server this pass:", remotePaths);
			this.log("operations applied this pass:", [...ops, ...deletes]);
		}
		if (diffLog.length > 0) {
			this.log("sync pass summary:\n" + diffLog.join("\n"));
		}
	}

	relocate(path: string) {
		this.path = path;
		this.setLoggers(`[VaultShare](${this.path})`);
		void this._config.mutateValue((current) => ({
			...current,
			path,
		}));
	}

	absolutePath(path: string): string {
		return join(this.path, path);
	}

	/**
	 * A share has no `entryPath` (see the field comment above), so the base
	 * implementation would report "unknown" for every share — including in the
	 * token requests and connection logs that call it.
	 */
	override getVaultPath(): string {
		return this.path || "unknown";
	}

	readContents(doc: SyncableEntry): Promise<string> {
		return this.vaultApi.adapter.read(normalizePath(this.absolutePath(doc.entryPath)));
	}

	hasFileSync(path: string): boolean {
		return (
			this.vaultApi.getAbstractFileByPath(normalizePath(this.absolutePath(path))) !==
			null
		);
	}

	hasFile(doc: SyncableEntry): Promise<boolean> {
		return this.vaultApi.adapter.exists(normalizePath(this.absolutePath(doc.entryPath)));
	}

	async writeContents(doc: SyncableEntry, content: string): Promise<void> {
		if (this.deletedEntries.has(doc) || this.isDeletePending(doc.entryPath)) {
			this.log("skipping write for pending delete", doc.entryPath);
			return Promise.resolve();
		}
		if (isDocument(doc) || isCanvasDocument(doc)) {
			const check = this.captureDocumentWrite(doc);
			await doc.assertNoRestoreReview(); check();
		}
		const vaultPath = normalizePath(this.absolutePath(doc.entryPath));
		this.log("writing to ", vaultPath);
		return this.mutateNativeSource([vaultPath], () => this.vaultApi.adapter.write(vaultPath, content));
	}

	/**
	 * Write `content` to a new file next to `doc.path`, never overwriting the
	 * original. Used to preserve content that a reconciliation is about to
	 * discard so nothing is silently lost — the file is
	 * left for the user to inspect/merge manually.
	 *
	 * Returns the doc-relative path (same shape as `doc.path`) it wrote to.
	 */
	async writeConflictCopy(
		doc: SyncableEntry,
		content: string,
		label: string,
	): Promise<string> {
		const conflictDocPath = buildConflictCopyPath(doc.entryPath, label);
		const target = normalizePath(this.absolutePath(conflictDocPath));
		await this.mutateNativeSource([target], () => this.vaultApi.adapter.write(target, content));
		return conflictDocPath;
	}

	requirePath(path: string) {
		if (!this.containsPath(path)) {
			throw new Error("path falls outside this shared folder: " + path);
		}
	}

	makeFolder(path: string): Promise<void> {
		const target = normalizePath(this.absolutePath(path));
		return this.mutateNativeSource([target], () => this.vaultApi.adapter.mkdir(target));
	}

	containsPath(path: string): boolean {
		// A root share (path === "") has no prefix to check against -- it
		// contains every real vault path unconditionally. The generic
		// `path.startsWith(this.path + sep)` math would otherwise test
		// `path.startsWith(sep)`, which is always false: real Obsidian
		// paths never start with a separator.
		if (isRootSharePath(this.path)) return true;
		return path.startsWith(this.path + sep);
	}

	toVirtualPath(path: string): string {
		this.requirePath(path);

		// A root share has no folder prefix to strip -- `path` is already
		// vault-relative. Falling through to the generic slice below would
		// chop off `path`'s own first character instead.
		if (isRootSharePath(this.path)) return path;

		// Slice past the folder path AND the separator (e.g., "Folder/file.md" -> "file.md")
		// Without +1, we'd get "/file.md" which starts with slash
		return path.slice(this.path.length + 1);
	}

	toVaultFile(file: SyncableEntry): TFile | null {
		const maybeTFile = this.vaultApi.getAbstractFileByPath(
			this.absolutePath(file.entryPath),
		);
		return maybeTFile instanceof TFile ? maybeTFile : null;
	}

	public docAt(vpath: string, update = true): Document {
		const id = this.folderIndex.guidFor(vpath);
		if (id === undefined) {
			return this._mintDocForUntrackedTFile(vpath, update);
		}
		const existing = this.trackedEntries.get(id);
		if (existing === undefined) {
			// A guid is tracked for this path but nothing is wrapping it in memory yet.
			this.log("[docAt]: no in-memory wrapper for this guid, building one");
			return this.newDoc(vpath, update);
		}
		existing.relocate(vpath, this);
		if (!isDocument(existing)) {
			throw new Error("docAt(): resolved to a non-Document ifile");
		}
		return existing;
	}

	private _mintDocForUntrackedTFile(vpath: string, update: boolean): Document {
		// The on-disk file exists, but the folder index has no guid for it yet.
		this.warn("[docAt]: minting a fresh guid for an untracked file");
		const tfile = this.vaultApi.getAbstractFileByPath(this.absolutePath(vpath));
		if (!(tfile instanceof TFile)) {
			throw new Error("expected a TFile at this path but found none (or a folder)");
		}
		const newDocs = this.claimPaths([tfile]);
		return newDocs.length > 0
			? this.publishDoc(vpath)
			: this.newDoc(vpath, update);
	}

	public canvasAt(vpath: string, update = true): CanvasDocument {
		const id = this.folderIndex.guidFor(vpath);
		if (id === undefined) {
			return this._mintCanvasForUntrackedTFile(vpath, update);
		}
		const existing = this.trackedEntries.get(id);
		if (existing === undefined) {
			// A guid is tracked for this path but nothing is wrapping it in memory yet.
			this.log("[canvasAt]: no in-memory wrapper for this guid, building one");
			return this.newCanvas(vpath, update);
		}
		existing.relocate(vpath, this);
		if (!isCanvasDocument(existing)) {
			throw new Error("canvasAt(): resolved to a non-Canvas ifile");
		}
		return existing;
	}

	private _mintCanvasForUntrackedTFile(
		vpath: string,
		update: boolean,
	): CanvasDocument {
		// The on-disk file exists, but the folder index has no guid for it yet.
		this.warn("[canvasAt]: minting a fresh guid for an untracked file");
		const tfile = this.vaultApi.getAbstractFileByPath(this.absolutePath(vpath));
		if (!(tfile instanceof TFile)) {
			throw new Error("expected a TFile at this path but found none (or a folder)");
		}
		const newDocs = this.claimPaths([tfile]);
		return newDocs.length > 0
			? this.publishCanvas(vpath)
			: this.newCanvas(vpath, update);
	}

	async noteUploaded(file: SyncableEntry, upload?: AttachmentUpload): Promise<void> {
		if (!this.folderIndex || this.deletedEntries.has(file) || this.isDeletePending(file.entryPath)) return;
		if (this.usesBaseSync(file.entryPath, file.entityGuid)) return;
		let checkDocument: (() => void) | undefined;
		if (isDocument(file) || isCanvasDocument(file)) {
			checkDocument = this.captureDocumentWrite(file);
			await file.assertNoRestoreReview(); checkDocument();
		}
		if (upload && isAttachmentFile(file)) {
			upload.check();
			// A late success acknowledges only the exact bytes sent. Reading the
			// latest CAF hash here could publish a newer file that was never uploaded.
			const type = this.folderIndex.kinds.kindForPath(file.path);
			if (!type) throw new Error("No registered sync type covers this path");
			this._commitMeta(file, makeFileRecord(type as AttachmentKind, file.entityGuid, file.mimeType, upload.hash, upload.mtime));
			return;
		}
		const meta = await this._metaForUpload(file);
		checkDocument?.();
		if (meta) {
			this._commitMeta(file, meta);
		}
	}

	private async _metaForUpload(file: SyncableEntry): Promise<ItemRecord | null> {
		if (isDocument(file)) {
			return makeDocumentRecord(file.entityGuid);
		}
		if (isCanvasDocument(file)) {
			return makeCanvasRecord(file.entityGuid);
		}
		if (isTrackedFolder(file)) {
			return makeFolderRecord(file.entityGuid);
		}
		if (isAttachmentFile(file)) {
			const type = this.folderIndex.kinds.kindForPath(file.path);
			if (!type) {
				throw new Error("no registered sync type covers this path");
			}
			const hash = await file.contentAddressedCache.resolveHash();
			if (!hash) {
				throw new Error("content hash isn't ready yet");
			}
			return makeFileRecord(
				type as AttachmentKind,
				file.entityGuid,
				file.mimeType,
				hash,
				file.stat.mtime,
			);
		}
		return null;
	}

	private _commitMeta(file: SyncableEntry, meta: ItemRecord): void {
		if (!this.folderIndex || this.deletedEntries.has(file) || this.isDeletePending(file.entryPath)) {
			return;
		}
		try {
			if (this.folderIndex.wouldChange(file.entryPath, meta)) {
				this.log("new meta", file.entryPath, meta);
				this.crdtDoc.transact(() => {
					this.folderIndex.recordUpload(file.entryPath, meta);
				}, this);
			}
		} catch (e: unknown) {
			this.warn(`noteUploaded failed for ${file.entryPath}`, e);
		}
	}

	entryFor(tfile: TAbstractFile, update = true): SyncableEntry | null {
		const vpath = this.toVirtualPath(tfile.path);
		const guid = this.folderIndex.guidFor(vpath);

		// A tracked guid means the folder index already knows what kind of file this is.
		if (guid) {
			const file = this.trackedEntries.get(guid);
			if (file) {
				return file;
			}

			// Tracked, but no in-memory wrapper yet -- build one from its metadata type.
			const meta = this.folderIndex.recordFor(vpath);
			if (meta) {
				switch (meta.type) {
					case ItemKind.Document:
						return this.docAt(vpath);
					case ItemKind.Canvas:
						return this.canvasAt(vpath);
					case ItemKind.Folder:
						return this.folderAt(vpath, update);
					default:
						// Anything else falls back to the generic synced-file wrapper.
						if (this.folderIndex.isSyncable(vpath)) {
							return this.attachmentAt(vpath, update);
						}
				}
			}
		}

		// Fallback to extension-based detection for new files: folders sync
		// as-is, files are typed by extension in doc > canvas > generic order.
		if (tfile instanceof TFolder) {
			return this.folderAt(vpath, update);
		}
		if (!(tfile instanceof TFile)) {
			return null;
		}
		if (Document.matchesTrackedExtension(vpath)) {
			return this.docAt(vpath);
		}
		if (CanvasDocument.matchesTrackedExtension(vpath) && currentToggles().enableCanvasSync) {
			return this.canvasAt(vpath);
		}
		if (this.folderIndex.isSyncable(vpath)) {
			return this.attachmentAt(vpath, update);
		}
		return null;
	}

	claimPaths(newFiles: TAbstractFile[]): string[] {
		const claimed: string[] = [];
		this.crdtDoc.transact(() => {
			for (const file of newFiles) {
				const vpath = this.toVirtualPath(file.path);
				if (this.isDeletePending(vpath)) {
					this.log("won't claim a path that's pending delete:", vpath);
					continue;
				}
				if (this.folderIndex.tracks(vpath)) {
					continue;
				}
				this.log("claiming a fresh guid for:", vpath);
				this.folderIndex.new(vpath);
				claimed.push(vpath);
			}
		}, this);
		return claimed;
	}

	ensureCanvas(guid: string, vpath: string): CanvasDocument {
		const existing = this.trackedEntries.get(guid);
		const canvas = existing ?? new CanvasDocument(vpath, guid, this.authSession, this);
		if (!isCanvasDocument(canvas)) {
			throw new Error("ensureCanvas(): resolved to a non-Canvas ifile");
		}
		canvas.relocate(vpath, this);
		return canvas;
	}

	pullCanvas(vpath: string, update = true): CanvasDocument {
		return this._downloadTyped<CanvasDocument>(
			vpath,
			update,
			CanvasDocument.matchesTrackedExtension,
			(guid, v) => this.ensureCanvas(guid, v),
			(canvas) => void this.transfers.enqueueCanvasFetch(canvas),
		);
	}

	public publishCanvas(vpath: string, update = true, priority = false): CanvasDocument {
		return this._uploadTyped<CanvasDocument>(
			vpath,
			update,
			priority,
			CanvasDocument.matchesTrackedExtension,
			(guid, v) => this.ensureCanvas(guid, v),
			(canvas, contents) => {
				try {
					canvas.applyJsonPayload(contents);
				} catch (e: unknown) {
					console.warn(contents);
					throw e;
				}
			},
		);
	}

	public newCanvas(vpath: string, update: boolean): CanvasDocument {
		if (!CanvasDocument.matchesTrackedExtension(vpath)) {
			throw new Error("path's extension doesn't match this file type");
		}
		if (!this.isSynced && !this.folderIndex.tracks(vpath)) {
			throw new Error(`local state hasn't synced yet, refusing to risk a split at ${vpath}`);
		}
		const guid = this.folderIndex.guidFor(vpath);
		if (!guid) {
			throw new Error("no guid is tracked for this path yet");
		}
		const canvas = this.ensureCanvas(guid, vpath);

		void this.awaitReady().then(() => this._reconcileNewCanvas(canvas));

		this.trackedEntries.set(guid, canvas);
		this.pathSet.include(canvas, update);
		return canvas;
	}

	private async _reconcileNewCanvas(canvas: CanvasDocument): Promise<void> {
		const synced = await canvas.getServerAcked();
		if (canvas.crdtStat.size === 0 && !synced) {
			void this.transfers.enqueueCanvasFetch(canvas);
		} else if (this.uploadClaims.get(canvas.entryPath)) {
			void this.transfers.enqueueUpload(canvas);
		} else if (!synced && this.workspaceId) {
			// For relay-onprem: CanvasDocument hasn't been synced to server yet
			void this.transfers.enqueueCanvasFetch(canvas);
		}
	}

	public peekDoc(vpath: string): Document | undefined {
		const guid = this.folderIndex.guidFor(vpath);
		if (!guid) {
			return undefined;
		}
		const doc = this.trackedEntries.get(guid);
		if (!isDocument(doc)) {
			throw new Error("peekDoc(): resolved to a non-Document ifile");
		}
		return doc;
	}

	public peekAttachment(vpath: string): AttachmentFile | undefined {
		const guid = this.folderIndex.guidFor(vpath);
		if (!guid) {
			return undefined;
		}
		const file = this.trackedEntries.get(guid);
		if (!file) {
			// Tracked by guid, but no in-memory wrapper has been built for it yet.
			this.debug(`peekAttachment(): no wrapper built yet, guid=${guid}, vpath=${vpath}`);
			return undefined;
		}
		if (isAttachmentFile(file)) {
			return file;
		}
		// The wrapper exists but isn't an AttachmentFile -- can happen when a feature
		// featureKey or fresh server metadata reclassifies the path as a CanvasDocument/Document/etc.
		this.debug(
			`peekAttachment(): wrapper isn't an AttachmentFile, guid=${guid}, vpath=${vpath}, actual type=${file.constructor.name}`,
		);
		return undefined;
	}

	ensureDoc(guid: string, vpath: string): Document {
		const existing = this.trackedEntries.get(guid);
		const doc = existing ?? new Document(vpath, guid, this.authSession, this);
		if (!isDocument(doc)) {
			throw new Error("resolved to the wrong ifile subtype");
		}
		doc.relocate(vpath, this);
		return doc;
	}

	pullDoc(vpath: string, update = true): Document {
		return this._downloadTyped<Document>(
			vpath,
			update,
			Document.matchesTrackedExtension,
			(guid, v) => this.ensureDoc(guid, v),
			// A peer's new note: someone is waiting for it to appear. A
			// share's first pull creates every note at once; only its first
			// few go ahead, the rest stay bulk so they can't hold every slot.
			(doc) =>
				void this.transfers.enqueueFetch(doc, {
					priority: this.transfers.priorityFetches(this) < this.transfers.laneLimit,
				}),
		);
	}

	/**
	 * Shared implementation behind pullDoc/pullCanvas: mint (or
	 * reuse) the live entry, mark it as remote-originated, hand it to
	 * TransferQueue to pull content for, and register it.
	 */
	private _downloadTyped<T extends Document | CanvasDocument>(
		vpath: string,
		update: boolean,
		checkExtension: (v: string) => boolean,
		mint: (guid: string, vpath: string) => T,
		enqueue: (item: T) => void,
	): T {
		if (!checkExtension(vpath)) {
			throw new Error("path's extension doesn't match this file type");
		}
		if (!this.isSynced && !this.folderIndex.tracks(vpath)) {
			throw new Error(`local state hasn't synced yet, refusing to risk a split at ${vpath}`);
		}
		const guid = this.folderIndex.guidFor(vpath);
		if (!guid) {
			throw new Error(`download requested for an untracked path ${vpath}`);
		}
		const item = mint(guid, vpath);
		void (isDocument(item) ? item.markSyncOrigin("remote") : item.markSyncOrigin("remote"));
		enqueue(item);

		this.trackedEntries.set(guid, item);
		this.pathSet.include(item, update);
		return item;
	}

	publishDoc(vpath: string, update = true, priority = false): Document {
		return this._uploadTyped<Document>(
			vpath,
			update,
			priority,
			Document.matchesTrackedExtension,
			(guid, v) => this.ensureDoc(guid, v),
			(doc, contents) => {
				doc.crdtDoc.getText("contents").insert(0, contents);
			},
		);
	}

	/**
	 * Shared implementation behind publishDoc/publishCanvas: mint (or reuse)
	 * the live entry, and -- iff no peer has ever seen this vpath yet --
	 * seed its Y.Doc from the on-disk content and hand it to TransferQueue
	 * to publish. `seed` is the one truly type-specific step (Document
	 * inserts plain text into a Y.Text; CanvasDocument parses+applies JSON).
	 */
	private _uploadTyped<T extends Document | CanvasDocument>(
		vpath: string,
		update: boolean,
		priority: boolean,
		checkExtension: (v: string) => boolean,
		mint: (guid: string, vpath: string) => T,
		seed: (item: T, contents: string) => void,
	): T {
		if (!checkExtension(vpath)) {
			throw new Error("path's extension doesn't match this file type");
		}
		if (!this.isSynced && !this.folderIndex.tracks(vpath)) {
			throw new Error(`local state hasn't synced yet, refusing to risk a split at ${vpath}`);
		}
		const guid: string | undefined = this.folderIndex.guidFor(vpath);
		if (!guid) {
			throw new Error("path has no tracked guid");
		}
		const item = mint(guid, vpath);

		const originPromise = isDocument(item) ? item.getSyncOrigin() : item.getSyncOrigin();
		const awaitingUpdatesPromise = this.hasPendingUpdates();

		void (async () => {
			const hasFile = await this.hasFile(item);
			if (!hasFile) {
				throw new Error(`can't upload -- no on-disk doc found at ${vpath}`);
			}
			const [contents, origin, hasPendingUpdates] = await Promise.all([
				this.readContents(item),
				originPromise,
				awaitingUpdatesPromise,
			]);
			if (!hasPendingUpdates && origin === undefined) {
				// Relay documents are initialized by the transfer queue after
				// connecting and settling the init claim. Seeding here races
				// that upload: its earlier disk snapshot can mistake our own
				// intermediate text for a remote conflict before a sync base exists.
				if (!this.workspaceId || !isDocument(item)) {
					this.log(`[${item.entryPath}] No Known Peers: Syncing file into ytext.`);
					void this.crdtDoc.transact(() => {
						seed(item, contents);
					}, this._localDb);
				}
				void (isDocument(item) ? item.markSyncOrigin("local") : item.markSyncOrigin("local"));
				this.log(`[${item.entryPath}] Uploading file`);
				await this.transfers.enqueueUpload(item, { priority });
				void this.noteUploaded(item).catch(error => this.warn("Document metadata was not acknowledged", error));
			}
		})();

		this.trackedEntries.set(guid, item);
		this.pathSet.include(item, update);
		return item;
	}

	newDoc(vpath: string, update = true): Document {
		if (!Document.matchesTrackedExtension(vpath)) {
			throw new Error("path's extension doesn't match this file type");
		}
		if (!this.isSynced && !this.folderIndex.tracks(vpath)) {
			throw new Error(`local state hasn't synced yet, refusing to risk a split at ${vpath}`);
		}
		const guid = this.folderIndex.guidFor(vpath);
		if (!guid) {
			throw new Error("no guid is tracked for this path yet");
		}
		const doc = this.ensureDoc(guid, vpath);

		void this.awaitReady().then(() => this._reconcileNewDoc(doc));

		this.trackedEntries.set(guid, doc);
		this.pathSet.include(doc, update);

		return doc;
	}

	private async _reconcileNewDoc(doc: Document): Promise<void> {
		const synced = await doc.getServerAcked();
		if (doc.obsidianFile?.stat.size === 0 && !synced) {
			void this.transfers.enqueueFetch(doc);
		} else if (this.uploadClaims.get(doc.entryPath)) {
			void this.transfers.enqueueUpload(doc);
		} else if (!synced && this.workspaceId) {
			// For relay-onprem: Document hasn't been synced to server yet.
			// Use enqueueUpload (WebSocket path) which properly reconciles:
			// if the relay is empty and local file has content, it uploads;
			// if the relay has content, it merges via applyDiffToYText.
			// enqueueFetch also syncs over WS for relay-linked docs,
			// but with worse timing guarantees.
			void this.transfers.enqueueUpload(doc);
		}
	}

	private ensureFolder(guid: string, vpath: string) {
		const existing = this.trackedEntries.get(guid);
		const folder = existing ?? new TrackedFolder(vpath, guid, this);
		if (!isTrackedFolder(folder)) {
			throw new Error("resolved to the wrong ifile subtype");
		}
		folder.relocate(vpath, this);
		return folder;
	}

	// Callers of folderAt either already hold a valid vpath->guid
	// mapping (`synced`) or must have registered one via claimPaths() first --
	// hence the split-detection guard below.
	folderAt(vpath: string, update: boolean) {
		this.log("[folderAt]", `resolving folder wrapper`);
		if (!this.isSynced && !this.folderIndex.tracks(vpath)) {
			throw new Error(`local state hasn't synced yet, refusing to risk a split at ${vpath}`);
		}
		const guid = this.folderIndex.guidFor(vpath);
		if (!guid) {
			throw new Error("no guid is tracked for this path yet");
		}

		const folder = this.ensureFolder(guid, vpath);
		this.trackedEntries.set(guid, folder);
		this.pathSet.include(folder, update);
		return folder;
	}

	ensureAttachment(guid: string, vpath: string, hashOrTFile: TFile | string): AttachmentFile {
		const existing = this.trackedEntries.get(guid);
		const file = existing ?? new AttachmentFile(vpath, guid, this.hashCache, this);
		if (!isAttachmentFile(file)) {
			throw new Error(`ensureAttachment(): unexpected ifile type, guid=${guid}`);
		}
		file.relocate(vpath, this);
		this.trackedEntries.set(guid, file);
		return file;
	}

	/** Shared guid-resolution prefix for the four AttachmentFile accessors below. */
	private _requireSyncFileGuid(vpath: string, missingGuidMessage: string): string {
		if (!this.folderIndex.isSyncable(vpath) && !(this.usesBaseSync(vpath, this.folderIndex.guidFor(vpath)) && this.attachmentSettings.readValue().bases === true)) {
			throw new Error("path's extension doesn't match this file type");
		}
		if (!this.isSynced && !this.folderIndex.tracks(vpath)) {
			throw new Error(`local state hasn't synced yet, refusing to risk a split at ${vpath}`);
		}
		const guid = this.folderIndex.guidFor(vpath);
		if (!guid) {
			throw new Error(missingGuidMessage);
		}
		return guid;
	}

	/** Shared vault-TFile resolution for publishAttachment/attachmentAt. */
	private _requireVaultTFile(vpath: string): TFile {
		const tfile = this.vaultApi.getAbstractFileByPath(this.absolutePath(vpath));
		if (!tfile) {
			throw new Error(`can't upload -- no on-disk file found at ${vpath}`);
		}
		if (!(tfile instanceof TFile)) {
			throw new Error(`can't upload -- ${vpath} resolved to a folder, not a file`);
		}
		return tfile;
	}

	syncAttachment(vpath: string, update: boolean) {
		const guid = this._requireSyncFileGuid(
			vpath,
			`called syncNow on item that is not in ids ${vpath}`,
		);
		const meta = this.folderIndex.recordFor(vpath);
		if (!meta || !meta.hash) {
			return this.publishAttachment(vpath, update);
		}
		const file = this.ensureAttachment(guid, vpath, meta.hash);

		void this.transfers.enqueueUpload(file);

		this.trackedEntries.set(guid, file);
		this.pathSet.include(file, update);

		return file;
	}

	pullAttachment(vpath: string, update: boolean) {
		const guid = this._requireSyncFileGuid(
			vpath,
			`called download on item that is not in ids ${vpath}`,
		);
		const meta = this.folderIndex.recordFor(vpath);
		if (!meta || !meta.hash && !this.usesBaseSync(vpath, guid)) {
			return this.publishAttachment(vpath, update);
		}
		const file = this.ensureAttachment(guid, vpath, meta.hash ?? "");

		void this.transfers.enqueueFetch(file);

		this.trackedEntries.set(guid, file);
		this.pathSet.include(file, update);

		return file;
	}

	publishAttachment(vpath: string, update = true): AttachmentFile {
		const guid = this._requireSyncFileGuid(vpath, "path has no tracked guid");
		const tfile = this._requireVaultTFile(vpath);
		const file = this.ensureAttachment(guid, vpath, tfile);

		void this.transfers.enqueueUpload(file);

		this.pathSet.include(file, update);
		return file;
	}

	attachmentAt(vpath: string, update = true): AttachmentFile {
		const guid = this._requireSyncFileGuid(vpath, "path has no tracked guid");
		const tfile = this._requireVaultTFile(vpath);
		const file = this.ensureAttachment(guid, vpath, tfile);

		const meta = this.folderIndex.recordFor(vpath);
		if (!meta) {
			this.log("no server metadata for this file yet, pushing local content");
			void file.pushToRemote();
		} else {
			void file.pullFromRemote();
		}

		this.trackedEntries.set(guid, file);
		this.pathSet.include(file, update);
		return file;
	}

	publishFile(tfile: TAbstractFile, update = true, priority = false): SyncableEntry {
		const vpath = this.toVirtualPath(tfile.path);
		if (tfile instanceof TFolder) {
			return this.folderAt(vpath, update);
		}
		if (tfile instanceof TFile) {
			if (Document.matchesTrackedExtension(vpath)) {
				return this.publishDoc(vpath, update, priority);
			}
			if (CanvasDocument.matchesTrackedExtension(vpath) && currentToggles().enableCanvasSync) {
				return this.publishCanvas(vpath, update, priority);
			}
			if (this.folderIndex.isSyncable(vpath)) {
				return this.publishAttachment(vpath, update);
			}
		}
		throw new Error("no upload path matched this file's type");
	}

	/** Create missing ancestors separately so each vault create event has an owner. */
	async createFolderForEntry(entry: SyncableEntry): Promise<TFolder> {
		const parts = entry.entryPath.split("/");
		let node: TFolder | null = null;
		for (let length = 1; length <= parts.length; length++) {
			if (this.deletedEntries.has(entry) || this.isDeletePending(entry.entryPath)) {
				throw new Error("folder entry was deleted during creation");
			}
			const vpath = parts.slice(0, length).join("/");
			const existing = this.vaultApi.getAbstractFileByPath(this.absolutePath(vpath));
			if (existing instanceof TFolder) {
				node = existing;
				continue;
			}
			node = await this.createOwnedFolderAt(entry, vpath);
		}
		if (!node) throw new Error("folder path is empty");
		return node;
	}

	private createOwnedFolderAt(entry: SyncableEntry, vpath: string): Promise<TFolder> {
		const check = this.captureNativeSource();
		const path = this.absolutePath(vpath);
		const ancestors = vpath.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));
		const before = new Map(ancestors.map((ancestor) => [ancestor, this.vaultApi.getAbstractFileByPath(this.absolutePath(ancestor))]));
		// Register before even a synchronous create event. Include ancestors because
		// Obsidian may recreate a removed parent inside its recursive mkdir call.
		const creation = Promise.resolve().then(async () => {
			let node: TFolder;
			try {
				check();
				node = await this.mutateNativeSource([path], () => this.vaultApi.createFolder(path));
				check();
			} catch (error: unknown) {
				check();
				// Another creator won this path. Its object belongs to that creator.
				const existing = this.vaultApi.getAbstractFileByPath(path);
				if (existing instanceof TFolder) return existing;
				throw error;
			}
			let deletedRoot = this.deletedEntryRoots?.get(entry);
			if (deletedRoot === undefined) deletedRoot = Array.from(this.awaitingDelete).find((root) => entry.entryPath === root || entry.entryPath.startsWith(root + "/"));
			if (deletedRoot !== undefined) {
				const discarded = this.discardedFolderNodes ??= new WeakSet();
				discarded.add(node);
				// Follow only newly-created objects in the returned parent chain, inside
				// the deleted subtree. Trash bottom-up, without permanent deletion.
				const chain: TFolder[] = [];
				for (let candidate: TFolder | null = node; candidate; candidate = candidate.parent) {
					if (!this.containsPath(candidate.path)) break;
					const candidatePath = this.toVirtualPath(candidate.path);
					if (candidatePath !== deletedRoot && !candidatePath.startsWith(deletedRoot + "/")) break;
					if (candidate === node || before.get(candidatePath) !== candidate) chain.push(candidate);
				}
				for (const candidate of chain) {
					if (this.vaultApi.getAbstractFileByPath(candidate.path) !== candidate) {
						discarded.add(candidate);
						continue;
					}
					if (candidate.children.length !== 0) continue;
					discarded.add(candidate);
					try {
						await this.trashFile(candidate);
					} catch (error: unknown) {
						this.warn("could not remove discarded folder creation", candidate.path, error);
					}
				}
			}
			return node;
		});
		const slots = ancestors.map((ancestor) => {
			const pending = (this.folderCreations ??= new Map()).get(ancestor) ?? new Set<Promise<TFolder>>();
			pending.add(creation);
			this.folderCreations.set(ancestor, pending);
			return { ancestor, pending };
		});
		const finished = () => {
			for (const { ancestor, pending } of slots) {
				pending.delete(creation);
				if (pending.size === 0 && this.folderCreations.get(ancestor) === pending) this.folderCreations.delete(ancestor);
			}
		};
		void creation.then(finished, finished);
		return creation;
	}

	/**
	 * Claim-protected entry point for callers OUTSIDE the adoptLocalFiles()
	 * bulk-sync flow that discover a single new file and would otherwise
	 * call claimPaths()+publishFile() directly -- e.g. main.ts's vault
	 * "create" event, which (per its own long-standing comment) fires for
	 * every pre-existing file at startup, including ones under a
	 * freshly-loaded VaultShare before that folder's own adoptLocalFiles()
	 * has necessarily run. Without this, that handler mints-then-uploads
	 * completely unprotected by the upload claim, re-opening the exact
	 * divergent-guid race adoptLocalFiles() closes for the SAME "two clients
	 * discover a brand-new shared vpath at once" scenario, just triggered by
	 * a different Obsidian event.
	 */
	async claimAndUploadFile(tfile: TAbstractFile): Promise<void> {
		// Local recovery copies stay local (GH #4) -- this handler also sees
		// the ones this client writes itself.
		if (isConflictCopyPath(tfile.path)) return;
		const vpath = this.toVirtualPath(tfile.path);
		// Startup "create" events can arrive before the tree scan has looked at
		// the persisted records; take them first so the check below sees them.
		if (!this.freshlyCreated && !this.knownBeforeSync) await this.recordsBeforeSync();
		if (this.removedWhileAway(vpath)) return;
		if (tfile instanceof TFolder) {
			const pending = this.folderCreations?.get(vpath);
			if (pending?.size) await Promise.allSettled(Array.from(pending));
			if (this.discardedFolderNodes?.has(tfile) || this.isDeletePending(vpath)) return;
		}
		if (this._liveProvider.managedIndex) {
			const allowed = await this._liveProvider.managedIndex.publishablePaths([vpath]);
			if (!allowed.has(vpath)) return;
		}
		const newDocs = this.claimPaths([tfile]);
		if (newDocs.length === 0) {
			// Already known -- ordinary existing-file path, unchanged.
			await this.awaitReady();
			this.entryFor(tfile);
			return;
		}

		const raceable =
			Document.matchesTrackedExtension(vpath) ||
			(CanvasDocument.matchesTrackedExtension(vpath) && currentToggles().enableCanvasSync);
		if (!raceable) {
			this.publishFile(tfile);
			return;
		}

		const { lost } = await this.claimUploadPaths([vpath]);
		if (lost.length === 0) {
			// One note created now, not a bulk adoption pass: queue it ahead.
			this.publishFile(tfile, true, true);
			return;
		}
		if (Document.matchesTrackedExtension(vpath)) {
			await this.adoptWinnerDoc(vpath);
		} else {
			await this.adoptWinnerCanvas(vpath);
		}
	}

	markDeletePending(vpath: string) {
		this.awaitingDelete.add(vpath);
		this.log("flagged as pending delete:", vpath);
	}

	clearDeletePending(vpath: string) {
		this.awaitingDelete.delete(vpath);
		this.log("pending-delete flag lifted:", vpath);
	}

	isDeletePending(vpath: string): boolean {
		for (const path of this.awaitingDelete) {
			if (vpath === path || vpath.startsWith(path + "/")) return true;
		}
		return false;
	}

	removeEntry(vpath: string, recursive = false) {
		if (!this.folderIndex) return;
		recursive = recursive || isFolderRecord(this.folderIndex.recordFor(vpath));
		const removed: SyncableEntry[] = [];
		for (const doc of this.trackedEntries.values()) {
			if (doc.entryPath === vpath || (recursive && doc.entryPath.startsWith(vpath + "/"))) {
				this.deletedEntries.add(doc);
				(this.deletedEntryRoots ??= new WeakMap()).set(doc, vpath);
				removed.push(doc);
			}
		}
		this.crdtDoc.transact(() => {
			if (recursive) this.folderIndex.deleteTree(vpath);
			else this.folderIndex.delete(vpath);
			for (const doc of removed) {
				void doc.dispose();
				this.pathSet.delete(doc);
				this.trackedEntries.delete(doc.entityGuid);
			}
		}, this);
		// Fully tear down the Document/CanvasDocument after removing from folderIndex:
		// cancel pending debounced saves, disconnect WebSocket, destroy Y.Doc.
		// Without this, a stale scheduleSave debounce can re-create the file
		// on disk after clearDeletePending runs.
		for (const doc of removed) {
			this._teardownDeletedFile(doc);
		}
	}

	private _teardownDeletedFile(doc: SyncableEntry): void {
		if (isDocument(doc)) {
			doc.scheduleSave.cancel();
			doc._obsidianFile = null;
		}
		doc.goOffline();
		doc.dismantle();
	}

	/** A hold drains already-admitted I/O, while this session check refuses an
	 * old asynchronous callback that reaches native admission after teardown. */
	private captureNativeSource(): () => void {
		const root = this.path, selection = this.sourceSelection;
		return () => {
			if (this.isTornDown || this.path !== root || this.sourceSelection !== selection) throw new Error("The shared-folder source changed. Local work is retained.");
			selection?.assertFolder(this.hostAppId, this.config.onpremServerId, ResourceAddress.serialize(this.resourceAddress));
		};
	}
	private async mutateNativeSource<T>(paths: readonly string[], mutation: () => Promise<T>): Promise<T> {
		const check = this.captureNativeSource();
		const result = await trackNativeSourceMutation(this.vaultApi, paths, () => { check(); return mutation(); });
		check(); return result;
	}

	async trashFile(file: TAbstractFile): Promise<void> {
		await this.mutateNativeSource([file.path], () => this.fileOps.trashFile(file));
	}

	renameEntry(tfile: TAbstractFile, oldPath: string) {
		if (this.isRecoveryMove(oldPath, tfile.path)) return;
		const newPath = tfile.path;
		const newVPath = this._tryGetVirtualPath(
			newPath,
			"Moving out of shared folder",
		);
		const oldVPath = this._tryGetVirtualPath(
			oldPath,
			"Moving in from outside of shared folder",
		);

		if (!newVPath && !oldVPath) {
			// Neither endpoint touches a shared folder -- nothing for us to do.
			return;
		}
		if (!oldVPath) {
			// Arriving from outside any shared folder -- needs a live doc minted for it.
			this._renameIntoVaultShare(tfile, newPath, newVPath);
			return;
		}
		if (!newVPath) {
			// Leaving the shared folder entirely -- tear down its live doc.
			this._renameOutOfVaultShare(oldVPath);
			return;
		}
		// Staying inside the same shared folder -- just relocate the live doc.
		this._renameWithinVaultShare(oldVPath, newVPath);
	}

	private _tryGetVirtualPath(path: string, logMessageOnFailure: string): string {
		try {
			return this.toVirtualPath(path);
		} catch {
			this.log(logMessageOnFailure);
			return "";
		}
	}

	private _renameIntoVaultShare(
		tfile: TAbstractFile,
		newPath: string,
		newVPath: string,
	): void {
		this.requirePath(newPath);
		if (!this.folderIndex.isSyncable(newVPath)) return;
		this.claimPaths([tfile]);
		this.publishFile(tfile);
	}

	private _renameOutOfVaultShare(oldVPath: string): void {
		const guid = this.folderIndex.guidFor(oldVPath);
		if (!guid) return;
		const file = this.trackedEntries.get(guid);
		this.crdtDoc.transact(() => {
			this.folderIndex.delete(oldVPath);
		}, this);
		if (file) {
			void file.dispose();
			file.dismantle();
			this.pathSet.delete(file);
		}
		this.trackedEntries.delete(guid);
	}

	private _renameWithinVaultShare(oldVPath: string, newVPath: string): void {
		const guid = this.folderIndex.guidFor(oldVPath);
		if (!guid) {
			return;
		}
		const file = this.trackedEntries.get(guid);

		const toMove: [string, string, string][] = [];
		if (file instanceof TrackedFolder) {
			this.folderIndex.eachRecord((meta, path) => {
				if (path.startsWith(oldVPath + sep)) {
					const destination = path.replace(oldVPath, newVPath);
					toMove.push([meta.id, path, destination]);
				}
			});
		}
		this.crdtDoc.transact(() => {
			this.folderIndex.repath(oldVPath, newVPath);
			if (file) {
				file.relocate(newVPath, this);
			}
			toMove.forEach(([subGuid, from, to]) => {
				this.folderIndex.repath(from, to);
				const subdoc = this.trackedEntries.get(subGuid);
				if (subdoc) {
					// Must stay inside the same transaction as the folderIndex move above.
					subdoc.relocate(to, this);
				}
			});
		}, this);

		// A nested-folder move updates the folder index in one bulk operation, but
		// Obsidian still fires a separate tfile event per descendant -- the two
		// can briefly disagree until every one of those events has arrived.
		this.folderIndex.clearAlias(oldVPath);
	}

	dismantle() {
		this.isTornDown = true;
		this.sourceSelection?.close();
		this.lostClaimSettler.cancelAll();
		this.cancelInitialFolderSync?.();
		this.cancelInitialFolderSync = null;
		this.teardowns.forEach((unsub) => {
			unsub();
		});
		this.trackedEntries.forEach((doc: SyncableEntry) => {
			doc.dismantle();
			this.trackedEntries.delete(doc.entityGuid);
		});
		this.folderIndex.destroy();
		this.docActivity?.destroy();
		this.attachmentSettings.destroy();
		super.dismantle();
		this.crdtDoc.destroy();
		this.pathSet.clearAll();
		this._config.destroy();
		this._nullOutFields();
		this.syncedValue?.destroy();
		this.syncedValue = null;
		this.readyValue?.destroy();
		this.readyValue = null;
		this.treeScanInFlight?.destroy();
		this.treeScanInFlight = null;
	}

	/**
	 * Release references to collaborators after teardown so a lingering
	 * closure elsewhere can't keep this folder's dependency graph alive.
	 * `as unknown as X` is deliberate: these fields are typed non-optional
	 * because they're always populated for the folder's live lifetime, and
	 * this is the one place that's no longer true.
	 */
	private _nullOutFields(): void {
		this._config = null as unknown as SettingsScope<
			VaultShareSettings,
			Record<string, unknown>
		>;
		this.unsavedStore = null as unknown as UnsavedFileStore;
		this.relayRegistry = null as unknown as RelayRegistry;
		this.transfers = null as unknown as TransferQueue;
		this.authSession = null as unknown as AuthSession;
		this.credentialCache = null as unknown as RelayCredentialCache;
		this.fileOps = null as unknown as FileManager;
		this.folderIndex = null as unknown as FolderIndex;
		this.attachmentSettings = null as unknown as AttachmentSyncSettings;
	}
}

// Signature shared by the field and the constructor param below -- named
// once so the shape isn't repeated verbatim in both places.
type FolderBuilder = (
	path: string,
	guid: string,
	workspaceId?: string,
	hasPendingUpdates?: boolean,
	isRestore?: boolean,
	freshlyCreated?: boolean,
) => VaultShare;

export class ShareRegistry extends NotifierSet<VaultShare> {
	private shareFactory: FolderBuilder;

	constructor(
		private relayRegistry: RelayRegistry,
		private vaultApi: Vault,
		shareFactory: FolderBuilder,
		private persistedShares: SettingsScope<VaultShareSettings[]>,
	) {
		super();
		this.shareFactory = shareFactory;
	}

	public delete(item: VaultShare): boolean {
		item?.dismantle();
		const deleted = super.delete(item);
		void this.persistedShares.mutateValue((current) => {
			return current.filter((settings) => settings.guid !== item.entityGuid);
		});
		return deleted;
	}

	notifyDebounced = debounce(() => this.notifySubscribers(), 100);

	public get registry(): RelayRegistry {
		return this.relayRegistry;
	}

	shareFor(path: string): VaultShare | null {
		if (isConflictCopyPath(path)) return null;
		// Purely a path-namespace match -- doesn't care whether `path` exists on disk.
		return this.locate((vaultShare) => vaultShare.containsPath(path)) ?? null;
	}

	/**
	 * Returns the existing VaultShare that would conflict by nesting with `path`,
	 * in either direction: `path` is a subfolder of an existing share, or `path`
	 * would itself contain an existing share. Null if sharing `path` is safe.
	 *
	 * Relay does not support nested shares -- two ShareRegistry covering
	 * overlapping files race on which one processes a given file.
	 * Single source of truth so callers (the file-menu UI and the actual
	 * creation guard in _create()) can't drift out of sync with each other.
	 */
	findNestingConflict(path: string): VaultShare | null {
		const existingPaths = this.toArray().map((folder) => folder.path);
		const conflictPath = findNestingConflictPath(path, existingPaths, sep);
		if (conflictPath === null) {
			return null;
		}
		return this.locate((folder) => folder.path === conflictPath) ?? null;
	}

	destroy() {
		this.toArray().forEach((folder) => {
			folder.dismantle();
		});
		this.clearAll();
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.relayRegistry = null as unknown as RelayRegistry;
		this.shareFactory = null as unknown as FolderBuilder;
	}

	restore() {
		this._restoreFrom(this.persistedShares.readValue());
	}

	/**
	 * A guid is only usable if it's a real UUID -- not just any non-empty
	 * string. A JS `undefined` guid template-coerces to the literal STRING
	 * "undefined" wherever it's interpolated (e.g. the SettingsScope path
	 * `sharedFolders/[guid=${guid}]`), and that literal string is itself a
	 * truthy, typeof-"string" value -- a naive `!guid || typeof guid !==
	 * "string"` check lets it straight through as if it were real (a literal placeholder string). `ResourceAddress.isValidUUID` is the same strict format
	 * check already used everywhere else a guid crosses a trust boundary in
	 * this codebase; reusing it here (instead of a second, looser
	 * guid-shaped check) is what keeps this one accidental gap from
	 * recurring under a different name.
	 */
	private _hasValidGuid(folder: VaultShareSettings): boolean {
		return typeof folder.guid === "string" && ResourceAddress.isValidUUID(folder.guid);
	}

	private _restoreFrom(folders: VaultShareSettings[]) {
		let updated = false;
		const byPath = this._dedupeByPath(folders);
		byPath.forEach((folder) => {
			// A missing/invalid guid (corrupt data.json, a manually-edited entry,
			// a field renamed by a bug elsewhere) must be refused here, not
			// passed through. `_instantiateVaultShare`'s SettingsScope path is
			// built as `sharedFolders/[guid=${guid}]` -- a JS `undefined` guid
			// template-coerces to the literal STRING "undefined", and
			// SettingsScope's array-item writer matches existing entries by
			// `entry.guid === matchValue` (a real `undefined` field never
			// equals the string "undefined"), so it can never find this
			// already-corrupt entry and instead CREATES a brand-new one with
			// `guid: "undefined"` on every restore. That new entry then also
			// gets picked up by loadRelayOnPremShares()'s guid-mismatch
			// migration path, producing a third, `relay-onprem`-marker entry
			// -- three competing local records from one corrupt input, none
			// of them cleaned up. Refusing here, at the
			// single point where a persisted entry becomes a live VaultShare,
			// closes the whole chain at its root rather than patching each
			// downstream symptom separately.
			if (!this._hasValidGuid(folder)) {
				this.warn(
					`settings entry at ${folder.path} has no valid guid -- refusing to restore it ` +
						`(this folder's local record may need to be reconnected/re-shared)`,
				);
				return;
			}
			const tFolder = resolveShareFolder(this.vaultApi, folder.path);
			if (!tFolder) {
				this.warn(`settings reference a path that doesn't exist: ${folder.path}`);
				return;
			}
			const workspaceId = folder?.relay;
			try {
				// isRestore: this is the ONLY path that constructs a VaultShare
				// for an entry already present in persisted settings -- its
				// onpremServerId (if any) was written in a prior session, so the
				// constructor's legacy-featureKey auto-connect fallback is safe here.
				// Every other construction path goes through the public new()
				// below, for a folder whose server field the caller is about to
				// write moments after this call returns.
				this._create(folder.path, folder.guid, workspaceId, undefined, true);
				updated = true;
			} catch (e: unknown) {
				this.warn(`Skipping duplicate folder ${folder.path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		});

		if (updated) {
			this.notifySubscribers();
		}
	}

	/**
	 * When the same path appears more than once (an already-triplicated
	 * `data.json` from the class, a hand-edited settings file,...),
	 * prefer a candidate with a valid guid over one without -- restoring the
	 * folder from whichever record can actually be turned into a VaultShare
	 * beats silently discarding all of them because an invalid one happened
	 * to sort first (: the old path-only dedupe kept the FIRST
	 * record regardless of guid validity, so a corrupted entry ahead of the
	 * real one meant the restore guard below rejected the only candidate it
	 * ever saw and the share never came back). Only among equally-valid (or
	 * equally-invalid) candidates does the pre-existing `relay`-presence
	 * preference still apply.
	 */
	private _dedupeByPath(
		folders: VaultShareSettings[],
	): Map<string, VaultShareSettings> {
		const byPath = new Map<string, VaultShareSettings>();
		for (const folder of folders) {
			const existing = byPath.get(folder.path);
			if (!existing) {
				byPath.set(folder.path, folder);
				continue;
			}
			const folderValid = this._hasValidGuid(folder);
			const existingValid = this._hasValidGuid(existing);
			if (folderValid && !existingValid) {
				byPath.set(folder.path, folder);
			} else if (folderValid === existingValid && folder.relay && !existing.relay) {
				byPath.set(folder.path, folder);
			}
		}
		return byPath;
	}

	private _create(
		path: string,
		guid: string,
		workspaceId?: string,
		hasPendingUpdates?: boolean,
		isRestore?: boolean,
		freshlyCreated?: boolean,
	): VaultShare {
		const existing = this.locate(
			(folder) => folder.path == path && folder.entityGuid == guid,
		);
		if (existing) {
			return existing;
		}
		this._assertNotMountedElsewhere(guid);
		this._assertPathFree(path);
		this._assertNoNestingConflict(path);

		const folder = this.shareFactory(path, guid, workspaceId, hasPendingUpdates, isRestore, freshlyCreated);
		this.backing.add(folder);
		return folder;
	}

	private _assertNotMountedElsewhere(guid: string): void {
		const sameGuid = this.locate((folder) => folder.entityGuid == guid);
		if (sameGuid) {
			throw new Error(`this guid is already mounted, at ${sameGuid.path}`);
		}
	}

	private _assertPathFree(path: string): void {
		const samePath = this.locate((folder) => folder.path == path);
		if (samePath) {
			throw new Error("a different shared folder already occupies this path");
		}
	}

	private _assertNoNestingConflict(path: string): void {
		const nestingConflict = this.findNestingConflict(path);
		if (nestingConflict) {
			throw new Error(
				`Conflict: nested shares are not supported (existing share at ${nestingConflict.path}).`,
			);
		}
	}

	new(
		path: string,
		guid: string,
		workspaceId?: string,
		hasPendingUpdates?: boolean,
		// True ONLY when this call is constructing a VaultShare for a guid
		// this client's own createShare() call minted moments ago -- never
		// for a "migrate"/reconcile of a share that may have been published
		// elsewhere under a different guid (, see freshlyCreated's
		// own doc comment on the VaultShare field).
		freshlyCreated?: boolean,
	) {
		// isRestore left undefined (falsy): every caller of this public method
		// writes onpremServerId immediately after it returns -- the
		// constructor must not race that write with its own auto-connect.
		const folder = this._create(path, guid, workspaceId, hasPendingUpdates, undefined, freshlyCreated);
		this.notifySubscribers();
		return folder;
	}
}
