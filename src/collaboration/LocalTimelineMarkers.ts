import { v5 as uuidv5 } from "uuid";
import type { NativeLocalMarker } from "../bases/TimelineLocalMarkerBridge";
import { isId } from "./DiscussionProtocol";
import { parseTimelineRange, type HistoricalPoint, type TimelineRange } from "./TimelineRange";

/** A stable, namespaced shared UUID plus the server's expected-revision zero
 * prevents duplicate promotion, including separate windows and lost receipts.
 * Neither a label nor an array index participates in identity. */
export function promotedMarkerId(definitionId: string, generation: string, localId: string): string {
	if (![definitionId, generation, localId].every(isId)) throw new Error("Local marker identity is unavailable.");
	return uuidv5("time-and-line-local-marker-v1:" + generation.toLowerCase() + ":" + localId.toLowerCase(), definitionId.toLowerCase());
}
export function localMarkerMatchKey(definitionId: string, generation: string, localId: string): string {
	return "timelineLocalMarker:" + promotedMarkerId(definitionId, generation, localId);
}
export function localMarkerColorLabel(value: string): string {
	const named = value.match(/^var\(--color-(red|orange|yellow|green|blue|purple)\)$/);
	if (named) return "theme " + named[1];
	if (value === "var(--interactive-accent)") return "theme accent";
	if (value === "var(--text-muted)") return "muted theme color";
	return value.startsWith("var(") ? "custom theme color" : value;
}
function historical(value: string): HistoricalPoint | undefined {
	const bce = value.match(/^([1-9][0-9]{0,9})\s*BC(?:E)?$/i);
	if (bce) return { precision: "year", year: 1 - Number(bce[1]) };
	if (/^-[0-9]{1,10}$/.test(value)) return { precision: "year", year: Number(value) };
	const match = value.match(/^([0-9]{1,4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?$/);
	if (!match) return;
	const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
	return match[3] ? { precision: "day", year, month, day } : match[2] ? { precision: "month", year, month } : { precision: "year", year };
}
/** Local bands end at the start of their last coordinate, as the provider draws
 * them. Preserve that exclusive bound. Uncertain syntax requires the existing
 * explicit position picker; never let Date.parse normalize invalid dates. */
export function localMarkerRange(marker: NativeLocalMarker, timeZone: string | null): TimelineRange | undefined {
	const point = !!marker.date, start = marker.date || marker.start, end = marker.date || marker.end;
	if (!start || !end) return;
	const bounds = { version: 1, start_inclusive: true, end_inclusive: point };
	try {
		if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(start) && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(end)) {
			if (!timeZone) return;
			return parseTimelineRange({ ...bounds, kind: "calendar", start, end, time_zone: timeZone });
		}
		const a = historical(start), b = historical(end);
		if (a && b) return parseTimelineRange({ ...bounds, kind: "historical", start: a, end: b, calendar: "proleptic-gregorian", year_numbering: "astronomical" });
	} catch { /* Explicit position review is required for unsupported or invalid coordinates. */ }
}
