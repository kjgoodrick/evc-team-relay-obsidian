import { restoreMetadata, type RestoreBinding } from "./RestoreGeneration";
import { v4 as uuid } from "uuid";
import { isId, isRecord, protocolJson, type DiscussionAnchor } from "./DiscussionProtocol";
import { reattachmentAnchor, scopedReattachmentAnchor } from "./ReattachmentProtocol";
import type { DiscussionTransport, OnlineOperation, WithdrawalResult } from "./DiscussionTransport";
import type { DiscussionStore } from "./storage/DiscussionStore";

/** Online-only moves retain an exact durable request until acceptance or server
 * withdrawal. No timer or reconnect worker sends these administrative actions. */
export class DiscussionReattachment {
	constructor(private store: DiscussionStore, private transport: Pick<DiscussionTransport, "sendOnline" | "withdrawOnline">) {}
	private key(scopeId: string, threadId: string): string { return `reattach:${scopeId}:${threadId}`; }
	private stored(value: unknown, scopeId: string, threadId: string): OnlineOperation | undefined {
		if (value === undefined || value === null) return;
		if (!isRecord(value) || value.version !== 1) throw new Error("Invalid saved reattachment");
		if (value.completed !== undefined && isId(value.completed) && ["accepted", "withdrawn"].includes(String(value.status))) return;
		if (!isRecord(value.operation) || value.operation.scopeId !== scopeId || !isRecord(value.operation.payload) ||
			value.operation.payload.thread_id !== threadId) throw new Error("Invalid saved reattachment");
		const operation = value.operation as unknown as OnlineOperation; reattachmentAnchor(operation);
		return operation;
	}
	async pending(scopeId: string, threadId: string): Promise<OnlineOperation | undefined> {
		return this.stored(await this.store.preference(this.key(scopeId, threadId)), scopeId, threadId);
	}
	async prepare(scopeId: string, threadId: string, revision: number, anchor: DiscussionAnchor, current: () => boolean, binding: RestoreBinding = {}): Promise<OnlineOperation> {
		const target = scopedReattachmentAnchor(anchor, scopeId);
		const operation = { ...restoreMetadata(binding), operationId: uuid(), scopeId, payload: protocolJson({ type: "thread.reattach", thread_id: threadId, expected_anchor_revision: revision, anchor: target }) };
		reattachmentAnchor(operation);
		if (!current()) throw new Error("Reconnect with comment access before choosing a new target.");
		const key = this.key(scopeId, threadId), previous = await this.store.preference(key);
		if (this.stored(previous, scopeId, threadId)) throw new Error("Review the unconfirmed move before choosing another target.");
		if (!current()) throw new Error("Reattachment access changed.");
		if (!await this.store.comparePreference(key, previous, protocolJson({ version: 1, operation }), current, operation)) throw new Error("A move was prepared in another window. Review it first.");
		return operation;
	}
	private async exact(operation: OnlineOperation): Promise<OnlineOperation> {
		reattachmentAnchor(operation);
		const threadId = (operation.payload as Record<string, unknown>).thread_id as string;
		const saved = await this.pending(operation.scopeId, threadId);
		if (!saved || saved.operationId !== operation.operationId) throw new Error("This move was completed or replaced in another window.");
		// Always use the saved bytes, never an older pane's mutable target.
		return saved;
	}
	private async complete(operation: OnlineOperation, status: "accepted" | "withdrawn", current: () => boolean): Promise<void> {
		const threadId = (operation.payload as Record<string, unknown>).thread_id as string;
		await this.store.comparePreference(this.key(operation.scopeId, threadId), protocolJson({ version: 1, operation }),
			{ version: 1, completed: operation.operationId, status }, current, operation);
	}
	async send(operation: OnlineOperation, current: () => boolean): Promise<void> {
		const exact = await this.exact(operation);
		if (!current()) throw new Error("Reconnect with comment access before moving this discussion.");
		await this.store.requireRestoreBinding(exact);
		await this.transport.sendOnline(exact, current);
		await this.complete(exact, "accepted", current);
	}
	/** Withdrawal and acceptance share the server receipt identity. A lost
 * response never makes the saved request replaceable without this fence. */
	async recover(operation: OnlineOperation, current: () => boolean): Promise<WithdrawalResult["status"]> {
		const exact = await this.exact(operation);
		if (!current()) throw new Error("Reconnect with comment access before reviewing this move.");
		await this.store.requireRestoreBinding(exact);
		const result = await this.transport.withdrawOnline(exact, current);
		await this.complete(exact, result.status, current);
		return result.status;
	}
}
