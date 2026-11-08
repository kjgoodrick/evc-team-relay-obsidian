import { TFolder, type Vault } from "obsidian";
import { basePath, copyBaseBytes } from "./BaseContentProtocol";
import { BaseContentFailure } from "./BaseContentTransport";
import { baseText, NativeBaseFile } from "./NativeBaseFile";
import { sameBaseBytes, type BaseSyncLock } from "./BaseSyncRunner";
import type { BaseRestore, BaseSyncRecord, BaseSyncStore } from "./BaseSyncStore";

export interface BaseRestoreAccess {
	/** Current account and visible explicit tombstone; no authority from cache. */
	current(entryId: string, formerPath: string): boolean;
	/** Only the original file with its original identity, or the recovery copy. */
	localSource(record: BaseSyncRecord): string | undefined;
	absolute(path: string): string;
	refresh(): Promise<void>;
	/** Checks current destination write access and inventory conflicts. */
	destination(path: string): Promise<void>;
}
export interface BaseRestoreCopy { key: string; label: string; bytes: ArrayBuffer; path?: string; identity?: unknown }
export interface BaseRestoreReview { record: BaseSyncRecord; copies: BaseRestoreCopy[] }

/** Creates an ordinary new local .base file. Existing guarded synchronization
 * owns its new managed identity and server publication. No remote receipt is
 * inferred from a local create; a racing remote file remains a sync conflict. */
export class BaseRestorationController {
	constructor(private store: BaseSyncStore, private vault: Vault, private access: BaseRestoreAccess, private lock: BaseSyncLock) {}
	private check(record: BaseSyncRecord): void {
		if (!record.retirement || !this.access.current(record.entryId, record.retirement.path)) throw new BaseContentFailure("pause", "base_context_changed");
	}
	private async copies(record: BaseSyncRecord): Promise<BaseRestoreCopy[]> {
		this.check(record);
		const copies: BaseRestoreCopy[] = [];
		const add = (key: string, label: string, bytes: ArrayBuffer | null | undefined) => {
			if (bytes !== null && bytes !== undefined) copies.push({ key, label, bytes: copyBaseBytes(bytes) });
		};
		const path = this.access.localSource(record);
		if (path) {
			const local = await new NativeBaseFile(this.vault, path, () => !!record.retirement && this.access.current(record.entryId, record.retirement.path) && this.access.localSource(record) === path).read();
			if (local.bytes !== null) copies.push({ key: "file", label: "Current retained file", bytes: local.bytes, path, identity: local.identity });
		}
		add("moved", "Copy saved before moving to recovery", record.retirement?.move?.local);
		add("removed", "Copy saved when removal was observed", record.retirement?.local);
		add("pending", "Unconfirmed local save", record.pending?.bytes);
		add("baseline", "Last synchronized copy", record.baseline?.bytes);
		add("conflict-local", "Retained local conflict", record.conflict?.local);
		add("conflict-remote", "Retained server conflict", record.conflict?.remote.bytes);
		add("download-before", "Copy before an interrupted download", record.download?.before);
		add("download-remote", "Retained download", record.download?.remote.bytes);
		this.check(record); return copies;
	}
	async review(entryId: string): Promise<BaseRestoreReview | undefined> {
		return this.lock(entryId, async () => {
			await this.access.refresh(); const record = await this.store.get(entryId);
			return { record, copies: await this.copies(record) };
		});
	}
	async restore(entryId: string, review: BaseRestoreReview, key: string, path: string): Promise<string | undefined> {
		return this.lock(entryId, async () => {
			await this.access.refresh(); const record = await this.store.get(entryId); this.check(record);
			if (record.revision !== review.record.revision) throw new BaseContentFailure("pause", "base_review_changed");
			const chosen = review.copies.find(copy => copy.key === key), fresh = (await this.copies(record)).find(copy => copy.key === key);
			if (!chosen || !fresh || chosen.path !== fresh.path || chosen.identity !== fresh.identity || !sameBaseBytes(chosen.bytes, fresh.bytes)) throw new BaseContentFailure("pause", "base_review_changed");
			// Validate encoding and destination before reserving local quota. The
			// destination is checked again at the actual creation boundary.
			baseText(fresh.bytes); this.validatePath(path, record);
			await this.access.destination(path); this.check(record);
			const parent = this.parent(path);
			if (this.vault.getAbstractFileByPath(this.access.absolute(path))) throw new Error("That destination already exists. Choose another name.");
			const intent = await this.store.prepareRestore(entryId, record.revision, path, fresh.bytes, fresh.label);
			return this.create(record, intent, false, parent);
		});
	}
	private validatePath(path: string, record: BaseSyncRecord): void {
		if (!basePath(path) || !path.toLowerCase().endsWith(".base") || path.toLowerCase() === record.retirement?.path.toLowerCase()) throw new Error("Choose a new .base path inside the shared folder.");
	}
	private parent(path: string): TFolder {
		const absolute = this.access.absolute(path), parentPath = absolute.slice(0, absolute.lastIndexOf("/"));
		const parent = parentPath ? this.vault.getAbstractFileByPath(parentPath) : this.vault.getRoot();
		if (!(parent instanceof TFolder)) throw new Error("Choose an existing destination folder.");
		return parent;
	}
	private async create(record: BaseSyncRecord, intent: BaseRestore, resume: boolean, parent = this.parent(intent.path)): Promise<string> {
		this.check(record); this.validatePath(intent.path, record);
		if (this.parent(intent.path) !== parent) throw new BaseContentFailure("pause", "base_context_changed");
		const absolute = this.access.absolute(intent.path), native = new NativeBaseFile(this.vault, absolute, () => {
			try { this.check(record); return this.access.absolute(intent.path) === absolute && this.parent(intent.path) === parent; } catch { return false; }
		});
		const local = await native.read();
		if (local.bytes !== null) {
			// Explicit recovery after an interrupted create can acknowledge the
			// exact copy already present. Never writes or adopts its managed ID.
			if (!resume || !sameBaseBytes(local.bytes, intent.bytes)) throw new Error("The restore destination is occupied or changed. Keep it and stop this restore before choosing another name.");
			await this.store.completeRestore(record.entryId, intent.id); return absolute;
		}
		await this.access.destination(intent.path); this.check(record);
		if (this.parent(intent.path) !== parent || this.access.absolute(intent.path) !== absolute) throw new BaseContentFailure("pause", "base_context_changed");
		if (!await native.replace({ bytes: null, identity: null }, intent.bytes)) throw new Error("The restore destination now exists. Check restoration to verify the saved copy before continuing.");
		this.check(record);
		await this.store.completeRestore(record.entryId, intent.id); return absolute;
	}
	async resume(entryId: string): Promise<string | undefined> {
		return this.lock(entryId, async () => {
			await this.access.refresh(); const record = await this.store.get(entryId); this.check(record);
			if (!record.restore) throw new Error("There is no pending restoration.");
			if (record.restore.state === "created") return this.access.absolute(record.restore.path);
			return this.create(record, record.restore, true);
		});
	}
	async cancel(entryId: string, revision: number): Promise<boolean | undefined> {
		return this.lock(entryId, async () => {
			const record = await this.store.get(entryId); this.check(record);
			await this.store.cancelRestore(entryId, revision); return true;
		});
	}
}
