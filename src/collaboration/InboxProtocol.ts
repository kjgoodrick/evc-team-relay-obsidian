import { isId, isRecord, isSequence } from "./DiscussionProtocol";
import { baseDiscussionScope } from "./DiscussionScope";

export type InboxSubscription = { version: number; following: boolean; muted: boolean };
export type InboxReadState = { version: number; read_version: number; dismissed_version: number; unread: boolean };
export type InboxItem = InboxReadState & {
	thread_id: string; entry_id: string; scope_id: string; kind: "note" | "image" | "base";
	path: string; view_id: string | null; message_id: string; message_revision: number;
	reason: "mention" | "reply"; last_sequence: number; activity_at: string; subscription: InboxSubscription;
};
export type InboxPage = { items: InboxItem[]; next_cursor: string | null };
export type InboxAction = "read" | "unread" | "dismiss";
export type InboxChange = { type: "state"; seen_version: number; action: InboxAction } |
	{ type: "subscription"; expected_version: number; following: boolean; muted: boolean };

function bad(): never { throw new Error("Invalid inbox protocol"); }
export function parseInboxSubscription(value: unknown): InboxSubscription {
	if (!isRecord(value) || !isSequence(value.version) || typeof value.following !== "boolean" || typeof value.muted !== "boolean") bad();
	return { version: value.version, following: value.following, muted: value.muted };
}
export function parseInboxReadState(value: unknown): InboxReadState {
	if (!isRecord(value) || !isSequence(value.version) || value.version < 1 || !isSequence(value.read_version) ||
		!isSequence(value.dismissed_version) || value.read_version > value.version || value.dismissed_version > value.version ||
		typeof value.unread !== "boolean" || value.unread !== (value.read_version < value.version)) bad();
	return { version: value.version, read_version: value.read_version, dismissed_version: value.dismissed_version, unread: value.unread };
}
export function parseInboxItem(value: unknown): InboxItem {
	if (!isRecord(value) || !isId(value.thread_id) || !isId(value.entry_id) || !isId(value.scope_id) || !isId(value.message_id) ||
		!["note", "image", "base"].includes(String(value.kind)) || !(value.view_id === null || isId(value.view_id)) ||
		(value.kind === "base") !== (value.view_id !== null) || !isSequence(value.message_revision) || value.message_revision < 1 ||
		!isSequence(value.last_sequence) || value.last_sequence < 1 || !["mention", "reply"].includes(String(value.reason)) ||
		typeof value.path !== "string" || !value.path || value.path.length > 512 || Array.from(value.path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
		typeof value.activity_at !== "string" || value.activity_at.length > 40 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|\+00:00)$/.test(value.activity_at) ||
		!Number.isFinite(Date.parse(value.activity_at))) bad();
	return { ...parseInboxReadState(value), thread_id: value.thread_id, entry_id: value.entry_id, scope_id: value.scope_id,
		kind: value.kind as InboxItem["kind"], path: value.path, view_id: value.view_id as string | null,
		message_id: value.message_id, message_revision: value.message_revision, reason: value.reason as InboxItem["reason"],
		last_sequence: value.last_sequence, activity_at: value.activity_at, subscription: parseInboxSubscription(value.subscription) };
}
export function inboxCursor(value: unknown): value is string | null {
	return value === null || typeof value === "string" && /^[A-Za-z0-9_=-]{1,2048}$/.test(value);
}
export function parseInboxPage(value: unknown): InboxPage {
	if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 100 || !inboxCursor(value.next_cursor)) bad();
	const items = value.items.map(parseInboxItem), threads = new Set<string>();
	let previous = Infinity;
	for (const item of items) {
		if (threads.has(item.thread_id) || item.last_sequence >= previous) bad();
		threads.add(item.thread_id); previous = item.last_sequence;
	}
	if (value.next_cursor !== null && !items.length) bad();
	return { items, next_cursor: value.next_cursor };
}
export function inboxScope(item: Pick<InboxItem, "entry_id" | "view_id">): string {
	return item.view_id === null ? item.entry_id : baseDiscussionScope(item.entry_id, item.view_id);
}
export function parseInboxChange(value: unknown): InboxChange {
	if (!isRecord(value)) bad();
	if (value.type === "state" && isSequence(value.seen_version) && value.seen_version > 0 && ["read", "unread", "dismiss"].includes(String(value.action))) {
		return { type: "state", seen_version: value.seen_version, action: value.action as InboxAction };
	}
	if (value.type === "subscription" && isSequence(value.expected_version) && value.expected_version < Number.MAX_SAFE_INTEGER &&
		typeof value.following === "boolean" && typeof value.muted === "boolean") return {
		type: "subscription", expected_version: value.expected_version, following: value.following, muted: value.muted,
	};
	return bad();
}
