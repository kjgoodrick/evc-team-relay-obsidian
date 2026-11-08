import { isId, isRecord, isRevision, isSequence, parseAnchor, parseTimelineAxis, type TimelineAxis } from "./DiscussionProtocol";
import { parseTimelineMarkerContent, type TimelineMarkerContent } from "./TimelineMarkerContent";
import type { TimelineMarkerPlacement } from "./TimelineMarkerProtocol";

export type TimelineMarkerPut = { type: "marker.put"; marker_id: string; expected_marker_revision: number; content: TimelineMarkerContent;
	placements: { view_id: string; axis_definition_id: string; axis_definition_revision: number }[] };
export type TimelineMarkerArchive = { type: "marker.archive"; marker_id: string; expected_marker_revision: number };
export type TimelineMarkerCommand = { operation_id: string; definition_id: string; generation: string; registry_revision: number;
	expected_catalog_revision: number; command: TimelineMarkerPut | TimelineMarkerArchive };
export type TimelineMarkerDetail = { protocol_version: 1; entry_id: string; definition_id: string; generation: string; registry_revision: number;
	catalog_revision: number; marker: { id: string; revision: number; active: boolean; content: TimelineMarkerContent; placements: TimelineMarkerPlacement[] } };
export type TimelineMarkerReceipt = TimelineMarkerDetail & { operation_id: string };
export type TimelineMarkerCommandStatus = { status: "unknown" } | { status: "accepted"; result: TimelineMarkerReceipt };
/** Base-wide list omits placements; fetch one selected marker's full details. */
export type TimelineMarkerInventory = Omit<TimelineMarkerDetail, "marker"> & {
	markers: Omit<TimelineMarkerDetail["marker"], "placements">[];
};
export type TimelineMarkerInventoryPage = TimelineMarkerInventory & { has_more: boolean; next_after: string | null };

function check(value: unknown): asserts value { if (!value) throw new Error("Invalid marker management data"); }
function fields(value: Record<string, unknown>, keys: string[]): void { check(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))); }
function id(value: unknown): string { check(isId(value)); return value.toLowerCase(); }
function nextRevision(value: unknown): value is number { return isSequence(value) && value < Number.MAX_SAFE_INTEGER; }

export function parseTimelineMarkerCommandStatus(value: unknown, entryId: string, request: TimelineMarkerCommand): TimelineMarkerCommandStatus {
	check(isRecord(value));
	if (value.status === "accepted") {
		fields(value, ["status", "result"]);
		return { status: "accepted", result: parseTimelineMarkerReceipt(value.result, entryId, request) };
	}
	fields(value, ["status", "operation_id", "entry_id"]);
	check(value.status === "unknown" && value.operation_id === request.operation_id && value.entry_id === entryId);
	return { status: "unknown" };
}

export function parseTimelineMarkerInventoryPage(value: unknown, entryId: string, after?: string): TimelineMarkerInventoryPage {
	check(isRecord(value)); fields(value, ["protocol_version", "entry_id", "definition_id", "generation", "registry_revision", "catalog_revision", "markers", "has_more", "next_after"]);
	check(value.protocol_version === 1 && isId(entryId) && value.entry_id === entryId && isRevision(value.registry_revision) && isSequence(value.catalog_revision) &&
		Array.isArray(value.markers) && value.markers.length <= 50 && typeof value.has_more === "boolean" && (!after || isId(after)));
	const catalogRevision = value.catalog_revision;
	let previous = after?.toLowerCase();
	const markers = value.markers.map(item => {
		check(isRecord(item)); fields(item, ["id", "revision", "active", "content"]);
		const markerId = id(item.id); check((!previous || markerId > previous) && isRevision(item.revision) && item.revision <= catalogRevision && typeof item.active === "boolean");
		previous = markerId;
		return { id: markerId, revision: item.revision, active: item.active, content: parseTimelineMarkerContent(item.content) };
	});
	check((!value.has_more || markers.length > 0) && value.next_after === (previous ?? null));
	return { protocol_version: 1, entry_id: entryId, definition_id: id(value.definition_id), generation: id(value.generation), registry_revision: value.registry_revision,
		catalog_revision: catalogRevision, markers, has_more: value.has_more, next_after: previous ?? null };
}

