import type { NativeBaseGroupTarget } from "../bases/NativeBasesSurface";
import type { BaseCommentContext } from "./BaseCommentContext";
import type { AnchoredThread } from "./DiscussionSession";
import type { TimelineAxisContext } from "./TimelineRangeProtocol";
import { timelineRangeKey, timelineRangeLabel } from "./TimelineRange";
import { nativeGroupTargetKey } from "./NativeBaseGroupComments";
import { rangeLaneHandle, timelineTargetMatchesAxis, timelineTargetMatchesProof, timelineAxisMatches } from "./NativeTimelineRanges";

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
