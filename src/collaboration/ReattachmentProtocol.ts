import { isId, isRecord, isRevision, isSequence, parseAnchor, parseThread, sourceAnchor, type DiscussionAnchor, type ThreadSummary } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";
import type { OnlineOperation } from "./DiscussionTransport";

export type AnchorRevision = { revision: number; actor_id: string | null; created_at: string; anchor: DiscussionAnchor | null; unavailable: boolean };
export type AnchorHistoryPage = { thread: ThreadSummary; revisions: AnchorRevision[]; has_more: boolean; next_after: number };

export function scopedReattachmentAnchor(value: unknown, scopeId: string): DiscussionAnchor {
	const scope = parseDiscussionScope(scopeId), anchor = parseAnchor(value), source = sourceAnchor(anchor);
	if (!scope || (anchor.type === "base") !== (scope.viewId !== undefined) ||
		anchor.type === "base" && anchor.view_id !== scope.viewId ||
		source && source.document_id !== scope.entryId ||
		anchor.type === "image_file" && anchor.asset.entry_id !== scope.entryId) throw new Error("Invalid target scope");
	return anchor;
}

/** Checks the immutable online command without silently rewriting its receipt identity. */
export function reattachmentAnchor(operation: OnlineOperation): DiscussionAnchor {
	const command = operation.payload;
	if (!isId(operation.operationId) || !isRecord(command) || command.type !== "thread.reattach" ||
		!isId(command.thread_id) || !isRevision(command.expected_anchor_revision) ||
		Object.keys(command).some(key => !["type", "thread_id", "expected_anchor_revision", "anchor"].includes(key))) throw new Error("Invalid reattachment command");
	return scopedReattachmentAnchor(command.anchor, operation.scopeId);
}

export function parseAnchorHistory(value: unknown, scopeId: string, threadId: string, after: number, limit: number): AnchorHistoryPage {
	const scope = parseDiscussionScope(scopeId);
	if (!scope || !isRecord(value) || value.entry_id !== scope.entryId || value.view_id !== scope.viewId ||
		!Array.isArray(value.revisions) || value.revisions.length > limit || typeof value.has_more !== "boolean" ||
		!isSequence(value.next_after)) throw new Error("Invalid target history");
	const thread = parseThread(value.thread);
	if (thread.id !== threadId || thread.removed) throw new Error("Invalid target history thread");
	let previous = after;
	const revisions = value.revisions.map((row): AnchorRevision => {
		if (!isRecord(row) || !isRevision(row.revision) || row.revision <= previous || row.revision > thread.anchor_revision ||
			row.actor_id !== null && !isId(row.actor_id) || typeof row.created_at !== "string" || row.created_at.length > 64 ||
			!Number.isFinite(Date.parse(row.created_at)) || typeof row.unavailable !== "boolean" ||
			row.unavailable !== (row.anchor === null)) throw new Error("Invalid target revision");
		previous = row.revision;
		return { revision: row.revision, actor_id: row.actor_id as string | null, created_at: row.created_at, unavailable: row.unavailable,
			anchor: row.anchor === null ? null : scopedReattachmentAnchor(row.anchor, scopeId) };
	});
	if (value.next_after !== previous || value.has_more && !revisions.length) throw new Error("Invalid target history page");
	return { thread, revisions, has_more: value.has_more, next_after: value.next_after };
}
