import { isId, isRecord, isRevision, parseThread, type ThreadSummary } from "./DiscussionProtocol";
import { inboxCursor } from "./InboxProtocol";
import { baseDiscussionScope, parseDiscussionScope } from "./DiscussionScope";

export type DiscussionSearchRequest = Readonly<{ query: string; state: "all" | "open" | "resolved"; mine: boolean; mentions: boolean; scopeId?: string; cursor: string | null; limit: number }>;
export type DiscussionSearchItem = Readonly<{ thread: ThreadSummary; entry_id: string; kind: "note" | "image" | "base"; path: string; view_id: string | null;
	message_id: string; message_revision: number; message_sequence: number; excerpt: string }>;
export type DiscussionSearchPage = Readonly<{ items: DiscussionSearchItem[]; next_cursor: string | null }>;
function invalid(): never { throw new Error("Invalid discussion search"); }
const controls = (value: string): boolean => Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export function searchRequest(value: DiscussionSearchRequest): DiscussionSearchRequest {
	if (!isRecord(value) || Object.keys(value).some(key => !["query", "state", "mine", "mentions", "scopeId", "cursor", "limit"].includes(key)) ||
		typeof value.query !== "string" || Array.from(value.query).length > 256 || controls(value.query) ||
		Array.from(value.query).some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff) ||
		!["all", "open", "resolved"].includes(value.state) || typeof value.mine !== "boolean" || typeof value.mentions !== "boolean" ||
		value.scopeId !== undefined && !parseDiscussionScope(value.scopeId) || !inboxCursor(value.cursor) || !isRevision(value.limit) || value.limit > 50) invalid();
	return Object.freeze({ ...value, query: value.query.trim() });
}
export function searchEnvelope(value: DiscussionSearchRequest): string {
	const request = searchRequest(value), scope = request.scopeId ? parseDiscussionScope(request.scopeId)! : undefined;
	return JSON.stringify({ protocol_version: 1, query: request.query, state: request.state, mine: request.mine, mentions: request.mentions,
		cursor: request.cursor, limit: request.limit, ...(scope ? { entry_id: scope.entryId, ...(scope.viewId ? { view_id: scope.viewId } : {}) } : {}) });
}
export function parseSearchPage(value: unknown, input: DiscussionSearchRequest): DiscussionSearchPage {
	const request = searchRequest(input), scope = request.scopeId ? parseDiscussionScope(request.scopeId)! : undefined;
	if (!isRecord(value) || value.protocol_version !== 1 || !Array.isArray(value.items) || value.items.length > request.limit || !inboxCursor(value.next_cursor)) invalid();
	let previous = Infinity; const ids = new Set<string>();
	const items = value.items.map((item: unknown): DiscussionSearchItem => {
		if (!isRecord(item) || !isId(item.entry_id) || !["note", "image", "base"].includes(String(item.kind)) || !(item.view_id === null || isId(item.view_id)) ||
			(item.kind === "base") !== (item.view_id !== null) || typeof item.path !== "string" || !item.path || Array.from(item.path).length > 512 || controls(item.path) ||
			!isId(item.message_id) || !isRevision(item.message_revision) || !isRevision(item.message_sequence) || typeof item.excerpt !== "string" || Array.from(item.excerpt).length > 480) invalid();
		const thread = parseThread(item.thread);
		if (thread.removed || thread.created_sequence >= previous || ids.has(thread.id) || item.message_sequence < thread.created_sequence || item.message_sequence > thread.activity_sequence ||
			request.state !== "all" && thread.state !== request.state || scope && (item.entry_id !== scope.entryId || item.view_id !== (scope.viewId ?? null))) invalid();
		previous = thread.created_sequence; ids.add(thread.id);
		return Object.freeze({ thread: Object.freeze(thread), entry_id: item.entry_id, kind: item.kind as DiscussionSearchItem["kind"], path: item.path, view_id: item.view_id as string | null,
			message_id: item.message_id, message_revision: item.message_revision, message_sequence: item.message_sequence, excerpt: item.excerpt });
	});
	// Empty pages may carry a continuation after a bounded scan of nonmatches.
	return Object.freeze({ items, next_cursor: value.next_cursor });
}
export const searchItemScope = (item: DiscussionSearchItem): string => item.view_id === null ? item.entry_id : baseDiscussionScope(item.entry_id, item.view_id);
