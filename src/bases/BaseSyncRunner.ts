import { baseRestoreBinding, copyBaseBytes, decideBaseSync, type BaseSnapshot, type BaseCommandStatus } from "./BaseContentProtocol";
import { BaseContentFailure, type BaseContentTransport } from "./BaseContentTransport";
import { BaseSyncStore, type BaseDownload, type BaseSyncRecord } from "./BaseSyncStore";

export interface BaseLocalFile { bytes: ArrayBuffer | null; identity: unknown }
export interface BaseSyncAccess {
	path: string;
	/** Includes account, entry/path identity, sync setting and structural guards. */
	current(): boolean;
	writable(): boolean;
	canInitialize: boolean;
	read(): Promise<BaseLocalFile>;
	/** Must compare contents and identity at the atomic native write boundary. */
	replace(before: BaseLocalFile, bytes: ArrayBuffer): Promise<boolean>;
}
export type BaseSyncResult = "synced" | "waiting" | "conflict" | "busy";
export type BaseSyncLock = <T>(entryId: string, action: () => Promise<T>) => Promise<T | undefined>;
export interface BaseConflictReview { record: BaseSyncRecord; local: BaseLocalFile; remote: BaseSnapshot }

export function sameBaseBytes(a: ArrayBuffer | null, b: ArrayBuffer | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.byteLength !== b.byteLength) return false;
	const left = new Uint8Array(a), right = new Uint8Array(b);
	return left.every((value, index) => value === right[index]);
}
function sameSnapshot(a: BaseSnapshot | undefined, b: BaseSnapshot): boolean {
	return !!a && JSON.stringify(a.state) === JSON.stringify(b.state) && sameBaseBytes(a.bytes, b.bytes) &&
		JSON.stringify(a.restoreContext) === JSON.stringify(b.restoreContext);
}

/** One bounded reconciliation. Native actors and review actions must share the
 * same exclusive lock. Durable intents survive destruction of this runner. */
