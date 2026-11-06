import { v4 as uuid } from "uuid";
import { DiscussionOutbox } from "./DiscussionOutbox";
import { DiscussionSync, messagePrefix, threadKey, type SyncStatus } from "./DiscussionSync";
import { DiscussionFailure, DiscussionTransport, queuedEnvelope, type DiscussionParticipant, type DiscussionPermissions, type OnlineOperation } from "./DiscussionTransport";
import { isId, isRecord, parseAnchor, sourceAnchor, parseMessage, parseThread, protocolJson, type DiscussionAnchor, type DiscussionMessage, type ThreadSummary } from "./DiscussionProtocol";
import { DiscussionStore, type Draft, type OutboxOperation, type QueuedCommand, type StoreIdentity } from "./storage/DiscussionStore";

export type SessionStatus = "starting" | "ready" | "offline" | "unavailable" | "authentication_required" | "error" | "closed";
type Entry = { listeners: Set<() => void>; sync: DiscussionSync; permission?: DiscussionPermissions; documentGeneration?: string;
	permissionFlight?: Promise<void>; permissionChecked: number; unavailable: boolean; people: DiscussionParticipant[] };
export type AnchoredThread = ThreadSummary & { anchor?: DiscussionAnchor };
export type DiscussionLocalView = { threads: AnchoredThread[]; pending: OutboxOperation[]; hasMore: boolean; nextAfter: number };
function storedThread(value: unknown): AnchoredThread {
	const thread = parseThread(value);
	return { ...thread, ...(isRecord(value) && value.anchor !== undefined ? { anchor: parseAnchor(value.anchor) } : {}) };
}

/** A single account/server/vault/share owns this session. The native host removes
 * it synchronously on account change, then awaits shutdown before closing IDB.
 * No worker can acquire credentials for a different account through this object.
 */
export class DiscussionSession {
	readonly outbox: DiscussionOutbox;
	private entries = new Map<string, Entry>();
	private listeners = new Set<() => void>();
	private foreground = true;
	private closed = false;
	private startFlight?: Promise<void>;
	private onlineFlights = new Set<Promise<unknown>>();
	private channel?: BroadcastChannel;
	private statusValue: SessionStatus = "starting";
	private enabled = false;
	private textEnabled = false;
	private blocksEnabled = false;
	private imagesEnabled = false;
	private lastPublish = 0;

	constructor(readonly store: DiscussionStore, readonly transport: DiscussionTransport) {
		this.outbox = new DiscussionOutbox(store, transport, uuid(), status => {
			if (this.closed) return;
			if (status === "authentication_required") this.statusValue = "authentication_required";
			if (status === "protocol_error" || status === "storage_error") this.statusValue = "error";
			if (status === "idle") { this.invalidate(); this.broadcast(); }
			this.notify();
		});
		// Only invalidation signals cross windows; never bodies or credentials.
		if (typeof BroadcastChannel !== "undefined") {
			this.channel = new BroadcastChannel("team-relay-discussion-wake:" + JSON.stringify([
				store.identity.serverId, store.identity.accountId, store.identity.vaultId, store.identity.shareId]));
			this.channel.onmessage = event => {
				if (event.data !== "changed" || this.closed) return;
				if (this.foreground && this.enabled) this.outbox.wake();
				this.invalidate(); this.notify();
			};
		}
	}
	get identity(): Readonly<StoreIdentity> { return this.store.identity; }
	get status(): SessionStatus { return this.statusValue; }
	get canQueue(): boolean { return !this.closed && this.enabled && !["unavailable", "authentication_required", "error"].includes(this.statusValue); }
	get online(): boolean { return !this.closed && this.foreground && this.statusValue === "ready"; }
	get canAnchorText(): boolean { return this.canQueue && this.textEnabled; }
	get canAnchorImages(): boolean { return this.canAnchorText && this.imagesEnabled; }
	get canAnchorBlocks(): boolean { return this.canAnchorText && this.blocksEnabled; }
	documentGeneration(entryId: string): string | undefined {
		const entry = this.entries.get(entryId);
		return this.canAnchorText && entry?.permission?.read && !entry.unavailable ? entry.documentGeneration : undefined;
	}
	onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private notify(): void {
		for (const listener of [...this.listeners, ...[...this.entries.values()].flatMap(entry => [...entry.listeners])]) {
			try { listener(); } catch { /* Rendering does not affect delivery. */ }
		}
	}
	private broadcast(): void {
		// A wake in another window can end in idle with no work; do not echo it.
		if (Date.now() - this.lastPublish > 1000) { this.lastPublish = Date.now(); this.channel?.postMessage("changed"); }
	}
	private invalidate(): void {
		for (const entry of this.entries.values()) if (this.foreground) entry.sync.wake();
	}

