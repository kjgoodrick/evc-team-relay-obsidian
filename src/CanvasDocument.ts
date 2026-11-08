import { ItemKind } from "./ItemKinds";
import type { TFile, Vault } from "obsidian";
import { ProviderBacked } from "./ProviderBacked";
import type { MimeTyped, SyncableEntry } from "./SyncableEntry";
import type { AuthSession } from "./AuthSession";
import { CanvasAddress, FolderAddress, ResourceAddress, RemoteCanvasAddress } from "./ResourceAddress";
import * as Y from "yjs";
import type { VaultShare } from "./VaultShare";
import { mimeTypeForPath } from "./mimeLookup";
import { LocalDocumentStore } from "./storage/local-document-store";
import type { SourceCacheDescriptor } from "./storage/source-document-cache";
import { LazyValue } from "./asyncCache";
import type { Unsubscriber } from "./notifiers/Notifier";
import type {
	CanvasData,
	CanvasEdgeData,
	CanvasNodeData,
	HostCanvasView,
} from "./HostCanvasView";
import { deepValueEquals } from "./deepValueEquals";

export function isCanvasDocument(file?: SyncableEntry): file is CanvasDocument {
	return file instanceof CanvasDocument;
}

/** Diff result for one entity kind (nodes or edges) between incoming JSON and the current Y state. */
interface EntityDiff<T> {
	changed: Map<string, T>;
	deleted: Set<string>;
}

function diffEntities<T extends { id: string }>(
	incoming: T[],
	current: Y.Map<T>,
	onNew?: (item: T) => void,
): EntityDiff<T> {
	const changed = new Map<string, T>();
	const seen = new Set<string>();
	for (const item of incoming) {
		seen.add(item.id);
		const existing = current.get(item.id);
		if (!existing) {
			changed.set(item.id, item);
			onNew?.(item);
		} else if (!deepValueEquals(existing, item)) {
			changed.set(item.id, item);
		}
	}
	const deleted = new Set<string>();
	for (const id of current.keys()) {
		if (!seen.has(id)) {
			deleted.add(id);
		}
	}
	return { changed, deleted };
}

export class CanvasDocument extends ProviderBacked implements SyncableEntry, MimeTyped {
	private _parent: VaultShare;
	private _indexeddbPersistence: LocalDocumentStore;
	firstSyncPromise: LazyValue<void> | null = null;
	isLocallyPersisted: boolean = false;
	syncedPromise?: LazyValue<CanvasDocument>;
	entryPath: string;
	_obsidianFile: TFile | null;
	crdtName: string;
	editLock: boolean = false;
	crdtExtension: string;
	crdtBasename: string;
	hostVault: Vault;
	crdtStat: {
		ctime: number;
		mtime: number;
		size: number;
	};
	unsubscribes: Unsubscriber[] = [];
	private _hasPendingCrdtUpdate: boolean = false;
	private _hostCanvasRef: unknown;
	private readonly sourceCache?: Readonly<SourceCacheDescriptor>;
	private readonly selectedRestoreGeneration: string | null = null;

	constructor(
		path: string,
		guid: string,
		loginManager: AuthSession,
		parent: VaultShare,
	) {
		const s3rn = parent.workspaceId
			? new RemoteCanvasAddress(parent.workspaceId, parent.entityGuid, guid)
			: new CanvasAddress(parent.entityGuid, guid);
		parent.sourceSelection?.assertFolder(parent.hostAppId, parent.config.onpremServerId, ResourceAddress.serialize(parent.resourceAddress));
		const sourceCache = parent.sourceSelection?.document(ResourceAddress.serialize(s3rn));
		super(guid, s3rn, parent.credentialCache, loginManager, parent.config.onpremServerId, parent.sourceSelection?.binding, parent.sourceSelection);
		this.sourceCache = sourceCache;
		this.selectedRestoreGeneration = parent.sourceSelection?.binding?.restoreGeneration ?? null;

		this._parent = parent;
		this.entryPath = path;
		this.crdtName = "[CRDT] " + (path.split("/").pop() || "");
		this.setLoggers(this.crdtName);
		this.crdtExtension = this.crdtName.split(".").pop() || "";
		this.crdtBasename = this.crdtName.replace(`.${this.crdtExtension}`, "");
		this.hostVault = this._parent.vaultApi;
		this.crdtStat = { ctime: Date.now(), mtime: Date.now(), size: 0 };
		this._obsidianFile = null;

		this.unsubscribes.push(
			this._parent.subscribe(this.entryPath, (state) => {
				if (this.restoreReviewRequired) { this.pauseForRestore(); return; }
				if (state.intent === "disconnected") {
					this.goOffline();
				}
			}),
		);

		this.setLoggers(`[CanvasDocument](${this.entryPath})`);
		this._indexeddbPersistence = this.openPersistence();
		this.retainRestoreReviewIn(this._indexeddbPersistence);

		void this.awaitFirstSync().then(() => this.bootstrapAfterSync()).catch(error => this.warn("Canvas startup paused", error));
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
			const key = this.sourceCache?.name ?? `${this.vaultShare.hostAppId}-relay-canvas-${this.entityGuid}`;
			return new LocalDocumentStore(key, this.crdtDoc, this.sourceCache?.identity);
		} catch (e: unknown) {
			this.warn("Unable to open persistence.", this.entityGuid);
			console.error(e);
			throw e;
		}
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
		this.refreshFileStats();
		this.recordPersistenceMetadata();
		if (this.restoreReviewRequired) return;

