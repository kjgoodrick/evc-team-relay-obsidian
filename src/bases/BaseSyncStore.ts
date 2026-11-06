import { v4 as uuidv4 } from "uuid";
import { BASE_LOCAL_QUOTA, baseId, copyBaseBytes, copyBasePending, parseBaseAccepted, validateBaseSnapshot,
	type BaseSnapshot, type BasePending, type BaseWithdrawal, type BaseAccepted } from "./BaseContentProtocol";

export interface BaseStoreIdentity { serverId: string; accountId: string; vaultId: string; shareId: string }
export interface BaseConflict { reason: string; local: ArrayBuffer | null; remote: BaseSnapshot }
export interface BaseDownload { id: string; before: ArrayBuffer | null; remote: BaseSnapshot }
export interface BaseSyncRecord {
	entryId: string; revision: number; baseline?: BaseSnapshot; pending?: BasePending;
	conflict?: BaseConflict; download?: BaseDownload;
	reviewRequired?: "withdrawn";
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
		(record.download?.before?.byteLength ?? 0) + (record.download?.remote.bytes?.byteLength ?? 0);
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
		const open = factory.open("team-relay-bases:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]), 1);
		open.onupgradeneeded = () => {
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
		if (record.conflict || record.reviewRequired) throw new Error("Review the retained Bases conflict first");
	}

	async adopt(entryId: string, revision: number, snapshot: BaseSnapshot): Promise<void> {
		snapshot = await validateBaseSnapshot(snapshot, entryId);
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision); this.idle(before);
			this.reviewed(before);
			await this.write(tx, before, { ...before, baseline: snapshot });
		});
	}

	async stage(entryId: string, revision: number, expected: BaseSnapshot["state"], bytes: ArrayBuffer): Promise<BasePending> {
		const pending = copyBasePending({ operationId: uuidv4(), expected, bytes }, entryId);
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.check(before, revision); this.idle(before);
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
			const after = { ...before }; delete after.pending;
			if (validated) after.baseline = { state: validated.state, bytes: before.pending.bytes };
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
			if (!before.conflict && !before.reviewRequired) throw new Error("The Bases conflict was already reviewed");
			const after = { ...before }; delete after.conflict; delete after.reviewRequired;
			if (choice === "local") after.pending = { operationId: uuidv4(), expected: remote.state, bytes: local! };
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
			this.reviewed(before);
			await this.write(tx, before, { ...before, download });
		});
		return download;
	}
	/** A failed local replacement becomes a conflict; retain its original intent. */
	async rejectDownload(entryId: string, downloadId: string, localBytes: ArrayBuffer | null): Promise<boolean> {
		const local = localBytes === null ? null : copyBaseBytes(localBytes);
		return this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId);
			if (before.download?.id !== downloadId) return false;
			const after = { ...before, conflict: { reason: "local-changed-during-download", local, remote: before.download.remote } };
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
			const after = { ...before, baseline: before.download.remote }; delete after.download;
			await this.write(tx, before, after); return true;
		});
	}
	async recoveries(entryId: string, after = "", limit = 25): Promise<BaseRecovery[]> {
		if (!baseId(entryId) || !Number.isInteger(limit) || limit < 1 || limit > 100 || after && !baseId(after)) throw new Error("Invalid Bases recovery page");
		return this.transaction("readonly", tx => request(tx.objectStore("recoveries").getAll(IDBKeyRange.bound([entryId, after], [entryId, "\uffff"], true), limit)) as Promise<BaseRecovery[]>);
	}
}
