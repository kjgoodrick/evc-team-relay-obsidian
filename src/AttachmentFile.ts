"use strict";
import {
	FileAddress,
	RemoteFileAddress,
	DocumentAddress,
	FolderAddress,
	type ResourceAddressType,
} from "./ResourceAddress";
import { VaultShare } from "./VaultShare";
import { Loggable } from "./logging";
import { type FileRecord, type AttachmentRecords, type AttachmentKind } from "./ItemKinds";
import { TFile, type Vault, type TFolder, type FileStats } from "obsidian";
import { Notifier, type Unsubscriber } from "./notifiers/Notifier";
import { sha256Hex } from "./contentDigest";
import type { MimeTyped, SyncableEntry } from "./SyncableEntry";
import { mimeTypeForPath } from "./mimeLookup";
import { currentToggles } from "./featureToggleState";

export function isAttachmentFile(file: SyncableEntry | undefined): file is AttachmentFile {
	return !!file && file instanceof AttachmentFile;
}

/** name/extension/basename split shared by AttachmentFile's constructor and move(). */
function splitFileName(path: string): { name: string; extension: string; basename: string } {
	const name = path.split("/").pop() || "";
	const extension = name.split(".").pop() || "";
	const basename = name.replace(`.${extension}`, "");
	return { name, extension, basename };
}

const HASH_STORE_NAME = "files";

export class FileHashCache extends Loggable {
	private dbHandle: IDBDatabase | null = null;
	private databaseName: string;
	private dbReady: Promise<void>;

	constructor(appId: string) {
		super();
		this.setLoggers("[FileHashCache]");
		this.databaseName = `${appId}-relay-hashes`;
		this.dbReady = this.openDatabase();
	}

	private async openDatabase(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.databaseName, 1);

			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(HASH_STORE_NAME)) {
					db.createObjectStore(HASH_STORE_NAME, { keyPath: "path" });
				}
			};
			request.onsuccess = () => {
				this.dbHandle = request.result;
				resolve();
			};
			request.onerror = () => {
				this.error("Error opening HashedFile database:", request.error);
				reject(request.error ?? new Error("Failed to open HashedFile database"));
			};
		});
	}

	/** Run one IndexedDB request against the `files` store, awaiting DB readiness first. */
	private async runRequest<T>(
		mode: IDBTransactionMode,
		errorLabel: string,
		build: (store: IDBObjectStore) => IDBRequest,
	): Promise<T | undefined> {
		await this.dbReady;
		const db = this.dbHandle;
		if (!db) return undefined;

		return new Promise<T | undefined>((resolve, reject) => {
			const store = db.transaction([HASH_STORE_NAME], mode).objectStore(HASH_STORE_NAME);
			const request = build(store);
			request.onsuccess = () => resolve(request.result as T);
			request.onerror = () => {
				this.error(errorLabel, request.error);
				reject(request.error ?? new Error(errorLabel));
			};
		});
	}

	async persistHash(path: string, hash: string, modifiedAt: number): Promise<void> {
		await this.runRequest("readwrite", "Error saving hash:", (store) =>
			store.put({ path, hash, modifiedAt }),
		);
	}

	async fetchHash(path: string): Promise<{ hash: string; modifiedAt: number } | null> {
		const result = await this.runRequest<{ hash: string; modifiedAt: number }>(
			"readonly",
			"Error retrieving hash:",
			(store) => store.get(path),
		);
		return result ?? null;
	}

	async deleteHash(path: string): Promise<void> {
		await this.runRequest("readwrite", "Error removing hash:", (store) => store.delete(path));
	}

	shutdown() {
		if (this.dbHandle) {
			this.dbHandle.close();
			this.dbHandle = null;
		}
	}
}

export interface FileHashEntry {
	/**
	 * Hash of file contents
	 */
	contentHash: string;
	/**
	 * Last modified time of file
	 */
	modifiedAt: number;
	/**
	 * Size of file in bytes
	 */
	sizeBytes: number;
}

export class HashedFile extends Loggable {
	cachedValue: string | undefined;
	cachedContent: ArrayBuffer | null = null;
	cachedTFile: TFile | null = null;

	constructor(
		private vaultRef: Vault,
		public hashedFilePath: string,
		private hashCacheRef: FileHashCache,
	) {
		super();
		const tfile = this.vaultRef.getAbstractFileByPath(hashedFilePath);
		if (tfile instanceof TFile) {
			this.cachedTFile = tfile;
		}
	}

	private get resolvedTFile(): TFile {
		if (!this.cachedTFile) {
			const tfile = this.vaultRef.getAbstractFileByPath(this.hashedFilePath);
			if (!(tfile instanceof TFile)) {
				throw new Error(`missing tfile: ${this.hashedFilePath}`);
			}
			this.cachedTFile = tfile;
		}
		return this.cachedTFile;
	}

