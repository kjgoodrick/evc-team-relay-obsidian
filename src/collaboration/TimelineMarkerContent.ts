import { parseTimelineRange, type TimelineRange } from "./TimelineRange";

export type TimelineMarkerContent = { kind: "point" | "range"; label: string; color: string; range: TimelineRange };

/** Metadata is independent of any placement. An archived placement may use an
 * older, incompatible axis; only a current placement can authorize capture. */
export function parseTimelineMarkerContent(value: unknown): TimelineMarkerContent {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid timeline marker");
	const item = value as Record<string, unknown>;
	if (Object.keys(item).length !== 4 || !Object.keys(item).every(key => ["kind", "label", "color", "range"].includes(key)) ||
		(item.kind !== "point" && item.kind !== "range") || typeof item.label !== "string" || !item.label.trim() ||
		[...item.label].length > 256 || [...item.label].some(char => char.charCodeAt(0) < 32 || char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff) ||
		typeof item.color !== "string" || !/^#[a-f0-9]{6}$/i.test(item.color)) throw new Error("Invalid timeline marker");
	const range = parseTimelineRange(item.range);
	if (item.kind === "point" && (JSON.stringify(range.start) !== JSON.stringify(range.end) || !range.start_inclusive || !range.end_inclusive)) {
		throw new Error("A point marker requires identical closed endpoints");
	}
	return { kind: item.kind, label: item.label, color: item.color.toLowerCase(), range };
}
