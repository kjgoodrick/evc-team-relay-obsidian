import { isId, isRecord, isSequence, parseHistory, type HistoryPage } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";
import { parsePictureMetadata, type PictureMetadata } from "./PictureProtocol";

/** Administrative read data belongs only to the currently open review. */
export type ModerationHistory = HistoryPage & {
	audit_id: string; thread_id: string; message_id: string; recoverable_until: string;
	thread_removed: boolean; message_removed: boolean; thread_removal_reason: string | null;
};
export type ModerationPicture = { audit_id: string; picture: PictureMetadata };
export type ModerationItem = { thread_id: string; message_id: string; author_id: string | null;
	created_at: string; removed_at: string; recoverable_until: string; thread_removed: boolean; message_removed: boolean; revision: number };
export type ModerationCatalog = { audit_id: string; items: ModerationItem[]; has_more: boolean; next_after: number };

export function moderationReason(scopeId: string, reason: string) {
	const scope = parseDiscussionScope(scopeId), trimmed = reason.trim();
	if (!scope || !trimmed || [...trimmed].length > 512 || [...trimmed].some(char => char.codePointAt(0)! < 32 || char.codePointAt(0)! >= 0xd800 && char.codePointAt(0)! <= 0xdfff)) throw new Error("Enter a plain-text reason of 1–512 characters.");
	return { protocol_version: 1, reason: trimmed, ...(scope.viewId ? { view_id: scope.viewId } : {}) };
}

export function parseModerationCatalog(value: unknown, scopeId: string, after: number, limit: number): ModerationCatalog {
	envelope(value, scopeId);
	if (!Array.isArray(value.items) || value.items.length > limit || typeof value.has_more !== "boolean" ||
		!isSequence(value.next_after) || value.next_after < after || value.has_more && value.next_after <= after) throw new Error("Invalid removed-comment inventory.");
	const seen = new Set<string>();
	const items = value.items.map((item: unknown): ModerationItem => {
		if (!isRecord(item) || !isId(item.thread_id) || !isId(item.message_id) || !(item.author_id === null || isId(item.author_id)) ||
			!isSequence(item.revision) || item.revision < 1 || typeof item.thread_removed !== "boolean" || typeof item.message_removed !== "boolean" ||
			!item.thread_removed && !item.message_removed || [item.created_at, item.removed_at, item.recoverable_until].some(stamp => typeof stamp !== "string" || stamp.length > 64 || !Number.isFinite(Date.parse(stamp)))) throw new Error("Invalid removed-comment item.");
		if (seen.has(item.message_id) || Date.parse(item.recoverable_until as string) <= Date.parse(item.removed_at as string)) throw new Error("Invalid removed-comment item.");
		seen.add(item.message_id);
		return { thread_id: item.thread_id, message_id: item.message_id, author_id: item.author_id as string | null,
			created_at: item.created_at as string, removed_at: item.removed_at as string, recoverable_until: item.recoverable_until as string,
			thread_removed: item.thread_removed, message_removed: item.message_removed, revision: item.revision };
	});
	return { audit_id: value.audit_id as string, items, has_more: value.has_more, next_after: value.next_after };
}

export function moderationPageRequest(scopeId: string, reason: string, after: number, limit: number) {
	if (!isSequence(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid recovery page.");
	return { ...moderationReason(scopeId, reason), after, limit };
}

function envelope(value: unknown, scopeId: string): asserts value is Record<string, unknown> {
	const scope = parseDiscussionScope(scopeId);
	if (!scope || !isRecord(value) || value.protocol_version !== 1 || !isId(value.audit_id) ||
		value.entry_id !== scope.entryId || value.view_id !== (scope.viewId ?? null)) throw new Error("Invalid recovery response.");
}

export function parseModerationHistory(value: unknown, scopeId: string, threadId: string, messageId: string, after: number, limit: number): ModerationHistory {
	envelope(value, scopeId);
	if (value.thread_id !== threadId || value.message_id !== messageId ||
		typeof value.thread_removed !== "boolean" || typeof value.message_removed !== "boolean" ||
		!value.thread_removed && !value.message_removed ||
		typeof value.recoverable_until !== "string" || value.recoverable_until.length > 64 || !Number.isFinite(Date.parse(value.recoverable_until)) ||
		!(value.thread_removal_reason === null || typeof value.thread_removal_reason === "string" && [...value.thread_removal_reason].length <= 512) ||
		!value.thread_removed && value.thread_removal_reason !== null) throw new Error("Invalid recovery response.");
	const page = parseHistory(value, after);
	if (page.revisions.length > limit) throw new Error("Invalid recovery page size.");
	return { ...page, audit_id: value.audit_id as string, thread_id: threadId, message_id: messageId,
		recoverable_until: value.recoverable_until, thread_removed: value.thread_removed, message_removed: value.message_removed,
		thread_removal_reason: value.thread_removal_reason as string | null };
}

export function parseModerationPicture(value: unknown, scopeId: string, threadId: string, messageId: string, pictureId: string): ModerationPicture {
	envelope(value, scopeId);
	if (value.thread_id !== threadId || value.message_id !== messageId) throw new Error("Invalid recovery picture target.");
	const picture = parsePictureMetadata(value.picture, pictureId);
	if (picture.state !== "attached") throw new Error("Invalid recovery picture state.");
	return { audit_id: value.audit_id as string, picture };
}
