import { DiscussionFailure, type DiscussionIdentity } from "./DiscussionTransport";
import { isId, protocolJson, type ChangesPage, type MessageRead, type ThreadStateRead } from "./DiscussionProtocol";
import type { CachedEntity, CachePurge, DiscussionStore } from "./storage/DiscussionStore";

export interface DiscussionReader {
	readonly identity: Readonly<DiscussionIdentity>;
	changes(entryId: string, cursor?: string): Promise<ChangesPage>;
	state(entryId: string, threadId: string): Promise<ThreadStateRead>;
	message(entryId: string, threadId: string, messageId: string): Promise<MessageRead>;
}
export type SyncStatus = "stopped" | "syncing" | "current" | "offline" | "authentication_required" | "unavailable" | "protocol_error" | "storage_error";
export const threadKey = (id: string) => "thread:" + id;
export const messagePrefix = (threadId: string) => "message:" + threadId + ":";
export const messageKey = (threadId: string, messageId: string) => messagePrefix(threadId) + messageId;

/** Authorized metadata replay with targeted current-state fetches. Host suspends
 * this worker when its surface is hidden. WebSocket invalidations can call wake;
 * the five-second fallback is used only while the discussion surface is active.
 * The current server retains all events, so reset replays from zero. A future
 * retained snapshot protocol must replace that before event pruning is enabled.
 */
export class DiscussionSync {
	private active = false;
	private generation = 0;
	private flight?: Promise<void>;
	private timer?: number;
	private requested = false;
	private notBefore = 0;
	private failures = 0;
	private currentStatus: SyncStatus = "stopped";

