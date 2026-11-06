import { TFile, TFolder, type Vault } from "obsidian";
import { RECOVERY_FOLDER } from "../conflictCopyPath";
import { basePath } from "./BaseContentProtocol";
import { BaseContentFailure } from "./BaseContentTransport";
import { NativeBaseFile } from "./NativeBaseFile";
import { sameBaseBytes, type BaseLocalFile, type BaseSyncLock } from "./BaseSyncRunner";
import type { BaseSyncRecord, BaseSyncStore } from "./BaseSyncStore";

export interface BaseRetirementAccess {
	/** Requires an explicit current tombstone, no replacement and no local move. */
	current(entryId: string, path: string): boolean;
	absolute(path: string): string;
	refresh(): Promise<void>;
}
export interface BaseRetirementReview { record: BaseSyncRecord; local: BaseLocalFile }

/** Removal is an explicit review. The file is moved intact outside sync, never
 * unlinked. Originals and pending delivery state remain in the private cache. */
export class BaseRetirementController {
	constructor(private store: BaseSyncStore, private vault: Vault, private access: BaseRetirementAccess, private lock: BaseSyncLock) {}
	private check(entryId: string, path: string): void {
		if (!basePath(path) || !this.access.current(entryId, path)) throw new BaseContentFailure("pause", "base_context_changed");
	}
	private local(entryId: string, path: string): Promise<BaseLocalFile> {
		return new NativeBaseFile(this.vault, this.access.absolute(path), () => this.access.current(entryId, path)).read();
	}
	async observe(entryId: string, path: string): Promise<boolean | undefined> {
		return this.lock(entryId, async () => {
			this.check(entryId, path);
			const record = await this.store.get(entryId);
			// A tombstone for another device's file cannot identify arbitrary local
			// data at its former path. Require this account's previous sync state.
			if (!record.revision || record.retirement) return false;
			const local = await this.local(entryId, path); this.check(entryId, path);
			await this.store.retainRetirement(entryId, record.revision, path, local.bytes); return true;
		});
	}
	async review(entryId: string): Promise<BaseRetirementReview | undefined> {
		return this.lock(entryId, async () => {
			await this.access.refresh();
			const record = await this.store.get(entryId), retired = record.retirement;
			if (!retired) throw new Error("This Bases removal is no longer available.");
			this.check(entryId, retired.path);
			const local = await this.local(entryId, retired.path); this.check(entryId, retired.path);
			return { record, local };
		});
	}
	async move(entryId: string, reviewed: BaseRetirementReview): Promise<string | undefined> {
		return this.lock(entryId, async () => {
			await this.access.refresh();
			let record = await this.store.get(entryId);
			const retired = record.retirement;
			if (!retired || record.revision !== reviewed.record.revision) throw new BaseContentFailure("pause", "base_review_changed");
			this.check(entryId, retired.path);
			if (retired.move?.state === "complete") return retired.move.path;
			const local = await this.local(entryId, retired.path); this.check(entryId, retired.path);
			if (!sameBaseBytes(local.bytes, reviewed.local.bytes) || local.identity !== reviewed.local.identity) throw new BaseContentFailure("pause", "base_review_changed");
			if (local.bytes === null) {
				// Restart after the rename but before its local acknowledgement.
				const intent = retired.move;
				if (!intent) throw new Error("The local file is missing. Export retained copies to recover its contents.");
				const recovered = await new NativeBaseFile(this.vault, intent.path, () => this.access.current(entryId, retired.path)).read();
				if (!sameBaseBytes(recovered.bytes, intent.local)) throw new Error("The recovery file changed or is missing. Export the retained originals and review the recovery folder.");
				await this.store.completeRetirementMove(entryId, intent.path); return intent.path;
			}
			const destination = retired.move?.path ?? `${RECOVERY_FOLDER}/Bases-removed-${crypto.randomUUID()}/${retired.path.split("/").pop()!}`;
			if (this.vault.getAbstractFileByPath(destination)) throw new Error("The recovery destination is occupied. Both files are retained; review the recovery folder.");
			await this.store.prepareRetirementMove(entryId, record.revision, destination, local.bytes);
			record = await this.store.get(entryId);
			await this.ensureFolder(RECOVERY_FOLDER);
			await this.ensureFolder(destination.slice(0, destination.lastIndexOf("/")));
			this.check(entryId, retired.path);
			const file = this.vault.getAbstractFileByPath(this.access.absolute(retired.path));
			if (!(file instanceof TFile) || file !== local.identity || this.vault.getAbstractFileByPath(destination)) throw new BaseContentFailure("pause", "base_review_changed");
			const latest = await this.local(entryId, retired.path);
			if (!sameBaseBytes(latest.bytes, local.bytes) || latest.identity !== local.identity) throw new BaseContentFailure("pause", "base_review_changed");
			this.check(entryId, retired.path);
			// Rename preserves the entire live file, including an edit arriving
			// after the final read. The reviewed snapshot is also already durable.
			await this.vault.rename(file, destination);
			this.check(entryId, retired.path);
			if (this.vault.getAbstractFileByPath(destination) !== file || file.path !== destination) throw new Error("Check the recovery folder before continuing.");
			await this.store.completeRetirementMove(entryId, record.retirement!.move!.path);
			return destination;
		});
	}
	private async ensureFolder(path: string): Promise<void> {
		let folder = this.vault.getAbstractFileByPath(path);
		if (!folder) { try { folder = await this.vault.createFolder(path); } catch { folder = this.vault.getAbstractFileByPath(path); } }
		if (!(folder instanceof TFolder)) throw new Error("The local recovery folder is unavailable.");
	}
}
