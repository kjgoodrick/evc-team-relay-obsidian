import * as Y from "yjs";
import { localTextAnchor, type DiscussionAnchor, type BaseAnchor } from "./DiscussionProtocol";
import { resolveTextAnchor } from "./anchors/text";
import { markdownImages, imageAssetChanged, type ImageOccurrence } from "./anchors/images";
import type { ImageAsset } from "./anchors/imageGeometry";
import type { BaseDefinitionCatalog } from "./BaseDefinitionProtocol";
import type { TimelineAxisContext } from "./TimelineRangeProtocol";
import type { TimelineMarkerCatalog } from "./TimelineMarkerProtocol";

export type CommentTargetState = "attached" | "unanchored" | "changed" | "waiting" | "unknown";
export interface CommentTargetStatus { state: CommentTargetState; message: string }
export const targetNeedsReview = (status: CommentTargetStatus) => status.state === "unanchored" || status.state === "changed";
export const uncheckedTarget = (message = "This target has not been checked in a synchronized local view."): CommentTargetStatus => ({ state: "unknown", message });
const status = (state: CommentTargetState, message: string): CommentTargetStatus => ({ state, message });
export interface NoteTargetEvidence {
	text: Y.Text; entryId: string; generation: string;
	asset?(destination: string): ImageAsset;
}

/** One source parse and Yjs snapshot per page, independent of thread state.
 * A missing dependency is never evidence that the selection was deleted. */
export function noteTargetStatuses(anchors: DiscussionAnchor[], evidence?: NoteTargetEvidence): CommentTargetStatus[] {
	const snapshot = evidence?.text.doc ? Y.snapshot(evidence.text.doc) : undefined;
	let images: ImageOccurrence[] | undefined;
	return anchors.map(anchor => {
		if (!evidence || !snapshot) return uncheckedTarget();
		if (anchor.type === "note") return status("attached", "Attached to this note.");
		if (anchor.type !== "text" && anchor.type !== "image") return uncheckedTarget();
		const source = anchor.type === "image" ? anchor.occurrence : anchor;
		const placed = resolveTextAnchor(evidence.text, evidence.entryId, evidence.generation, localTextAnchor(source), snapshot);
		if (placed.status === "waiting_for_sync") return status("waiting", "Waiting for the note updates used by this selection.");
		if (placed.status === "generation_mismatch") return status("changed", "The note identity changed after this selection was captured. Review its target.");
		if (placed.status === "invalid") return status("changed", "The saved selection could not be verified. Review its target.");
		if (placed.status === "unanchored") return status("unanchored", "The selected content no longer has a position in this synchronized note.");
		if (placed.status !== "attached") return uncheckedTarget();
		if (anchor.type === "text") return status("attached", anchor.structure ? "Selected blocks still have a position in this note." : "Selected text still has a position in this note.");
		images ??= markdownImages(evidence.text.toString());
		const image = images.find(item => item.from === placed.from && item.to === placed.to);
		if (!image) return status("changed", "The selected image occurrence changed. Review its target.");
		try {
			const current = evidence.asset?.(image.destination);
			if (!current) return uncheckedTarget("The image occurrence is present; its current image version is unchecked.");
			if (imageAssetChanged(anchor.asset, current)) return status("changed", "The image link or recorded image version changed. Review its target.");
			return current.kind === "external" ? uncheckedTarget("The external image occurrence is present. Its remote content version cannot be verified.") : status("attached", "The image occurrence matches its recorded image version.");
		} catch { return uncheckedTarget("The image occurrence is present; access or synchronization prevents checking its image version."); }
	});
}

export function imageFileTargetStatus(anchor: Extract<DiscussionAnchor, { type: "image_file" }>, generation?: string, asset?: ImageAsset): CommentTargetStatus {
	if (!generation) return status("waiting", "Waiting for the image file's synchronized identity.");
	if (anchor.generation !== generation) return status("changed", "The image file identity changed after this target was captured.");
	if (!asset) return uncheckedTarget("The current image file version is unavailable or still synchronizing.");
	return imageAssetChanged(anchor.asset, asset) ? status("changed", "The recorded image file version changed. Review its target.") : status("attached", "The image file matches its recorded version.");
}

