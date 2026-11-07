import { isId, isRecord, isRevision, parseAnchor, type BaseAnchor } from "./DiscussionProtocol";
import { parseBaseGroupValue, type BaseGroupValue } from "./BaseGroupValue";
import { decodeBoundedBase64 } from "./anchors/text";

export type BaseGroupCapture = { operation_id: string; definition_id: string; view_id: string; generation: string;
	registry_revision: number; group_definition_id: string; group_definition_revision: number;
	record_id: string; record_generation: string; dependency: string; time_zone: string; value: BaseGroupValue };
function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid Bases group capture"); }

/** Copy before asynchronous credential lookup; retries must send the same request. */
export function copyBaseGroupCapture(value: unknown): BaseGroupCapture {
	requireValue(isRecord(value) && Object.keys(value).length === 12 &&
		isId(value.operation_id) && isId(value.definition_id) && isId(value.view_id) && isId(value.generation) &&
		isId(value.group_definition_id) && isId(value.record_id) && isId(value.record_generation) &&
		isRevision(value.registry_revision) && isRevision(value.group_definition_revision) && value.group_definition_revision <= value.registry_revision &&
		typeof value.dependency === "string" && decodeBoundedBase64(value.dependency, 65536).length > 0 &&
		typeof value.time_zone === "string" && value.time_zone.length > 0 && value.time_zone.length <= 128 && /^[A-Za-z0-9_+/-]+$/.test(value.time_zone));
	return { operation_id: value.operation_id.toLowerCase(), definition_id: value.definition_id.toLowerCase(), view_id: value.view_id.toLowerCase(),
		generation: value.generation.toLowerCase(), registry_revision: value.registry_revision, group_definition_id: value.group_definition_id.toLowerCase(),
		group_definition_revision: value.group_definition_revision, record_id: value.record_id.toLowerCase(), record_generation: value.record_generation.toLowerCase(),
		dependency: value.dependency, time_zone: value.time_zone, value: parseBaseGroupValue(value.value) };
}

export function parseBaseGroupCaptureResult(value: unknown, entryId: string, request: BaseGroupCapture): BaseAnchor {
	requireValue(isRecord(value) && value.protocol_version === 1 && value.entry_id === entryId &&
		Object.keys(value).every(key => ["protocol_version", "entry_id", "anchor"].includes(key)));
	const anchor = parseAnchor(value.anchor);
	requireValue(anchor.type === "base" && anchor.definition_id === request.definition_id && anchor.view_id === request.view_id &&
		anchor.generation === request.generation && anchor.registry_revision >= request.registry_revision && anchor.target.type === "group" &&
		anchor.target.definition_id === request.group_definition_id && anchor.target.definition_revision === request.group_definition_revision &&
		JSON.stringify(anchor.target.value) === JSON.stringify(request.value));
	return anchor;
}
