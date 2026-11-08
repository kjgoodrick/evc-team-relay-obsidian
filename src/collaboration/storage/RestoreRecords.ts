import { isRecord, isSequence } from "../DiscussionProtocol";
import { DiscussionFailure } from "../DiscussionFailure";
import { restoreContext, restoreGeneration, type RestoreBinding, type RestoreContext } from "../RestoreGeneration";
import { INBOX_KEY, forgetInboxScope, parseInboxLocalState } from "./InboxRecords";
import type { OutboxOperation } from "./DiscussionStore";

const CONTEXT_KEY = "restoreContext";
// Array keys cannot collide with any string scope, including an uncached scope.
const CACHE_GENERATION_KEY = ["restore-generation"];
export const RESTORE_STORES = ["preferences", "outbox", "entities", "cursors", "generations", "pictureCache"];
export interface RestoreCheckpoint { revision: number; context: RestoreContext }

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error ?? new Error("Restore reconciliation failed")); });
}
async function scan(store: IDBObjectStore, visit: (row: IDBCursorWithValue) => void): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cursor = store.openCursor(); cursor.onerror = () => reject(cursor.error);
		cursor.onsuccess = () => {
			try { const row = cursor.result; if (!row) { resolve(); return; } visit(row); row.continue(); }
			catch (error) { reject(error); }
		};
	});
}
export async function readRestoreCheckpoint(tx: IDBTransaction): Promise<RestoreCheckpoint> {
	const value: unknown = await request(tx.objectStore("preferences").get(CONTEXT_KEY));
	if (value === undefined) return { revision: 0, context: { supported: false, generation: null } };
	if (!isRecord(value) || !isSequence(value.revision) || !isRecord(value.context)) throw new DiscussionFailure("pause", "invalid_restore_generation");
	const context = restoreContext(value.context.supported, value.context.generation);
	if (!context) throw new DiscussionFailure("pause", "invalid_restore_generation");
	return { revision: value.revision, context };
}
export function bindingMatches(context: RestoreContext, operation: RestoreBinding): boolean {
	return restoreGeneration(operation.restoreGeneration) === context.generation && (context.supported || context.generation === null);
}
export async function requireRestoreBinding(tx: IDBTransaction, operation: RestoreBinding): Promise<void> {
	if (!bindingMatches((await readRestoreCheckpoint(tx)).context, operation)) throw new DiscussionFailure("pause", "restore_generation_changed");
}
export async function cacheGeneration(tx: IDBTransaction, scopeId: string): Promise<number> {
	const store = tx.objectStore("generations");
	return await request(store.get(scopeId)) ?? await request(store.get(CACHE_GENERATION_KEY)) ?? 0;
}

/** Caller stops workers first. CAS rejects capabilities fetched before another
 * window's observation; a late response cannot rotate the local lineage back. */
export async function observeRestoreContext(tx: IDBTransaction, next: RestoreContext | undefined, expectedRevision: number,
	current: () => boolean): Promise<{ checkpoint: RestoreCheckpoint; changed: boolean }> {
	const prior = await readRestoreCheckpoint(tx), context = next === undefined ? { supported: false, generation: null } : restoreContext(next.supported, next.generation)!;
	if (!current() || prior.revision !== expectedRevision) throw new DiscussionFailure("pause", "action_context_changed");
	if ((!context.supported || context.generation === null) && (prior.context.generation !== null || context.generation !== null)) throw new DiscussionFailure("pause", "restore_guard_unavailable");
	if (context.generation === prior.context.generation && context.supported === prior.context.supported) return { checkpoint: prior, changed: false };
	const changed = context.generation !== prior.context.generation, checkpoint = { revision: prior.revision + 1, context };
	if (!Number.isSafeInteger(checkpoint.revision)) throw new Error("Restore revision limit reached");
	const preferences = tx.objectStore("preferences");
	if (changed) {
		await scan(tx.objectStore("outbox"), row => {
			const operation = row.value as OutboxOperation;
			if (operation.state === "accepted" || operation.state === "withdrawn" || bindingMatches(context, operation)) return;
			// Review means an explicit prior withdrawal. Preserve that distinction.
			if (operation.state !== "review") operation.state = "rejected";
			operation.error = "restore_generation_changed"; delete operation.lease; row.update(operation);
		});
		await request(tx.objectStore("entities").clear()); await request(tx.objectStore("cursors").clear());
		await request(tx.objectStore("pictureCache").clear());
		await request(preferences.put(0, "pictureCacheBytes"));
		await request(preferences.put((await request(preferences.get("pictureCacheEpoch")) ?? 0) + 1, "pictureCacheEpoch"));
		const generations = tx.objectStore("generations");
		const global = await request(generations.get(CACHE_GENERATION_KEY)) ?? 0;
		await scan(generations, row => { if (typeof row.key === "string") row.update((row.value as number) + 1); });
		await request(generations.put(global + 1, CACHE_GENERATION_KEY));
		const remotePrefixes = ["permission:", "people:", "documentGeneration:", "baseContext:", "baseRecordComment:",
			"baseRecords:", "baseDefinitions:", "timelineAxis:", "timelineMarkers:", "verification:"];
		await scan(preferences, row => { if (typeof row.key === "string" && remotePrefixes.some(prefix => row.key.toString().startsWith(prefix))) row.delete(); });
		const inbox = await request(preferences.get(INBOX_KEY));
		if (inbox !== undefined) {
			// An old inbox worker loses its lease/epoch. Keep pending user choices
			// for review; do not apply them to restored versions of the same thread.
			const state = parseInboxLocalState(inbox); forgetInboxScope(state); state.revision++; state.retryAt = 0; delete state.lease;
			for (const operation of state.operations) { operation.state = "rejected"; operation.error = "restore_generation_changed"; }
			await request(preferences.put(state, INBOX_KEY));
		}
	}
	await request(preferences.put(checkpoint, CONTEXT_KEY));
	if (!current()) throw new DiscussionFailure("pause", "action_context_changed");
	return { checkpoint, changed };
}