	private async readHashFromStore(): Promise<string | undefined> {
		try {
			const storedData = await this.hashCacheRef.fetchHash(this.hashedFilePath);
			if (storedData && storedData.modifiedAt === this.resolvedTFile.stat.mtime) {
				// If the stored hash is for the same modification time, use it
				return storedData.hash;
			}
		} catch (error: unknown) {
			this.warn("Failed to load hash from store:", error);
		}
	}

	public get fileModifiedAt() {
		if (!this.resolvedTFile) {
			throw new Error("missing tfile");
		}
		return this.resolvedTFile.stat.mtime;
	}

	/** Read the on-disk content, hash it, and persist that hash for next time. */
	private async readAndPersistHash(): Promise<{ content: ArrayBuffer; hash: string }> {
		const mtime = this.resolvedTFile.stat.mtime;
		const content = await this.vaultRef.readBinary(this.resolvedTFile);
		const hash = await sha256Hex(content);
		try {
			await this.hashCacheRef.persistHash(this.hashedFilePath, hash, mtime);
		} catch (error: unknown) {
			this.warn("Failed to save hash to store:", error);
		}
		return { content, hash };
	}

	async readBytes(): Promise<ArrayBuffer | null> {
		this.log("reading content from disk");
		const { content } = await this.readAndPersistHash();
		return content;
	}

	/** The digest belongs to these exact bytes, not a later cache lookup. */
	readSnapshot(): Promise<{ content: ArrayBuffer; hash: string }> { return this.readAndPersistHash(); }

	async computeFreshHash(): Promise<string> {
		const { hash } = await this.readAndPersistHash();
		return hash;
	}

	existsOnDisk() {
		if (this.cachedTFile) {
			return true;
		}
		const tfile = this.vaultRef.getAbstractFileByPath(this.hashedFilePath);
		if (tfile instanceof TFile) {
			this.cachedTFile = tfile;
			return true;
		}
		return false;
	}

	invalidate() {
		this.cachedTFile = null;
		// Also remove from store when clearing
		this.hashCacheRef.deleteHash(this.hashedFilePath).catch((error: unknown) => {
			this.warn("Failed to remove hash from store:", error);
		});
	}

	async resolveHash(): Promise<string> {
		// NB: falsy check, not `??` — an empty-string hash from the store
		// (never produced by sha256Hex() in practice, but not guarded
		// against here either) is treated the same as "no cached hash" and
		// recomputed, matching the pre-rewrite behavior exactly.
		const cached = await this.readHashFromStore();
		return cached || (await this.computeFreshHash());
	}

	disposeCache() {
		this.vaultRef = null as unknown as Vault;
		this.cachedTFile = null;
		// Don't destroy store as it might be shared
	}
}

