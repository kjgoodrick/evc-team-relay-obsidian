import type { Draft, StoreIdentity } from "./DiscussionStore";
import { isId, isRecord } from "../DiscussionProtocol";
import { parseDiscussionScope } from "../DiscussionScope";
import { isPictureHash, pictureIds, type LocalPicture } from "../PictureProtocol";
import { putPictureSources, setPictureReferences } from "./PictureRecords";

export interface ImportedDraftOrigin {
	version: 1; manifestSha256: string; snapshotId: string; draftId: string;
	identity: StoreIdentity; scopeId: string;
}
export interface DraftImportReceipt { version: 1; draftId: string; scopeId: string; importedAt: number; origin: ImportedDraftOrigin }
export const IMPORTED_DRAFT_PREFIX = "importedDraft:";
export const IMPORT_RECEIPT_PREFIX = "importReceipt:";

function server(value: string): string {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid recovery server identity.");
	return url.href.replace(/\/+$/, "");
}
/** Source metadata is untrusted provenance. It never grants remote access. */
export function importOrigin(value: unknown, destination: Readonly<StoreIdentity>): ImportedDraftOrigin {
	if (!isRecord(value) || value.version !== 1 || !isPictureHash(value.manifestSha256) || !isId(value.snapshotId) ||
		typeof value.draftId !== "string" || !value.draftId || value.draftId.length > 512 || !parseDiscussionScope(value.scopeId) || !isRecord(value.identity) ||
		typeof value.identity.serverId !== "string" || !isId(value.identity.accountId) || !isId(value.identity.shareId) || typeof value.identity.vaultId !== "string" || !value.identity.vaultId || value.identity.vaultId.length > 512) throw new Error("Invalid recovery-copy identity.");
	if (server(value.identity.serverId) !== server(destination.serverId) || value.identity.accountId.toLowerCase() !== destination.accountId.toLowerCase() || value.identity.shareId.toLowerCase() !== destination.shareId.toLowerCase()) throw new Error("Choose the same server, account and shared folder before restoring this local draft.");
	return { version: 1, manifestSha256: value.manifestSha256, snapshotId: value.snapshotId, draftId: value.draftId,
		identity: { serverId: value.identity.serverId, accountId: value.identity.accountId, shareId: value.identity.shareId, vaultId: value.identity.vaultId }, scopeId: value.scopeId as string };
}
function read<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("Could not restore the local draft.")); });
}

/** Receipts, draft ownership and original bytes share one transaction. Repeating
 * an import never overwrites an edited/sent/discarded copy or resumes a request. */
export async function commitDraftImport(tx: IDBTransaction, key: string, origin: ImportedDraftOrigin, draft: Draft,
	sources: LocalPicture[], current: () => boolean, now: number): Promise<{ receipt: DraftImportReceipt; created: boolean }> {
	if (!current()) throw new Error("The recovery review changed. Nothing was restored.");
	const preferences = tx.objectStore("preferences"), previous: unknown = await read(preferences.get(IMPORT_RECEIPT_PREFIX + key));
	if (previous !== undefined) {
		if (!isRecord(previous) || previous.version !== 1 || typeof previous.draftId !== "string" || !previous.draftId.startsWith("imported:") || !isId(previous.draftId.slice(9)) ||
			!Number.isSafeInteger(previous.importedAt) || (previous.importedAt as number) < 0 ||
			previous.scopeId !== origin.scopeId || !isRecord(previous.origin) || previous.origin.manifestSha256 !== origin.manifestSha256 ||
			previous.origin.snapshotId !== origin.snapshotId || previous.origin.draftId !== origin.draftId ||
			JSON.stringify(importOrigin(previous.origin, origin.identity)) !== JSON.stringify(origin)) throw new Error("The previous import receipt needs review.");
		if (!current()) throw new Error("The recovery review changed. Nothing was restored.");
		return { receipt: previous as unknown as DraftImportReceipt, created: false };
	}
	const receipt: DraftImportReceipt = { version: 1, draftId: draft.id, scopeId: draft.scopeId, importedAt: now, origin };
	await read(tx.objectStore("drafts").add(draft));
	const ids = pictureIds(draft.body, true);
	await setPictureReferences(tx, "draft", draft.id, draft.scopeId, ids);
	await putPictureSources(tx, sources, draft.scopeId, ids);
	await read(preferences.add(receipt, IMPORT_RECEIPT_PREFIX + key));
	await read(preferences.add(origin, IMPORTED_DRAFT_PREFIX + draft.id));
	if (!current()) throw new Error("The recovery review changed. Nothing was restored.");
	return { receipt, created: true };
}
