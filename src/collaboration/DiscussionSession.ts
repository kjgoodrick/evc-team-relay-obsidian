import { v4 as uuid } from "uuid";
import { DiscussionOutbox } from "./DiscussionOutbox";
import { DiscussionDelivery } from "./DiscussionDelivery";
import { DiscussionPictures } from "./DiscussionPictures";
import { parsePictureUpload, pictureIds } from "./PictureProtocol";
import { commandPictures } from "./storage/PictureRecords";
import { DiscussionSync, messagePrefix, threadKey, type SyncStatus } from "./DiscussionSync";
import { DiscussionFailure, DiscussionTransport, queuedEnvelope, type DiscussionParticipant, type DiscussionPermissions, type OnlineOperation } from "./DiscussionTransport";
import { BASE_TARGET_KINDS, isId, isRecord, parseAnchor, parseBaseTargetContext, sourceAnchor, parseMessage, parseThread, protocolJson, type BaseAnchor, type BaseProperty, type BaseTargetContext, type BaseTargetKind, type DiscussionAnchor, type DiscussionMessage, type ThreadSummary } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";
import { BASE_RECORD_TYPES, isBaseRecordType, type BaseRecordType } from "./DiscussionProtocol";
import { DiscussionStore, type Draft, type OutboxOperation, type QueuedCommand, type StoreIdentity } from "./storage/DiscussionStore";
import { parseBaseDefinitionCatalog, type BaseDefinitionCatalog } from "./BaseDefinitionProtocol";

export type SessionStatus = "starting" | "ready" | "offline" | "unavailable" | "authentication_required" | "error" | "closed";
type Entry = { kind: "note" | "image" | "base"; listeners: Set<() => void>; sync: DiscussionSync; permission?: DiscussionPermissions; documentGeneration?: string;
	baseRegistryRevision?: number;
	permissionFlight?: Promise<void>; permissionRestoreFlight?: Promise<void>; permissionChecked: number; unavailable: boolean; people: DiscussionParticipant[] };
