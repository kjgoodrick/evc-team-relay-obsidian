/** Renderer-independent, view-scoped targets. This module never uses DOM positions. */
import { parseTimelineRange, timelineRangeKey, type TimelineRange } from "../TimelineRange";
export interface BaseViewIdentity { baseId: string; viewId: string }
export interface PropertyIdentity { source: "note" | "file" | "formula"; id: string }
export type GroupValue =
	| { type: "empty" }
	| { type: "text"; value: string }
	| { type: "number"; value: number }
	| { type: "boolean"; value: boolean }
	| { type: "date"; value: string };
export interface GroupIdentity { property: PropertyIdentity; value: GroupValue }
export type TimelinePoint =
	| { type: "date"; value: string }
	| { type: "instant"; value: string };

export type BaseTarget = BaseViewIdentity & (
	| { type: "base-view" }
	| { type: "base-item"; recordId: string }
	| { type: "base-cell"; recordId: string; property: PropertyIdentity }
	| { type: "base-property"; property: PropertyIdentity }
	| { type: "base-group"; group: GroupIdentity }
	| { type: "base-summary"; definitionId: string; definitionRevision: string; group?: GroupIdentity }
	| { type: "base-formula"; definitionId: string; definitionRevision: string }
	| { type: "timeline-item"; recordId: string }
	| { type: "timeline-milestone"; milestoneId: string; recordId?: string }
	| { type: "timeline-range"; start: TimelinePoint; end: TimelinePoint;
		startInclusive: boolean; endInclusive: boolean; timeZone: string; lane?: GroupIdentity }
	| { type: "timeline-range"; range: TimelineRange; axisDefinitionId: string;
		axisDefinitionRevision: number; lane?: GroupIdentity }
);

function id(value: string): string {
	if (typeof value !== "string" || !value || value.length > 512 || Array.from(value).some(c => c.charCodeAt(0) < 32)) {
		throw new Error("Invalid Bases target identity");
	}
	return value;
}

function propertyKey(property: PropertyIdentity): [string, string] {
	if (!["note", "file", "formula"].includes(property.source)) throw new Error("Invalid property source");
	return [property.source, id(property.id)];
}

function calendarDate(value: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid calendar date");
	const parsed = new Date(value + "T00:00:00.000Z");
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
		throw new Error("Invalid calendar date");
	}
	return value;
}

function groupKey(group: GroupIdentity): unknown[] {
	const value = group.value;
	let normalized: string | number | boolean | null;
	switch (value.type) {
		case "empty": normalized = null; break;
		case "number":
			if (typeof value.value !== "number" || !Number.isFinite(value.value)) throw new Error("Invalid group number");
			normalized = value.value; break;
		case "date": normalized = calendarDate(value.value); break;
		case "boolean":
			if (typeof value.value !== "boolean") throw new Error("Invalid group boolean");
			normalized = value.value; break;
		case "text":
			if (typeof value.value !== "string" || value.value.length > 2048) throw new Error("Invalid group value");
			normalized = value.value; break;
		default: throw new Error("Unsupported group value");
	}
	return [propertyKey(group.property), value.type, normalized];
}

function pointKey(point: TimelinePoint): string {
	if (point.type === "date") return calendarDate(point.value);
	if (point.type !== "instant" || typeof point.value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(point.value)) {
		throw new Error("Timeline instants require an explicit UTC offset");
	}
	calendarDate(point.value.slice(0, 10));
	const parsed = new Date(point.value);
	if (!Number.isFinite(parsed.getTime()) || Number(point.value.slice(11, 13)) > 23) throw new Error("Invalid instant");
	return parsed.toISOString();
}

/** Definition revisions are evidence, not identity: editing a formula keeps its discussion. */
export function baseTargetKey(target: BaseTarget): string {
	const scope = [1, id(target.baseId), id(target.viewId)];
	let key: unknown[];
	switch (target.type) {
		case "base-view": key = ["view"]; break;
		case "base-item":
		case "timeline-item": key = ["item", id(target.recordId)]; break;
		case "base-cell": key = ["cell", id(target.recordId), propertyKey(target.property)]; break;
		case "base-property": key = ["property", propertyKey(target.property)]; break;
		case "base-group": key = ["group", groupKey(target.group)]; break;
		case "base-summary":
			id(target.definitionRevision);
			key = ["summary", id(target.definitionId), target.group ? groupKey(target.group) : null]; break;
		case "base-formula":
			id(target.definitionRevision); key = ["formula", id(target.definitionId)]; break;
		case "timeline-milestone":
			key = ["milestone", id(target.milestoneId), target.recordId ? id(target.recordId) : null]; break;
		case "timeline-range": {
			if ("range" in target) {
				if (!Number.isSafeInteger(target.axisDefinitionRevision) || target.axisDefinitionRevision < 1) throw new Error("Invalid timeline axis revision");
				key = ["range-v1", id(target.axisDefinitionId), target.axisDefinitionRevision, timelineRangeKey(parseTimelineRange(target.range)), target.lane ? groupKey(target.lane) : null];
				break;
			}
			if (target.start.type !== target.end.type || typeof target.startInclusive !== "boolean" ||
				typeof target.endInclusive !== "boolean") throw new Error("Invalid timeline interval");
			const start = pointKey(target.start), end = pointKey(target.end);
			if (start > end || (start === end && !(target.startInclusive && target.endInclusive))) throw new Error("Empty or reversed timeline interval");
			const zone = new Intl.DateTimeFormat("en-US", { timeZone: id(target.timeZone) }).resolvedOptions().timeZone;
			key = ["range", target.start.type, start, end, target.startInclusive, target.endInclusive, zone,
				target.lane ? groupKey(target.lane) : null]; break;
		}
		default: throw new Error("Unsupported Bases target");
	}
	return JSON.stringify([...scope, ...key]);
}