export class AttachmentFile
	extends Notifier<AttachmentFile>
	implements TFile, SyncableEntry, MimeTyped
{
	s3rn: ResourceAddressType;
	private _parent: VaultShare;
	syncMeta: AttachmentRecords | undefined;
	name: string;
	extension: string;
	basename: string;
	type: AttachmentKind;
	vault: Vault;
	contentAddressedCache: HashedFile;
	fileReady: boolean = false;
	isConnected: boolean = true;
	unsubscribeFileInfo: Unsubscriber = () => {};
	lastUploadError?: string = undefined;
	guardedBase = false;

	constructor(
		public path: string,
		private _localGuid: string,
		private hashStoreRef: FileHashCache,
		parent: VaultShare,
	) {
		super();
		this.s3rn = parent.workspaceId
			? new RemoteFileAddress(parent.workspaceId, parent.entityGuid, _localGuid)
			: new FileAddress(parent.entityGuid, _localGuid);
		this._parent = parent;
		this.setLoggers(`[SharedFile](${this.path})`);
		({ name: this.name, extension: this.extension, basename: this.basename } =
			splitFileName(path));
		this.vault = this._parent.vaultApi;
		this.type = this.resolveSyncType(path);
		this.contentAddressedCache = new HashedFile(
			this.vault,
			this.vaultShare.absolutePath(path),
			this.hashStoreRef,
		);

		this.log("created");
	}

	private resolveSyncType(path: string): AttachmentKind {
		const registered = this.vaultShare.folderIndex.kinds.kindForPath(path);
		if (!registered) {
			throw new Error("unexpected synctype");
		}
		// XXX remove typecast
		return registered as AttachmentKind;
	}

	public get entityGuid(): string {
		return this._localGuid;
	}

	public set entityGuid(guid: string) {
		this._localGuid = guid;
		this.s3rn = this._parent.workspaceId
			? new RemoteFileAddress(this._parent.workspaceId, this._parent.entityGuid, guid)
			: new FileAddress(this._parent.entityGuid, guid);
	}

	/**
	 * `SyncableEntry.entryPath` and `TFile.path` are the same string here, and
	 * this class is the only one that has to satisfy both interfaces at once —
	 * an attachment IS a real vault file, unlike a CRDT `Document`. The alias
	 * exists so `path` keeps meaning exactly what Obsidian means by it, while
	 * code that only knows it holds a `SyncableEntry` still has one spelling
	 * that works across documents, canvases and attachments alike.
	 */
	public get entryPath(): string {
		return this.path;
	}

	public set entryPath(newPath: string) {
		this.path = newPath;
	}

	public get mimeType(): string {
		return mimeTypeForPath(this.path);
	}

	goOffline() {
		// pass
	}

	public get hasRemoteMeta() {
		return !!this.vaultShare.folderIndex.recordFor(this.path);
	}

	public get hasPendingUpload() {
		return !!this.vaultShare.folderIndex.mintedGuids.has(this.path);
	}

	public get statusTag() {
		if (this.lastUploadError) return this.lastUploadError;
		if (this.hasRemoteMeta) return "";
		return this.hasPendingUpload ? "pending" : "unknown";
	}

	relocate(newPath: string, vaultShare: VaultShare) {
		if (newPath === this.path) {
			return;
		}
		this._parent = vaultShare;
		this.debug("setting new path", newPath);
		this.path = newPath;
		({ name: this.name, extension: this.extension, basename: this.basename } =
			splitFileName(newPath));
		this.setLoggers(`[SharedFile](${this.path})`);
	}

	public get modifiedTime() {
		return this.stat.mtime;
		//return Math.max(this.stat.mtime, this.stat.ctime);
	}

	refreshRemoteMeta() {
		const meta = this.vaultShare.folderIndex.recordFor(this.path);
		this.syncMeta = meta as AttachmentRecords;
		return meta;
	}

	private static formatUploadError(error: unknown): string {
		let message = "Failed to push file";
		try {
			message = (error as string).toString();
		} catch {
			// pass
		}
		return message.replace(/^Error:/, "").trim();
	}

	/** Guard for pushToRemote(): can we even attempt an upload right now? */
	private canPush(): boolean {
		if (!this.vaultShare) {
			// dismantle() already detached this entry from its shared folder; a
			// retry/reconnect that fires afterwards has nothing to connect to.
			return false;
		}
		if (!this.vaultShare.isOnline) {
			this.log("push blocked: shared folder offline");
			return false;
		}
		if (!this.vaultShare.folderIndex.isSyncable(this.path)) {
			this.log("push blocked: this file type is excluded from sync");
			return false;
		}
		return true;
	}

	private async uploadNow(): Promise<void> {
		try {
			const share = this.vaultShare;
			const upload = await share.blobs.pushFile(this);
			upload.check();
			await share.noteUploaded(this, upload);
			this.lastUploadError = undefined;
		} catch (error: unknown) {
			this.lastUploadError = AttachmentFile.formatUploadError(error);
		} finally {
			this.notifySubscribers();
		}
	}

	private async syncBase(): Promise<boolean> {
		if (!this.vaultShare?.usesBaseSync(this.path, this.entityGuid)) return false;
		this.guardedBase = true;
		try {
			if (!this.vaultShare.basesSync) throw new Error("Bases sync is starting. Your local edits are retained.");
			await this.vaultShare.basesSync.sync(this);
		} catch (error) { this.lastUploadError = AttachmentFile.formatUploadError(error); }
		this.notifySubscribers(); return true;
	}

	public async pushToRemote(force = false) {
		if (await this.syncBase()) return;
		this.log("push");
		if (!this.canPush()) {
			return;
		}

		const localHash = await this.contentAddressedCache.resolveHash();
		this.refreshRemoteMeta();

		const outOfDate = !this.syncMeta || (!!localHash && this.syncMeta.hash !== localHash);
		if (force || outOfDate) {
			await this.uploadNow();
		}
	}

	/** If verify-uploads is enabled, confirm the metadata's claim actually exists remotely; re-push if it doesn't. */
	private async reconcileRemoteVerification(): Promise<void> {
		if (!currentToggles().enableVerifyUploads) {
			return;
		}
		try {
			const verified = await this.verifyRemoteUpload();
			if (!verified) {
				this.warn("file in metadata, but not on the server!");
				await this.pushToRemote();
			}
		} catch {
			// pass
		}
	}

	/** Decide push vs. pull once both a local hash and remote meta are known. */
	private async reconcileAgainstMeta(meta: AttachmentRecords): Promise<void> {
		try {
			const localHash = await this.contentAddressedCache.resolveHash();
			await this.reconcileRemoteVerification();

			if (localHash === meta.hash) {
				return;
			}
			if (this.stat.mtime > meta.synctime) {
				// local copy is the newer one
				await this.pushToRemote();
				return;
			}
			// remote copy is the newer one
			this.warn("synctime", meta.synctime, this.syncMeta?.synctime, this.stat.mtime);
			await this.pullFromRemote();
		} catch (err: unknown) {
			this.warn("unable to compute hash", err);
		}
	}

	public async runSync() {
		if (await this.syncBase()) return;
		this.log("sync");
		this.refreshRemoteMeta();

		if (!this.contentAddressedCache.existsOnDisk()) {
			if (!this.syncMeta) {
				throw new Error("unexpected case");
			}
			return this.pullFromRemote();
		}
		if (!this.syncMeta) {
			return this.pushToRemote();
		}
		return this.reconcileAgainstMeta(this.syncMeta);
	}

	needsPull(meta: FileRecord) {
		// Bases inventory changes are scheduled by BaseSyncHost; timestamps do
		// not express whether a guarded configuration needs reconciliation.
		if (this.vaultShare?.usesBaseSync(this.path, this.entityGuid)) return false;
		return !this.obsidianFile || meta.synctime > this.stat.mtime;
	}

	public async verifyRemoteUpload() {
		this.log("verify upload");
		this.refreshRemoteMeta();
		if (!this.syncMeta) {
			throw new Error("cannot verify upload without meta");
		}
		return this.vaultShare.blobs.headFile(this);
	}

	public async pullFromRemote() {
		if (await this.syncBase()) return;
		this.log("pull");
		this.refreshRemoteMeta();
		if (!this.syncMeta) {
			throw new Error("cannot pull without meta");
		}

		if (
			this.contentAddressedCache.existsOnDisk() &&
			(await this.contentAddressedCache.resolveHash()) === this.syncMeta.hash
		) {
			// Already have the bytes the metadata points at — nothing to fetch.
			return;
		}

		try {
			const context = this.vaultShare.captureAttachmentContext(this), hash = this.syncMeta.hash;
			const diskPath = this.vaultShare.absolutePath(this.path);
			const before = await this.vault.adapter.stat(diskPath);
			context.check();
			const content = await this.vaultShare.blobs.pullFile(this);
			const after = await this.vault.adapter.stat(diskPath);
			context.check();
			if (hash !== this.syncMeta?.hash || before?.mtime !== after?.mtime || before?.ctime !== after?.ctime || before?.size !== after?.size) {
				throw new Error("Attachment changed during download. Local content is retained.");
			}
			await this.vault.adapter.writeBinary(diskPath, content);
			await this.contentAddressedCache.resolveHash();
		} catch (e: unknown) {
			this.log(e);
		}
	}

	public get obsidianFile(): TFile {
		const abstractFile = this.vault.getAbstractFileByPath(this.vaultShare.absolutePath(this.path));
		if (abstractFile instanceof TFile) {
			return abstractFile;
		}
		throw new Error("TFile API used before file existed");
	}

	public get stat(): FileStats {
		return this.obsidianFile.stat;
	}

	public get parent(): TFolder | null {
		return this.obsidianFile?.parent || null;
	}

	public get vaultShare(): VaultShare {
		return this._parent;
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
		if (this.s3rn instanceof DocumentAddress) {
			// convert to remote document
			this.s3rn = this.vaultShare.workspaceId
				? new RemoteFileAddress(this.vaultShare.workspaceId, this.vaultShare.entityGuid, this.entityGuid)
				: new FileAddress(this.vaultShare.entityGuid, this.entityGuid);
		}
		if (!this.vaultShare.wantsConnection) {
			return false;
		}
		await this.vaultShare.bringOnline();
		this.isConnected = true;
		return this.isConnected;
	}

	public async readText(): Promise<string> {
		return this.vault.read(this.obsidianFile);
	}

	public async delete(): Promise<void> {
		this.contentAddressedCache.invalidate();
		await this.vaultShare.trashFile(this.obsidianFile);
	}

	public async writeContent(content: string): Promise<void> {
		void this.vault.adapter.write(this.obsidianFile.path, content);
		await this.contentAddressedCache.resolveHash();
	}

	public async appendContent(content: string): Promise<void> {
		void this.vault.append(this.obsidianFile, content);
		await this.contentAddressedCache.resolveHash();
	}

	dispose() {}

	dismantle() {
		this.unsubscribeFileInfo?.();
		this.unsubscribeFileInfo = null as unknown as Unsubscriber;

		this._parent = null as unknown as VaultShare;
		this.contentAddressedCache.disposeCache();
	}
}
