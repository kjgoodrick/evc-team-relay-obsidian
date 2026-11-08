import type { Draft, OutboxOperation } from "./DiscussionStore";

export interface LocalDraftItem { draft: Draft; pendingSend: boolean; recovery: boolean; imported?: boolean }
export interface LocalWorkPage<T, C> { items: T[]; next?: C }
export type WaitingState = "review" | "rejected" | "sending" | "queued";
export interface WaitingCursor { state: WaitingState; id: string }
const states: WaitingState[] = ["review", "rejected", "sending", "queued"];
function limitSize(limit: number): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Choose a page size from 1 to 20.");
}
function identity(id: string): void {
	if (typeof id !== "string" || !id.length || id.length > 512) throw new Error("Invalid saved work cursor.");
}
function read<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
/** Bounded cursor reads never clone picture bytes or scan accepted history. Pages
 * reflect current local state; refresh starts again after concurrent changes. */
export async function localDraftPage(tx: IDBTransaction, after?: string, limit = 10): Promise<LocalWorkPage<LocalDraftItem, string>> {
	limitSize(limit); if (after !== undefined) identity(after);
	const drafts = await read(tx.objectStore("drafts").getAll(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true), limit + 1)) as Draft[];
	const more = drafts.length > limit; drafts.length = Math.min(drafts.length, limit);
	const preferences = tx.objectStore("preferences"), items: LocalDraftItem[] = [];
	for (const draft of drafts) items.push({ draft, pendingSend: !!await read(preferences.get("online:" + draft.id)), recovery: !!await read(preferences.get("recovery:" + draft.id)),
		...(await read(preferences.get("importedDraft:" + draft.id)) ? { imported: true } : {}) });
	return { items, ...(more ? { next: drafts[drafts.length - 1].id } : {}) };
}
export async function waitingWorkPage(tx: IDBTransaction, after?: WaitingCursor, limit = 10): Promise<LocalWorkPage<OutboxOperation, WaitingCursor>> {
	limitSize(limit);
	if (after) { if (!states.includes(after.state)) throw new Error("Invalid waiting work state."); identity(after.id); }
	const items: OutboxOperation[] = [], index = tx.objectStore("outbox").index("state");
	for (let position = after ? states.indexOf(after.state) : 0; position < states.length && items.length <= limit; position++) {
		const state = states[position], resume = after?.state === state ? after.id : undefined;
		await new Promise<void>((resolve, reject) => {
			const request = index.openCursor(IDBKeyRange.only(state));
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const row = request.result;
				if (!row) { resolve(); return; }
				if (resume !== undefined && String(row.primaryKey) <= resume) {
					if (String(row.primaryKey) < resume) row.continuePrimaryKey(state, resume); else row.continue();
					return;
				}
				items.push(row.value as OutboxOperation);
				if (items.length > limit) resolve(); else row.continue();
			};
		});
	}
	const more = items.length > limit; items.length = Math.min(items.length, limit);
	const last = items[items.length - 1];
	return { items, ...(more ? { next: { state: last.state as WaitingState, id: last.operationId } } : {}) };
}