export function parseTimelineMarkerCommand(value: unknown): TimelineMarkerCommand {
	check(isRecord(value)); fields(value, ["operation_id", "definition_id", "generation", "registry_revision", "expected_catalog_revision", "command"]);
	check(isRevision(value.registry_revision) && nextRevision(value.expected_catalog_revision));
	const registryRevision = value.registry_revision;
	const item = value.command; check(isRecord(item) && nextRevision(item.expected_marker_revision));
	let command: TimelineMarkerCommand["command"];
	if (item.type === "marker.archive") {
		fields(item, ["type", "marker_id", "expected_marker_revision"]); check(item.expected_marker_revision > 0);
		command = { type: "marker.archive", marker_id: id(item.marker_id), expected_marker_revision: item.expected_marker_revision };
	} else {
		check(item.type === "marker.put"); fields(item, ["type", "marker_id", "expected_marker_revision", "content", "placements"]);
		check(Array.isArray(item.placements) && item.placements.length > 0 && item.placements.length <= 64);
		const views = new Set<string>();
		const placements = item.placements.map(placement => {
			check(isRecord(placement)); fields(placement, ["view_id", "axis_definition_id", "axis_definition_revision"]);
			const view_id = id(placement.view_id); check(!views.has(view_id) && isRevision(placement.axis_definition_revision) && placement.axis_definition_revision <= registryRevision);
			views.add(view_id); return { view_id, axis_definition_id: id(placement.axis_definition_id), axis_definition_revision: placement.axis_definition_revision };
		});
		command = { type: "marker.put", marker_id: id(item.marker_id), expected_marker_revision: item.expected_marker_revision, content: parseTimelineMarkerContent(item.content), placements };
	}
	return { operation_id: id(value.operation_id), definition_id: id(value.definition_id), generation: id(value.generation), registry_revision: value.registry_revision,
		expected_catalog_revision: value.expected_catalog_revision, command };
}

export function parseTimelineMarkerDetail(value: unknown, entryId: string, markerId: string): TimelineMarkerDetail {
	check(isRecord(value) && value.protocol_version === 1 && value.entry_id === entryId && isId(entryId) && isRevision(value.registry_revision) && isSequence(value.catalog_revision));
	check(Object.keys(value).every(key => ["protocol_version", "entry_id", "definition_id", "generation", "registry_revision", "catalog_revision", "marker", "operation_id"].includes(key)));
	const registryRevision = value.registry_revision;
	const definition_id = id(value.definition_id), generation = id(value.generation), item = value.marker;
	check(isRecord(item) && item.id === markerId && isId(markerId) && isRevision(item.revision) && item.revision <= value.catalog_revision && typeof item.active === "boolean");
	fields(item, ["id", "revision", "active", "content", "placements"]);
	const content = parseTimelineMarkerContent(item.content); check(Array.isArray(item.placements) && item.placements.length > 0 && item.placements.length <= 256);
	const views = new Set<string>();
	const placements = item.placements.map(placement => {
		check(isRecord(placement)); fields(placement, ["view_id", "active", "axis_definition_id", "axis_definition_revision", "axis"]);
		const view_id = id(placement.view_id); check(!views.has(view_id) && typeof placement.active === "boolean" && isRevision(placement.axis_definition_revision) && placement.axis_definition_revision <= registryRevision);
		views.add(view_id); const axis: TimelineAxis = parseTimelineAxis(placement.axis), axis_definition_id = id(placement.axis_definition_id);
		check(item.active || !placement.active);
		if (placement.active) parseAnchor({ version: 1, type: "base", definition_id, generation, view_id, registry_revision: value.registry_revision,
			target: { type: "timeline_marker", marker_id: markerId, marker_revision: item.revision, axis_definition_id, axis_definition_revision: placement.axis_definition_revision, axis, content } });
		return { view_id, active: placement.active, axis_definition_id, axis_definition_revision: placement.axis_definition_revision, axis };
	});
	check(!item.active || placements.some(placement => placement.active));
	return { protocol_version: 1, entry_id: entryId, definition_id, generation, registry_revision: value.registry_revision,
		catalog_revision: value.catalog_revision, marker: { id: markerId, revision: item.revision, active: item.active, content, placements } };
}

export function parseTimelineMarkerReceipt(value: unknown, entryId: string, request: TimelineMarkerCommand): TimelineMarkerReceipt {
	const command = parseTimelineMarkerCommand(request), result = parseTimelineMarkerDetail(value, entryId, command.command.marker_id);
	check(isRecord(value) && value.operation_id === command.operation_id && result.definition_id === command.definition_id && result.generation === command.generation &&
		result.registry_revision === command.registry_revision && result.catalog_revision === command.expected_catalog_revision + 1 && result.marker.revision === command.command.expected_marker_revision + 1);
	if (command.command.type === "marker.archive") check(!result.marker.active && result.marker.placements.every(placement => !placement.active));
	else {
		check(result.marker.active && JSON.stringify(result.marker.content) === JSON.stringify(command.command.content));
		const active = result.marker.placements.filter(placement => placement.active); check(active.length === command.command.placements.length);
		for (const placement of command.command.placements) check(active.some(item => item.view_id === placement.view_id && item.axis_definition_id === placement.axis_definition_id && item.axis_definition_revision === placement.axis_definition_revision));
	}
	return { ...result, operation_id: command.operation_id };
}
