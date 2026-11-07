import type { NativeBaseGroupTarget } from "../bases/NativeBasesSurface";
import type { BaseCommentContext } from "./BaseCommentContext";
import type { AnchoredThread } from "./DiscussionSession";
import type { TimelineAxisContext } from "./TimelineRangeProtocol";
import { timelineRangeKey, timelineRangeLabel } from "./TimelineRange";
import { nativeGroupTargetKey } from "./NativeBaseGroupComments";
import { rangeLaneHandle, timelineTargetMatchesAxis, timelineTargetMatchesProof, timelineAxisMatches } from "./NativeTimelineRanges";
import type { BaseAnchor } from "./DiscussionProtocol";
import type { TimelineMarkerCatalog, TimelineViewMarker } from "./TimelineMarkerProtocol";

/** Current shared definitions remain visible without discussions. Nearby labels
 * may share a chooser; their UUIDs, revisions and exact positions stay distinct.
 * Projection only consumes an already verified catalog and live bridge geometry. */
export function renderTimelineSharedMarkers(options: {
	context: BaseCommentContext; catalog?: TimelineMarkerCatalog; proof?: TimelineAxisContext;
	root: DOMRect; viewport: DOMRect; marks: HTMLElement; limit: number; current(): boolean;
	open(markers: TimelineViewMarker[], button: HTMLButtonElement, current: () => boolean): void;
}): number {
	const { context, catalog, proof, root, viewport, marks } = options;
	if (!catalog || !proof || !options.current() || options.limit <= 0) return 0;
	const native = context.surface.rangeContext();
	if (!native || !timelineAxisMatches(context, proof, native) ||
		catalog.definition_id !== proof.definition_id || catalog.generation !== proof.generation || catalog.view_id !== proof.view_id || catalog.registry_revision !== proof.registry_revision) return 0;
	const leftEdge = Math.max(viewport.left, root.left), rightEdge = Math.min(viewport.right, root.right), topEdge = Math.max(viewport.top, root.top), bottomEdge = Math.min(viewport.bottom, root.bottom);
	const width = Math.min(160, rightEdge - leftEdge), height = marks.ownerDocument.body.classList.contains("is-mobile") ? 44 : 28;
	// Leave the native horizontal scrollbar reachable below the label rows.
	const labelBottom = bottomEdge - 16;
	if (width < 24 || labelBottom - topEdge < height) return 0;
	const rows = Math.min(4, Math.floor((labelBottom - topEdge) / height));
	type Item = { marker: TimelineViewMarker; anchor: BaseAnchor; geometry: NonNullable<ReturnType<BaseCommentContext["surface"]["rangeGeometry"]>>; left: number; right: number; top: number; bottom: number; x: number };
	const items: Item[] = [];
	for (const marker of catalog.markers) {
		if (!marker.active || !marker.placement.active) continue;
		const anchor: BaseAnchor = { version: 1, type: "base", definition_id: catalog.definition_id, generation: catalog.generation, view_id: catalog.view_id, registry_revision: catalog.registry_revision, target: marker.target };
		if (!timelineTargetMatchesProof(anchor, proof)) continue;
		const geometry = context.surface.rangeGeometry(marker.content.range, marker.target.axis); if (!geometry?.current()) continue;
		const left = Math.max(Math.min(geometry.startX, geometry.endX), leftEdge), right = Math.min(Math.max(geometry.startX, geometry.endX), rightEdge);
		const top = Math.max(geometry.top, topEdge), bottom = Math.min(geometry.bottom, bottomEdge);
		if (right < left || left >= rightEdge || bottom <= top) continue;
		items.push({ marker, anchor, geometry, left, right, top, bottom, x: Math.max(leftEdge, Math.min((left + right - width) / 2, rightEdge - width)) });
	}
	items.sort((a, b) => a.x - b.x || a.marker.id.localeCompare(b.marker.id));
	const groups: { items: Item[]; x: number; row: number }[] = [], ends = Array<number>(rows).fill(-Infinity);
	for (const item of items) {
		const row = ends.findIndex(end => end + 4 <= item.x);
		if (row >= 0 && groups.length < options.limit) { groups.push({ items: [item], x: item.x, row }); ends[row] = item.x + width; }
		else {
			// A crowded viewport retains every visible marker in a nearby chooser.
			const nearest = groups.reduce((best, group) => Math.abs(group.x - item.x) < Math.abs(best.x - item.x) ? group : best, groups[0]);
			if (nearest) nearest.items.push(item);
		}
		const span = marks.ownerDocument.createElement("div"); span.className = "relay-timeline-shared-marker-band"; span.setAttribute("aria-hidden", "true");
		span.style.setProperty("--relay-marker-color", item.marker.content.color); span.classList.toggle("is-discontinuous", item.geometry.discontinuous);
		span.dataset.startInclusive = String(item.marker.content.range.start_inclusive); span.dataset.endInclusive = String(item.marker.content.range.end_inclusive);
		span.dataset.leftClipped = String(Math.min(item.geometry.startX, item.geometry.endX) < item.left); span.dataset.rightClipped = String(Math.max(item.geometry.startX, item.geometry.endX) > item.right);
		span.style.left = item.left - root.left + "px"; span.style.top = item.top - root.top + "px"; span.style.width = Math.max(2, item.right - item.left) + "px"; span.style.height = item.bottom - item.top + "px"; marks.append(span);
	}
	for (const group of groups) {
		const selected = group.items.map(item => item.marker), button = marks.ownerDocument.createElement("button"); button.type = "button"; button.className = "relay-timeline-shared-marker-button";
		button.dataset.baseMarker = JSON.stringify(["shared-markers", selected.map(marker => [marker.id, marker.revision])]);
		button.textContent = selected.length === 1 ? selected[0].content.label : selected.length + " nearby markers";
		const description = selected.length === 1 ? "Shared marker: " + selected[0].content.label + " · " + timelineRangeLabel(selected[0].content.range) : selected.length + " shared markers nearby. Choose a marker to inspect its exact position.";
		button.setAttribute("aria-label", description); button.title = description; button.style.setProperty("--relay-marker-color", selected.length === 1 ? selected[0].content.color : "var(--interactive-accent)");
		button.style.left = group.x - root.left + "px"; button.style.top = labelBottom - root.top - height * (group.row + 1) + "px"; button.style.width = width + "px"; button.style.height = height + "px";
		const current = () => options.current() && context.current() && group.items.every(item => item.geometry.current() && timelineTargetMatchesAxis(context, item.anchor, proof));
		button.onclick = event => { event.stopPropagation(); if (current()) options.open(selected, button, current); }; marks.append(button);
	}
	return groups.length;
}