	constructor(private store: DiscussionStore, private reader: DiscussionReader, readonly entryId: string,
		private onChange: (status: SyncStatus) => void = () => {}, private now: () => number = Date.now,
		private random: () => number = Math.random) {
		if (!isId(entryId) || ["serverId", "accountId", "shareId"].some(key =>
			store.identity[key as keyof typeof reader.identity] !== reader.identity[key as keyof typeof reader.identity])) {
			throw new Error("Discussion reader identity does not match its local store");
		}
	}
	get status(): SyncStatus { return this.currentStatus; }
	private changed(status: SyncStatus): void {
		this.currentStatus = status;
		try { this.onChange(status); } catch { /* Observers cannot change sync outcomes. */ }
	}
	resume(): void { if (!this.active) { this.active = true; this.generation++; } this.wake(); }
	stop(): void { this.pause("stopped"); }
	async settled(): Promise<void> { await this.flight; }
	wake(): void {
		if (!this.active) return;
		this.clearTimer(); this.requested = true;
		if (this.flight) return;
		const generation = this.generation;
		this.flight = this.pump(generation).catch(() => {
			if (this.valid(generation)) this.pause("storage_error");
		}).finally(() => {
			this.flight = undefined;
			if (this.active && this.requested) this.schedule(0);
		});
	}
	private valid(generation: number): boolean { return this.active && generation === this.generation; }
	private clearTimer(): void { if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined; }
	private pause(status: SyncStatus): void {
		this.active = false; this.generation++; this.requested = false; this.clearTimer(); this.changed(status);
	}
	private schedule(delay: number): void {
		this.clearTimer();
		this.timer = window.setTimeout(() => { this.timer = undefined; this.wake(); }, Math.max(delay, this.notBefore - this.now(), 0));
	}
	private async pump(generation: number): Promise<void> {
		this.requested = false;
		if (this.now() < this.notBefore) { this.schedule(0); return; }
		this.changed("syncing");
		let resets = 0;
		for (let pageNumber = 0; pageNumber < 3 && this.valid(generation); pageNumber++) {
			const checkpoint = await this.store.checkpoint(this.entryId);
			if (!this.valid(generation)) return;
			try {
				const page = await this.reader.changes(this.entryId, checkpoint.cursor);
				if (!this.valid(generation)) return;
				const entities = new Map<string, CachedEntity>(), purges: CachePurge[] = [];
				const put = (entity: CachedEntity) => {
					if ((entities.get(entity.id)?.revision ?? 0) < entity.revision) entities.set(entity.id, entity);
				};
				const remove = (id: string, revision: number) => {
					put({ id: threadKey(id), revision, value: { id, removed: true } });
					purges.push({ prefix: messagePrefix(id), throughRevision: revision });
				};
				// Collapse repeated edits/reactions within a page. Message cache
				// versions use the read's activity sequence, not its edit revision:
				// a reaction changes without incrementing the message revision.
				const targets = new Map<string, ChangesPage["events"][number]>();
				const removed = new Map<string, number>();
				for (const event of page.events) {
					const data = event.data;
					if (data.removed) removed.set(data.thread_id, event.sequence);
					targets.set(data.message_id ? messageKey(data.thread_id, data.message_id) : threadKey(data.thread_id), event);
				}
				for (const [id, sequence] of removed) remove(id, sequence);
				for (const event of targets.values()) {
					const data = event.data;
					if (removed.has(data.thread_id)) continue;
					try {
						const messageRead = data.message_id ? await this.reader.message(this.entryId, data.thread_id, data.message_id) : undefined;
						if (!this.valid(generation)) return;
						const read = messageRead ?? await this.reader.state(this.entryId, data.thread_id);
						if (!this.valid(generation)) return;
						const sequence = read.thread.activity_sequence;
						if (sequence < event.sequence) throw new DiscussionFailure("pause", "read_precedes_event");
						if (read.thread.removed) { remove(data.thread_id, sequence); continue; }
						put({ id: threadKey(data.thread_id), revision: sequence, value: protocolJson({ ...read.thread, anchor: read.anchor }) });
						const messages = messageRead ? [messageRead.message] : [];
						for (const message of messages) put({ id: messageKey(data.thread_id, message.id), revision: sequence,
							value: protocolJson({ ...message, thread_id: data.thread_id }) });
					} catch (error) {
						if (!(error instanceof DiscussionFailure) || error.status !== 404 || error.code !== "target_unavailable") throw error;
						if (!this.valid(generation)) return;
						// A removal after this page has an authoritative newer sequence.
						// Read only metadata, rechecking entry access without exposing
						// removed bodies/anchor quotes or guessing a deletion from 404.
						const state = await this.reader.state(this.entryId, data.thread_id);
						if (!this.valid(generation)) return;
						if (!state.thread.removed || state.thread.activity_sequence < event.sequence) throw new DiscussionFailure("pause", "invalid_read_response");
						remove(data.thread_id, state.thread.activity_sequence);
					}
				}
				if (!this.valid(generation)) return;
				const applied = await this.store.applyRemoteBatch(this.entryId, checkpoint.cursor, page.cursor,
					[...entities.values()], [], checkpoint.generation, purges);
				if (!this.valid(generation)) return;
				this.failures = 0;
				if (!applied) continue; // Another window advanced or invalidated it.
				this.changed(page.has_more ? "syncing" : "current");
				if (!page.has_more) { this.schedule(5000); return; }
			} catch (error) {
				if (!this.valid(generation)) return;
				if (!(error instanceof DiscussionFailure)) throw error;
				if (error.code === "snapshot_required" && checkpoint.cursor !== undefined && resets++ === 0) {
					await this.store.clearRemoteScope(this.entryId, checkpoint);
					if (!this.valid(generation)) return;
					this.changed("syncing"); continue;
				}
				if (error.status === 403 || error.status === 404 && error.code === "target_unavailable") {
					// This is an authorization decision, not a paginated absence.
					await this.store.clearRemoteScope(this.entryId);
					if (this.valid(generation)) this.pause("unavailable"); return;
				}
				if (error.action === "authenticate") { this.pause("authentication_required"); return; }
				if (error.action !== "retry") { this.pause("protocol_error"); return; }
				const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6)) * (0.8 + this.random() * 0.4);
				const serverDelay = Number.isFinite(error.retryAfterMs) ? Math.min(86400_000, Math.max(0, error.retryAfterMs!)) : 0;
				this.notBefore = this.now() + Math.max(delay, serverDelay);
				this.changed("offline"); this.schedule(0); return;
			}
		}
		// Bound each turn; yield between backlog pages rather than monopolizing UI.
		if (this.valid(generation)) this.schedule(0);
	}
}
