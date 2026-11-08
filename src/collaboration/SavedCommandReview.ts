import { restoreMetadata } from "./RestoreGeneration";
import { isRecord, parseAnchor, parseBody, REACTIONS, type DiscussionAnchor, type MessageBody } from "./DiscussionProtocol";
import { prepareBaseGroupCommand } from "./LocalDiscussionAnchor";
import type { InspectedLocalWork } from "./LocalWorkImport";
import { queuedEnvelope } from "./QueuedDiscussionCommand";
import { importOrigin } from "./storage/ImportedDrafts";
import type { Json, QueuedCommand, StoreIdentity } from "./storage/DiscussionStore";

export interface SavedCommandReview { operation: QueuedCommand; label: string; body?: MessageBody; target?: DiscussionAnchor }

/** Preserve the original immutable wire payload, including a previously saved
 * group capture. Inspecting must never acquire a new target or upload a picture. */
export function savedCommandReview(operation: QueuedCommand & { preparedAnchor?: Json }, shareId: string): SavedCommandReview {
	if (operation.type === "picture.upload") throw new Error("Picture uploads use separate receipts. Review the comment that uses this picture; no picture will be uploaded here.");
	if (operation.type === "base.group.create") {
		if (operation.preparedAnchor === undefined) throw new Error("This group request has no saved final target. Its comment receipt cannot be checked here yet.");
		operation = prepareBaseGroupCommand(operation, operation.preparedAnchor);
	}
	const payload = (JSON.parse(queuedEnvelope(shareId, operation)) as { command: Json }).command;
	if (!isRecord(payload)) throw new Error("This saved request is invalid.");
	const captured: QueuedCommand = { ...restoreMetadata(operation), operationId: operation.operationId, scopeId: operation.scopeId, type: operation.type, payload, dependsOn: [...operation.dependsOn] };
	const labels = { "thread.create": "New discussion", "reply.create": "Reply", "message.edit": "Comment edit", "reaction.set": "Reaction" };
	const label = labels[operation.type as keyof typeof labels];
	if (!label) throw new Error("This request cannot be checked here yet.");
	if (operation.type === "reaction.set") {
		if (typeof payload.emoji !== "string" || !Object.prototype.hasOwnProperty.call(REACTIONS, payload.emoji) || typeof payload.present !== "boolean") throw new Error("This saved reaction is invalid.");
		return { operation: captured, label: `${payload.present ? "Add" : "Remove"} reaction ${REACTIONS[payload.emoji as keyof typeof REACTIONS]}` };
	}
	return { operation: captured, label, body: parseBody(payload.body),
		...(operation.type === "thread.create" ? { target: parseAnchor(payload.anchor) } : {}) };
}

export function recoveryCommandReview(copy: InspectedLocalWork, operationId: string, destination: Readonly<StoreIdentity>): SavedCommandReview {
	const source = copy.snapshot.operations.find(operation => operation.operationId === operationId);
	if (!source) throw new Error("This request is no longer in the recovery copy.");
	// Reuse the account/share boundary already enforced by local draft imports.
	importOrigin({ version: 1, manifestSha256: copy.manifestSha256, snapshotId: copy.snapshot.id,
		draftId: "request:" + operationId, scopeId: source.scopeId, identity: copy.snapshot.identity }, destination);
	return savedCommandReview(source, destination.shareId);
}
