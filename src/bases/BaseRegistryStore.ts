import { baseId } from "./BaseContentProtocol";
import type { BaseStoreIdentity } from "./BaseSyncStore";
import { BASE_REGISTRY_RESPONSE_LIMIT, copyBaseViewIntent, parseBaseRegistry, parseBaseViewRepairResult,
	type BaseRegistrySnapshot, type BaseViewRepairIntent } from "./BaseRegistryProtocol";

const QUOTA = 8 * 1024 * 1024;
const REPAIR_RESERVATION = BASE_REGISTRY_RESPONSE_LIMIT + 16_384;
export interface BaseRegistryPending extends BaseViewRepairIntent { reviewed: BaseRegistrySnapshot }
export interface BaseRegistryRecord { entryId: string; revision: number; snapshot?: BaseRegistrySnapshot; pending?: BaseRegistryPending }
export interface BaseRegistryHistory {
	entryId: string; id: string; createdAt: number; status: "accepted" | "superseded"; intent: BaseRegistryPending;
	observedRevision: number; bindings?: { slot: number; view_id: string | null }[];
}
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const footprint = (value: BaseRegistryRecord) => value.revision ? size(value) + (value.pending ? REPAIR_RESERVATION : 0) : 0;
const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
	value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});
const completion = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
	tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("Saved-view storage transaction aborted")); tx.onerror = () => {};
});

/** Separate bounded account cache. The pending request and its operation ID
 * commit before the remote repair. Nothing retries merely because the DB opens. */