	start(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.startFlight) return this.startFlight;
		this.startFlight = this.initialize().finally(() => { this.startFlight = undefined; });
		return this.startFlight;
	}
	private async initialize(): Promise<void> {
		try {
			const cached = await this.store.preference("enabled");
			if (this.closed) return;
			this.enabled = cached === true;
			this.textEnabled = await this.store.preference("textAnchorsEnabled") === true;
			this.blocksEnabled = await this.store.preference("blockAnchorsEnabled") === true;
			this.imagesEnabled = await this.store.preference("imageOccurrencesEnabled") === true;
			if (this.closed) return;
			const capability = await this.transport.capabilities();
			if (this.closed) return;
			this.enabled = capability.discussions;
			this.textEnabled = capability.textAnchors === true;
			this.blocksEnabled = capability.blockAnchors === true;
			this.imagesEnabled = capability.imageOccurrences === true;
			await this.store.setPreference("enabled", this.enabled);
			await this.store.setPreference("textAnchorsEnabled", this.textEnabled);
			await this.store.setPreference("blockAnchorsEnabled", this.blocksEnabled);
			await this.store.setPreference("imageOccurrencesEnabled", this.imagesEnabled);
			if (this.closed) return;
			this.statusValue = this.enabled ? "ready" : "unavailable";
		} catch (error) {
			if (this.closed) return;
			this.statusValue = error instanceof DiscussionFailure ? error.action === "retry" ? "offline" :
				error.action === "authenticate" ? "authentication_required" : "unavailable" : "error";
		}
		if (this.closed) return;
		if (this.foreground && this.canQueue) this.outbox.resume(); else this.outbox.stop();
		for (const [id, entry] of this.entries) void this.refreshPermission(id, entry);
		this.notify();
	}

	watch(entryId: string, listener: () => void): () => void {
		if (this.closed) return () => {};
		let entry = this.entries.get(entryId);
		if (!entry) {
			const sync = new DiscussionSync(this.store, this.transport, entryId, status => this.syncChanged(entryId, status));
			entry = { listeners: new Set(), sync, permissionChecked: 0, unavailable: false, people: [] };
			this.entries.set(entryId, entry);
		}
		entry.listeners.add(listener);
		void this.refreshPermission(entryId, entry);
		const owned = entry;
		return () => {
			owned.listeners.delete(listener);
			if (owned.listeners.size === 0) owned.sync.stop();
		};
	}
	permission(entryId: string): DiscussionPermissions | undefined { return this.entries.get(entryId)?.permission; }
	participants(entryId: string): DiscussionParticipant[] { return this.entries.get(entryId)?.people ?? []; }
	displayName(entryId: string, id: string | null): string {
		if (!id) return "Former member";
		return this.participants(entryId).find(person => person.id === id)?.name ?? "Member " + id.slice(0, 8);
	}
	syncStatus(entryId: string): SyncStatus { return this.entries.get(entryId)?.sync.status ?? "stopped"; }
	private syncChanged(id: string, status: SyncStatus): void {
		if (this.closed) return;
		const entry = this.entries.get(id);
		if (entry && status === "unavailable") { entry.unavailable = true; entry.permission = undefined; entry.people = []; entry.documentGeneration = undefined; }
		if (status === "authentication_required") this.statusValue = "authentication_required";
		if (status === "protocol_error" || status === "storage_error") this.statusValue = "error";
		if (status === "offline") this.statusValue = "offline";
		if (status === "current") {
			this.statusValue = "ready";
			if (entry && Date.now() - entry.permissionChecked > 30_000) void this.refreshPermission(id, entry);
		}
		this.notify();
	}
	private refreshPermission(id: string, entry: Entry): Promise<void> {
		if (this.closed || !this.foreground || entry.listeners.size === 0) return Promise.resolve();
		if (entry.permissionFlight) return entry.permissionFlight;
		entry.permissionFlight = (async () => {
			try {
				if (!entry.permission) {
					const cached = await this.store.preference("permission:" + id);
					if (this.closed) return;
					if (isRecord(cached) && ["read", "comment", "edit", "moderate"].every(key => typeof cached[key] === "boolean")) {
						entry.permission = cached as unknown as DiscussionPermissions;
					}
					const people = await this.store.preference("people:" + id);
					if (this.closed) return;
					if (Array.isArray(people) && people.every(p => isRecord(p) && typeof p.id === "string" && typeof p.name === "string")) {
						entry.people = people as unknown as DiscussionParticipant[];
					}
					const generation = await this.store.preference("documentGeneration:" + id);
					if (this.closed) return;
					entry.documentGeneration = isId(generation) ? generation : undefined;
					this.notify();
				}
				if (!this.enabled) return;
				const permission = await this.transport.permissions(id);
				if (this.closed) return;
				entry.permission = permission; entry.unavailable = !permission.read;
				if (permission.read) {
					await this.store.setPreference("permission:" + id, protocolJson(permission));
					if (this.textEnabled) {
						try {
							const context = await this.transport.anchorContext(id);
							if (this.closed) return;
							entry.documentGeneration = context.generation;
							await this.store.setPreference("documentGeneration:" + id, context.generation);
						} catch (error) {
							// A transient failure retains the last verified generation for offline
							// capture. Existing drafts/queued anchors are never rewritten.
							if (!(error instanceof DiscussionFailure) || error.action !== "retry") {
								entry.documentGeneration = undefined;
								await this.store.setPreference("documentGeneration:" + id, null);
							}
							if (error instanceof DiscussionFailure && (error.action === "authenticate" ||
								error.action === "reject" && [403, 404].includes(error.status))) throw error;
						}
					}
					// Directory pages include only users authorized for this entry.
					// Keep prior offline names on a transient failure, never on revocation.
					try {
						const people: DiscussionParticipant[] = []; let after: string | undefined;
						for (let page = 0; page < 20 && !this.closed; page++) {
							const result = await this.transport.participants(id, after);
							people.push(...result.participants); after = result.nextAfter;
							if (!result.hasMore) break;
						}
						if (!this.closed) { entry.people = people; await this.store.setPreference("people:" + id, protocolJson(people)); }
					} catch { /* Display stable fallbacks until the directory can refresh. */ }
				} else { entry.people = []; entry.documentGeneration = undefined; await this.store.clearRemoteScope(id); }
			} catch (error) {
				if (this.closed) return;
				if (error instanceof DiscussionFailure && [403, 404].includes(error.status)) {
					entry.permission = undefined; entry.unavailable = true; entry.people = []; entry.documentGeneration = undefined; await this.store.clearRemoteScope(id);
				} else if (error instanceof DiscussionFailure && error.action === "authenticate") this.statusValue = "authentication_required";
			} finally {
				entry.permissionChecked = Date.now(); entry.permissionFlight = undefined;
				if (!this.closed) {
					if (this.foreground && this.canQueue && entry.listeners.size && entry.permission?.read && !entry.unavailable) entry.sync.resume();
					else entry.sync.stop();
					this.notify();
				}
			}
		})();
		return entry.permissionFlight;
	}

	setForeground(foreground: boolean): void {
		if (this.closed || foreground === this.foreground) return;
		this.foreground = foreground;
		if (!foreground) { this.outbox.stop(); for (const entry of this.entries.values()) entry.sync.stop(); }
		else void this.start();
	}
	async refresh(): Promise<void> {
		await this.start();
		if (this.closed) return;
		await Promise.all([...this.entries].map(([id, entry]) => this.refreshPermission(id, entry)));
		this.invalidate();
	}
	async local(entryId: string, after = 0, limit = 20): Promise<DiscussionLocalView> {
		if (this.closed) throw new Error("This discussion account is closed.");
		const rows = await this.store.orderedEntities(entryId, "thread:", after, limit + 1);
		const page = rows.slice(0, limit), threads = page.filter(row => isRecord(row.value) && !row.value.removed).map(row => storedThread(row.value));
		const last = page[page.length - 1];
		return { threads, pending: await this.store.pending(entryId), hasMore: rows.length > limit,
			nextAfter: last && isRecord(last.value) && typeof last.value.created_sequence === "number" ? last.value.created_sequence : last?.revision ?? after };
	}
	async cachedThread(entryId: string, threadId: string): Promise<AnchoredThread | undefined> {
		if (this.closed || !this.permission(entryId)?.read) return undefined;
		const row = await this.store.entity(entryId, threadKey(threadId));
		return row && isRecord(row.value) && !row.value.removed ? storedThread(row.value) : undefined;
	}
	async anchorThreads(entryId: string): Promise<AnchoredThread[]> {
		const threads: AnchoredThread[] = []; let after = 0;
		while (!this.closed && this.permission(entryId)?.read) {
			const rows = await this.store.orderedEntities(entryId, "thread:", after, 100);
			for (const row of rows) if (isRecord(row.value) && !row.value.removed) threads.push(storedThread(row.value));
			if (rows.length < 100) return threads;
			const last = rows[rows.length - 1].value;
			if (!isRecord(last) || typeof last.created_sequence !== "number" || last.created_sequence <= after) throw new Error("Invalid cached thread order");
			after = last.created_sequence;
		}
		return [];
	}
	async messages(entryId: string, threadId: string, after = 0, limit = 20): Promise<{ messages: DiscussionMessage[]; hasMore: boolean }> {
		if (this.closed) throw new Error("This discussion account is closed.");
		const root = await this.store.entity(entryId, threadKey(threadId));
		if (!root || !isRecord(root.value) || root.value.removed) return { messages: [], hasMore: false };
		const rows = await this.store.orderedEntities(entryId, messagePrefix(threadId), after, limit + 1);
		return { messages: rows.slice(0, limit).map(row => parseMessage(row.value)), hasMore: rows.length > limit };
	}
	async queue(command: QueuedCommand, draft?: Pick<Draft, "id" | "revision">): Promise<void> {
		if (!this.canQueue || !this.permission(command.scopeId)?.comment) throw new Error("Comment permission is required.");
		queuedEnvelope(this.identity.shareId, command);
		if (command.type === "thread.create" && isRecord(command.payload)) {
			const anchor = parseAnchor(command.payload.anchor), source = sourceAnchor(anchor);
			if (source) {
				if (!this.canAnchorText) throw new Error("Selected-text comments are not enabled on this server.");
				if (source.structure && !this.canAnchorBlocks) throw new Error("Block comments are not enabled on this server.");
				if (anchor.type === "image" && !this.canAnchorImages) throw new Error("Image comments are not enabled on this server.");
				if (source.generation !== this.documentGeneration(command.scopeId)) throw new Error("Review this selection after refreshing the note’s comment context.");
			}
		}
		await this.store.enqueue(command, Date.now(), draft);
		if (this.closed) return;
		this.broadcast(); if (this.foreground) this.outbox.wake(); this.notify();
	}
	async onlineAction(operation: OnlineOperation): Promise<void> {
		if (!this.online || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect before changing this discussion.");
		const flight = this.transport.sendOnline(operation);
		this.onlineFlights.add(flight);
		try { await flight; } finally {
			this.onlineFlights.delete(flight);
			if (!this.closed) { this.invalidate(); this.broadcast(); this.notify(); }
		}
	}
	async retryRejected(operation: OutboxOperation): Promise<boolean> {
		if (!this.online || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect and check comment permission before retrying.");
		queuedEnvelope(this.identity.shareId, operation);
		const retried = await this.trackLocal(this.store.retryRejected(operation.operationId, operation.scopeId, operation.attempt));
		if (!this.closed) { this.broadcast(); this.outbox.wake(); this.notify(); }
		return retried;
	}
	async onlineDraft(draft: Pick<Draft, "id" | "revision">, operation: OnlineOperation): Promise<void> {
		if (!this.online || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect before changing this discussion.");
		await this.trackLocal((async () => {
			const exact = await this.store.prepareOnlineDraft(draft.id, draft.revision, operation);
			if (this.closed) throw new Error("This discussion account is closed.");
			await this.onlineAction(exact);
			await this.store.completeOnlineDraft(draft.id, draft.revision, exact.operationId);
		})());
	}
	/** Include queued local saves in account shutdown, including saves waiting on a previous draft transaction. */
	trackLocal<T>(flight: Promise<T>): Promise<T> {
		this.onlineFlights.add(flight);
		void flight.finally(() => this.onlineFlights.delete(flight)).catch(() => {});
		return flight;
	}
	/** Synchronously disables all activity before waiting for uncancelable native HTTP. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true; this.statusValue = "closed";
		this.outbox.stop(); for (const entry of this.entries.values()) entry.sync.stop();
		this.channel?.close(); this.channel = undefined; this.notify(); this.listeners.clear();
		await Promise.allSettled([this.startFlight, this.outbox.settled(), ...this.onlineFlights,
			...[...this.entries.values()].flatMap(entry => [entry.sync.settled(), entry.permissionFlight])]);
		this.entries.clear(); this.store.close();
	}
}
