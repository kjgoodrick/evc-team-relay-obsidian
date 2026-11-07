import type { Draft, Json, OutboxOperation, StoreIdentity } from "./DiscussionStore";
import { isRecord } from "../DiscussionProtocol";
import { PICTURE_MAX_BYTES, PICTURE_SOURCE_QUOTA, type LocalPicture } from "../PictureProtocol";
import { setPictureReferences } from "./PictureRecords";

export const LOCAL_WORK_STORE = "localWorkExports";
export const LOCAL_WORK_MAX_RECORDS = 5000;
export const LOCAL_WORK_MAX_METADATA = 8 * 1024 * 1024;
export interface LocalWorkSummary { id: string; createdAt: number; drafts: number; operations: number; actions: number; pictures: number; pictureBytes: number }
export interface LocalWorkSnapshot {
	format: "team-relay-local-comment-work";
	version: 1;
	storageVersion: 23;
	id: string;
	createdAt: number;
	identity: StoreIdentity;
	drafts: Draft[];
	operations: Omit<OutboxOperation, "lease" | "result">[];
	dependencies: { operationId: string; state: OutboxOperation["state"] | "missing"; replacementId?: string }[];
	actions: { key: string; value: Json }[];
	pictures: Omit<LocalPicture, "bytes">[];
}
export const exportOwner = (id: string, scopeId: string) => `${id}:${scopeId}`;
function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error ?? new Error("Local recovery capture failed")); });
}
/** Cursor callbacks stay synchronous: no file/network/hash waits in an IDB transaction. */
async function scan(source: IDBObjectStore | IDBIndex, collect: (value: unknown, key: IDBValidKey) => void, range?: IDBKeyRange): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cursor = source.openCursor(range);
		cursor.onerror = () => reject(cursor.error);
		cursor.onsuccess = () => {
			try {
				const row = cursor.result; if (!row) { resolve(); return; }
				collect(row.value, row.key); row.continue();
			} catch (error) { reject(error); }
		};
	});
}
function publicIdentity(identity: StoreIdentity): StoreIdentity {
	// Server identity is useful for manual reconciliation, but URL credentials
	// and query tokens have no place in a portable recovery file.
	let serverId = "[unavailable]";
	try { const url = new URL(identity.serverId); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; serverId = url.href; } catch { /* retain other identities */ }
	return { ...identity, serverId };
}

/** One immutable capture per account/share. Pins survive crashes without copying
 * the 100 MiB source pool, and normal acknowledgements may continue concurrently. */
export async function captureLocalWork(tx: IDBTransaction, identity: StoreIdentity, id: string, now: number): Promise<LocalWorkSnapshot> {
	const captures = tx.objectStore(LOCAL_WORK_STORE);
	if (await request(captures.get("summary"))) throw new Error("Finish or release the retained recovery copy before starting another.");
	const snapshot: LocalWorkSnapshot = { format: "team-relay-local-comment-work", version: 1, storageVersion: 23,
		id, createdAt: now, identity: publicIdentity(identity), drafts: [], operations: [], dependencies: [], actions: [], pictures: [] };
	let records = 0, metadataBytes = 0;
	const account = (value: unknown) => {
		metadataBytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
		if (++records > LOCAL_WORK_MAX_RECORDS || metadataBytes > LOCAL_WORK_MAX_METADATA) throw new Error("Saved comment work exceeds the recovery-copy limit. Nothing was removed.");
	};
	await scan(tx.objectStore("drafts"), value => { account(value); snapshot.drafts.push(value as Draft); });
	const outbox = tx.objectStore("outbox");
	for (const state of ["queued", "sending", "rejected", "review"]) await scan(outbox.index("state"), value => {
		const operation = { ...value as OutboxOperation }; delete operation.lease; delete operation.result;
		account(operation); snapshot.operations.push(operation);
	}, IDBKeyRange.only(state));
	const included = new Set(snapshot.operations.map(operation => operation.operationId));
	for (const operationId of new Set(snapshot.operations.flatMap(operation => operation.dependsOn))) {
		if (included.has(operationId)) continue;
		const operation: OutboxOperation | undefined = await request(outbox.get(operationId));
		const dependency = { operationId, state: operation?.state ?? "missing" as const,
			...(operation?.replacementId ? { replacementId: operation.replacementId } : {}) };
		account(dependency); snapshot.dependencies.push(dependency);
	}
	const drafts = new Set(snapshot.drafts.map(draft => draft.id));
	for (const prefix of ["online:", "recovery:", "reattach:", "timelineMarkerCommand:"]) await scan(tx.objectStore("preferences"), (value, key) => {
		if (value == null || typeof key !== "string") return;
		if ((prefix === "online:" || prefix === "recovery:") && !drafts.has(key.slice(prefix.length))) return;
		if (prefix === "reattach:" && isRecord(value) && value.completed !== undefined) return;
		if (prefix === "timelineMarkerCommand:" && isRecord(value) && value.status === "accepted") return;
		const action = { key, value: value as Json }; account(action); snapshot.actions.push(action);
	}, IDBKeyRange.bound(prefix, prefix + "\uffff"));
	let pictureBytes = 0;
	await scan(tx.objectStore("pictureSources"), value => {
		const source = value as LocalPicture;
		if (!Number.isSafeInteger(source.size) || source.size < 1 || source.size > PICTURE_MAX_BYTES || source.bytes.byteLength !== source.size ||
			(pictureBytes += source.size) > PICTURE_SOURCE_QUOTA) throw new Error("Original picture storage needs repair before exporting.");
		const picture = { id: source.id, scopeId: source.scopeId, sha256: source.sha256, size: source.size };
		account(picture); snapshot.pictures.push(picture);
		// Capture and pin happen under the same write transaction as draft/outbox
		// ownership, so a concurrent accepted send cannot delete these bytes.
		tx.objectStore("pictureReferences").put({ pictureId: source.id, kind: "export", ownerId: exportOwner(id, source.scopeId), scopeId: source.scopeId });
	});
	if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > LOCAL_WORK_MAX_METADATA) throw new Error("Saved comment work exceeds the recovery-copy limit. Nothing was removed.");
	const summary: LocalWorkSummary = { id, createdAt: now, drafts: snapshot.drafts.length, operations: snapshot.operations.length,
		actions: snapshot.actions.length, pictures: snapshot.pictures.length, pictureBytes };
	await request(captures.add(snapshot, "snapshot")); await request(captures.add(summary, "summary")); return snapshot;
}

export async function releaseLocalWork(tx: IDBTransaction, id: string): Promise<boolean> {
	const captures = tx.objectStore(LOCAL_WORK_STORE), snapshot: LocalWorkSnapshot | undefined = await request(captures.get("snapshot"));
	if (!snapshot || snapshot.id !== id) return false;
	for (const scope of new Set(snapshot.pictures.map(picture => picture.scopeId))) await setPictureReferences(tx, "export", exportOwner(id, scope), scope, []);
	await request(captures.clear()); return true;
}