		const serverSynced = await this.getServerAcked();
		if (!serverSynced) {
			await this.onceEverSynced();
			await this.markServerAcked();
		}
		void this.vaultShare.noteUploaded(this).catch(error => this.warn("Canvas metadata was not acknowledged", error));
	}

	public get crdtEdges(): Y.Map<CanvasEdgeData> {
		return this.crdtDoc.getMap("edges");
	}

	public get crdtNodes(): Y.Map<CanvasNodeData> {
		return this.crdtDoc.getMap("nodes");
	}

	public nodeText(node: CanvasNodeData): Y.Text {
		const ytext = this.crdtDoc.getText(node.id);
		if (ytext.toJSON() === "") {
			ytext.insert(0, node.text);
		}
		return ytext;
	}

	/**
	 * Like nodeText(), but safe to call before this canvas's own persisted
	 * history is known to have replayed (`isLocallyPersisted`).
	 *
	 * nodeText() decides "safe to seed from the local Obsidian view" purely
	 * from `ytext.toJSON() === ""` -- but if this canvas's IndexedDB replay
	 * hasn't completed yet, an empty read is a false negative for "genuinely
	 * new node", not "not synced yet". Seeding on that false premise
	 * duplicates/overwrites real content once the persisted history lands a
	 * moment later -- the same empty-check-then-seed race fixed for
	 * `TransferQueue.uploadDocumentViaSocket`. Most call sites
	 * (CanvasDocument.mergeCanvasData(), CanvasViewPatch.observeCanvasNode()) are only reachable
	 * once `isLocallyPersisted` is already guaranteed true, via
	 * CanvasViewBinding.mountView() gating CanvasViewPatch construction on
	 * `awaitFullyConnected()` (which awaits `awaitFirstSync()` first) or via
	 * VaultShare.publishCanvas()'s own `hasPendingCrdtUpdate()` gate. But
	 * LiveNodePlugin.ts's CodeMirror extension is registered globally
	 * whenever any view is open, independent of any single view's own
	 * readiness, so it can reach `nodeText()` before either of those guards
	 * apply.
	 *
	 * Deliberately NOT folded into nodeText() itself: CanvasDocument.mergeCanvasData()
	 * marks a node as "known" (added to `crdtNodes`) in the same pass it seeds
	 * it, regardless of whether the seed happened -- so a guard inside
	 * nodeText() that silently skips seeding would leave that node's text
	 * permanently empty (mergeCanvasData() would never revisit the `!ynode`
	 * branch that seeds). This accessor sidesteps that entirely: it never
	 * marks anything as seeded, so a later real `nodeText()` call (once
	 * synced) can still seed the node normally.
	 */
	public textNodeSafe(node: CanvasNodeData): Y.Text {
		if (!this.isLocallyPersisted) {
			return this.crdtDoc.getText(node.id);
		}
		return this.nodeText(node);
	}

	static exportData(ydoc: Y.Doc): CanvasData {
		const yedges = ydoc.getMap<CanvasEdgeData>("edges");
		const ynodes = ydoc.getMap<CanvasNodeData>("nodes");
		const edges = Array.from(yedges.values(), (yedge) => ({ ...yedge }));
		const nodes = Array.from(ynodes.values(), (ynode) => {
			const ytext = ydoc.getText(ynode.id);
			return { ...ynode, text: ytext.toJSON() || ynode.text };
		});
		return { edges, nodes };
	}

	async markServerAcked(): Promise<void> {
		await this.assertNoRestoreReview();
		await this._indexeddbPersistence.rememberServerSync();
	}

	async getServerAcked(): Promise<boolean> {
		return this._indexeddbPersistence.loadServerSyncFlag();
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
		if (this.resourceAddress instanceof CanvasAddress) {
			// convert to remote document
			this.resourceAddress = this.vaultShare.workspaceId
				? new RemoteCanvasAddress(
						this.vaultShare.workspaceId,
						this.vaultShare.entityGuid,
						this.entityGuid,
					)
				: new CanvasAddress(this.vaultShare.entityGuid, this.entityGuid);
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

	async awaitFullyConnected(): Promise<CanvasDocument> {
		const promiseFn = async (): Promise<CanvasDocument> => {
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
		this.syncedPromise ??= new LazyValue<CanvasDocument>(promiseFn, () => [this.synced, this]);
		return this.syncedPromise.value();
	}

	awaitFirstSync(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			await this.vaultShare.awaitSynced();

			// Check if already synced first
			if (this._indexeddbPersistence.synced && !this.isLocallyPersisted) {
				this.isLocallyPersisted = true;
				return;
			}

			return new Promise<void>((resolve) => {
				if (this.isLocallyPersisted) {
					resolve();
				}
				// Registered unconditionally (even if the branch above just
				// resolved already) — matches the pre-rewrite behavior; this
				// is a `.once` handler so it's a harmless dangling listener
				// in the already-synced case, not a second resolution path.
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

	public get vaultShare(): VaultShare {
		return this._parent;
	}

	/**
	 * Get the full vault path for this canvas.
	 * Combines the shared folder path with the canvas's relative path.
	 * Used for relay-onprem token requests that need full vault paths.
	 */
	override getVaultPath(): string {
		if (this._parent && this.entryPath) {
			return `${this._parent.path}/${this.entryPath}`;
		}
		return this.entryPath || "unknown";
	}

	override async requestProviderToken() {
		await this.vaultShare.ensureManagedEntry?.(this.entryPath, { id: this.entityGuid, version: 0, type: ItemKind.Canvas });
		return super.requestProviderToken();
	}

	public get obsidianFile(): TFile | null {
		if (!this._obsidianFile) {
			this._obsidianFile = this._parent.toVaultFile(this);
		}
		return this._obsidianFile;
	}

	static matchesTrackedExtension(this: void, vpath: string): boolean {
		return vpath.endsWith(".canvas");
	}

	async markSyncOrigin(origin: "local" | "remote"): Promise<void> {
		await this._indexeddbPersistence.rememberOrigin(origin);
	}

	async getSyncOrigin(): Promise<"local" | "remote" | undefined> {
		return this._indexeddbPersistence.loadOrigin();
	}

	applyJsonPayload(json: string) {
		if (json === "") return;
		const data = JSON.parse(json) as CanvasData;
		this.mergeCanvasData(data);
	}

	syncFromView(view: HostCanvasView) {
		if (view.file && view.file === this.obsidianFile) {
			this.mergeCanvasData(view.canvas.getData());
		}
	}

	mergeCanvasData(data: CanvasData) {
		const nodeDiff = diffEntities(data.nodes, this.crdtNodes, (node) => {
			if (node.type === "text") {
				this.nodeText(node);
			}
		});
		const edgeDiff = diffEntities(data.edges, this.crdtEdges);

		const nothingChanged =
			nodeDiff.changed.size === 0 &&
			nodeDiff.deleted.size === 0 &&
			edgeDiff.changed.size === 0 &&
			edgeDiff.deleted.size === 0;
		if (nothingChanged) {
			return;
		}

		Y.transact(
			this.crdtDoc,
			() => {
				for (const node of nodeDiff.changed.values()) {
					this.crdtNodes.set(node.id, node);
				}
				for (const id of nodeDiff.deleted) {
					this.crdtNodes.delete(id);
				}
				for (const edge of edgeDiff.changed.values()) {
					this.crdtEdges.set(edge.id, edge);
				}
				for (const id of edgeDiff.deleted) {
					this.crdtEdges.delete(id);
				}
			},
			this,
		);
	}

	relocate(newPath: string, vaultShare: VaultShare) {
		this.entryPath = newPath;
		this._parent = vaultShare;
		this.crdtName = newPath.split("/").pop() || "";
		this.crdtExtension = this.crdtName.split(".").pop() || "";
		this.crdtBasename = this.crdtName.replace(`.${this.crdtExtension}`, "");
		this.refreshFileStats();
	}

	public get mimeType(): string {
		return mimeTypeForPath(this.entryPath);
	}

	public get canvasJson(): string {
		const data = CanvasDocument.exportData(this.crdtDoc);
		return JSON.stringify(data);
	}

	public dispose(): void {}

	// Helper method to update file stats
	private refreshFileStats(): void {
		this.crdtStat.mtime = Date.now();
		this.crdtStat.size = this.canvasJson.length;
	}

	dismantle() {
		this.unsubscribes.forEach((unsubscribe) => unsubscribe());
		super.dismantle();
		this.crdtDoc.destroy();
		this.firstSyncPromise?.destroy();
		this.firstSyncPromise = null;
		this.syncedPromise?.destroy();
		this.syncedPromise = null as unknown as LazyValue<CanvasDocument> | undefined;
	}
}
