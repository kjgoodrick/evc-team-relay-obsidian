import { isId, isRecord, isSequence } from "../DiscussionProtocol";
import { parseDiscussionScope } from "../DiscussionScope";
import { inboxCursor, inboxScope, parseInboxChange, parseInboxItem, parseInboxSubscription, type InboxChange, type InboxItem, type InboxSubscription } from "../InboxProtocol";

export const INBOX_KEY = "inbox:v1";
export const INBOX_CACHE_LIMIT = 500;
export const INBOX_QUEUE_LIMIT = 200;
export type InboxOperation = { id: string; scopeId: string; threadId: string; change: InboxChange;
	state: "queued" | "rejected"; attempted: boolean; error?: string };
export type InboxLease = { token: string; expiresAt: number };
export type InboxLocalState = { version: 1; revision: number; epoch: number; items: InboxItem[]; operations: InboxOperation[];
	subscriptions: { scopeId: string; threadId: string; value: InboxSubscription }[];
	checkedAt: number; retryAt: number; startCursor: string | null; nextCursor: string | null; lease?: InboxLease };

export function emptyInbox(): InboxLocalState { return { version: 1, revision: 0, epoch: 0, items: [], operations: [], subscriptions: [], checkedAt: 0, retryAt: 0, startCursor: null, nextCursor: null }; }
export function parseInboxLocalState(value: unknown): InboxLocalState {
	if (value === undefined) return emptyInbox();
	if (!isRecord(value) || value.version !== 1 || !isSequence(value.revision) || !isSequence(value.epoch) || !isSequence(value.checkedAt) || !isSequence(value.retryAt) ||
		!Array.isArray(value.items) || value.items.length > INBOX_CACHE_LIMIT || !Array.isArray(value.operations) ||
		value.operations.length > INBOX_QUEUE_LIMIT || !Array.isArray(value.subscriptions) || value.subscriptions.length > 500 ||
		!inboxCursor(value.startCursor ?? null) || !inboxCursor(value.nextCursor)) throw new Error("Invalid local inbox");
	const subscriptions = value.subscriptions.map(row => {
		if (!isRecord(row) || typeof row.scopeId !== "string" || !parseDiscussionScope(row.scopeId) || !isId(row.threadId)) throw new Error("Invalid subscription identity");
		return { scopeId: row.scopeId, threadId: row.threadId, value: parseInboxSubscription(row.value) };
	});
	const items = value.items.map(parseInboxItem);
	const operations: InboxOperation[] = value.operations.map(op => {
		if (!isRecord(op) || !isId(op.id) || typeof op.scopeId !== "string" || !parseDiscussionScope(op.scopeId) || !isId(op.threadId) ||
			!["queued", "rejected"].includes(String(op.state)) || typeof op.attempted !== "boolean" ||
			(op.error !== undefined && (typeof op.error !== "string" || !/^[a-z_]{1,80}$/.test(op.error)))) throw new Error("Invalid local inbox operation");
		return { id: op.id, scopeId: op.scopeId, threadId: op.threadId, change: parseInboxChange(op.change),
			state: op.state as InboxOperation["state"], attempted: op.attempted, ...(op.error ? { error: op.error as string } : {}) };
	});
	if (new Set(items.map(item => item.thread_id)).size !== items.length || new Set(operations.map(op => op.id)).size !== operations.length) throw new Error("Duplicate inbox identity");
	let lease: InboxLease | undefined;
	if (value.lease !== undefined) {
		if (!isRecord(value.lease) || !isId(value.lease.token) || !isSequence(value.lease.expiresAt)) throw new Error("Invalid inbox lease");
		lease = { token: value.lease.token, expiresAt: value.lease.expiresAt };
	}
	if (new Set(subscriptions.map(row => row.threadId)).size !== subscriptions.length) throw new Error("Duplicate subscription identity");
	return { version: 1, revision: value.revision, epoch: value.epoch, items, operations, subscriptions, checkedAt: value.checkedAt, retryAt: value.retryAt,
		startCursor: value.startCursor as string | null | undefined ?? null, nextCursor: value.nextCursor, ...(lease ? { lease } : {}) };
}

/** Remove readable references but retain identifier-only pending user choices. */
export function forgetInboxScope(state: InboxLocalState, scopeId?: string): void {
	state.items = scopeId === undefined ? [] : state.items.filter(item => inboxScope(item) !== scopeId);
	state.subscriptions = scopeId === undefined ? [] : state.subscriptions.filter(row => row.scopeId !== scopeId);
	state.epoch++; state.startCursor = null; state.nextCursor = null; state.checkedAt = 0;
}

export function overlayInbox(item: InboxItem, operations: InboxOperation[]): InboxItem {
	const result = parseInboxItem(item);
	for (const op of operations) {
		if (op.threadId !== item.thread_id || op.scopeId !== inboxScope(item) || op.state !== "queued") continue;
		const change = op.change;
		if (change.type === "subscription") result.subscription = { version: change.expected_version + 1, following: change.following, muted: change.muted };
		else if (change.seen_version <= result.version) {
			if (change.action === "unread" && change.seen_version === result.version) {
				result.read_version = Math.min(result.read_version, change.seen_version - 1);
				result.dismissed_version = Math.min(result.dismissed_version, change.seen_version - 1);
			} else if (change.action !== "unread") {
				result.read_version = Math.max(result.read_version, change.seen_version);
				if (change.action === "dismiss") result.dismissed_version = Math.max(result.dismissed_version, change.seen_version);
			}
			result.unread = result.read_version < result.version;
		}
	}
	return result;
}
