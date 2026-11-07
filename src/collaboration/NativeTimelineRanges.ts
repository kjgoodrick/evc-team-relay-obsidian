import type { BaseCommentContext } from "./BaseCommentContext";
import { parseTimelineAxis, type BaseAnchor } from "./DiscussionProtocol";
import type { TimelineAxisContext } from "./TimelineRangeProtocol";
import type { NativeBaseGroupHandle, NativeBaseGroupTarget, NativeTimelineContext } from "../bases/NativeBasesSurface";
import { nativeGroupTargetKey } from "./NativeBaseGroupComments";

export function sameTimelineAxis(a: unknown, b: unknown): boolean {
	try { return JSON.stringify(parseTimelineAxis(a)) === JSON.stringify(parseTimelineAxis(b)); } catch { return false; }
}
export function timelineAxisMatches(context: BaseCommentContext, proof: TimelineAxisContext, native: NativeTimelineContext): boolean {
	const snapshot = context.binding.snapshot;
	return context.current() && native.current() && context.binding.type === native.axis.renderer && proof.entry_id === context.baseEntryId && proof.definition_id === snapshot.definition_id &&
		proof.generation === snapshot.generation && proof.view_id === context.binding.viewId && proof.registry_revision === snapshot.revision &&
		sameTimelineAxis(proof.axis.axis, native.axis);
}
export async function readNativeTimelineAxis(context: BaseCommentContext, native = context.surface.rangeContext()): Promise<TimelineAxisContext> {
	if (!native?.current() || !context.current()) throw new Error("This timeline changed. Close this dialog and select the range again.");
	const proof = await context.session.readTimelineAxis(context.entryId);
	if (!timelineAxisMatches(context, proof, native)) throw new Error("This timeline axis does not match the saved view. Finish synchronization and try again.");
	return proof;
}
export function rangeMatchesAxis(context: BaseCommentContext, anchor: BaseAnchor, proof: TimelineAxisContext): boolean {
	const native = context.surface.rangeContext();
	return !!native && timelineAxisMatches(context, proof, native) && rangeTargetMatchesProof(anchor, proof);
}
export function rangeTargetMatchesProof(anchor: BaseAnchor, proof: TimelineAxisContext): boolean {
	const target = anchor.target;
	return target.type === "timeline_range" &&
		anchor.definition_id === proof.definition_id && anchor.generation === proof.generation && anchor.view_id === proof.view_id &&
		anchor.registry_revision <= proof.registry_revision && target.axis_definition_id === proof.axis.id &&
		target.axis_definition_revision === proof.axis.revision && sameTimelineAxis(target.axis, proof.axis.axis);
}
export async function rangeLane(context: BaseCommentContext, anchor: BaseAnchor): Promise<NativeBaseGroupTarget | undefined> {
	return anchor.target.type === "timeline_range" && anchor.target.lane && context.groups ?
		context.groups.native({ ...anchor, target: anchor.target.lane }) : undefined;
}
/** Exact typed lane identity, including refusal when several native headers
 * would project the same target. Absence never becomes a view-wide range. */
export function rangeLaneHandle(context: BaseCommentContext, lane: NativeBaseGroupTarget): NativeBaseGroupHandle | undefined {
	const key = nativeGroupTargetKey(lane), handles = context.groups?.handles().filter(handle => handle.current() && nativeGroupTargetKey(handle.target) === key) ?? [];
	return handles.length === 1 ? handles[0] : undefined;
}