/** Synchronous projection from already authorized cached data. Scroll causes no
 * network, vault reads, axis verification, or source-note loading. */
export function renderTimelineDiscussionMarkers(options: {
	context: BaseCommentContext; threads: AnchoredThread[]; proof?: TimelineAxisContext;
	lanes: Map<string, NativeBaseGroupTarget>; root: DOMRect; viewport: DOMRect; marks: HTMLElement; limit: number;
	open(threads: AnchoredThread[], button: HTMLButtonElement, current: () => boolean): void;
}): number {
	const { context, proof, root, viewport, marks } = options; if (!proof || options.limit <= 0) return 0;
	const native = context.surface.rangeContext(); if (!native || !timelineAxisMatches(context, proof, native)) return 0;
	const grouped = new Map<string, AnchoredThread[]>();
	for (const thread of options.threads) {
		const anchor = thread.anchor; if (anchor?.type !== "base" || (anchor.target.type !== "timeline_range" && anchor.target.type !== "timeline_marker") || !timelineTargetMatchesProof(anchor, proof)) continue;
		const target = anchor.target, lane = target.type === "timeline_range" ? options.lanes.get(thread.id) : undefined;
		if (target.type === "timeline_range" && target.lane && !lane) continue;
		const key = target.type === "timeline_marker" ? JSON.stringify(["marker", target]) :
			JSON.stringify(["range", target.axis_definition_id, target.axis_definition_revision, timelineRangeKey(target.range), lane ? nativeGroupTargetKey(lane) : null]);
		const threads = grouped.get(key) ?? []; threads.push(thread); grouped.set(key, threads);
	}
	let count = 0;
	for (const [key, threads] of grouped) {
		const anchor = threads[0].anchor!; if (anchor.type !== "base" || (anchor.target.type !== "timeline_range" && anchor.target.type !== "timeline_marker")) continue;
		const target = anchor.target, range = target.type === "timeline_marker" ? target.content.range : target.range;
		const lane = target.type === "timeline_range" ? options.lanes.get(threads[0].id) : undefined, handle = lane ? rangeLaneHandle(context, lane) : undefined;
		if (lane && !handle) continue;
		const geometry = context.surface.rangeGeometry(range, target.axis, handle?.element);
		if (!geometry?.current()) continue;
		const left = Math.max(Math.min(geometry.startX, geometry.endX), viewport.left, root.left), right = Math.min(Math.max(geometry.startX, geometry.endX), viewport.right, root.right);
		const top = Math.max(geometry.top, viewport.top, root.top), bottom = Math.min(geometry.bottom, viewport.bottom, root.bottom);
		if (right < left || bottom <= top || left >= Math.min(root.right, viewport.right)) continue;
		if (count >= options.limit) break; count++;
		const span = marks.ownerDocument.createElement("div"); span.className = "relay-timeline-range-mark";
		span.setAttribute("aria-hidden", "true"); span.dataset.startInclusive = String(range.start_inclusive); span.dataset.endInclusive = String(range.end_inclusive);
		if (target.type === "timeline_marker") { span.classList.add("relay-timeline-captured-marker"); span.style.setProperty("--relay-marker-color", target.content.color); }
		span.dataset.leftClipped = String(Math.min(geometry.startX, geometry.endX) < left);
		span.dataset.rightClipped = String(Math.max(geometry.startX, geometry.endX) > right);
		span.classList.toggle("is-discontinuous", geometry.discontinuous);
		span.style.left = left - root.left + "px"; span.style.top = top - root.top + "px"; span.style.width = Math.max(2, right - left) + "px"; span.style.height = bottom - top + "px"; marks.append(span);
		const button = marks.ownerDocument.createElement("button"); button.type = "button"; button.className = "relay-base-comment-marker relay-timeline-range-marker";
		button.textContent = String(threads.length); button.dataset.baseMarker = key;
		const description = `${threads.length} discussion(s) · ${target.type === "timeline_marker" ? "Captured marker: " + target.content.label + " · " : ""}${timelineRangeLabel(range)} · start ${range.start_inclusive ? "included" : "excluded"}, end ${range.end_inclusive ? "included" : "excluded"}${lane ? " · lane " + lane.property.name : ""}${geometry.discontinuous ? " · daylight-saving time changes the displayed interval" : ""}`;
		button.setAttribute("aria-label", description); button.title = description;
		button.style.left = Math.max(0, Math.min((left + right) / 2 - 12, viewport.right - 24, root.right - 24) - root.left) + "px";
		button.style.top = Math.max(0, top - root.top) + "px";
		const current = () => context.current() && timelineTargetMatchesAxis(context, anchor, proof) && geometry.current() && (!handle || handle.current());
		button.onclick = event => { event.stopPropagation(); if (current()) options.open(threads, button, current); };
		marks.append(button);
	}
	return count;
}
