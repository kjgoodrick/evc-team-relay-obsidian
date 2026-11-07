import { isId, isRecord, isRevision, isSequence, parseAnchor, parseBaseTargetContext, parseTimelineAxis,
	type BaseAnchor, type BaseTargetContext, type BaseTimelineMarkerTarget, type TimelineAxis } from "./DiscussionProtocol";
import { parseTimelineMarkerContent, type TimelineMarkerContent } from "./TimelineMarkerContent";

export type TimelineMarkerPlacement = { view_id: string; active: boolean; axis_definition_id: string;
	axis_definition_revision: number; axis: TimelineAxis };
export type TimelineViewMarker = { id: string; revision: number; active: boolean; content: TimelineMarkerContent;
	placement: TimelineMarkerPlacement; target: BaseTimelineMarkerTarget };
export type TimelineMarkerCatalog = BaseTargetContext & { catalog_revision: number; markers: TimelineViewMarker[] };
export type TimelineMarkerPage = TimelineMarkerCatalog & { has_more: boolean; next_after: string | null };

function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid timeline marker catalog"); }
function fields(value: Record<string, unknown>, keys: string[]): void {
	requireValue(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)));
}
function placement(value: unknown, viewId: string, revision: number): TimelineMarkerPlacement {
	requireValue(isRecord(value) && value.view_id === viewId && typeof value.active === "boolean" &&
		isId(value.axis_definition_id) && isRevision(value.axis_definition_revision) && value.axis_definition_revision <= revision);
	fields(value, ["view_id", "active", "axis_definition_id", "axis_definition_revision", "axis"]);
	return { view_id: viewId, active: value.active, axis_definition_id: value.axis_definition_id,
		axis_definition_revision: value.axis_definition_revision, axis: parseTimelineAxis(value.axis) };
}
export function timelineMarkerAnchor(catalog: TimelineMarkerCatalog, marker: TimelineViewMarker): BaseAnchor {
	return parseAnchor({ version: 1, type: "base", definition_id: catalog.definition_id, generation: catalog.generation,
		view_id: catalog.view_id, registry_revision: catalog.registry_revision, target: marker.target }) as BaseAnchor;
}
export function parseTimelineMarkerCatalog(value: unknown, entryId: string, viewId: string): TimelineMarkerCatalog {
	requireValue(isRecord(value) && isId(entryId) && isId(viewId) && (value.view_id === undefined || value.view_id === viewId));
	const context = parseBaseTargetContext({ ...value, view_id: viewId }, entryId, viewId);
	requireValue(isSequence(value.catalog_revision) && Array.isArray(value.markers) && value.markers.length <= 256 &&
		Object.keys(value).every(key => ["protocol_version", "entry_id", "definition_id", "view_id", "generation", "registry_revision",
			"catalog_revision", "markers", "has_more", "next_after"].includes(key)));
	const catalog: TimelineMarkerCatalog = { ...context, catalog_revision: value.catalog_revision, markers: [] }, ids = new Set<string>();
	for (const item of value.markers) {
		requireValue(isRecord(item) && isId(item.id) && !ids.has(item.id.toLowerCase()) && isRevision(item.revision) &&
			item.revision <= catalog.catalog_revision && typeof item.active === "boolean");
		fields(item, ["id", "revision", "active", "content", "placement", "target"]); ids.add(item.id.toLowerCase());
		const content = parseTimelineMarkerContent(item.content), bound = placement(item.placement, viewId, context.registry_revision);
		const target = item.target;
		requireValue(isRecord(target));
		fields(target, ["type", "marker_id", "marker_revision", "axis_definition_id", "axis_definition_revision", "axis", "content"]);
		requireValue(target.type === "timeline_marker" && target.marker_id === item.id && target.marker_revision === item.revision &&
			target.axis_definition_id === bound.axis_definition_id && target.axis_definition_revision === bound.axis_definition_revision &&
			JSON.stringify(parseTimelineAxis(target.axis)) === JSON.stringify(bound.axis) &&
			JSON.stringify(parseTimelineMarkerContent(target.content)) === JSON.stringify(content));
		const marker: TimelineViewMarker = { id: item.id, revision: item.revision, active: item.active, content, placement: bound,
			target: { type: "timeline_marker", marker_id: item.id, marker_revision: item.revision, axis_definition_id: bound.axis_definition_id,
				axis_definition_revision: bound.axis_definition_revision, axis: bound.axis, content } };
		// An inactive placement can describe an older axis than the marker's new
		// content. Retain that metadata without turning it into a usable anchor.
		if (marker.active && bound.active) timelineMarkerAnchor(catalog, marker);
		catalog.markers.push(marker);
	}
	return catalog;
}
export function parseTimelineMarkerPage(value: unknown, entryId: string, viewId: string, after?: string): TimelineMarkerPage {
	const catalog = parseTimelineMarkerCatalog(value, entryId, viewId);
	requireValue(isRecord(value) && typeof value.has_more === "boolean" && catalog.markers.length <= 50 &&
		(!value.has_more || catalog.markers.length > 0) && value.next_after === (catalog.markers.at(-1)?.id ?? after ?? null));
	let previous = after?.toLowerCase();
	for (const item of catalog.markers) { requireValue(!previous || item.id.toLowerCase() > previous); previous = item.id.toLowerCase(); }
	return { ...catalog, has_more: value.has_more, next_after: value.next_after as string | null };
}
