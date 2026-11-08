/** Pure serialization shared by delivery and read-only recovery review. */
import { isId as validId, isRecord as object, parseAnchor, sourceAnchor } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";
import { DiscussionFailure } from "./DiscussionFailure";
import type { QueuedCommand } from "./storage/DiscussionStore";

/** Local scope keys retain managed file identity and, for Bases, saved-view identity. */
export function queuedEnvelope(shareId: string, op: QueuedCommand): string {
	const payload = op.payload;
	const scope = parseDiscussionScope(op.scopeId);
	if (!validId(shareId) || !validId(op.operationId) || !scope || !object(payload) ||
		payload.type !== op.type || !validId(payload.thread_id) || !validId(payload.message_id) ||
		!["thread.create", "reply.create", "message.edit", "reaction.set"].includes(op.type)) {
		throw new DiscussionFailure("reject", "invalid_local_command");
	}
	if (op.type === "reply.create" && (payload.reopen !== undefined && payload.reopen !== false ||
		payload.expected_state_revision != null)) throw new DiscussionFailure("reject", "online_command_required");
	let body: string;
	try {
		body = JSON.stringify({ protocol_version: 1, operation_id: op.operationId, share_id: shareId,
			entry_id: scope.entryId, command: payload });
	} catch { throw new DiscussionFailure("reject", "invalid_local_command"); }
	let limit = 65536;
	if (op.type === "thread.create" && object(payload.anchor) && payload.anchor.type === "base") {
		try { const anchor = parseAnchor(payload.anchor);
			if (scope.viewId !== undefined && (anchor.type !== "base" || anchor.view_id !== scope.viewId)) throw new Error("Wrong saved view");
			if (anchor.type === "base" && (anchor.target.type === "group" || anchor.target.type === "group_summary" || anchor.target.type === "timeline_range" && anchor.target.lane)) limit = 256 * 1024;
		} catch { throw new DiscussionFailure("reject", "invalid_local_anchor"); }
	}
	if (op.type === "thread.create" && scope.viewId !== undefined && (!object(payload.anchor) || payload.anchor.type !== "base")) throw new DiscussionFailure("reject", "invalid_local_anchor");
	if (op.type === "thread.create" && object(payload.anchor) && payload.anchor.type === "image_file") {
		try {
			const anchor = parseAnchor(payload.anchor);
			if (anchor.type !== "image_file" || anchor.asset.entry_id !== op.scopeId) throw new Error("Wrong image file");
		} catch { throw new DiscussionFailure("reject", "invalid_local_anchor"); }
	}
	if (op.type === "thread.create" && object(payload.anchor) && ["text", "image"].includes(String(payload.anchor.type))) {
		try {
			const anchor = sourceAnchor(parseAnchor(payload.anchor));
			if (!anchor || anchor.document_id !== op.scopeId) throw new Error("Wrong document");
		} catch { throw new DiscussionFailure("reject", "invalid_local_anchor"); }
		limit = 256 * 1024;
	}
	if (new TextEncoder().encode(body).byteLength > limit) throw new DiscussionFailure("reject", "command_too_large");
	return body;
}

