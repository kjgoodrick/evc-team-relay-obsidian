import { copyBaseGroupCapture, parseBaseGroupCaptureResult, type BaseGroupCapture } from "./BaseGroupProtocol";
import { isBaseDefinitionProperty, isId, isRecord, parseAnchor, parseBody, protocolJson,
	type BaseAnchor, type BaseDefinitionProperty, type BaseTimelineRangeTarget, type DiscussionAnchor, type MessageBody } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";
import type { QueuedCommand } from "./storage/DiscussionStore";

/** A captured selection, not server authority. Never send this as a wire anchor. */
export type PendingBaseGroupAnchor = { version: 1; type: "base_group_pending"; entry_id: string;
	property: BaseDefinitionProperty; capture: BaseGroupCapture; range?: Omit<BaseTimelineRangeTarget, "lane"> };
export type LocalDiscussionAnchor = DiscussionAnchor | PendingBaseGroupAnchor;
export type PendingBaseGroupCommand = { type: "base.group.create"; thread_id: string; message_id: string;
	body: MessageBody; anchor: PendingBaseGroupAnchor };

function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid saved group selection"); }
export function parseLocalDiscussionAnchor(value: unknown): LocalDiscussionAnchor {
	if (!isRecord(value) || value.type !== "base_group_pending") return parseAnchor(value);
	requireValue(value.version === 1 && Object.keys(value).length === ("range" in value ? 6 : 5) &&
		Object.keys(value).every(key => ["version", "type", "entry_id", "property", "capture", "range"].includes(key)) &&
		isId(value.entry_id) && isBaseDefinitionProperty(value.property));
	const capture = copyBaseGroupCapture(value.capture);
	requireValue(value.property.source === (capture.source_kind === "file" ? "file" : "note"));
	let range: PendingBaseGroupAnchor["range"];
	if ("range" in value) {
		requireValue(isRecord(value.range) && value.range.type === "timeline_range" && !("lane" in value.range));
		const location = parseAnchor({ version: 1, type: "base", definition_id: capture.definition_id, view_id: capture.view_id,
			generation: capture.generation, registry_revision: capture.registry_revision, target: value.range });
		requireValue(location.type === "base" && location.target.type === "timeline_range"); range = location.target;
	}
	return { version: 1, type: "base_group_pending", entry_id: value.entry_id.toLowerCase(),
		property: { source: value.property.source, name: value.property.name }, capture, ...(range ? { range } : {}) };
}

/** Axis-only local location for validation/navigation. It is never a substitute
 * for the required lane proof and must not be sent as a thread target. */
export function pendingRangeLocation(anchor: PendingBaseGroupAnchor): BaseAnchor | undefined {
	if (!anchor.range) return;
	return { version: 1, type: "base", definition_id: anchor.capture.definition_id, view_id: anchor.capture.view_id,
		generation: anchor.capture.generation, registry_revision: anchor.capture.registry_revision, target: anchor.range };
}

/** Validate scope and immutable evidence before persisting or resuming a send. */
export function parsePendingBaseGroupCommand(operation: QueuedCommand): PendingBaseGroupCommand {
	const scope = parseDiscussionScope(operation.scopeId), value = operation.payload;
	requireValue(isId(operation.operationId) && operation.type === "base.group.create" && isRecord(value) &&
		value.type === "base.group.create" && Object.keys(value).length === 5 && isId(value.thread_id) && isId(value.message_id));
	const anchor = parseLocalDiscussionAnchor(value.anchor);
	requireValue(anchor.type === "base_group_pending" && scope?.entryId === anchor.entry_id && scope.viewId === anchor.capture.view_id &&
		operation.operationId.toLowerCase() !== anchor.capture.operation_id);
	const body = parseBody(value.body);
	const result: PendingBaseGroupCommand = { type: "base.group.create", thread_id: value.thread_id, message_id: value.message_id, body, anchor };
	requireValue(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 256 * 1024);
	return result;
}

/** Bind the proof to the original selection; a receipt cannot retarget a draft. */
export function prepareBaseGroupCommand(operation: QueuedCommand, value: unknown): QueuedCommand {
	const pending = parsePendingBaseGroupCommand(operation);
	let anchor = parseBaseGroupCaptureResult({ protocol_version: 1, entry_id: pending.anchor.entry_id, anchor: value },
		pending.anchor.entry_id, pending.anchor.capture) as BaseAnchor;
	requireValue(anchor.target.type === "group" && anchor.target.property.source === pending.anchor.property.source &&
		anchor.target.property.name === pending.anchor.property.name);
	if (pending.anchor.range) {
		// The range is immutable user intent; only the verified lane is supplied
		// by capture. An axis change must be rejected by the server, never rebased.
		anchor = parseAnchor({ ...anchor, target: { ...pending.anchor.range, lane: anchor.target } }) as BaseAnchor;
	}
	return { operationId: operation.operationId, scopeId: operation.scopeId, type: "thread.create", dependsOn: [...operation.dependsOn],
		payload: protocolJson({ type: "thread.create", thread_id: pending.thread_id, message_id: pending.message_id, body: pending.body, anchor }) };
}
