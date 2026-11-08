import { v4 as uuidv4 } from "uuid";
import { BASE_LOCAL_QUOTA, baseId, basePath, baseRestoreBinding, copyBaseBytes, copyBasePending, parseBaseAccepted, parseBaseRestoreContext, validateBaseSnapshot,
	type BaseSnapshot, type BasePending, type BaseWithdrawal, type BaseAccepted } from "./BaseContentProtocol";
import { RECOVERY_FOLDER } from "../conflictCopyPath";
import { restoreGeneration, restoreMetadata, type RestoreBinding, type RestoreContext } from "../collaboration/RestoreGeneration";
import { BaseContentFailure } from "./BaseContentTransport";

export interface BaseStoreIdentity { serverId: string; accountId: string; vaultId: string; shareId: string }
export interface BaseConflict { reason: string; local: ArrayBuffer | null; remote: BaseSnapshot }
export interface BaseDownload { id: string; before: ArrayBuffer | null; remote: BaseSnapshot }
export interface BaseRetirement {
	path: string; local: ArrayBuffer | null;
	move?: { path: string; local: ArrayBuffer; state: "prepared" | "complete" };
}
export interface BaseRestore {
	id: string; path: string; bytes: ArrayBuffer; label: string; state: "prepared" | "created";
}
export interface BaseSyncRecord {
	entryId: string; revision: number; baseline?: BaseSnapshot; pending?: BasePending;
	restoreContext?: RestoreContext;
	conflict?: BaseConflict; download?: BaseDownload;
	reviewRequired?: "withdrawn";
	retirement?: BaseRetirement;
	restore?: BaseRestore;
}
export interface BaseRecovery { entryId: string; id: string; createdAt: number; record: BaseSyncRecord }

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
function completion(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("Bases local save aborted")); tx.onerror = () => {}; });
}
function footprint(record: BaseSyncRecord): number {
	return (record.baseline?.bytes?.byteLength ?? 0) + (record.pending?.bytes.byteLength ?? 0) +
		(record.conflict?.local?.byteLength ?? 0) + (record.conflict?.remote.bytes?.byteLength ?? 0) +
		(record.download?.before?.byteLength ?? 0) + (record.download?.remote.bytes?.byteLength ?? 0) +
		(record.retirement?.local?.byteLength ?? 0) + (record.retirement?.move?.local.byteLength ?? 0) + (record.restore?.bytes.byteLength ?? 0);
}

/** Private IndexedDB state, isolated by server/account/vault/share. All mutation
 * completion means the transaction committed, not merely that put() succeeded. */
export class BaseSyncStore {
	private constructor(private db: IDBDatabase, readonly identity: Readonly<BaseStoreIdentity>, private quota: number) {}
	static async open(identity: BaseStoreIdentity, factory: IDBFactory = indexedDB, quota = BASE_LOCAL_QUOTA): Promise<BaseSyncStore> {
		const url = new URL(identity.serverId);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
			!baseId(identity.accountId) || !baseId(identity.shareId) || !identity.vaultId || identity.vaultId.length > 512 ||
			!Number.isSafeInteger(quota) || quota < 1 || quota > BASE_LOCAL_QUOTA) throw new Error("Invalid Bases storage identity");
		identity = { ...identity, serverId: url.toString().replace(/\/+$/, "") };
		// Older workers would drop pending restore bindings. Preserve all stores
		// while forcing those workers to close instead of silently restamping work.
		const open = factory.open("team-relay-bases:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]), 3);
		open.onupgradeneeded = event => {
			if (event.oldVersion !== 0) return;
			open.result.createObjectStore("files", { keyPath: "entryId" });
			open.result.createObjectStore("recoveries", { keyPath: ["entryId", "id"] });
			open.result.createObjectStore("meta");
		};
		const db = await request(open); db.onversionchange = () => db.close();
		return new BaseSyncStore(db, Object.freeze(identity), quota);
	}
	close(): void { this.db.close(); }