export interface BaseTargetEvidence { generation?: string; definitions?: BaseDefinitionCatalog; axis?: TimelineAxisContext; markers?: TimelineMarkerCatalog; online: boolean; groupPresent?: boolean }
export function baseTargetStatus(anchor: BaseAnchor, evidence: BaseTargetEvidence): CommentTargetStatus {
	if (!evidence.generation) return status("waiting", "Waiting for this saved view's synchronized identity.");
	if (anchor.generation !== evidence.generation) return status("changed", "The saved-view identity changed. The original target is retained.");
	const target = anchor.target;
	const context = target.type === "timeline_marker" ? evidence.markers : target.type === "timeline_range" ? evidence.axis : evidence.definitions;
	if (!context) return uncheckedTarget("This target's current identity or definition has not been verified. It may also be hidden by the view's filters or layout.");
	if (context.generation !== anchor.generation || context.definition_id !== anchor.definition_id || context.view_id !== anchor.view_id) return status("changed", "This discussion belongs to an earlier saved-view identity.");
	if (context.registry_revision < anchor.registry_revision) return status("waiting", "Waiting for the saved-view revision used by this target.");
	if (target.type === "timeline_marker") {
		const marker = evidence.markers?.markers.find(item => item.id === target.marker_id);
		if (!marker) return evidence.online ? status("unanchored", "The marker is absent from the latest verified catalog.") : uncheckedTarget("The marker is absent from the cached catalog. Reconnect to verify it.");
		if (!marker.active || !marker.placement.active) return status("unanchored", "The marker was archived or removed from this view in the verified catalog.");
		if (JSON.stringify(marker.target) !== JSON.stringify(target)) return status("changed", "The marker changed after capture. Its original label and position are retained.");
		return status("attached", evidence.online ? "Matches the latest verified marker revision." : "Matches the last verified marker revision. Reconnect to check for changes.");
	}
	if (target.type === "timeline_range") {
		const axis = evidence.axis?.axis;
		if (!axis || axis.id !== target.axis_definition_id || axis.revision !== target.axis_definition_revision) return status("changed", "The timeline axis changed after this range was captured.");
		return target.lane ? evidence.groupPresent ? status("attached", "The timeline axis matches and the captured lane is present in the current local saved view.") :
			uncheckedTarget("The timeline axis matches. The captured lane still needs a membership check; absence from the layout alone does not detach it.") : status("attached", evidence.online ? "Matches the latest verified timeline axis." : "Matches the last verified timeline axis. Reconnect to check for changes.");
	}
	if (target.type === "formula" || target.type === "formula_cell" || target.type === "summary" || target.type === "group") {
		const found = evidence.definitions?.targets.find(item => item.id === target.definition_id && item.kind === (target.type === "formula_cell" ? "formula" : target.type));
		if (!found) return evidence.online ? status("unanchored", "This definition is absent from the latest verified saved view.") : uncheckedTarget("This definition is absent from the cached view. Reconnect to verify it.");
		if (found.revision !== target.definition_revision) return status("changed", "The target definition changed after this discussion was created.");
		if (target.type === "group" && evidence.groupPresent) return status("attached", "The saved definition matches and the captured group is present in the current local saved view.");
		if (target.type === "formula_cell" || target.type === "group") return uncheckedTarget("The saved definition matches. Its record or group still needs verification; view filters alone do not detach it.");
		return status("attached", evidence.online ? "Matches the latest verified definition." : "Matches the last verified definition. Reconnect to check for changes.");
	}
	return target.type === "view" ? status("attached", "Attached to this saved view.") : uncheckedTarget("This target retains its saved-view identity. A hidden record or property is not evidence of a detached discussion.");
}
