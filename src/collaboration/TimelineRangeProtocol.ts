import { isId, isRecord, isRevision, parseBaseTargetContext, parseTimelineAxis, type BaseTargetContext, type TimelineAxis } from "./DiscussionProtocol";

export type TimelineAxisContext = BaseTargetContext & { axis: { id: string; kind: "axis"; revision: number; fingerprint: string; axis: TimelineAxis } };

export function parseTimelineAxisContext(value: unknown, entryId: string, viewId: string): TimelineAxisContext {
	const context = parseBaseTargetContext(value, entryId, viewId);
	if (!isRecord(value) || !isRecord(value.axis)) throw new Error("Invalid timeline axis context");
	const axis = value.axis;
	if (!isId(axis.id) || axis.kind !== "axis" || !isRevision(axis.revision) || axis.revision > context.registry_revision ||
		typeof axis.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(axis.fingerprint) ||
		Object.keys(axis).length !== 5 || !Object.keys(axis).every(key => ["id", "kind", "revision", "fingerprint", "axis"].includes(key))) throw new Error("Invalid timeline axis context");
	return { ...context, axis: { id: axis.id, kind: "axis", revision: axis.revision, fingerprint: axis.fingerprint, axis: parseTimelineAxis(axis.axis) } };
}