export class BaseSyncRunner {
	constructor(readonly store: BaseSyncStore, private transport: Pick<BaseContentTransport, "read" | "publish" | "withdraw"> & Partial<Pick<BaseContentTransport, "status">>,
		private lock: BaseSyncLock) {}
	private check(access: BaseSyncAccess, remote?: BaseSnapshot): void {
		if (!access.current() || remote && remote.state.path !== access.path) throw new BaseContentFailure("pause", "base_context_changed");
	}
	private async remote(entryId: string, access: BaseSyncAccess): Promise<BaseSnapshot> {
		this.check(access); const before = await this.store.get(entryId);
		const remote = await this.transport.read(entryId); this.check(access, remote);
		await this.store.observeRestoreContext(entryId, before.revision, remote.restoreContext, () => access.current());
		return remote;
	}
	async sync(entryId: string, access: BaseSyncAccess): Promise<BaseSyncResult> {
		return await this.lock(entryId, () => this.run(entryId, access)) ?? "busy";
	}
	private async run(entryId: string, access: BaseSyncAccess): Promise<BaseSyncResult> {
		this.check(access);
		let record = await this.store.get(entryId);
		if (record.retirement) throw new BaseContentFailure("pause", "base_entry_retired");
		if (record.conflict) return "conflict";
		if (record.pending) {
			await this.remote(entryId, access);
			await this.send(entryId, access, record);
			record = await this.store.get(entryId);
			if (record.conflict) return "conflict";
		}
		const remote = await this.remote(entryId, access), local = await access.read(); this.check(access, remote);
		record = await this.store.get(entryId);
		if (record.reviewRequired) return this.conflict(entryId, record, local.bytes, remote, "withdrawn-save");
		if (record.download) return this.download(entryId, access, record.download, local, remote);
		const decision = await decideBaseSync(record.baseline, local.bytes, remote, access.canInitialize); this.check(access, remote);
		switch (decision) {
			case "wait": return "waiting";
			case "adopt":
				if (!sameSnapshot(record.baseline, remote)) await this.store.adopt(entryId, record.revision, remote);
				return "synced";
			case "upload": {
				if (!access.writable()) return this.conflict(entryId, record, local.bytes, remote, "read-only-local-edit");
				await this.store.stage(entryId, record.revision, remote.state, local.bytes!, baseRestoreBinding(remote));
				await this.send(entryId, access, await this.store.get(entryId));
				return (await this.store.get(entryId)).conflict ? "conflict" : "synced";
			}
			case "download": {
				const intent = await this.store.prepareDownload(entryId, record.revision, local.bytes, remote);
				return this.download(entryId, access, intent, local, remote);
			}
			default: return this.conflict(entryId, record, local.bytes, remote, decision);
		}
	}
	private async conflict(entryId: string, record: BaseSyncRecord, local: ArrayBuffer | null, remote: BaseSnapshot, reason: string): Promise<"conflict"> {
		await this.store.retainConflict(entryId, record.revision, { reason, local, remote }); return "conflict";
	}
	private async send(entryId: string, access: BaseSyncAccess, record: BaseSyncRecord): Promise<void> {
		const pending = record.pending; if (!pending) return;
		this.check(access);
		await this.store.requireBinding(entryId, pending);
		if (!access.writable()) throw new BaseContentFailure("reject", "base_editor_required");
		try {
			const result = await this.transport.publish(entryId, pending);
			this.check(access);
			await this.store.settle(entryId, pending.operationId, { status: "accepted", result });
		} catch (error) {
			if (!(error instanceof BaseContentFailure) || error.action !== "conflict") throw error;
			// A concurrent attempt may have committed after this rejection. Only
			// the server's exact withdrawal receipt can release pending bytes.
			await this.store.requireBinding(entryId, pending);
			const result = await this.transport.withdraw(entryId, pending); this.check(access);
			await this.store.settle(entryId, pending.operationId, result);
			if (result.status === "accepted") return;
			const remote = await this.remote(entryId, access), local = await access.read(); this.check(access, remote);
			await this.conflict(entryId, await this.store.get(entryId), local.bytes, remote, "concurrent-save");
		}
	}
	private async download(entryId: string, access: BaseSyncAccess, intent: BaseDownload, local: BaseLocalFile, remote: BaseSnapshot): Promise<BaseSyncResult> {
		this.check(access, remote);
		if ((intent.remote.restoreContext?.generation ?? null) !== (remote.restoreContext?.generation ?? null)) {
			await this.store.rejectDownload(entryId, intent.id, local.bytes, "restore-changed"); return "conflict";
		}
		// A crash after the native write but before the IndexedDB acknowledgement.
		if (sameBaseBytes(local.bytes, intent.remote.bytes)) {
			await this.store.completeDownload(entryId, intent.id); return "synced";
		}
		if (!sameBaseBytes(local.bytes, intent.before) || !sameSnapshot(intent.remote, remote)) {
			await this.store.rejectDownload(entryId, intent.id, local.bytes); return "conflict";
		}
		this.check(access, intent.remote);
		await this.store.requireBinding(entryId, baseRestoreBinding(intent.remote));
		if (!await access.replace(local, copyBaseBytes(intent.remote.bytes!))) {
			const changed = await access.read(); this.check(access);
			await this.store.rejectDownload(entryId, intent.id, changed.bytes); return "conflict";
		}
		this.check(access);
		await this.store.completeDownload(entryId, intent.id); return "synced";
	}
	/** Review fresh copies rather than the possibly old, retained conflict. */
	async review(entryId: string, access: BaseSyncAccess): Promise<BaseConflictReview | undefined> {
		return this.lock(entryId, async () => {
			const remote = await this.remote(entryId, access), local = await access.read(); this.check(access, remote);
			const record = await this.store.get(entryId);
			return { record, local, remote };
		});
	}
	async resolve(entryId: string, access: BaseSyncAccess, reviewed: BaseConflictReview, choice: "local" | "server"): Promise<BaseSyncResult> {
		return await this.lock(entryId, async () => {
			const remote = await this.remote(entryId, access), local = await access.read(); this.check(access, remote);
			if (!sameSnapshot(reviewed.remote, remote) || !sameBaseBytes(reviewed.local.bytes, local.bytes) || reviewed.local.identity !== local.identity) {
				throw new BaseContentFailure("pause", "base_review_changed");
			}
			if (choice === "local" && !access.writable()) throw new BaseContentFailure("reject", "base_editor_required");
			await this.store.resolveConflict(entryId, reviewed.record.revision, choice, local.bytes, remote);
			return this.run(entryId, access);
		}) ?? "busy";
	}
	/** Explicit recovery also works after new publication is disabled. It never
	 * automatically sends a replacement for a withdrawn request. */
	async withdraw(entryId: string, access: BaseSyncAccess): Promise<BaseSyncResult> {
		return await this.lock(entryId, async () => {
			this.check(access); const record = await this.store.get(entryId);
			if (!record.pending) return record.conflict ? "conflict" : "waiting";
			await this.store.requireBinding(entryId, record.pending);
			const result = await this.transport.withdraw(entryId, record.pending); this.check(access);
			await this.store.settle(entryId, record.pending.operationId, result); return "waiting";
		}) ?? "busy";
	}
	/** Observation only: retain the exact pending bytes and do not trigger sync,
	 * settlement or replacement merely because a historical receipt exists. */
	async checkStatus(entryId: string, access: BaseSyncAccess): Promise<BaseCommandStatus> {
		const result = await this.lock(entryId, async () => {
			this.check(access); const record = await this.store.get(entryId);
			if (!record.pending || !this.transport.status) throw new BaseContentFailure("pause", "base_receipt_unavailable");
			const receipt = await this.transport.status(entryId, record.pending); this.check(access);
			if ((await this.store.get(entryId)).revision !== record.revision) throw new BaseContentFailure("pause", "base_review_changed");
			return receipt;
		});
		if (!result) throw new BaseContentFailure("pause", "base_content_busy");
		return result;
	}
}
