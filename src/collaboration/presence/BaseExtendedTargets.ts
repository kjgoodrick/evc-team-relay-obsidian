import { isRecord, parseTimelineAxis, type TimelineAxis } from "../DiscussionProtocol";
import { parseTimelineRange, type TimelineRange } from "../TimelineRange";
import { exactFields, locationId } from "./LocationProtocol";
import type { BasePresenceProperty } from "./BasePositionProtocol";

export type BasePresenceReference = Readonly<{ record_id: string; record_generation: string }>;
export type BasePresenceGroup = BasePresenceReference & Readonly<{ type: "group"; property: BasePresenceProperty;
	value_sha256: string; references: readonly BasePresenceReference[] }>;
export type BasePresenceRange = Readonly<{ type: "timeline_range"; axis: TimelineAxis; range: TimelineRange; lane: BasePresenceGroup | null }>;
const inventory = new Set(["name", "basename", "fullname", "ext", "path", "folder", "file"]);
function requireValue(value: unknown): asserts value { if (!value) throw new Error("Invalid extended Bases target"); }
function freeze<T>(value: T): T {
	if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
	return value;
}
type PropertyParser = (value: unknown) => BasePresenceProperty;
export function parsePresenceGroup(value: unknown, property: PropertyParser): BasePresenceGroup {
	requireValue(isRecord(value) && exactFields(value, ["type", "record_id", "record_generation", "property", "value_sha256", "references"]) &&
		value.type === "group" && locationId(value.record_id) && locationId(value.record_generation) && typeof value.value_sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(value.value_sha256) && Array.isArray(value.references) && value.references.length <= 8);
	const prop = property(value.property), ids = new Set([value.record_id]);
	requireValue(prop.source === "note" || prop.source === "formula" || prop.source === "file" && inventory.has(prop.name.toLowerCase()));
	const references = value.references.map(ref => {
		requireValue(isRecord(ref) && exactFields(ref, ["record_id", "record_generation"]) && locationId(ref.record_id) && locationId(ref.record_generation) && !ids.has(ref.record_id));
		ids.add(ref.record_id); return Object.freeze({ record_id: ref.record_id, record_generation: ref.record_generation });
	});
	return Object.freeze({ type: "group", record_id: value.record_id, record_generation: value.record_generation, property: prop,
		value_sha256: value.value_sha256, references: Object.freeze(references) });
}
export function parsePresenceRange(value: unknown, property: PropertyParser): BasePresenceRange {
	requireValue(isRecord(value) && exactFields(value, ["type", "axis", "range", "lane"]) && value.type === "timeline_range");
	const axis = parseTimelineAxis(value.axis), range = parseTimelineRange(value.range);
	// Presence property limits are deliberately tighter than persisted comments.
	property(axis.start_property); if (axis.end_property) property(axis.end_property);
	const sequence = axis.renderer === "sabidurian-sequence";
	requireValue(sequence === (range.kind === "ordinal") && (!sequence || axis.time_zone === null) &&
		!("time_zone" in range && axis.time_zone !== null && axis.time_zone !== range.time_zone));
	return freeze({ type: "timeline_range", axis, range, lane: value.lane === null ? null : parsePresenceGroup(value.lane, property) });
}
