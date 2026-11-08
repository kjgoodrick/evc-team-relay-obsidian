import { isId, isRecord, isSequence, parseAnchor, parseMessage, parseThread,
	type DiscussionAnchor, type DiscussionMessage, type ThreadSummary } from "./DiscussionProtocol";
import { restoreGeneration } from "./RestoreGeneration";

export const DISCUSSION_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const DISCUSSION_SNAPSHOT_MAX_RECORDS = 5000;
export interface DiscussionSnapshot {
	protocol_version: 1;
	entry_id: string;
	view_id?: string;
	through_sequence: number;
	restore_generation: string | null;
	cursor: string;
	threads: { thread: ThreadSummary; anchor: DiscussionAnchor; messages: DiscussionMessage[] }[];
}
function requireValue(value: unknown): asserts value {
	if (!value) throw new Error("Invalid discussion snapshot");
}

/** A complete bounded scope baseline, never a partial page. A caller must
 * atomically replace its old remote cache and cursor, preserving local work. */
export function parseDiscussionSnapshot(value: unknown, entryId: string, viewId?: string): DiscussionSnapshot {
	requireValue(isRecord(value) && value.protocol_version === 1 && isId(entryId) && value.entry_id === entryId
		&& value.view_id === viewId && (viewId === undefined || isId(viewId)) && isSequence(value.through_sequence)
		&& Object.prototype.hasOwnProperty.call(value, "restore_generation") && typeof value.cursor === "string"
		&& value.cursor.length > 0 && value.cursor.length <= 2048 && Array.isArray(value.threads) && value.threads.length <= DISCUSSION_SNAPSHOT_MAX_RECORDS);
	requireValue(new TextEncoder().encode(JSON.stringify(value)).byteLength <= DISCUSSION_SNAPSHOT_MAX_BYTES);
	const generation = restoreGeneration(value.restore_generation), through = value.through_sequence, ids = new Set<string>(), messageIds = new Set<string>();
	let records = value.threads.length, previous = 0;
	const threads = value.threads.map(item => {
		requireValue(isRecord(item) && Array.isArray(item.messages) && item.messages.length > 0);
		records += item.messages.length; requireValue(records <= DISCUSSION_SNAPSHOT_MAX_RECORDS);
		const thread = parseThread(item.thread), anchor = parseAnchor(item.anchor);
		requireValue(!thread.removed && thread.created_sequence > previous && thread.activity_sequence <= through && !ids.has(thread.id));
		requireValue(viewId === undefined ? anchor.type !== "base" : anchor.type === "base" && anchor.view_id === viewId);
		previous = thread.created_sequence; ids.add(thread.id);
		let messageSequence = 0;
		const messages = item.messages.map(input => {
			const message = parseMessage(input);
			requireValue(message.created_sequence > messageSequence && message.created_sequence >= thread.created_sequence
				&& message.created_sequence <= thread.activity_sequence && !messageIds.has(message.id));
			messageSequence = message.created_sequence; messageIds.add(message.id); return message;
		});
		return { thread, anchor, messages };
	});
	return { protocol_version: 1, entry_id: entryId, ...(viewId === undefined ? {} : { view_id: viewId }),
		through_sequence: through, restore_generation: generation, cursor: value.cursor, threads };
}