export type AnchoredThread = ThreadSummary & { anchor?: DiscussionAnchor };
export type DiscussionLocalView = { threads: AnchoredThread[]; pending: OutboxOperation[]; hasMore: boolean; nextAfter: number };
export type BaseTargetSelection = { type: "view" } | { type: "property"; property: BaseProperty } |
	{ type: "item"; recordId: string } | { type: "cell"; recordId: string; property: BaseProperty } |
	{ type: "formula" | "summary"; definitionId: string; definitionRevision: number };
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
	readonly pictures = new DiscussionPictures(this);
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
	private imageFilesEnabled = false;
	private picturesEnabled = false;
	private recoveryEnabled = false;
	private baseKinds: BaseTargetKind[] = [];
	private baseContextFlights = new Map<string, Promise<BaseTargetContext>>();
	private baseDefinitionFlights = new Map<string, Promise<BaseDefinitionCatalog>>();
	private baseRecordTypes: BaseRecordType[] = [];
	private lastPublish = 0;

	constructor(readonly store: DiscussionStore, readonly transport: DiscussionTransport) {
		this.outbox = new DiscussionOutbox(store, new DiscussionDelivery(store, transport, () => this.picturesEnabled), uuid(), status => {
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
	get canAnchorImageFiles(): boolean { return this.canQueue && this.imageFilesEnabled; }
	get canAnchorBlocks(): boolean { return this.canAnchorText && this.blocksEnabled; }
	get canAttachPictures(): boolean { return this.canQueue && this.picturesEnabled; }
	get canRepairPictures(): boolean { return this.online && this.canAttachPictures && this.recoveryEnabled; }
	get canRecoverOnlineDraft(): boolean { return this.online && this.recoveryEnabled; }
	canAnchorBase(kind: BaseTargetKind): boolean { return this.canQueue && this.baseKinds.includes(kind); }
	baseRegistryRevision(scopeId: string): number { return this.entries.get(scopeId)?.baseRegistryRevision ?? 0; }
	private observeBaseRevision(scopeId: string, generation: string, revision: number): void {
		const entry = this.entries.get(scopeId);
		if (entry?.documentGeneration === generation && (entry.baseRegistryRevision ?? 0) < revision) {
			entry.baseRegistryRevision = revision; this.notify();
		}
	}
	canAnchorBaseRecord(kind: unknown): boolean {
		return (this.canAnchorBase("item") || this.canAnchorBase("cell")) && isBaseRecordType(kind) && this.baseRecordTypes.includes(kind);
	}
	documentGeneration(entryId: string): string | undefined {
		const entry = this.entries.get(entryId);
		const enabled = entry?.kind === "base" ? this.canQueue && this.baseKinds.length > 0 : entry?.kind === "image" ? this.canAnchorImageFiles : this.canAnchorText;
		return enabled ? this.knownDocumentGeneration(entryId) : undefined;
	}
	knownDocumentGeneration(entryId: string): string | undefined {
		const entry = this.entries.get(entryId);
		return entry?.permission?.read && !entry.unavailable && !this.closed ? entry.documentGeneration : undefined;
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
			this.imageFilesEnabled = await this.store.preference("imageFilesEnabled") === true;
			this.picturesEnabled = await this.store.preference("picturesEnabled") === true;
			const baseKinds = await this.store.preference("baseTargetKinds");
			this.baseKinds = Array.isArray(baseKinds) ? BASE_TARGET_KINDS.filter(kind => baseKinds.includes(kind)) : [];
			const recordTypes = await this.store.preference("baseRecordTypes");
			this.baseRecordTypes = Array.isArray(recordTypes) ? BASE_RECORD_TYPES.filter(kind => recordTypes.includes(kind)) : ["markdown"];
			if (this.closed) return;
			const capability = await this.transport.capabilities();
			if (this.closed) return;
			this.enabled = capability.discussions;
			this.textEnabled = capability.textAnchors === true;
			this.blocksEnabled = capability.blockAnchors === true;
			this.imagesEnabled = capability.imageOccurrences === true;
			this.imageFilesEnabled = capability.imageFiles === true;
			this.picturesEnabled = capability.pictures === true;
			this.recoveryEnabled = capability.recovery === true;
			this.baseKinds = capability.baseTargets ?? [];
			this.baseRecordTypes = capability.baseRecordTypes ?? ["markdown"];
			await this.store.setPreference("enabled", this.enabled);
			await this.store.setPreference("textAnchorsEnabled", this.textEnabled);
			await this.store.setPreference("blockAnchorsEnabled", this.blocksEnabled);
			await this.store.setPreference("imageOccurrencesEnabled", this.imagesEnabled);
			await this.store.setPreference("imageFilesEnabled", this.imageFilesEnabled);
			await this.store.setPreference("picturesEnabled", this.picturesEnabled);
			await this.store.setPreference("baseTargetKinds", protocolJson(this.baseKinds));
			await this.store.setPreference("baseRecordTypes", protocolJson(this.baseRecordTypes));
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

	watch(entryId: string, listener: () => void, kind: "note" | "image" | "base" = "note"): () => void {
		if (this.closed) return () => {};
		if ((parseDiscussionScope(entryId)?.viewId !== undefined) !== (kind === "base")) throw new Error("A Bases discussion requires a saved view.");
		let entry = this.entries.get(entryId);
		if (entry && entry.kind !== kind) throw new Error("Reopen comments after the file type changes.");
		if (!entry) {
			const sync = new DiscussionSync(this.store, this.transport, entryId, status => this.syncChanged(entryId, status), undefined, undefined,
				() => this.reauthorizeAfterReset(entryId));
			entry = { kind, listeners: new Set(), sync, permissionChecked: 0, unavailable: false, people: [] };
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
	/** Opening an offline pane waits for local authority restoration only.
	 * watch() continues its network refresh independently. */
	async scopeReady(entryId: string): Promise<void> {
		const entry = this.entries.get(entryId); if (!entry || this.closed) return;
		await (this.statusValue === "offline" ? entry.permissionRestoreFlight : entry.permissionFlight);
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
	private async reauthorizeAfterReset(id: string): Promise<void> {
		const entry = this.entries.get(id); if (!entry || this.closed) return;
		// A refresh that began before the reset may have saved its grant just
		// before it was cleared. Finish that request, then get fresh authority.
		await entry.permissionFlight;
		if (this.closed) return;
		entry.permission = undefined; entry.people = []; entry.documentGeneration = undefined; entry.permissionChecked = 0;
		await this.refreshPermission(id, entry);
	}
	private async restorePermission(id: string, entry: Entry): Promise<void> {
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
	private refreshPermission(id: string, entry: Entry): Promise<void> {
		if (this.closed || !this.foreground || entry.listeners.size === 0) return Promise.resolve();
		if (entry.permissionFlight) return entry.permissionFlight;
		entry.permissionFlight = (async () => {
			try {
				if (!entry.permission) {
					entry.permissionRestoreFlight = this.restorePermission(id, entry);
					try { await entry.permissionRestoreFlight; } finally { entry.permissionRestoreFlight = undefined; }
				}
				if (!this.enabled) return;
				const permission = await this.transport.permissions(id);
				if (this.closed) return;
				entry.permission = permission; entry.unavailable = !permission.read;
				if (permission.read) {
					await this.store.setPreference("permission:" + id, protocolJson(permission));
					if (entry.kind === "base" ? this.baseKinds.length > 0 : entry.kind === "image" ? this.imageFilesEnabled : this.textEnabled) {
						try {
							const context = entry.kind === "base" ? await this.fetchBaseContext(id) : await this.transport.anchorContext(id);
							if (this.closed) return;
							if (entry.documentGeneration !== context.generation) entry.baseRegistryRevision = undefined;
							entry.documentGeneration = context.generation;
							if ("registry_revision" in context) this.observeBaseRevision(id, context.generation, context.registry_revision);
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
		if (!this.canAttachPictures) {
			for (const id of commandPictures(command.payload)) if (await this.store.pictureSource(id, command.scopeId) &&
				(await this.store.getOperation(id))?.state !== "accepted") throw new Error("Pictures are not enabled on this server.");
		}
		if (command.type === "thread.create" && isRecord(command.payload)) {
			const anchor = parseAnchor(command.payload.anchor), source = sourceAnchor(anchor);
			if ((anchor.type === "base") !== (this.entries.get(command.scopeId)?.kind === "base")) throw new Error("The comment target does not match this saved view.");
			if (anchor.type === "base") {
				if (!this.canAnchorBase(anchor.target.type)) throw new Error("This Bases target is not enabled on the server.");
				if (anchor.generation !== this.documentGeneration(command.scopeId)) throw new Error("Refresh this saved view and review the comment target before sending.");
				const recordId = anchor.target.type === "item" || anchor.target.type === "cell" ? anchor.target.record_id : undefined;
				const context = await this.cachedBaseContext(command.scopeId, recordId);
				if (!context || context.definition_id !== anchor.definition_id || context.generation !== anchor.generation ||
					context.view_id !== anchor.view_id || context.registry_revision < anchor.registry_revision ||
					(recordId !== undefined && context.record_generation !== (anchor.target as { record_generation: string }).record_generation)) throw new Error("Refresh this saved view and review the comment target before sending.");
				if (recordId && await this.store.preference("baseRecordComment:" + command.scopeId + ":" + recordId) !== true) throw new Error("Comment permission is required on the selected record.");
			}
			if ((anchor.type === "image_file") !== (this.entries.get(command.scopeId)?.kind === "image")) throw new Error("The comment target does not match this file.");
			if (anchor.type === "image_file") {
				if (!this.canAnchorImageFiles) throw new Error("Image-file comments are not enabled on this server.");
				if (anchor.generation !== this.documentGeneration(command.scopeId)) throw new Error("Review this image after refreshing its comment context.");
			}
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
	private async cachedBaseContext(scopeId: string, recordId?: string): Promise<BaseTargetContext | undefined> {
		const scope = parseDiscussionScope(scopeId);
		if (!scope?.viewId) return undefined;
		const value = await this.store.preference("baseContext:" + scopeId + (recordId ? ":" + recordId : ""));
		try { return parseBaseTargetContext(value, scope.entryId, scope.viewId, recordId); } catch { return undefined; }
	}
	/** One request per target in this session. Store tickets also fence other
	 * windows, late denials and resets; an old revision cannot replace a newer one. */
	private fetchBaseContext(scopeId: string, recordId?: string): Promise<BaseTargetContext> {
		const key = "baseContext:" + scopeId + (recordId ? ":" + recordId : "");
		const existing = this.baseContextFlights.get(key); if (existing) return existing;
		const flight = (async () => {
			const scope = parseDiscussionScope(scopeId); if (!scope?.viewId || this.closed) throw new Error("Saved view access is unavailable.");
			const proof = await this.store.beginPreferenceVerification(scopeId, key, uuid());
			let context: BaseTargetContext;
			try { context = await this.transport.baseTargetContext(scopeId, scope.viewId, recordId); }
			catch (error) {
				if (!this.closed && error instanceof DiscussionFailure && error.action !== "retry") await this.store.finishPreferenceVerification(scopeId, key, proof, null);
				throw error;
			}
			if (this.closed) throw new Error("This discussion account is closed.");
			let previous: BaseTargetContext | undefined;
			try { previous = parseBaseTargetContext(proof.previous, scope.entryId, scope.viewId, recordId); } catch { /* No prior verified target. */ }
			if (previous?.generation === context.generation && previous.registry_revision > context.registry_revision) throw new Error("Saved view association changed.");
			if (!await this.store.finishPreferenceVerification(scopeId, key, proof, protocolJson(context))) throw new Error("Saved target verification changed. Try again.");
			this.observeBaseRevision(scopeId, context.generation, context.registry_revision);
			return context;
		})().finally(() => { if (this.baseContextFlights.get(key) === flight) this.baseContextFlights.delete(key); });
		this.baseContextFlights.set(key, flight); return flight;
	}

	/** Read-side lineage for navigation. It does not require comment permission.
	 * Offline navigation requires a context previously verified for this account. */
	async readBaseContext(scopeId: string, recordId?: string): Promise<BaseTargetContext> {
		const scope = parseDiscussionScope(scopeId), generation = this.knownDocumentGeneration(scopeId);
		const current = () => !this.closed && this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
		if (!scope?.viewId || !generation || !current()) throw new Error("Saved view access is unavailable.");
		return this.trackLocal((async () => {
			let context: BaseTargetContext | undefined;
			try {
				if (this.statusValue === "offline") throw new DiscussionFailure("retry", "offline_cache");
				context = await this.fetchBaseContext(scopeId, recordId);
				if (!current() || context.generation !== generation) throw new Error("Saved view changed.");
			} catch (error) {
				if (!current()) throw error;
				if (!(error instanceof DiscussionFailure) || error.action !== "retry") throw error;
				context = await this.cachedBaseContext(scopeId, recordId);
			}
			if (!current() || !context || context.generation !== generation) throw new Error("Connect to verify this saved target before navigating offline.");
			return context;
		})());
	}
	async captureBaseTarget(scopeId: string, target: BaseTargetSelection): Promise<BaseAnchor> {
		const scope = parseDiscussionScope(scopeId), entry = this.entries.get(scopeId);
		if (!scope?.viewId || entry?.kind !== "base" || !entry.permission?.comment || !this.canAnchorBase(target.type)) throw new Error("Open this saved view with comment permission first.");
		if (target.type === "formula" || target.type === "summary") {
			const catalog = await this.readBaseDefinitions(scopeId);
			const definition = catalog.targets.find(item => item.id === target.definitionId && item.kind === target.type);
			if (!definition || definition.revision !== target.definitionRevision) throw new Error("This definition changed. Choose its current definition before starting another comment. Existing drafts are retained.");
			if (this.closed || !this.canAnchorBase(target.type) || !this.permission(scopeId)?.comment || entry.unavailable ||
				this.documentGeneration(scopeId) !== catalog.generation) throw new Error("Comment access or the saved view changed during capture.");
			return parseAnchor({ version: 1, type: "base", definition_id: catalog.definition_id, view_id: catalog.view_id,
				generation: catalog.generation, registry_revision: catalog.registry_revision,
				target: { type: target.type, definition_id: definition.id, definition_revision: definition.revision,
					property: definition.property, ...(definition.kind === "summary" ? { summary: definition.summary } : {}) } }) as BaseAnchor;
		}
		const recordId = target.type === "item" || target.type === "cell" ? target.recordId : undefined;
		if (recordId !== undefined && !isId(recordId)) throw new Error("The selected record has no synchronized identity.");
		const permissionKey = "baseRecordComment:" + scopeId + ":" + recordId;
		return this.trackLocal((async () => {
			let context: BaseTargetContext | undefined;
			try {
				if (this.statusValue === "offline") throw new DiscussionFailure("retry", "offline_cache");
				context = await this.fetchBaseContext(scopeId, recordId);
				const permission = recordId ? await this.transport.permissions(recordId) : entry.permission;
				if (this.closed) throw new Error("This discussion account is closed.");
				if (recordId) await this.store.setPreference(permissionKey, permission?.read === true && permission.comment);
				if (!permission?.read || !permission.comment) throw new DiscussionFailure("reject", "comment_forbidden", 403);
			} catch (error) {
				if (this.closed) throw error;
				if (!(error instanceof DiscussionFailure) || error.action !== "retry") {
					if (recordId) await this.store.setPreference(permissionKey, false);
					throw error;
				}
				context = await this.cachedBaseContext(scopeId, recordId);
				if (!context || context.generation !== entry.documentGeneration || recordId && await this.store.preference(permissionKey) !== true) throw new Error("Connect once to verify this saved view and record before commenting offline.");
			}
			if (this.closed || !this.canAnchorBase(target.type) || !this.permission(scopeId)?.comment || entry.unavailable ||
				this.documentGeneration(scopeId) !== context.generation) throw new Error("Comment access or the saved view changed while capturing this target. Refresh before trying again.");
			const parsed = parseAnchor({ version: 1, type: "base", definition_id: context.definition_id, view_id: context.view_id,
				generation: context.generation, registry_revision: context.registry_revision, target: target.type === "view" ? { type: "view" } :
				target.type === "property" ? { type: "property", property: target.property } : { type: target.type, record_id: recordId,
					record_generation: context.record_generation, ...(target.type === "cell" ? { property: target.property } : {}) } });
			return parsed as BaseAnchor;
		})());
	}
	/** Complete, account-scoped catalogue. Pagination commits as one proof; stale
	 * successes/denials and resets cannot overwrite another window's newer proof. */
	readBaseDefinitions(scopeId: string): Promise<BaseDefinitionCatalog> {
		const existing = this.baseDefinitionFlights.get(scopeId); if (existing) return existing;
		const scope = parseDiscussionScope(scopeId), generation = this.knownDocumentGeneration(scopeId);
		const current = () => !this.closed && !!generation && this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
		const key = "baseDefinitions:" + scopeId;
		const flight = this.trackLocal((async () => {
			if (!scope?.viewId || !current()) throw new Error("Saved view access is unavailable.");
			const parse = (value: unknown) => parseBaseDefinitionCatalog(value, scope.entryId, scope.viewId!);
			try {
				if (this.statusValue === "offline") throw new DiscussionFailure("retry", "offline_cache");
				const proof = await this.store.beginPreferenceVerification(scopeId, key, uuid());
				let catalog: BaseDefinitionCatalog;
				try { catalog = await this.transport.baseDefinitions(scopeId, scope.viewId); }
				catch (error) {
					if (!this.closed && error instanceof DiscussionFailure && error.action !== "retry") await this.store.finishPreferenceVerification(scopeId, key, proof, null);
					throw error;
				}
				if (!current() || catalog.generation !== generation) throw new Error("Saved view changed during verification.");
				const context = await this.cachedBaseContext(scopeId);
				if (!current() || context?.generation === catalog.generation && context.registry_revision > catalog.registry_revision) throw new Error("Saved definition verification is stale. Refresh the definitions.");
				let previous: BaseDefinitionCatalog | undefined; try { previous = parse(proof.previous); } catch { /* No prior proof. */ }
				if (previous?.generation === catalog.generation && previous.registry_revision > catalog.registry_revision) throw new Error("Saved definition verification is stale.");
				if (!await this.store.finishPreferenceVerification(scopeId, key, proof, protocolJson(catalog))) throw new Error("Saved definition verification changed. Try again.");
				this.observeBaseRevision(scopeId, catalog.generation, catalog.registry_revision);
				return catalog;
			} catch (error) {
				if (!current() || !(error instanceof DiscussionFailure) || error.action !== "retry") throw error;
				let catalog: BaseDefinitionCatalog | undefined;
				try { catalog = parse(await this.store.preference(key)); } catch { /* An incomplete catalogue cannot authorize offline capture. */ }
				const context = await this.cachedBaseContext(scopeId);
				if (!current() || !catalog || catalog.generation !== generation || context?.generation === generation && context.registry_revision > catalog.registry_revision) {
					throw new Error("Connect to verify this view’s definitions before using them offline.");
				}
				return catalog;
			}
		})()).finally(() => { if (this.baseDefinitionFlights.get(scopeId) === flight) this.baseDefinitionFlights.delete(scopeId); });
		this.baseDefinitionFlights.set(scopeId, flight); return flight;
	}
	async baseDefinitionStatus(scopeId: string, anchor: BaseAnchor): Promise<string> {
		if (anchor.target.type !== "formula" && anchor.target.type !== "summary") return "";
		try {
			const catalog = await this.readBaseDefinitions(scopeId), target = anchor.target;
			if (catalog.definition_id !== anchor.definition_id || catalog.generation !== anchor.generation || catalog.view_id !== anchor.view_id) return "This discussion belongs to an earlier saved-view identity. Its original target is retained.";
			const found = catalog.targets.find(item => item.id === target.definition_id && item.kind === target.type);
			if (!found) return this.statusValue === "ready" ? "This definition is no longer available in the saved view. The original discussion is retained." : "This definition is absent from the cached view. Reconnect to verify it.";
			if (found.revision !== target.definition_revision) return "The definition has changed since this discussion was created. The original discussion is retained.";
			return this.statusValue === "ready" ? "Matches the latest verified definition." : "Matches the last verified definition. Reconnect to check for changes.";
		} catch { return "The current definition could not be verified. The original discussion and target are retained."; }
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
		if (operation.type === "picture.upload") parsePictureUpload(operation.payload);
		else queuedEnvelope(this.identity.shareId, operation);
		const retried = await this.trackLocal(this.store.retryRejected(operation.operationId, operation.scopeId, operation.attempt));
		if (!this.closed) { this.broadcast(); this.outbox.wake(); this.notify(); }
		return retried;
	}
	async repairPictures(operation: OutboxOperation): Promise<"accepted" | "requeued"> {
		if (!this.canRepairPictures || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect with picture and comment permission before repairing uploads.");
		queuedEnvelope(this.identity.shareId, operation);
		return this.trackLocal((async () => {
			const current = await this.store.getOperation(operation.operationId);
			if (!current || current.scopeId !== operation.scopeId) throw new Error("Saved comment changed during recovery.");
			if (current.state === "accepted") return "accepted" as const;
			if (current.replacementId) return "requeued" as const;
			const replacements = [];
			for (const oldId of commandPictures(operation.payload)) {
				const source = await this.store.pictureSource(oldId, operation.scopeId);
				if (source) replacements.push({ oldId, newId: uuid() });
			}
			if (!replacements.length) throw new Error("No saved picture originals are available for this comment.");
			if (!this.canRepairPictures || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect before repairing this comment.");
			const outcome = await this.transport.withdraw(operation);
			if (outcome.status === "accepted") { await this.store.accept(operation.operationId, protocolJson(outcome.result)); return "accepted" as const; }
			await this.store.replacePicturesAfterWithdrawal(operation, uuid(), replacements);
			return "requeued" as const;
		})().finally(() => {
			if (!this.closed) { this.broadcast(); this.invalidate(); if (this.foreground) this.outbox.wake(); this.notify(); }
		}));
	}
	async refreshDraftPictures(draft: Pick<Draft, "id" | "scopeId" | "revision">): Promise<Draft> {
		if (!this.canAttachPictures || !this.permission(draft.scopeId)?.comment) throw new Error("Check picture and comment permission before refreshing pictures.");
		return this.trackLocal((async () => {
			const saved = await this.store.getDraft(draft.id);
			if (!saved || saved.scopeId !== draft.scopeId || saved.revision !== draft.revision) throw new Error("Draft changed in another view");
			const replacements = [];
			for (const oldId of pictureIds(saved.body, true)) {
				if (await this.store.pictureSource(oldId, draft.scopeId)) replacements.push({ oldId, newId: uuid() });
			}
			if (!replacements.length) throw new Error("No saved picture originals are available for this draft.");
			if (this.closed) throw new Error("This discussion account is closed.");
			return await this.store.refreshDraftPictures(draft.id, draft.revision, replacements);
		})().finally(() => { if (!this.closed) { this.broadcast(); this.notify(); } }));
	}
	async recoverOnlineDraft(draft: Pick<Draft, "id" | "scopeId" | "revision">): Promise<{ status: "accepted" } | { status: "editable"; draft: Draft }> {
		if (!this.canRecoverOnlineDraft || !this.permission(draft.scopeId)?.comment) throw new Error("Reconnect with comment permission before reviewing this send.");
		return this.trackLocal((async () => {
			const saved = await this.store.getDraft(draft.id), pending = await this.store.preference("online:" + draft.id);
			if (!saved || saved.scopeId !== draft.scopeId || saved.revision !== draft.revision || !isRecord(pending) ||
				pending.revision !== draft.revision || !isRecord(pending.operation) || pending.operation.scopeId !== draft.scopeId ||
				!isId(pending.operation.operationId) || !isRecord(pending.operation.payload) || pending.operation.payload.type !== "reply.create") throw new Error("Online action changed in another view");
			const operation = pending.operation as unknown as OnlineOperation;
			if (!this.canRecoverOnlineDraft || !this.permission(draft.scopeId)?.comment) throw new Error("Reconnect before reviewing this send.");
			const result = await this.transport.withdrawOnline(operation);
			if (result.status === "accepted") {
				await this.store.completeOnlineDraft(draft.id, draft.revision, operation.operationId); return { status: "accepted" as const };
			}
			return { status: "editable" as const, draft: await this.store.withdrawOnlineDraft(draft.id, draft.revision, operation) };
		})().finally(() => { if (!this.closed) { this.broadcast(); this.invalidate(); this.notify(); } }));
	}
	async onlineDraft(draft: Pick<Draft, "id" | "revision">, operation: OnlineOperation): Promise<void> {
		if (!this.online || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect before changing this discussion.");
		await this.trackLocal((async () => {
			const saved = await this.store.getDraft(draft.id);
			if (!saved || saved.scopeId !== operation.scopeId || saved.revision !== draft.revision) throw new Error("Draft changed in another view");
			// Upload before locking the online receipt. A rejected picture leaves the
			// draft editable; a lost reply acknowledgment retries the exact command.
			if (!await this.store.preference("online:" + draft.id)) {
				for (const pictureId of commandPictures(operation.payload)) {
					const source = await this.store.pictureSource(pictureId, operation.scopeId);
					if (!source) continue; // Existing published picture; the server checks scope/access.
					if (!this.online || !this.canAttachPictures || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect and check picture permission before sending.");
					await this.transport.uploadPicture(operation.scopeId, { type: "picture.upload", picture_id: pictureId, sha256: source.sha256, size: source.size }, source.bytes);
				}
			}
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