	private async transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
		const tx = this.db.transaction(["files", "recoveries", "meta"], mode), done = completion(tx);
		void done.catch(() => undefined);
		try { const value = await work(tx); await done; return value; }
		catch (error) { try { tx.abort(); } catch { /* Already terminal. */ } await done.catch(() => undefined); throw error; }
	}
	private async current(tx: IDBTransaction, entryId: string): Promise<BaseSyncRecord> {
		if (!baseId(entryId)) throw new Error("Invalid Bases entry identity");
		return await request(tx.objectStore("files").get(entryId)) as BaseSyncRecord | undefined ?? { entryId, revision: 0 };
	}
	get(entryId: string): Promise<BaseSyncRecord> { return this.transaction("readonly", tx => this.current(tx, entryId)); }
	list(after = "", limit = 100): Promise<BaseSyncRecord[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100 || after && !baseId(after)) throw new Error("Invalid Bases storage page");
		return this.transaction("readonly", tx => request(tx.objectStore("files").getAll(IDBKeyRange.lowerBound(after, true), limit)) as Promise<BaseSyncRecord[]>);
	}

	private async write(tx: IDBTransaction, before: BaseSyncRecord, after: BaseSyncRecord, archive?: BaseRecovery | BaseRecovery[]): Promise<void> {
		const meta = tx.objectStore("meta"), used = await request(meta.get("bytes")) as number | undefined ?? 0;
		let archivedBytes = 0;
		for (const item of archive ? Array.isArray(archive) ? archive : [archive] : []) {
			if (await request(tx.objectStore("recoveries").getKey([item.entryId, item.id]))) continue;
			archivedBytes += footprint(item.record);
			await request(tx.objectStore("recoveries").add(item));
		}
		const next = used - footprint(before) + footprint(after) + archivedBytes;
		if (next > this.quota) throw new Error("Bases local storage quota reached; retained work was not discarded");
		after.revision = before.revision + 1;
		await request(tx.objectStore("files").put(after));
		await request(meta.put(next, "bytes"));
	}
	private check(record: BaseSyncRecord, revision: number): void {
		if (record.revision !== revision) throw new Error("Bases state changed; reload before continuing");
	}
	private idle(record: BaseSyncRecord): void {
		if (record.pending || record.download) throw new Error("Finish pending Bases work before replacing it");
	}
	private reviewed(record: BaseSyncRecord): void {
		if (record.conflict || record.reviewRequired || record.retirement) throw new Error("Review the retained Bases conflict first");
	}
	private bound(record: BaseSyncRecord, binding: RestoreBinding): void {
		const context = parseBaseRestoreContext(record.restoreContext?.supported, record.restoreContext?.generation);
		if (restoreGeneration(binding.restoreGeneration) !== (context?.generation ?? null)) throw new BaseContentFailure("pause", "restore_generation_changed");
	}
	async requireBinding(entryId: string, binding: RestoreBinding): Promise<void> {
		await this.transaction("readonly", async tx => this.bound(await this.current(tx, entryId), binding));
	}
	/** Call under the native entry lock. The revision is captured before the
	 * network read so another window's observation cannot be rolled back. */
	async observeRestoreContext(entryId: string, revision: number, context: RestoreContext | undefined, current: () => boolean): Promise<void> {
		const next = parseBaseRestoreContext(context?.supported, context?.generation) ?? { supported: false, generation: null };
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision);
			if (!current()) throw new BaseContentFailure("pause", "base_context_changed");
			const prior = parseBaseRestoreContext(before.restoreContext?.supported, before.restoreContext?.generation) ?? { supported: false, generation: null };
			if (prior.generation !== null && (!next.supported || next.generation === null)) throw new BaseContentFailure("pause", "restore_guard_unavailable");
			if (prior.generation === next.generation && prior.supported === next.supported) return;
			await this.write(tx, before, { ...before, restoreContext: next });
			if (!current()) throw new BaseContentFailure("pause", "base_context_changed");
		});
	}

	/** A tombstone never settles or discards an unknown pending publication.
	 * Retain the whole previous state and the observed local bytes together. */
	async retainRetirement(entryId: string, revision: number, path: string, localBytes: ArrayBuffer | null): Promise<void> {
		if (!basePath(path)) throw new Error("Invalid retired Bases path");
		const local = localBytes === null ? null : copyBaseBytes(localBytes);
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision);
			if (before.retirement) return;
			await this.write(tx, before, { ...before, retirement: { path, local } },
				{ entryId, id: uuidv4(), createdAt: Date.now(), record: before });
		});
	}
	async prepareRetirementMove(entryId: string, revision: number, path: string, localBytes: ArrayBuffer): Promise<void> {
		if (!basePath(path) || !path.startsWith(RECOVERY_FOLDER + "/")) throw new Error("Invalid Bases recovery destination");
		const local = copyBaseBytes(localBytes);
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision);
			if (!before.retirement || before.retirement.move && (before.retirement.move.path !== path || before.retirement.move.state === "complete")) throw new Error("Review the current Bases removal first");
			await this.write(tx, before, { ...before, retirement: { ...before.retirement, move: { path, local, state: "prepared" } } },
				before.retirement.move ? { entryId, id: uuidv4(), createdAt: Date.now(), record: before } : undefined);
		});
	}
	async completeRetirementMove(entryId: string, path: string): Promise<void> {
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId), retired = before.retirement;
			if (!retired?.move || retired.move.path !== path) throw new Error("Bases recovery destination changed");
			if (retired.move.state === "complete") return;
			await this.write(tx, before, { ...before, retirement: { ...retired, move: { ...retired.move, state: "complete" } } });
		});
	}
	/** Persist the exact local creation before calling Vault.create. Restoration
	 * never settles old requests or reuses the retired managed identity. */
	async prepareRestore(entryId: string, revision: number, path: string, bytes: ArrayBuffer, label: string): Promise<BaseRestore> {
		if (!basePath(path) || !path.toLowerCase().endsWith(".base") || path.startsWith(RECOVERY_FOLDER + "/")) throw new Error("Choose a new .base file inside the shared folder.");
		const restore: BaseRestore = { id: uuidv4(), path, bytes: copyBaseBytes(bytes), label: label.slice(0, 160), state: "prepared" };
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision);
			if (!before.retirement || before.restore?.state === "prepared") throw new Error("Review the current Bases restoration first.");
			if (path.toLowerCase() === before.retirement.path.toLowerCase()) throw new Error("Choose a new path so the removed file and its identity remain separate.");
			await this.write(tx, before, { ...before, restore }, before.restore ? { entryId, id: uuidv4(), createdAt: Date.now(), record: { entryId, revision, restore: before.restore } } : undefined);
		});
		return { ...restore, bytes: restore.bytes.slice(0) };
	}
	async completeRestore(entryId: string, restoreId: string): Promise<void> {
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId);
			if (before.restore?.id !== restoreId) throw new Error("Bases restoration changed; review it again.");
			if (before.restore.state === "created") return;
			await this.write(tx, before, { ...before, restore: { ...before.restore, state: "created" } });
		});
	}
	async cancelRestore(entryId: string, revision: number): Promise<void> {
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision);
			if (!before.restore) return;
			const after = { ...before }; delete after.restore;
			await this.write(tx, before, after, { entryId, id: uuidv4(), createdAt: Date.now(), record: { entryId, revision, restore: before.restore } });
		});
	}

	async adopt(entryId: string, revision: number, snapshot: BaseSnapshot): Promise<void> {
		snapshot = await validateBaseSnapshot(snapshot, entryId);
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision); this.idle(before);
			this.bound(before, baseRestoreBinding(snapshot));
			this.reviewed(before);
			await this.write(tx, before, { ...before, baseline: snapshot });
		});
	}

	async stage(entryId: string, revision: number, expected: BaseSnapshot["state"], bytes: ArrayBuffer, binding: RestoreBinding = {}): Promise<BasePending> {
		const pending = copyBasePending({ operationId: uuidv4(), expected, bytes, ...restoreMetadata(binding) }, entryId);
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision); this.idle(before);
			this.bound(before, pending);
			this.reviewed(before);
			await this.write(tx, before, { ...before, pending });
		});
		return copyBasePending(pending, entryId);
	}

	async settle(entryId: string, operationId: string, result: BaseWithdrawal): Promise<boolean> {
		const captured = await this.get(entryId);
		if (captured.pending?.operationId !== operationId) return false;
		let accepted: BaseAccepted | undefined;
		if (result.status === "accepted") accepted = await parseBaseAccepted({ protocol_version: 1, ...result.result }, captured.pending, entryId);
		else if (result.status !== "withdrawn" || result.entry_id !== entryId || result.operation_id !== operationId) throw new Error("Invalid Bases withdrawal receipt");
		const validated = accepted;
		return this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId);
			if (before.pending?.operationId !== operationId) return false;
			this.bound(before, before.pending);
			const after = { ...before }; delete after.pending;
			if (validated) after.baseline = { state: validated.state, bytes: before.pending.bytes,
				...(before.pending.restoreGeneration !== undefined ? { restoreContext: { supported: true, generation: restoreGeneration(before.pending.restoreGeneration) } } : {}) };
			else after.reviewRequired = "withdrawn";
			await this.write(tx, before, after, validated ? undefined : { entryId, id: operationId, createdAt: Date.now(), record: before });
			return true;
		});
	}

	async retainConflict(entryId: string, revision: number, conflict: BaseConflict): Promise<void> {
		const copy = { reason: conflict.reason.slice(0, 128), local: conflict.local === null ? null : copyBaseBytes(conflict.local),
			remote: await validateBaseSnapshot(conflict.remote, entryId) };
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision); this.idle(before);
			// Repeated observations never discard the original conflict copies.
			if (before.conflict) throw new Error("Review the retained Bases conflict first");
			const after = { ...before, conflict: copy }; delete after.reviewRequired;
			await this.write(tx, before, after);
		});
	}

	/** Caller has reviewed fresh local/remote bytes. Archive the old conflict
 * atomically before allowing a new decision; this does not modify disk. */
	async archiveConflict(entryId: string, revision: number): Promise<void> {
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision); this.idle(before);
			if (!before.conflict) return;
			const after = { ...before }; delete after.conflict;
			await this.write(tx, before, after, { entryId, id: uuidv4(), createdAt: Date.now(), record: before });
		});
	}

	/** Archive reviewed conflicts and prepare their replacement in one commit.
	 * A crash cannot leave a cleared conflict with an unrecorded overwrite. */
	async resolveConflict(entryId: string, revision: number, choice: "local" | "server", localBytes: ArrayBuffer | null, remote: BaseSnapshot): Promise<void> {
		const local = localBytes === null ? null : copyBaseBytes(localBytes);
		remote = await validateBaseSnapshot(remote, entryId);
		if (choice === "local" ? local === null : remote.bytes === null) throw new Error("The chosen Bases copy is unavailable");
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision); this.idle(before);
			this.bound(before, baseRestoreBinding(remote));
			if (before.retirement) throw new Error("This Bases identity was removed. Recover it as a separate file.");
			if (!before.conflict && !before.reviewRequired) throw new Error("The Bases conflict was already reviewed");
			const after = { ...before }; delete after.conflict; delete after.reviewRequired;
			if (choice === "local") after.pending = { operationId: uuidv4(), expected: remote.state, bytes: local!, ...baseRestoreBinding(remote) };
			else after.download = { id: uuidv4(), before: local, remote };
			// The displayed copies may be newer than the initial conflict. Preserve
			// those too before an explicit server choice can overwrite local edits.
			await this.write(tx, before, after, [
				{ entryId, id: uuidv4(), createdAt: Date.now(), record: before },
				{ entryId, id: uuidv4(), createdAt: Date.now(), record: { entryId, revision: before.revision,
					conflict: { reason: "reviewed-copies", local, remote } } },
			]);
		});
	}

	async prepareDownload(entryId: string, revision: number, beforeBytes: ArrayBuffer | null, remote: BaseSnapshot): Promise<BaseDownload> {
		const download = { id: uuidv4(), before: beforeBytes === null ? null : copyBaseBytes(beforeBytes), remote: await validateBaseSnapshot(remote, entryId) };
		if (download.remote.bytes === null) throw new Error("The Bases file has not been published");
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision); this.idle(before);
			this.bound(before, baseRestoreBinding(download.remote));
			this.reviewed(before);
			await this.write(tx, before, { ...before, download });
		});
		return download;
	}
	/** A failed local replacement becomes a conflict; retain its original intent. */
	async rejectDownload(entryId: string, downloadId: string, localBytes: ArrayBuffer | null, reason: "local-changed-during-download" | "restore-changed" = "local-changed-during-download"): Promise<boolean> {
		const local = localBytes === null ? null : copyBaseBytes(localBytes);
		return this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId);
			if (before.download?.id !== downloadId) return false;
			const after = { ...before, conflict: { reason, local, remote: before.download.remote } };
			delete after.download;
			await this.write(tx, before, after, { entryId, id: downloadId, createdAt: Date.now(), record: before });
			return true;
		});
	}
	/** Called only after the host confirms its conditional local replacement. */
	async completeDownload(entryId: string, downloadId: string): Promise<boolean> {
		return this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId);
			if (before.download?.id !== downloadId) return false;
			this.bound(before, baseRestoreBinding(before.download.remote));
			const after = { ...before, baseline: before.download.remote }; delete after.download;
			await this.write(tx, before, after); return true;
		});
	}
	async recoveries(entryId: string, after = "", limit = 25): Promise<BaseRecovery[]> {
		if (!baseId(entryId) || !Number.isInteger(limit) || limit < 1 || limit > 100 || after && !baseId(after)) throw new Error("Invalid Bases recovery page");
		return this.transaction("readonly", tx => request(tx.objectStore("recoveries").getAll(IDBKeyRange.bound([entryId, after], [entryId, "\uffff"], true), limit)) as Promise<BaseRecovery[]>);
	}
}