export class BaseRegistryStore {
	private constructor(private db: IDBDatabase, readonly identity: Readonly<BaseStoreIdentity>, private quota: number) {}
	static async open(identity: BaseStoreIdentity, factory: IDBFactory = indexedDB, quota = QUOTA): Promise<BaseRegistryStore> {
		const url = new URL(identity.serverId);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !baseId(identity.accountId) ||
			!baseId(identity.shareId) || !identity.vaultId || identity.vaultId.length > 512 || !Number.isSafeInteger(quota) || quota < 1 || quota > QUOTA) throw new Error("Invalid saved-view storage identity");
		identity = { ...identity, serverId: url.toString().replace(/\/+$/, "") };
		const open = factory.open("team-relay-base-views:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]), 1);
		open.onupgradeneeded = () => {
			open.result.createObjectStore("files", { keyPath: "entryId" });
			open.result.createObjectStore("history", { keyPath: ["entryId", "id"] }); open.result.createObjectStore("meta");
		};
		const db = await request(open); db.onversionchange = () => db.close();
		return new BaseRegistryStore(db, Object.freeze(identity), quota);
	}
	close(): void { this.db.close(); }
	private async transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
		const tx = this.db.transaction(["files", "history", "meta"], mode), done = completion(tx); void done.catch(() => {});
		try { const result = await work(tx); await done; return result; }
		catch (error) { try { tx.abort(); } catch { /* Already terminal. */ } await done.catch(() => {}); throw error; }
	}
	private async current(tx: IDBTransaction, entryId: string): Promise<BaseRegistryRecord> {
		if (!baseId(entryId)) throw new Error("Invalid saved-view entry");
		return await request(tx.objectStore("files").get(entryId)) as BaseRegistryRecord | undefined ?? { entryId, revision: 0 };
	}
	get(entryId: string): Promise<BaseRegistryRecord> { return this.transaction("readonly", tx => this.current(tx, entryId)); }
	private async write(tx: IDBTransaction, before: BaseRegistryRecord, after: BaseRegistryRecord, history?: BaseRegistryHistory): Promise<void> {
		const meta = tx.objectStore("meta"), used = await request(meta.get("bytes")) as number | undefined ?? 0;
		after.revision = before.revision + 1;
		const next = used - footprint(before) + footprint(after) + (history ? size(history) : 0);
		if (next > this.quota) throw new Error("Saved-view storage is full. Existing associations and pending work were retained.");
		if (history) await request(tx.objectStore("history").add(history));
		await request(tx.objectStore("files").put(after)); await request(meta.put(next, "bytes"));
	}
	private lineage(before: BaseRegistrySnapshot | undefined, after: BaseRegistrySnapshot): void {
		if (before && (before.definition_id !== after.definition_id || before.generation !== after.generation)) throw new Error("The saved-view definition identity changed. Existing mappings are retained for review.");
	}
	async cache(entryId: string, snapshot: BaseRegistrySnapshot): Promise<void> {
		snapshot = parseBaseRegistry(snapshot, entryId);
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId); this.lineage(before.snapshot, snapshot);
			if (before.snapshot && before.snapshot.revision > snapshot.revision) throw new Error("A newer saved-view mapping is already cached. Refresh the view list.");
			if (before.snapshot?.revision === snapshot.revision) {
				if (JSON.stringify(before.snapshot) !== JSON.stringify(snapshot)) throw new Error("Inconsistent saved-view revision. Existing mappings were retained.");
				return;
			}
			await this.write(tx, before, { ...before, snapshot });
		});
	}
	async stage(entryId: string, revision: number, requested: BaseViewRepairIntent): Promise<void> {
		const pending = copyBaseViewIntent(requested);
		await this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId), snapshot = before.snapshot;
			if (before.revision !== revision || before.pending) throw new Error("Saved-view work changed. Check the pending repair before continuing.");
			if (!snapshot || snapshot.definition_id !== pending.definitionId || snapshot.generation !== pending.generation || snapshot.revision !== pending.request.expected_revision ||
				snapshot.content_sha256 !== pending.request.content_sha256 || snapshot.views.length !== pending.request.bindings.length) throw new Error("Refresh the saved-view mapping before repairing it.");
			if (await request(tx.objectStore("history").getKey([entryId, pending.request.operation_id]))) throw new Error("This saved-view operation was already completed.");
			await this.write(tx, before, { ...before, pending: { ...pending, reviewed: snapshot } });
		});
	}
	async settle(entryId: string, operationId: string, snapshot: BaseRegistrySnapshot, status: "accepted" | "superseded"): Promise<boolean> {
		snapshot = parseBaseRegistry(snapshot, entryId);
		return this.transaction("readwrite", async tx => {
			const before = await this.current(tx, entryId), pending = before.pending;
			if (!pending || pending.request.operation_id !== operationId) return false;
			this.lineage(before.snapshot, snapshot);
			if (before.snapshot?.revision === snapshot.revision && JSON.stringify(before.snapshot) !== JSON.stringify(snapshot)) throw new Error("Inconsistent saved-view revision. Existing mappings were retained.");
			if (status === "accepted") parseBaseViewRepairResult(snapshot, entryId, pending);
			else if (status !== "superseded" || snapshot.revision <= pending.request.expected_revision || snapshot.definition_id !== pending.definitionId || snapshot.generation !== pending.generation) throw new Error("The pending saved-view repair has not been fenced by a newer revision.");
			const after = { ...before, snapshot: before.snapshot && before.snapshot.revision > snapshot.revision ? before.snapshot : snapshot }; delete after.pending;
			await this.write(tx, before, after, { entryId, id: operationId, createdAt: Date.now(), status, intent: pending,
				observedRevision: snapshot.revision, ...(status === "accepted" ? { bindings: snapshot.views.map(view => ({ slot: view.slot, view_id: view.id })) } : {}) });
			return true;
		});
	}
	history(entryId: string, after = "", limit = 25): Promise<BaseRegistryHistory[]> {
		if (!baseId(entryId) || after && !baseId(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid saved-view history page");
		return this.transaction("readonly", tx => request(tx.objectStore("history").getAll(IDBKeyRange.bound([entryId, after], [entryId, "\uffff"], true), limit)) as Promise<BaseRegistryHistory[]>);
	}
	/** One coherent local diagnostic snapshot, bounded by this database's quota. */
	exportRecord(entryId: string): Promise<{ record: BaseRegistryRecord; history: BaseRegistryHistory[] }> {
		return this.transaction("readonly", async tx => {
			const record = await this.current(tx, entryId);
			const history = await request(tx.objectStore("history").getAll(IDBKeyRange.bound([entryId, ""], [entryId, "\uffff"]))) as BaseRegistryHistory[];
			return { record, history };
		});
	}
}
