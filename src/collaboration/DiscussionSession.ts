import { restoreGeneration, type RestoreBinding } from "./RestoreGeneration";
import { saveDiscussionExport, saveDiscussionCollection } from "./DiscussionExport";
import { parseTimelineAxisContext, type TimelineAxisContext } from "./TimelineRangeProtocol";
import { baseRecordIds, parseBaseRecordContexts, type BaseRecordContexts } from "./BaseRecordContexts";
import { parseTimelineMarkerCatalog, timelineMarkerAnchor, type TimelineMarkerCatalog } from "./TimelineMarkerProtocol";
import { TimelineMarkerManagement } from "./TimelineMarkerManagement";
import { parseTimelineMarkerVersion, type TimelineMarkerVersion } from "./DiscussionProtocol";
import type { HistoryWindow } from "./DiscussionProtocol";
import { parseTimelineRange, validateTimelineTimeZone, type TimelineRange } from "./TimelineRange";
import { v4 as uuid } from "uuid";
import { parseLocalDiscussionAnchor, parsePendingBaseGroupCommand, prepareBaseGroupCommand, resolvePendingBaseGroupAnchor, type PendingBaseGroupAnchor, type LocalDiscussionAnchor } from "./LocalDiscussionAnchor";
import { DiscussionReattachment } from "./DiscussionReattachment";
import { saveLocalWorkRecovery, type LocalWorkIO } from "./LocalWorkRecovery";
import { restoreLocalDraft } from "./LocalDraftImport";
import { savedCommandReview } from "./SavedCommandReview";
import type { InspectedLocalWork, LocalWorkImportIO } from "./LocalWorkImport";
import { copySavedDraft, reviewSavedDraftCopy, type SavedDraftCopyReview } from "./SavedDraftCopy";
import type { ReviewedAbandonment } from "./storage/DiscussionStore";
import { editableCommentDraft } from "./ui/CommentDraft";
import { parseBody } from "./DiscussionProtocol";
import { BASE_FILE_GROUP_PROPERTIES, copyBaseGroupCapture, type BaseGroupSelection } from "./BaseGroupProtocol";
import { parseBaseGroupValue } from "./BaseGroupValue";
import { DiscussionOutbox } from "./DiscussionOutbox";
import { DiscussionInbox } from "./DiscussionInbox";
import { inboxScope, type InboxItem } from "./InboxProtocol";
import { searchItemScope, searchRequest, type DiscussionSearchRequest, type DiscussionSearchPage } from "./DiscussionSearchProtocol";
import { DiscussionDelivery } from "./DiscussionDelivery";
import { DiscussionPictures } from "./DiscussionPictures";
import { parsePictureUpload, pictureIds } from "./PictureProtocol";
import { commandPictures } from "./storage/PictureRecords";
import { DiscussionSync, messagePrefix, messageKey, threadKey, type SyncStatus } from "./DiscussionSync";
import { DiscussionFailure, DiscussionTransport, queuedEnvelope, type DiscussionParticipant, type DiscussionPermissions, type OnlineOperation } from "./DiscussionTransport";
import { BASE_TARGET_KINDS, isId, isRecord, parseAnchor, parseBaseTargetContext, sourceAnchor, parseMessage, parseThread, protocolJson, type BaseAnchor, type BaseProperty, type BaseTargetContext, type BaseTargetKind, type DiscussionAnchor, type DiscussionMessage, type ThreadSummary } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";
import { BASE_RECORD_TYPES, isBaseRecordType, type BaseRecordType } from "./DiscussionProtocol";
import { DiscussionStore, type Draft, type OutboxOperation, type QueuedCommand, type StoreIdentity, type PreferenceVerification } from "./storage/DiscussionStore";
import { parseBaseDefinitionCatalog, supportsBaseGroupDefinition, type BaseDefinitionCatalog } from "./BaseDefinitionProtocol";

export type SessionStatus = "starting" | "ready" | "offline" | "unavailable" | "authentication_required" | "error" | "closed";
type Entry = { kind: "note" | "image" | "base"; listeners: Set<() => void>; sync: DiscussionSync; permission?: DiscussionPermissions; documentGeneration?: string;
	baseRegistryRevision?: number;
	permissionFlight?: Promise<void>; permissionRestoreFlight?: Promise<void>; permissionChecked: number; unavailable: boolean; people: DiscussionParticipant[] };
export type AnchoredThread = ThreadSummary & { anchor?: DiscussionAnchor };
export type DiscussionLocalView = { threads: AnchoredThread[]; pending: OutboxOperation[]; hasMore: boolean; nextAfter: number };
export type BaseTargetSelection = { type: "view" } | { type: "property"; property: BaseProperty } |
	{ type: "item"; recordId: string } | { type: "cell"; recordId: string; property: BaseProperty } |
	{ type: "formula_cell"; recordId: string; definitionId: string; definitionRevision: number } |
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
	readonly inbox: DiscussionInbox;
	readonly pictures = new DiscussionPictures(this);
	readonly markerManagement = new TimelineMarkerManagement(this, (scopeId, status) => {
		if (status === "accepted" && !this.closed) {
			const baseId = parseDiscussionScope(scopeId)?.entryId;
			for (const [id, entry] of this.entries) if (baseId && parseDiscussionScope(id)?.entryId === baseId) {
				this.timelineMarkerVersions.delete(id); this.timelineMarkerFreshUntil.delete(id); entry.sync.wake();
			}
		}
		if (!this.closed) { this.invalidate(); this.broadcast(); this.notify(); }
	});
	private entries = new Map<string, Entry>();
	private listeners = new Set<() => void>();
	private foreground = true;
	private closed = false;
	private startFlight?: Promise<void>;
	private onlineFlights = new Set<Promise<unknown>>();
	private channel?: BroadcastChannel;
	private discardedDraftListeners = new Set<(id: string) => void>();
	private statusValue: SessionStatus = "starting";
	private authenticationEpoch = 0;
	private restoreLineage: string | null = null;
	private restoreReconciling = false;
	private restoreLoaded = false;
	private enabled = false;
	private textEnabled = false;
	private blocksEnabled = false;
	private imagesEnabled = false;
	private imageFilesEnabled = false;
	private picturesEnabled = false;
	private recoveryEnabled = false;
	private commandStatusEnabled = false;
	private moderationRecoveryEnabled = false;
	private inboxEnabled = false;
	private searchEnabled = false;
	private exportEnabled = false;
	private exportCatalogEnabled = false;
	private exporting = false;
	private reattachEnabled = false;
	private reattachments: DiscussionReattachment;
	private baseKinds: BaseTargetKind[] = [];
	private baseFileGroupProperties: string[] = [];
	private baseFormulaGroups = false;
	private baseContextFlights = new Map<string, Promise<BaseTargetContext>>();
	private verifiedTargetCatalogs = new WeakMap<object, { epoch: number; at: number }>();
	private baseRecordFlights = new Map<string, Promise<BaseRecordContexts>>();
	private baseDefinitionFlights = new Map<string, Promise<BaseDefinitionCatalog>>();
	private timelineAxisFlights = new Map<string, Promise<TimelineAxisContext>>();
	private timelineMarkerFlights = new Map<string, Promise<TimelineMarkerCatalog>>();
	private timelineMarkerVersions = new Map<string, TimelineMarkerVersion>();
	private timelineMarkerFreshUntil = new Map<string, number>();
	private baseRecordTypes: BaseRecordType[] = [];
	private lastPublish = 0;

	constructor(readonly store: DiscussionStore, readonly transport: DiscussionTransport) {
		this.reattachments = new DiscussionReattachment(store, transport);
		this.inbox = new DiscussionInbox(store, transport, broadcast => { if (broadcast) this.channel?.postMessage("inbox"); this.notify(); });
		this.outbox = new DiscussionOutbox(store, new DiscussionDelivery(store, transport, () => this.picturesEnabled), uuid(), status => {
			if (this.closed) return;
			if (status === "authentication_required") { this.requireAuthentication(); return; }
			if (this.statusValue === "authentication_required") return;
			if (status === "protocol_error" || status === "storage_error") this.statusValue = "error";
			if (status === "idle") { this.invalidate(); this.broadcast(); }
			this.notify();
		});
		// Only invalidation signals cross windows; never bodies or credentials.
		if (typeof BroadcastChannel !== "undefined") {
			this.channel = new BroadcastChannel("team-relay-discussion-wake:" + JSON.stringify([
				store.identity.serverId, store.identity.accountId, store.identity.vaultId, store.identity.shareId]));
			this.channel.onmessage = event => {
				if (!this.closed && isRecord(event.data) && event.data.type === "draft-discarded" && typeof event.data.id === "string" && event.data.id.length <= 512) {
					this.draftDiscarded(event.data.id, false); return;
				}
				if (event.data === "restore" && !this.closed) {
					const pending = this.startFlight ?? Promise.resolve();
					void this.pauseForRestore().then(() => pending).then(() => this.start()).catch(() => {}); return;
				}
				if (event.data === "inbox" && !this.closed) { void this.inbox.reload(); return; }
				if (event.data === "cache" && !this.closed) { this.notify(); return; }
				if (event.data !== "changed" || this.closed) return;
				if (this.foreground && this.enabled) this.outbox.wake();
				this.invalidate(); this.notify();
			};
		}
	}
	get identity(): Readonly<StoreIdentity> { return this.store.identity; }
	async setPictureCacheLimit(limit: number): Promise<void> {
		if (this.closed) throw new Error("This discussion account is closed.");
		await this.trackLocal(this.store.setPictureCacheLimit(limit));
		if (!this.closed) { this.channel?.postMessage("cache"); this.notify(); }
	}
	async clearDownloadedPictures(): Promise<void> {
		if (this.closed) throw new Error("This discussion account is closed.");
		await this.trackLocal(this.store.clearDownloadedPictures());
		if (!this.closed) { this.channel?.postMessage("cache"); this.notify(); }
	}
	async saveLocalWorkRecovery(io: LocalWorkIO, visible: () => boolean, retainedId?: string, progress?: (text: string) => void): Promise<string> {
		if (this.closed) throw new Error("This discussion account is closed.");
		return this.trackLocal(saveLocalWorkRecovery(this.store, io, () => !this.closed && visible(), retainedId, progress)
			.finally(() => { if (!this.closed) { this.channel?.postMessage("cache"); this.notify(); } }));
	}
	async restoreLocalDraft(io: LocalWorkImportIO, copy: InspectedLocalWork, draftId: string, visible: () => boolean, progress?: (text: string) => void) {
		if (this.closed) throw new Error("This discussion account is closed.");
		return this.trackLocal(restoreLocalDraft(this.store, io, copy, draftId, () => !this.closed && visible(), progress)
			.finally(() => { if (!this.closed) { this.channel?.postMessage("cache"); this.notify(); } }));
	}
	canCopySavedDraft(scopeId: string, target?: LocalDiscussionAnchor): boolean {
		const generation = target?.type === "base_group_pending" ? target.capture.generation : target?.type === "base" || target?.type === "image_file" ? target.generation : target ? sourceAnchor(target)?.generation : undefined;
		return this.canQueue && this.permission(scopeId)?.read === true && this.permission(scopeId)?.comment === true && (generation === undefined || generation === this.knownDocumentGeneration(scopeId));
	}
	async reviewSavedDraftCopy(sourceId: string, scopeId: string, target: LocalDiscussionAnchor, active: string | undefined, visible: () => boolean): Promise<SavedDraftCopyReview> {
		const epoch = this.authenticationEpoch, generation = this.knownDocumentGeneration(scopeId);
		const current = () => visible() && this.canCopySavedDraft(scopeId, target) && epoch === this.authenticationEpoch && generation === this.knownDocumentGeneration(scopeId);
		if (!current()) throw new Error("Open a writable comment target before copying saved work.");
		return this.trackLocal(reviewSavedDraftCopy(this.store, sourceId, scopeId, target, active, current));
	}
	async copySavedDraft(review: SavedDraftCopyReview, destinationId: string, omitMissing: boolean, visible: () => boolean) {
		const scopeId = review.destinationScope, epoch = this.authenticationEpoch, generation = this.knownDocumentGeneration(scopeId);
		const current = () => visible() && this.canCopySavedDraft(scopeId, review.target) && epoch === this.authenticationEpoch && generation === this.knownDocumentGeneration(scopeId);
		if (!current()) throw new Error("Open a writable comment target before copying saved work.");
		return this.trackLocal(copySavedDraft(this.store, review, destinationId, omitMissing, current)
			.finally(() => { if (!this.closed) { this.channel?.postMessage("cache"); this.notify(); } }));
	}
	async saveDiscussionExport(scopeId: string, io: LocalWorkIO, visible: () => boolean, includePictures = true, progress?: (text: string) => void): Promise<string> {
		if (!this.canExport || !this.permission(scopeId)?.read) throw new Error("Connect and open readable comments on a server with discussion export enabled.");
		if (this.exporting) throw new Error("Another discussion export is running. Wait for it to finish.");
		const epoch = this.authenticationEpoch, generation = this.knownDocumentGeneration(scopeId);
		let valid = true;
		const current = () => valid && visible() && this.canExport && epoch === this.authenticationEpoch &&
			this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
		const stop = this.onChange(() => { if (!current()) valid = false; });
		this.exporting = true;
		return this.trackLocal(saveDiscussionExport(this.transport, { ...this.transport.identity, scopeId }, io, current, includePictures, progress)
			.catch(error => {
				if (!this.closed && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				throw error;
			}).finally(() => { stop(); this.exporting = false; }));
	}

	async saveDiscussionCollection(io: LocalWorkIO, visible: () => boolean, includePictures = true, progress?: (text: string) => void): Promise<string> {
		if (!this.canExportCollection) throw new Error("Connect to a server with shared-folder discussion export enabled.");
		if (this.exporting) throw new Error("Another discussion export is running. Wait for it to finish.");
		const epoch = this.authenticationEpoch;
		let valid = true;
		const current = () => valid && visible() && this.canExportCollection && epoch === this.authenticationEpoch;
		const stop = this.onChange(() => { if (!current()) valid = false; }); this.exporting = true;
		return this.trackLocal(saveDiscussionCollection(this.transport, this.transport.identity, io, current, includePictures, progress)
			.catch(error => {
				if (!this.closed && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				throw error;
			}).finally(() => { stop(); this.exporting = false; }));
	}

	async releaseLocalWorkRecovery(id: string): Promise<void> {
		if (this.closed) throw new Error("This discussion account is closed.");
		if (!await this.trackLocal(this.store.releaseLocalWork(id))) throw new Error("The retained capture changed in another window. Refresh before reviewing it.");
		if (!this.closed) { this.channel?.postMessage("cache"); this.notify(); }
	}
	onDraftDiscarded(listener: (id: string) => void): () => void {
		if (this.closed) return () => {};
		this.discardedDraftListeners.add(listener); return () => { this.discardedDraftListeners.delete(listener); };
	}
	private draftDiscarded(id: string, broadcast = true): void {
		if (this.closed) return;
		for (const listener of this.discardedDraftListeners) listener(id);
		if (broadcast) this.channel?.postMessage({ type: "draft-discarded", id });
		this.notify();
	}
	async discardDraft(draft: Draft, visible: () => boolean): Promise<void> {
		const epoch = this.authenticationEpoch, current = () => !this.closed && visible() && epoch === this.authenticationEpoch;
		if (!current()) throw new Error("This draft review is closed.");
		if (!await this.trackLocal(this.store.removeDraft(draft.id, draft.revision, draft, current))) throw new Error("This draft changed after review. Nothing was discarded; reopen it and review again.");
		this.draftDiscarded(draft.id);
	}
	get status(): SessionStatus { return this.statusValue; }
	get restoreBinding(): RestoreBinding { return this.restoreLineage === null ? {} : { restoreGeneration: this.restoreLineage }; }
	get canQueue(): boolean { return !this.closed && !this.restoreReconciling && this.enabled && !["unavailable", "authentication_required", "error"].includes(this.statusValue); }
	get online(): boolean { return !this.closed && !this.restoreReconciling && this.foreground && this.statusValue === "ready"; }
	get canExportCollection(): boolean { return this.canExport && this.exportCatalogEnabled; }
	get canExport(): boolean { return this.online && this.exportEnabled; }
	get canSearch(): boolean { return this.online && this.searchEnabled; }
	get canReattach(): boolean { return this.online && this.reattachEnabled; }
	get canRecoverSavedCommand(): boolean { return this.online && this.recoveryEnabled; }
	get canCheckSavedCommand(): boolean { return this.online && this.commandStatusEnabled; }
	/** Receipt inspection needs no cached source note, and never alters the queue. */
	checkSavedCommand(operation: QueuedCommand & Pick<OutboxOperation, "preparedAnchor">, visible: () => boolean) {
		return this.trackLocal((async () => {
			const epoch = this.authenticationEpoch, current = () => visible() && this.canCheckSavedCommand && epoch === this.authenticationEpoch;
			if (!current()) throw new Error("Connect to a server that supports receipt inspection before checking this saved request.");
			const review = savedCommandReview(operation, this.identity.shareId);
			try { return await this.transport.commandStatus(review.operation, current); }
			catch (error) {
				if (epoch === this.authenticationEpoch && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				throw error;
			}
		})());
	}
	canReviewRemoved(scopeId: string): boolean { return this.online && this.moderationRecoveryEnabled && this.permission(scopeId)?.read === true && this.permission(scopeId)?.moderate === true; }
	/** Explicit administrative reads never enter the normal cache or outbox. */
	private reviewRead<T>(scopeId: string, visible: () => boolean, read: (current: () => boolean) => Promise<T>): Promise<T> {
		return this.trackLocal((async () => {
			const epoch = this.authenticationEpoch, generation = this.knownDocumentGeneration(scopeId);
			const current = () => visible() && this.canReviewRemoved(scopeId) && this.authenticationEpoch === epoch && this.knownDocumentGeneration(scopeId) === generation;
			if (!parseDiscussionScope(scopeId) || !current()) throw new Error("Connect with moderator access to review removed comments.");
			const checkpoint = await this.store.checkpoint(scopeId);
			try {
				if (!current()) throw new Error("This recovery review is no longer available.");
				const value = await read(current);
				const latest = await this.store.checkpoint(scopeId);
				if (!current() || checkpoint.generation !== latest.generation) throw new Error("Recovery access changed. Start a new review.");
				return value;
			} catch (error) {
				if (!this.closed && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				throw error;
			}
		})());
	}
	reviewRemovedCatalog(scopeId: string, reason: string, after: number, visible: () => boolean) {
		return this.reviewRead(scopeId, visible, current => this.transport.moderationCatalog(scopeId, reason, after, 20, current));
	}
	reviewRemovedHistory(scopeId: string, threadId: string, messageId: string, reason: string, after: number, visible: () => boolean) {
		return this.reviewRead(scopeId, visible, current => this.transport.moderationHistory(scopeId, threadId, messageId, reason, after, 10, current));
	}
	reviewRemovedPicture(scopeId: string, threadId: string, messageId: string, pictureId: string, reason: string, variant: "content" | "thumbnail", visible: () => boolean) {
		return this.reviewRead(scopeId, visible, async current => {
			const metadata = await this.transport.moderationPicture(scopeId, threadId, messageId, pictureId, reason, current);
			if (!current()) throw new Error("Recovery access changed.");
			const rendition = metadata.picture.renditions[variant];
			if (!rendition) throw new Error("This retained picture is unavailable.");
			const content = await this.transport.moderationPictureContent(scopeId, threadId, messageId, pictureId, reason, variant, rendition, current);
			return { ...content, ...rendition };
		});
	}
	async search(input: DiscussionSearchRequest): Promise<DiscussionSearchPage> {
		const request = searchRequest(input);
		if (!this.canSearch) throw new Error("Connect to a server with comment search enabled.");
		const authenticationEpoch = this.authenticationEpoch;
		return this.trackLocal((async () => {
			try {
				const page = await this.transport.search(request);
				if (!this.canSearch || authenticationEpoch !== this.authenticationEpoch) throw new Error("Search access changed. Search again after connecting.");
				return { ...page, items: page.items.filter(item => {
					const entry = this.entries.get(searchItemScope(item));
					return !entry?.unavailable && entry?.permission?.read !== false;
				}) };
			} catch (error) {
				if (!this.closed && error instanceof DiscussionFailure && error.action === "authenticate") {
					this.requireAuthentication();
				}
				throw error;
			}
		})());
	}
	get canAnchorText(): boolean { return this.canQueue && this.textEnabled; }
	get canAnchorImages(): boolean { return this.canAnchorText && this.imagesEnabled; }
	get canAnchorImageFiles(): boolean { return this.canQueue && this.imageFilesEnabled; }
	get canAnchorBlocks(): boolean { return this.canAnchorText && this.blocksEnabled; }
	get canAttachPictures(): boolean { return this.canQueue && this.picturesEnabled; }
	get canRepairPictures(): boolean { return this.online && this.canAttachPictures && this.recoveryEnabled; }
	get canRecoverOnlineDraft(): boolean { return this.online && this.recoveryEnabled; }
	canAnchorBase(kind: BaseTargetKind): boolean { return this.canQueue && this.baseKinds.includes(kind); }
	canAnchorBaseGroup(property: { source: string; name: string }): boolean {
		return this.canAnchorBase("group") && (property.source === "note" || property.source === "file" && this.baseFileGroupProperties.includes(property.name.toLowerCase()) ||
			property.source === "formula" && this.baseFormulaGroups);
	}
	baseRegistryRevision(scopeId: string): number { return this.entries.get(scopeId)?.baseRegistryRevision ?? 0; }
	private observeBaseRevision(scopeId: string, generation: string, revision: number): void {
		const entry = this.entries.get(scopeId);
		if (entry?.documentGeneration === generation && (entry.baseRegistryRevision ?? 0) < revision) {
			entry.baseRegistryRevision = revision; this.notify();
		}
	}
	canAnchorBaseRecord(kind: unknown): boolean {
		return (this.canAnchorBase("item") || this.canAnchorBase("cell") || this.canAnchorBase("formula_cell")) && isBaseRecordType(kind) && this.baseRecordTypes.includes(kind);
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
	private requireAuthentication(): void {
		if (this.closed) return;
		this.authenticationEpoch++; this.statusValue = "authentication_required";
		this.outbox.stop(); for (const entry of this.entries.values()) entry.sync.stop();
		void this.inbox.configure(this.inboxEnabled, "blocked", this.foreground).catch(() => {});
		this.notify();
	}
	private broadcast(): void {
		// A wake in another window can end in idle with no work; do not echo it.
		if (Date.now() - this.lastPublish > 1000) { this.lastPublish = Date.now(); this.channel?.postMessage("changed"); }
	}
	private invalidate(): void {
		for (const entry of this.entries.values()) if (this.foreground) entry.sync.wake();
	}

	/** Invalidate synchronous UI intent and drain old readers before reauthorizing.
	 * Local work stays in the store; only derived in-memory authority is cleared. */
	private async pauseForRestore(): Promise<void> {
		this.restoreReconciling = true; this.authenticationEpoch++; this.statusValue = "starting";
		this.outbox.stop();
		const flights: Promise<unknown>[] = [this.outbox.settled(), this.inbox.configure(this.inboxEnabled, "blocked", this.foreground)];
		for (const entry of this.entries.values()) {
			entry.sync.stop(); flights.push(entry.sync.settled());
			if (entry.permissionFlight) flights.push(entry.permissionFlight);
			entry.permission = undefined; entry.people = []; entry.documentGeneration = undefined;
			entry.baseRegistryRevision = undefined; entry.permissionChecked = 0;
		}
		for (const map of [this.baseContextFlights, this.baseRecordFlights, this.baseDefinitionFlights, this.timelineAxisFlights, this.timelineMarkerFlights]) flights.push(...map.values());
		this.verifiedTargetCatalogs = new WeakMap(); this.timelineMarkerVersions.clear(); this.timelineMarkerFreshUntil.clear();
		this.notify(); await Promise.allSettled(flights);
	}

	start(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.startFlight) return this.startFlight;
		this.startFlight = this.initialize().finally(() => { this.startFlight = undefined; });
		return this.startFlight;
	}
	private async initialize(): Promise<void> {
		let authenticationEpoch = this.authenticationEpoch;
		const requiredAuthentication = this.statusValue === "authentication_required";
		try {
			const checkpoint = await this.store.restoreCheckpoint();
			if (this.closed || authenticationEpoch !== this.authenticationEpoch) return;
			if (this.restoreLoaded && this.restoreLineage !== checkpoint.context.generation) {
				const draining = this.pauseForRestore(); authenticationEpoch = this.authenticationEpoch;
				await draining;
				if (this.closed || authenticationEpoch !== this.authenticationEpoch) return;
			}
			this.restoreLineage = checkpoint.context.generation; this.restoreLoaded = true;
			const cached = await this.store.preference("enabled");
			if (this.closed) return;
			this.enabled = cached === true;
			this.textEnabled = await this.store.preference("textAnchorsEnabled") === true;
			this.blocksEnabled = await this.store.preference("blockAnchorsEnabled") === true;
			this.imagesEnabled = await this.store.preference("imageOccurrencesEnabled") === true;
			this.imageFilesEnabled = await this.store.preference("imageFilesEnabled") === true;
			this.picturesEnabled = await this.store.preference("picturesEnabled") === true;
			this.inboxEnabled = await this.store.preference("inboxEnabled") === true;
			const baseKinds = await this.store.preference("baseTargetKinds");
			this.baseKinds = Array.isArray(baseKinds) ? BASE_TARGET_KINDS.filter(kind => baseKinds.includes(kind)) : [];
			const recordTypes = await this.store.preference("baseRecordTypes");
			this.baseRecordTypes = Array.isArray(recordTypes) ? BASE_RECORD_TYPES.filter(kind => recordTypes.includes(kind)) : ["markdown"];
			const fileGroupProperties = await this.store.preference("baseFileGroupProperties");
			this.baseFileGroupProperties = Array.isArray(fileGroupProperties) ? BASE_FILE_GROUP_PROPERTIES.filter(name => fileGroupProperties.includes(name)) : [];
			this.baseFormulaGroups = await this.store.preference("baseFormulaGroups") === true;
			if (this.closed || authenticationEpoch !== this.authenticationEpoch) return;
			const capability = await this.transport.capabilities();
			if (this.closed || authenticationEpoch !== this.authenticationEpoch) return;
			const changed = restoreGeneration(capability.restoreContext?.generation) !== checkpoint.context.generation;
			let draining: Promise<void> | undefined;
			if (changed) { draining = this.pauseForRestore(); authenticationEpoch = this.authenticationEpoch; }
			const observed = await this.store.observeRestoreContext(capability.restoreContext, checkpoint.revision,
				() => !this.closed && authenticationEpoch === this.authenticationEpoch);
			if (observed.changed) this.channel?.postMessage("restore");
			this.restoreLineage = observed.checkpoint.context.generation;
			await draining;
			if (this.restoreReconciling) await this.inbox.reload();
			if (this.closed || authenticationEpoch !== this.authenticationEpoch) return;
			this.enabled = capability.discussions;
			this.textEnabled = capability.textAnchors === true;
			this.blocksEnabled = capability.blockAnchors === true;
			this.imagesEnabled = capability.imageOccurrences === true;
			this.imageFilesEnabled = capability.imageFiles === true;
			this.picturesEnabled = capability.pictures === true;
			this.recoveryEnabled = capability.recovery === true;
			this.commandStatusEnabled = capability.commandStatus === true;
			this.moderationRecoveryEnabled = capability.moderationRecovery === true;
			this.inboxEnabled = capability.inbox === true;
			this.searchEnabled = capability.search === true;
			this.exportEnabled = capability.export === true;
			this.exportCatalogEnabled = capability.exportCatalog === true;
			this.reattachEnabled = capability.reattach === true;
			this.baseKinds = capability.baseTargets ?? [];
			this.baseRecordTypes = capability.baseRecordTypes ?? ["markdown"];
			this.baseFileGroupProperties = capability.baseFileGroupProperties ?? [];
			this.baseFormulaGroups = capability.baseFormulaGroups === true;
			await this.store.setPreference("enabled", this.enabled);
			await this.store.setPreference("textAnchorsEnabled", this.textEnabled);
			await this.store.setPreference("blockAnchorsEnabled", this.blocksEnabled);
			await this.store.setPreference("imageOccurrencesEnabled", this.imagesEnabled);
			await this.store.setPreference("imageFilesEnabled", this.imageFilesEnabled);
			await this.store.setPreference("picturesEnabled", this.picturesEnabled);
			await this.store.setPreference("inboxEnabled", this.inboxEnabled);
			await this.store.setPreference("baseTargetKinds", protocolJson(this.baseKinds));
			await this.store.setPreference("baseRecordTypes", protocolJson(this.baseRecordTypes));
			await this.store.setPreference("baseFileGroupProperties", protocolJson(this.baseFileGroupProperties));
			await this.store.setPreference("baseFormulaGroups", this.baseFormulaGroups);
			if (this.closed || authenticationEpoch !== this.authenticationEpoch) return;
			this.statusValue = this.enabled ? "ready" : "unavailable";
		} catch (error) {
			if (this.closed || authenticationEpoch !== this.authenticationEpoch) return;
			if (error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
			else if (!requiredAuthentication) this.statusValue = error instanceof DiscussionFailure ? error.action === "retry" ? "offline" : "unavailable" : "error";
		}
		if (this.closed) return;
		this.restoreReconciling = false;
		await this.inbox.configure(this.enabled && this.inboxEnabled, this.statusValue === "ready" ? "online" : this.statusValue === "offline" ? "offline" : "blocked", this.foreground).catch(() => {});
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
				() => this.reauthorizeAfterReset(entryId), version => this.observeTimelineMarkerVersion(entryId, version));
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
		if (this.closed || this.restoreReconciling) return;
		const entry = this.entries.get(id);
		if (entry && status === "unavailable") { entry.unavailable = true; entry.permission = undefined; entry.people = []; entry.documentGeneration = undefined; }
		if (status === "unavailable") void this.inbox.forgetScope(id).catch(() => {});
		if (status === "authentication_required") { this.requireAuthentication(); return; }
		if (this.statusValue === "authentication_required") return;
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
		const epoch = this.authenticationEpoch;
		const cached = await this.store.preference("permission:" + id);
		if (this.closed || epoch !== this.authenticationEpoch || this.restoreReconciling) return;
		if (isRecord(cached) && ["read", "comment", "edit", "moderate"].every(key => typeof cached[key] === "boolean")) {
			entry.permission = cached as unknown as DiscussionPermissions;
		}
		const people = await this.store.preference("people:" + id);
		if (this.closed || epoch !== this.authenticationEpoch || this.restoreReconciling) return;
		if (Array.isArray(people) && people.every(p => isRecord(p) && typeof p.id === "string" && typeof p.name === "string")) {
			entry.people = people as unknown as DiscussionParticipant[];
		}
		const generation = await this.store.preference("documentGeneration:" + id);
		if (this.closed || epoch !== this.authenticationEpoch || this.restoreReconciling) return;
		entry.documentGeneration = isId(generation) ? generation : undefined;
		this.notify();
	}
	private refreshPermission(id: string, entry: Entry): Promise<void> {
		if (this.closed || this.restoreReconciling || !this.foreground || this.statusValue === "authentication_required" || entry.listeners.size === 0) return Promise.resolve();
		if (entry.permissionFlight) return entry.permissionFlight;
		const epoch = this.authenticationEpoch;
		const current = () => !this.closed && !this.restoreReconciling && epoch === this.authenticationEpoch;
		entry.permissionFlight = (async () => {
			let permissionProof: PreferenceVerification | undefined;
			try {
				if (!entry.permission) {
					entry.permissionRestoreFlight = this.restorePermission(id, entry);
					try { await entry.permissionRestoreFlight; } finally { entry.permissionRestoreFlight = undefined; }
				}
				if (!this.enabled || !current()) return;
				permissionProof = await this.store.beginPreferenceVerification(id, "permission:" + id, uuid());
				if (!current()) return;
				const permission = await this.transport.permissions(id);
				if (!current() || !await this.store.finishPreferenceVerification(id, "permission:" + id, permissionProof, protocolJson(permission), current)) return;
				if (!current()) return;
				entry.permission = permission; entry.unavailable = !permission.read;
				if (permission.read) {
					if (entry.kind === "base" ? this.baseKinds.length > 0 : entry.kind === "image" ? this.imageFilesEnabled : this.textEnabled) {
						const proof = await this.store.beginPreferenceVerification(id, "documentGeneration:" + id, uuid());
						try {
							if (!current()) return;
							const context = entry.kind === "base" ? await this.fetchBaseContext(id) : await this.transport.anchorContext(id);
							if (!current() || !await this.store.finishPreferenceVerification(id, "documentGeneration:" + id, proof, context.generation, current)) return;
							if (!current()) return;
							if (entry.documentGeneration !== context.generation) entry.baseRegistryRevision = undefined;
							entry.documentGeneration = context.generation;
							if ("registry_revision" in context) this.observeBaseRevision(id, context.generation, context.registry_revision);
						} catch (error) {
							if (!current()) return;
							// Transient failure retains verified offline authority. A stale
							// pre-restore response cannot erase a newer window's context.
							if (!(error instanceof DiscussionFailure) || error.action !== "retry") {
								if (!await this.store.finishPreferenceVerification(id, "documentGeneration:" + id, proof, null, current)) return;
								entry.documentGeneration = undefined;
							}
							if (error instanceof DiscussionFailure && (error.action === "authenticate" ||
								error.action === "reject" && [403, 404].includes(error.status))) throw error;
						}
					}
					try {
						const proof = await this.store.beginPreferenceVerification(id, "people:" + id, uuid());
						const people: DiscussionParticipant[] = []; let after: string | undefined;
						for (let page = 0; page < 20 && current(); page++) {
							const result = await this.transport.participants(id, after);
							people.push(...result.participants); after = result.nextAfter;
							if (!result.hasMore) break;
						}
						if (current() && await this.store.finishPreferenceVerification(id, "people:" + id, proof, protocolJson(people), current) && current()) entry.people = people;
					} catch { /* Stable fallbacks remain until the directory can refresh. */ }
				} else {
					entry.people = []; entry.documentGeneration = undefined;
					if (await this.store.clearRemoteScope(id, undefined, permissionProof.generation) && current()) await this.inbox.forgetScope(id);
				}
			} catch (error) {
				if (!current()) return;
				if (error instanceof DiscussionFailure && [403, 404].includes(error.status)) {
					entry.permission = undefined; entry.unavailable = true; entry.people = []; entry.documentGeneration = undefined;
					if (permissionProof && await this.store.clearRemoteScope(id, undefined, permissionProof.generation) && current()) await this.inbox.forgetScope(id);
				} else if (error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
			} finally {
				entry.permissionFlight = undefined;
				if (current()) {
					entry.permissionChecked = Date.now();
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
		this.inbox.setForeground(foreground);
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
		return !this.closed && this.permission(entryId)?.read && row && isRecord(row.value) && !row.value.removed ? storedThread(row.value) : undefined;
	}
	async inboxThread(item: InboxItem): Promise<AnchoredThread | undefined> {
		return (await this.linkedThread(inboxScope(item), item.thread_id))?.thread;
	}
	async cachedMessage(scopeId: string, threadId: string, messageId: string): Promise<DiscussionMessage | undefined> {
		if (this.closed || !isId(threadId) || !isId(messageId) || !this.permission(scopeId)?.read) return;
		const row = await this.store.entity(scopeId, messageKey(threadId, messageId));
		return !this.closed && this.permission(scopeId)?.read && row ? parseMessage(row.value) : undefined;
	}
	/** History stays in the open view only. Fetch a selected revision and its
	 * predecessor, after checking the current message and original saved view. */
	async historyWindow(scopeId: string, threadId: string, messageId: string, selected?: number): Promise<HistoryWindow> {
		if (!parseDiscussionScope(scopeId) || !isId(threadId) || !isId(messageId) ||
			selected !== undefined && (!Number.isSafeInteger(selected) || selected < 1)) throw new Error("Invalid history target.");
		return this.trackLocal((async () => {
			const generation = this.knownDocumentGeneration(scopeId);
			const authenticationEpoch = this.authenticationEpoch;
			const current = () => authenticationEpoch === this.authenticationEpoch && this.online && this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
			if (!current()) throw new Error("Reconnect with read access to view comment history.");
			const checkpoint = await this.store.checkpoint(scopeId);
			try {
				if (!current()) throw new Error("History access changed.");
				const head = await this.transport.message(scopeId, threadId, messageId);
				if (!current() || head.thread.removed || head.message.deleted) throw new Error("History access changed.");
				const revision = Math.min(selected ?? head.message.revision, head.message.revision);
				const page = await this.transport.history(scopeId, threadId, messageId, Math.max(0, revision - 2), revision === 1 ? 1 : 2);
				const [thread, message] = await Promise.all([
					this.store.entity(scopeId, threadKey(threadId)), this.store.entity(scopeId, messageKey(threadId, messageId))]);
				const epoch = await this.store.checkpoint(scopeId);
				if (!current() || epoch.generation !== checkpoint.generation || isRecord(thread?.value) && thread.value.removed ||
					isRecord(message?.value) && (typeof message.value.revision === "number" && message.value.revision > head.message.revision ||
						message.value.deleted)) throw new Error("History changed. Refresh to check access.");
				const chosen = page.revisions.find(item => item.revision === revision);
				const previous = page.revisions.find(item => item.revision === revision - 1);
				if (!chosen || revision > 1 && !previous) throw new Error("The requested revision is unavailable.");
				return { latest: head.message.revision, selected: chosen, ...(previous ? { previous } : {}) };
			} catch (error) {
				if (!this.closed && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				throw error;
			}
		})());
	}
	/** One authorized read can address an older reply without replaying a long
	 * thread. Cache commits are fenced by the scope generation, as for sync. */
	async linkedThread(scopeId: string, threadId: string, messageId?: string): Promise<{ thread: AnchoredThread; message?: DiscussionMessage } | undefined> {
		if (!parseDiscussionScope(scopeId) || !isId(threadId) || messageId !== undefined && !isId(messageId)) throw new Error("Invalid discussion target.");
		return this.trackLocal((async () => {
			const authenticationEpoch = this.authenticationEpoch;
			const current = () => authenticationEpoch === this.authenticationEpoch && !this.closed && !["authentication_required", "unavailable"].includes(this.statusValue) && this.permission(scopeId)?.read === true;
			if (!current()) return;
			let hasMessage = !this.online;
			if (this.online) {
				const checkpoint = await this.store.checkpoint(scopeId); if (!current()) return;
				let thread: AnchoredThread, messages: DiscussionMessage[];
				try {
					let selected;
					if (messageId) {
						try { selected = await this.transport.message(scopeId, threadId, messageId); }
						catch (error) { if (!(error instanceof DiscussionFailure) || error.status !== 404) throw error; }
					}
					if (!current()) return;
					if (selected) { thread = { ...selected.thread, anchor: selected.anchor }; messages = [selected.message]; }
					else { const page = await this.transport.thread(scopeId, threadId); thread = { ...page.thread, anchor: page.anchor }; messages = page.messages; }
				} catch (error) {
					if (error instanceof DiscussionFailure && (error.action === "authenticate" || [403, 404].includes(error.status))) {
						if (error.action === "authenticate") this.requireAuthentication();
						await this.store.clearRemoteScope(scopeId); await this.inbox.forgetScope(scopeId);
					}
					throw error;
				}
				if (!current() || thread.removed) return;
				hasMessage = messages.some(message => message.id === messageId);
				const sequence = thread.activity_sequence;
				if (!await this.store.cacheRemoteRead(scopeId, checkpoint.generation, [
					{ id: threadKey(thread.id), revision: sequence, value: protocolJson(thread) },
					...messages.map(message => ({ id: messageKey(thread.id, message.id), revision: sequence, value: protocolJson({ ...message, thread_id: thread.id }) })),
				])) return;
				this.notify();
			}
			const thread = await this.cachedThread(scopeId, threadId); if (!thread || !current()) return;
			const message = messageId && hasMessage ? await this.cachedMessage(scopeId, threadId, messageId) : undefined;
			return current() ? { thread, message } : undefined;
		})());
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
		command = JSON.parse(JSON.stringify(command)) as QueuedCommand;
		const epoch = this.authenticationEpoch;
		if (!this.canQueue || !this.permission(command.scopeId)?.comment) throw new Error("Comment permission is required.");
		if (command.type === "base.group.create") {
			const pending = parsePendingBaseGroupCommand(command), anchor = pending.anchor, capture = anchor.capture;
			const context = await this.cachedBaseContext(command.scopeId, capture.record_id);
			const catalog = await this.readBaseDefinitions(command.scopeId);
			const definition = catalog.targets.find(item => item.kind === "group" && item.id === capture.group_definition_id);
			if (this.closed || !this.permission(command.scopeId)?.comment || this.entries.get(command.scopeId)?.kind !== "base" ||
				!this.canAnchorBase("group") || this.documentGeneration(command.scopeId) !== capture.generation ||
				!context || context.definition_id !== capture.definition_id || context.generation !== capture.generation ||
				context.record_generation !== capture.record_generation || catalog.definition_id !== capture.definition_id ||
				catalog.generation !== capture.generation || catalog.registry_revision < capture.registry_revision ||
				!definition || !this.canAnchorBaseGroup(definition.property) || !supportsBaseGroupDefinition(catalog, definition) ||
				(definition.property.source === "file") !== (capture.source_kind === "file") ||
				definition.revision !== capture.group_definition_revision || definition.property.source !== anchor.property.source ||
				definition.property.name !== anchor.property.name) throw new Error("Review this group's saved selection before sending. Your draft is retained.");
			if (anchor.summary) {
				const selected = anchor.summary, summary = catalog.targets.find(item => item.kind === "summary" && item.id === selected.definition_id);
				if (!this.canAnchorBase("group_summary") || !summary || summary.kind !== "summary" || summary.revision !== selected.definition_revision ||
					summary.summary !== selected.summary || summary.property.source !== selected.property.source || summary.property.name !== selected.property.name) {
					throw new Error("Review this group's summary definition before sending. Your draft and group evidence are retained.");
				}
			}
			if (anchor.range) {
				const axis = await this.readTimelineAxis(command.scopeId), range = anchor.range;
				if (this.closed || !this.canAnchorBase("timeline_range") || !this.permission(command.scopeId)?.comment ||
					axis.definition_id !== capture.definition_id || axis.generation !== capture.generation || axis.view_id !== capture.view_id ||
					axis.registry_revision < capture.registry_revision || axis.axis.id !== range.axis_definition_id ||
					axis.axis.revision !== range.axis_definition_revision || JSON.stringify(axis.axis.axis) !== JSON.stringify(range.axis)) {
					throw new Error("Review this range's saved axis before sending. Your draft and lane evidence are retained.");
				}
			}
		} else queuedEnvelope(this.identity.shareId, command);
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
		if (epoch !== this.authenticationEpoch || !this.canQueue || !this.permission(command.scopeId)?.comment) throw new Error("Comment access changed. Your draft is retained.");
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
		const authenticationEpoch = this.authenticationEpoch;
		const current = () => !this.closed && authenticationEpoch === this.authenticationEpoch && !["authentication_required", "unavailable"].includes(this.statusValue);
		const flight = (async () => {
			const scope = parseDiscussionScope(scopeId); if (!scope?.viewId || !current()) throw new Error("Saved view access is unavailable.");
			const proof = await this.store.beginPreferenceVerification(scopeId, key, uuid());
			if (!current()) throw new Error("Saved view access changed during verification.");
			let context: BaseTargetContext;
			try { context = await this.transport.baseTargetContext(scopeId, scope.viewId, recordId); }
			catch (error) {
				if (current() && error instanceof DiscussionFailure && error.action !== "retry") await this.store.finishPreferenceVerification(scopeId, key, proof, null, current);
				if (authenticationEpoch === this.authenticationEpoch && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				throw error;
			}
			if (!current()) throw new Error("Saved view access changed during verification.");
			let previous: BaseTargetContext | undefined;
			try { previous = parseBaseTargetContext(proof.previous, scope.entryId, scope.viewId, recordId); } catch { /* No prior verified target. */ }
			if (previous?.generation === context.generation && previous.registry_revision > context.registry_revision) throw new Error("Saved view association changed.");
			if (!await this.store.finishPreferenceVerification(scopeId, key, proof, protocolJson(context), current)) throw new Error("Saved target verification changed. Try again.");
			if (!current()) throw new Error("Saved view access changed during verification.");
			this.observeBaseRevision(scopeId, context.generation, context.registry_revision);
			return context;
		})().finally(() => { if (this.baseContextFlights.get(key) === flight) this.baseContextFlights.delete(key); });
		this.baseContextFlights.set(key, flight); return flight;
	}

	/** Read-side lineage for navigation. It does not require comment permission.
	 * Offline navigation requires a context previously verified for this account. */
	async readBaseContext(scopeId: string, recordId?: string): Promise<BaseTargetContext> {
		const scope = parseDiscussionScope(scopeId), generation = this.knownDocumentGeneration(scopeId);
		const authenticationEpoch = this.authenticationEpoch;
		const current = () => !this.closed && authenticationEpoch === this.authenticationEpoch && !["authentication_required", "unavailable"].includes(this.statusValue) &&
			this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
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
	/** Save exact local evidence now; the ordinary outbox verifies it after reconnect.
	 * Group witnesses require source read access, not source comment permission. */
	async captureBaseGroupSelection(scopeId: string, input: BaseGroupSelection): Promise<PendingBaseGroupAnchor> {
		const selected = { ...input, value: parseBaseGroupValue(input.value) };
		if (!this.canAnchorBase("group") || !this.permission(scopeId)?.comment) throw new Error("Group comments are unavailable in this saved view.");
		const context = await this.readBaseContext(scopeId, selected.record_id), catalog = await this.readBaseDefinitions(scopeId);
		const definition = catalog.targets.find(item => item.kind === "group" && item.id === selected.group_definition_id);
		if (this.closed || !this.canAnchorBase("group") || !this.permission(scopeId)?.comment ||
			!definition || !this.canAnchorBaseGroup(definition.property) || !supportsBaseGroupDefinition(catalog, definition) ||
			(definition.property.source === "file") !== (selected.source_kind === "file") ||
			definition.revision !== selected.group_definition_revision || context.record_generation !== selected.record_generation ||
			context.definition_id !== catalog.definition_id || context.generation !== catalog.generation || context.registry_revision > catalog.registry_revision ||
			this.documentGeneration(scopeId) !== catalog.generation) throw new Error("The group or its source changed. Select it again; existing drafts are retained.");
		const capture = copyBaseGroupCapture({ ...selected, operation_id: uuid(), definition_id: catalog.definition_id, view_id: catalog.view_id,
			generation: catalog.generation, registry_revision: catalog.registry_revision });
		return parseLocalDiscussionAnchor({ version: 1, type: "base_group_pending", entry_id: catalog.entry_id,
			property: definition.property, capture }) as PendingBaseGroupAnchor;
	}
	async captureBaseGroupSummary(scopeId: string, input: PendingBaseGroupAnchor, definitionId: string, definitionRevision: number): Promise<PendingBaseGroupAnchor> {
		const group = parseLocalDiscussionAnchor(input), scope = parseDiscussionScope(scopeId), epoch = this.authenticationEpoch;
		if (group.type !== "base_group_pending" || group.range || group.summary || group.entry_id !== scope?.entryId || group.capture.view_id !== scope.viewId ||
			!this.canAnchorBase("group_summary") || !this.canAnchorBaseGroup(group.property) || !this.permission(scopeId)?.comment) throw new Error("Select a current group in this saved view first.");
		const catalog = await this.readBaseDefinitions(scopeId), capture = group.capture;
		const summary = catalog.targets.find(item => item.kind === "summary" && item.id === definitionId);
		const grouping = catalog.targets.find(item => item.kind === "group" && item.id === capture.group_definition_id);
		if (this.closed || epoch !== this.authenticationEpoch || !this.permission(scopeId)?.comment || !this.canAnchorBase("group_summary") || !this.canAnchorBaseGroup(group.property) ||
			catalog.definition_id !== capture.definition_id || catalog.generation !== capture.generation || catalog.view_id !== capture.view_id ||
			catalog.registry_revision !== capture.registry_revision || this.documentGeneration(scopeId) !== capture.generation ||
			!grouping || grouping.revision !== capture.group_definition_revision || grouping.property.source !== group.property.source || grouping.property.name !== group.property.name ||
			!summary || summary.kind !== "summary" || summary.revision !== definitionRevision) throw new Error("The group or summary changed. Select it again; your draft is retained.");
		return parseLocalDiscussionAnchor({ ...group, summary: { type: "summary", definition_id: summary.id, definition_revision: summary.revision,
			property: summary.property, summary: summary.summary } }) as PendingBaseGroupAnchor;
	}
	async captureBaseTarget(scopeId: string, target: BaseTargetSelection): Promise<BaseAnchor> {
		const scope = parseDiscussionScope(scopeId), entry = this.entries.get(scopeId);
		if (!scope?.viewId || entry?.kind !== "base" || !entry.permission?.comment || !this.canAnchorBase(target.type)) throw new Error("Open this saved view with comment permission first.");
		const authenticationEpoch = this.authenticationEpoch, generation = entry.documentGeneration;
		const current = () => !this.closed && authenticationEpoch === this.authenticationEpoch && this.canAnchorBase(target.type) &&
			this.permission(scopeId)?.comment === true && !entry.unavailable && entry.documentGeneration === generation;
		if (target.type === "formula" || target.type === "summary") {
			const catalog = await this.readBaseDefinitions(scopeId);
			const definition = catalog.targets.find(item => item.id === target.definitionId && item.kind === target.type);
			if (!definition || definition.revision !== target.definitionRevision) throw new Error("This definition changed. Choose its current definition before starting another comment. Existing drafts are retained.");
			if (!current() ||
				this.documentGeneration(scopeId) !== catalog.generation) throw new Error("Comment access or the saved view changed during capture.");
			return parseAnchor({ version: 1, type: "base", definition_id: catalog.definition_id, view_id: catalog.view_id,
				generation: catalog.generation, registry_revision: catalog.registry_revision,
				target: { type: target.type, definition_id: definition.id, definition_revision: definition.revision,
					property: definition.property, ...(definition.kind === "summary" ? { summary: definition.summary } : {}) } }) as BaseAnchor;
		}
		const recordId = "recordId" in target ? target.recordId : undefined;
		if (recordId !== undefined && !isId(recordId)) throw new Error("The selected record has no synchronized identity.");
		const permissionKey = "baseRecordComment:" + scopeId + ":" + recordId;
		return this.trackLocal((async () => {
			let context: BaseTargetContext | undefined, permissionProof: PreferenceVerification | undefined;
			try {
				if (this.statusValue === "offline") throw new DiscussionFailure("retry", "offline_cache");
				if (recordId) permissionProof = await this.store.beginPreferenceVerification(scopeId, permissionKey, uuid());
				if (!current()) throw new Error("Comment access changed during capture.");
				context = await this.fetchBaseContext(scopeId, recordId);
				if (!current()) throw new Error("Comment access changed during capture.");
				const permission = recordId ? await this.transport.permissions(recordId) : entry.permission;
				if (!current()) throw new Error("Comment access changed during capture.");
				if (permissionProof && !await this.store.finishPreferenceVerification(scopeId, permissionKey, permissionProof, permission?.read === true && permission.comment, current)) throw new Error("Record comment verification changed.");
				if (!permission?.read || !permission.comment) throw new DiscussionFailure("reject", "comment_forbidden", 403);
			} catch (error) {
				if (authenticationEpoch === this.authenticationEpoch && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				if (!current()) throw error;
				if (!(error instanceof DiscussionFailure) || error.action !== "retry") {
					if (permissionProof) await this.store.finishPreferenceVerification(scopeId, permissionKey, permissionProof, false, current);
					throw error;
				}
				context = await this.cachedBaseContext(scopeId, recordId);
				if (!context || context.generation !== entry.documentGeneration || recordId && await this.store.preference(permissionKey) !== true) throw new Error("Connect once to verify this saved view and record before commenting offline.");
			}
			if (target.type === "formula_cell") {
				const catalog = await this.readBaseDefinitions(scopeId);
				const definition = catalog.targets.find(item => item.kind === "formula" && item.id === target.definitionId);
				if (!definition || definition.revision !== target.definitionRevision) throw new Error("This definition changed. Choose its current definition before starting another comment. Existing drafts are retained.");
				if (!current() ||
					this.documentGeneration(scopeId) !== catalog.generation || context.generation !== catalog.generation ||
					context.definition_id !== catalog.definition_id || context.registry_revision > catalog.registry_revision) throw new Error("The saved view or record changed during capture.");
				return parseAnchor({ version: 1, type: "base", definition_id: catalog.definition_id, view_id: catalog.view_id,
					generation: catalog.generation, registry_revision: catalog.registry_revision,
					target: { type: "formula_cell", definition_id: definition.id, definition_revision: definition.revision,
						property: definition.property, record_id: recordId, record_generation: context.record_generation } }) as BaseAnchor;
			}
			if (!current() ||
				this.documentGeneration(scopeId) !== context.generation) throw new Error("Comment access or the saved view changed while capturing this target. Refresh before trying again.");
			const parsed = parseAnchor({ version: 1, type: "base", definition_id: context.definition_id, view_id: context.view_id,
				generation: context.generation, registry_revision: context.registry_revision, target: target.type === "view" ? { type: "view" } :
				target.type === "property" ? { type: "property", property: target.property } : { type: target.type, record_id: recordId,
					record_generation: context.record_generation, ...(target.type === "cell" ? { property: target.property } : {}) } });
			return parsed as BaseAnchor;
		})());
	}
	/** A successful HTTP catalogue is distinct from a safe offline fallback. */
	verifiedTargetCatalog(value: object | undefined): boolean {
		const proof = value && this.verifiedTargetCatalogs.get(value);
		return !!proof && this.online && proof.epoch === this.authenticationEpoch && Date.now() >= proof.at && Date.now() - proof.at < 10_000;
	}
	/** Complete, account-scoped catalogue. Pagination commits as one proof; stale
	 * successes/denials and resets cannot overwrite another window's newer proof. */
	/** One bounded identity batch per loaded page. Only the latest batch per view
	 * is retained; unavailable identities are never cached as deletion evidence. */
	readBaseRecordContexts(scopeId: string, recordIds: readonly string[]): Promise<BaseRecordContexts> {
		const ids = baseRecordIds(recordIds), flightKey = JSON.stringify([scopeId, ids]);
		const existing = this.baseRecordFlights.get(flightKey); if (existing) return existing;
		const scope = parseDiscussionScope(scopeId), generation = this.knownDocumentGeneration(scopeId), epoch = this.authenticationEpoch;
		const current = () => !this.closed && epoch === this.authenticationEpoch && !["authentication_required", "unavailable"].includes(this.statusValue) &&
			!!generation && this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
		const key = "baseRecords:" + scopeId;
		const flight = this.trackLocal((async () => {
			if (!scope?.viewId || !current()) throw new Error("Saved view access is unavailable.");
			const parse = (value: unknown) => parseBaseRecordContexts(value, scope.entryId, scope.viewId!, ids);
			try {
				if (this.statusValue === "offline") throw new DiscussionFailure("retry", "offline_cache");
				const proof = await this.store.beginPreferenceVerification(scopeId, key, uuid());
				if (!current()) throw new Error("Record access changed during verification.");
				let records: BaseRecordContexts;
				try { records = await this.transport.baseRecordContexts(scopeId, scope.viewId, ids); }
				catch (error) {
					if (current() && error instanceof DiscussionFailure && error.action !== "retry") await this.store.finishPreferenceVerification(scopeId, key, proof, null, current);
					throw error;
				}
				if (!current() || records.generation !== generation || records.registry_revision < this.baseRegistryRevision(scopeId)) throw new Error("Saved view changed during verification.");
				let previous: BaseTargetContext | undefined; try { previous = parseBaseTargetContext(proof.previous, scope.entryId, scope.viewId); } catch { /* No prior identity proof. */ }
				if (previous?.generation === generation && previous.registry_revision > records.registry_revision) throw new Error("Record verification is stale.");
				if (!await this.store.finishPreferenceVerification(scopeId, key, proof, protocolJson(records), current) || !current()) throw new Error("Record verification changed. Try again.");
				this.observeBaseRevision(scopeId, records.generation, records.registry_revision);
				this.verifiedTargetCatalogs.set(records, { epoch, at: Date.now() }); return records;
			} catch (error) {
				if (epoch === this.authenticationEpoch && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				if (!current() || !(error instanceof DiscussionFailure) || error.action !== "retry") throw error;
				const records = parse(await this.store.preference(key));
				if (!current() || records.generation !== generation || records.registry_revision < this.baseRegistryRevision(scopeId)) throw new Error("Reconnect to verify these record identities.");
				return records;
			}
		})()).finally(() => { if (this.baseRecordFlights.get(flightKey) === flight) this.baseRecordFlights.delete(flightKey); });
		this.baseRecordFlights.set(flightKey, flight); return flight;
	}
	readBaseDefinitions(scopeId: string): Promise<BaseDefinitionCatalog> {
		const existing = this.baseDefinitionFlights.get(scopeId); if (existing) return existing;
		const scope = parseDiscussionScope(scopeId), generation = this.knownDocumentGeneration(scopeId);
		const authenticationEpoch = this.authenticationEpoch;
		const current = () => !this.closed && authenticationEpoch === this.authenticationEpoch && !["authentication_required", "unavailable"].includes(this.statusValue) &&
			!!generation && this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
		const key = "baseDefinitions:" + scopeId;
		const flight = this.trackLocal((async () => {
			if (!scope?.viewId || !current()) throw new Error("Saved view access is unavailable.");
			const parse = (value: unknown) => parseBaseDefinitionCatalog(value, scope.entryId, scope.viewId!);
			try {
				if (this.statusValue === "offline") throw new DiscussionFailure("retry", "offline_cache");
				const proof = await this.store.beginPreferenceVerification(scopeId, key, uuid());
				if (!current()) throw new Error("Saved view access changed during verification.");
				let catalog: BaseDefinitionCatalog;
				try { catalog = await this.transport.baseDefinitions(scopeId, scope.viewId); }
				catch (error) {
					if (current() && error instanceof DiscussionFailure && error.action !== "retry") await this.store.finishPreferenceVerification(scopeId, key, proof, null, current);
					throw error;
				}
				if (!current() || catalog.generation !== generation) throw new Error("Saved view changed during verification.");
				const context = await this.cachedBaseContext(scopeId);
				if (!current() || context?.generation === catalog.generation && context.registry_revision > catalog.registry_revision) throw new Error("Saved definition verification is stale. Refresh the definitions.");
				let previous: BaseDefinitionCatalog | undefined; try { previous = parse(proof.previous); } catch { /* No prior proof. */ }
				if (previous?.generation === catalog.generation && previous.registry_revision > catalog.registry_revision) throw new Error("Saved definition verification is stale.");
				if (!await this.store.finishPreferenceVerification(scopeId, key, proof, protocolJson(catalog), current)) throw new Error("Saved definition verification changed. Try again.");
				if (!current()) throw new Error("Saved view access changed during verification.");
				this.observeBaseRevision(scopeId, catalog.generation, catalog.registry_revision);
				this.verifiedTargetCatalogs.set(catalog, { epoch: authenticationEpoch, at: Date.now() });
				return catalog;
			} catch (error) {
				if (authenticationEpoch === this.authenticationEpoch && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
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
	/** Management reads are online-only, never persisted as capture permissions.
	 * An authentication round trip cannot revive an earlier successful read. */
	private readOnlineMarkerMetadata<T extends { generation: string; registry_revision: number }>(scopeId: string, read: () => Promise<T>): Promise<T> {
		const epoch = this.authenticationEpoch, generation = this.knownDocumentGeneration(scopeId);
		const current = () => epoch === this.authenticationEpoch && this.online && !!generation && this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
		return this.trackLocal((async () => {
			if (!parseDiscussionScope(scopeId)?.viewId || !current()) throw new Error("Reconnect to read shared marker metadata.");
			try {
				const result = await read();
				if (!current() || result.generation !== generation || result.registry_revision < this.baseRegistryRevision(scopeId)) throw new Error("Shared marker access or the saved view changed. Reopen marker management.");
				return result;
			} catch (error) {
				if (epoch === this.authenticationEpoch && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				throw error;
			}
		})());
	}
	readTimelineMarkerInventory(scopeId: string) {
		return this.readOnlineMarkerMetadata(scopeId, () => this.transport.timelineMarkerInventory(scopeId));
	}
	readTimelineMarkerDetail(scopeId: string, markerId: string) {
		return this.readOnlineMarkerMetadata(scopeId, () => this.transport.timelineMarker(scopeId, markerId));
	}
	readTimelineMarkerPlacementAxis(scopeId: string, viewId: string, registryRevision: number) {
		return this.readOnlineMarkerMetadata(scopeId, () => this.transport.timelineAxis(parseDiscussionScope(scopeId)!.entryId, viewId, registryRevision));
	}
	readTimelineAxis(scopeId: string): Promise<TimelineAxisContext> {
		const existing = this.timelineAxisFlights.get(scopeId); if (existing) return existing;
		const scope = parseDiscussionScope(scopeId), generation = this.knownDocumentGeneration(scopeId);
		const authenticationEpoch = this.authenticationEpoch;
		const current = () => !this.closed && authenticationEpoch === this.authenticationEpoch && !["authentication_required", "unavailable"].includes(this.statusValue) &&
			!!generation && this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
		const key = "timelineAxis:" + scopeId;
		const flight = this.trackLocal((async () => {
			if (!scope?.viewId || !current()) throw new Error("Saved view access is unavailable.");
			const parse = (value: unknown) => parseTimelineAxisContext(value, scope.entryId, scope.viewId!);
			try {
				if (this.statusValue === "offline") throw new DiscussionFailure("retry", "offline_cache");
				const proof = await this.store.beginPreferenceVerification(scopeId, key, uuid());
				if (!current()) throw new Error("Saved view access changed during verification.");
				let catalog: TimelineAxisContext;
				try { catalog = await this.transport.timelineAxis(scopeId, scope.viewId); }
				catch (error) {
					if (current() && error instanceof DiscussionFailure && error.action !== "retry") await this.store.finishPreferenceVerification(scopeId, key, proof, null, current);
					throw error;
				}
				if (!current() || catalog.generation !== generation) throw new Error("Saved view changed during verification.");
				const context = await this.cachedBaseContext(scopeId);
				if (!current() || context?.generation === catalog.generation && context.registry_revision > catalog.registry_revision) throw new Error("Saved axis verification is stale. Refresh the timeline axis.");
				let previous: TimelineAxisContext | undefined; try { previous = parse(proof.previous); } catch { /* No prior proof. */ }
				if (previous?.generation === catalog.generation && previous.registry_revision > catalog.registry_revision) throw new Error("Saved axis verification is stale.");
				if (!await this.store.finishPreferenceVerification(scopeId, key, proof, protocolJson(catalog), current)) throw new Error("Saved axis verification changed. Try again.");
				if (!current()) throw new Error("Saved view access changed during verification.");
				this.observeBaseRevision(scopeId, catalog.generation, catalog.registry_revision);
				this.verifiedTargetCatalogs.set(catalog, { epoch: authenticationEpoch, at: Date.now() });
				return catalog;
			} catch (error) {
				if (authenticationEpoch === this.authenticationEpoch && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				if (!current() || !(error instanceof DiscussionFailure) || error.action !== "retry") throw error;
				let catalog: TimelineAxisContext | undefined;
				try { catalog = parse(await this.store.preference(key)); } catch { /* An incomplete axis context cannot authorize offline capture. */ }
				const context = await this.cachedBaseContext(scopeId);
				if (!current() || !catalog || catalog.generation !== generation || context?.generation === generation && context.registry_revision > catalog.registry_revision) {
					throw new Error("Connect to verify this view’s timeline axis before using it offline.");
				}
				return catalog;
			}
		})()).finally(() => { if (this.timelineAxisFlights.get(scopeId) === flight) this.timelineAxisFlights.delete(scopeId); });
		this.timelineAxisFlights.set(scopeId, flight); return flight;
	}
	private observeTimelineMarkerVersion(scopeId: string, value: TimelineMarkerVersion): void {
		const scope = parseDiscussionScope(scopeId); if (this.closed || !scope?.viewId || !this.permission(scopeId)?.read) return;
		const version = parseTimelineMarkerVersion(value, scope.entryId, scope.viewId), previous = this.timelineMarkerVersions.get(scopeId);
		if (previous?.generation === version.generation && previous.definition_id === version.definition_id &&
			(previous.registry_revision > version.registry_revision || previous.catalog_revision > version.catalog_revision)) return;
		this.timelineMarkerVersions.set(scopeId, version);
		this.observeBaseRevision(scopeId, version.generation, version.registry_revision);
	}
	/** The active discussion worker supplies version hints. Reuse verified cache
	 * when unchanged; legacy servers refresh at most once per 15 seconds. No new
	 * timer or scroll-triggered network path is introduced. Hints never authorize
	 * a target: missing/mismatched proofs use the normal verified catalog reads. */
	readTimelineMarkerMetadata(scopeId: string): Promise<{ axis: TimelineAxisContext; catalog: TimelineMarkerCatalog }> {
		return this.trackLocal((async () => {
			const scope = parseDiscussionScope(scopeId), generation = this.knownDocumentGeneration(scopeId);
			const authenticationEpoch = this.authenticationEpoch;
			const current = () => !this.closed && authenticationEpoch === this.authenticationEpoch && !["authentication_required", "unavailable"].includes(this.statusValue) &&
				!!generation && this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
			if (!scope?.viewId || !current()) throw new Error("Saved view access is unavailable.");
			const checkpoint = await this.store.checkpoint(scopeId), version = this.timelineMarkerVersions.get(scopeId);
			if (version && version.generation !== generation) throw new Error("The base generation changed. Refresh synchronization before showing shared markers.");
			const [rawAxis, rawCatalog] = await Promise.all([this.store.preference("timelineAxis:" + scopeId), this.store.preference("timelineMarkers:" + scopeId)]);
			const matches = (value: { definition_id: string; generation: string; registry_revision: number }) => value.generation === generation && value.registry_revision >= this.baseRegistryRevision(scopeId) &&
				(version ? value.definition_id === version.definition_id && value.generation === version.generation && value.registry_revision >= version.registry_revision : Date.now() < (this.timelineMarkerFreshUntil.get(scopeId) ?? 0));
			let axis: TimelineAxisContext | undefined, catalog: TimelineMarkerCatalog | undefined;
			try { const cached = parseTimelineAxisContext(rawAxis, scope.entryId, scope.viewId); if (matches(cached)) axis = cached; } catch { /* Verify missing or incompatible proof. */ }
			try { const cached = parseTimelineMarkerCatalog(rawCatalog, scope.entryId, scope.viewId); if (matches(cached) && (!version || cached.catalog_revision >= version.catalog_revision)) catalog = cached; } catch { /* Verify missing or incompatible proof. */ }
			if (!current()) throw new Error("Saved view access changed.");
			const result = await Promise.all([axis ?? this.readTimelineAxis(scopeId), catalog ?? this.readTimelineMarkers(scopeId)]);
			const completed = await this.store.checkpoint(scopeId), latest = this.timelineMarkerVersions.get(scopeId), verifiedAxis = result[0], verifiedCatalog = result[1];
			if (!current() || completed.generation !== checkpoint.generation ||
				verifiedAxis.definition_id !== verifiedCatalog.definition_id || verifiedAxis.generation !== verifiedCatalog.generation || verifiedAxis.registry_revision !== verifiedCatalog.registry_revision ||
				latest && (latest.definition_id !== verifiedCatalog.definition_id || latest.generation !== verifiedCatalog.generation || latest.registry_revision > verifiedCatalog.registry_revision || latest.catalog_revision > verifiedCatalog.catalog_revision)) {
				throw new Error("Shared marker verification changed. Refresh the view.");
			}
			this.timelineMarkerFreshUntil.set(scopeId, Date.now() + 15000);
			return { axis: verifiedAxis, catalog: verifiedCatalog };
		})());
	}
	readTimelineMarkers(scopeId: string): Promise<TimelineMarkerCatalog> {
		const existing = this.timelineMarkerFlights.get(scopeId); if (existing) return existing;
		const scope = parseDiscussionScope(scopeId), generation = this.knownDocumentGeneration(scopeId), key = "timelineMarkers:" + scopeId;
		const authenticationEpoch = this.authenticationEpoch;
		const current = () => !this.closed && authenticationEpoch === this.authenticationEpoch && !["authentication_required", "unavailable"].includes(this.statusValue) &&
			!!generation && this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
		const flight = this.trackLocal((async () => {
			if (!scope?.viewId || !current()) throw new Error("Saved view access is unavailable.");
			const parse = (value: unknown) => parseTimelineMarkerCatalog(value, scope.entryId, scope.viewId!);
			let proof: PreferenceVerification | undefined;
			try {
				if (this.statusValue === "offline") throw new DiscussionFailure("retry", "offline_cache");
				proof = await this.store.beginPreferenceVerification(scopeId, key, uuid());
				if (!current()) throw new Error("Saved view access changed during verification.");
				const catalog = parse(await this.transport.timelineMarkers(scopeId, scope.viewId));
				if (!current() || catalog.generation !== generation) throw new Error("Saved view changed during marker verification.");
				const context = await this.cachedBaseContext(scopeId);
				if (!current() || context?.generation === generation && (context.definition_id !== catalog.definition_id || context.registry_revision > catalog.registry_revision)) {
					throw new Error("Saved marker verification is stale. Refresh this view.");
				}
				let previous: TimelineMarkerCatalog | undefined; try { previous = parse(proof.previous); } catch { /* No prior verified catalog. */ }
				if (previous?.generation === generation && (previous.definition_id !== catalog.definition_id || previous.registry_revision > catalog.registry_revision ||
					previous.catalog_revision > catalog.catalog_revision)) throw new Error("Saved marker verification is stale.");
				if (!await this.store.finishPreferenceVerification(scopeId, key, proof, protocolJson(catalog), current)) throw new Error("Saved marker verification changed. Try again.");
				if (!current()) throw new Error("Saved view access changed during verification.");
				this.observeBaseRevision(scopeId, catalog.generation, catalog.registry_revision);
				this.verifiedTargetCatalogs.set(catalog, { epoch: authenticationEpoch, at: Date.now() });
				return catalog;
			} catch (error) {
				if (authenticationEpoch === this.authenticationEpoch && error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication();
				if (proof && current() && (!(error instanceof DiscussionFailure) || error.action !== "retry")) await this.store.finishPreferenceVerification(scopeId, key, proof, null, current);
				if (!current() || !(error instanceof DiscussionFailure) || error.action !== "retry") throw error;
				let catalog: TimelineMarkerCatalog | undefined; try { catalog = parse(await this.store.preference(key)); } catch { /* Never authorize capture from incomplete metadata. */ }
				const context = await this.cachedBaseContext(scopeId);
				if (!current() || !catalog || catalog.generation !== generation || context?.generation === generation &&
					(context.definition_id !== catalog.definition_id || context.registry_revision > catalog.registry_revision)) throw new Error("Connect to verify this view’s markers before using them offline.");
				return catalog;
			}
		})()).finally(() => { if (this.timelineMarkerFlights.get(scopeId) === flight) this.timelineMarkerFlights.delete(scopeId); });
		this.timelineMarkerFlights.set(scopeId, flight); return flight;
	}
	async captureTimelineMarker(scopeId: string, selected: TimelineMarkerCatalog, markerId: string): Promise<BaseAnchor> {
		const scope = parseDiscussionScope(scopeId);
		if (!scope?.viewId || !this.canAnchorBase("timeline_marker") || !this.permission(scopeId)?.comment) throw new Error("Open this saved view with comment permission first.");
		// Copy before awaiting so a repaint cannot replace the user's selection.
		const selection = parseTimelineMarkerCatalog(selected, scope.entryId, scope.viewId), chosen = selection.markers.find(item => item.id === markerId);
		if (!chosen?.active || !chosen.placement.active) throw new Error("Choose an active marker in this saved view.");
		const binding = await this.readBaseContext(scopeId), axis = await this.readTimelineAxis(scopeId), catalog = await this.readTimelineMarkers(scopeId);
		const marker = catalog.markers.find(item => item.id === markerId);
		if (this.closed || !this.canAnchorBase("timeline_marker") || !this.permission(scopeId)?.comment || !marker?.active || !marker.placement.active ||
			selection.definition_id !== catalog.definition_id || selection.generation !== catalog.generation ||
			binding.definition_id !== catalog.definition_id || binding.generation !== catalog.generation || binding.registry_revision !== catalog.registry_revision ||
			axis.definition_id !== catalog.definition_id || axis.generation !== catalog.generation || axis.registry_revision !== catalog.registry_revision ||
			axis.axis.id !== marker.target.axis_definition_id || axis.axis.revision !== marker.target.axis_definition_revision ||
			JSON.stringify(axis.axis.axis) !== JSON.stringify(marker.target.axis) || JSON.stringify(chosen.target) !== JSON.stringify(marker.target)) {
			throw new Error("The marker or its timeline axis changed. Select it again; your draft is retained.");
		}
		if ("time_zone" in marker.content.range) validateTimelineTimeZone(marker.content.range.time_zone);
		return timelineMarkerAnchor(catalog, marker);
	}
	async captureTimelineRange(scopeId: string, selected: TimelineAxisContext, input: TimelineRange, laneAnchor?: BaseAnchor): Promise<BaseAnchor>;
	async captureTimelineRange(scopeId: string, selected: TimelineAxisContext, input: TimelineRange, laneAnchor: PendingBaseGroupAnchor): Promise<PendingBaseGroupAnchor>;
	async captureTimelineRange(scopeId: string, selected: TimelineAxisContext, input: TimelineRange, laneAnchor?: BaseAnchor | PendingBaseGroupAnchor): Promise<BaseAnchor | PendingBaseGroupAnchor> {
		const scope = parseDiscussionScope(scopeId);
		if (!scope?.viewId || !this.canAnchorBase("timeline_range") || !this.permission(scopeId)?.comment) throw new Error("Open this saved view with comment permission first.");
		const selection = parseTimelineAxisContext(selected, scope.entryId, scope.viewId), range = parseTimelineRange(input);
		if ("time_zone" in range) validateTimelineTimeZone(range.time_zone);
		const lane = laneAnchor === undefined ? undefined : parseLocalDiscussionAnchor(laneAnchor);
		if (lane && lane.type !== "base_group_pending" && (lane.type !== "base" || lane.target.type !== "group" || lane.definition_id !== selection.definition_id ||
			lane.view_id !== selection.view_id || lane.generation !== selection.generation)) throw new Error("The lane does not belong to this saved view.");
		if (lane?.type === "base_group_pending" && (lane.range || lane.summary || lane.entry_id !== scope.entryId ||
			lane.capture.definition_id !== selection.definition_id || lane.capture.view_id !== selection.view_id ||
			lane.capture.generation !== selection.generation || lane.capture.registry_revision !== selection.registry_revision ||
			!this.canAnchorBaseGroup(lane.property))) throw new Error("Select a current supported lane in this saved view.");
		const binding = await this.readBaseContext(scopeId);
		const context = await this.readTimelineAxis(scopeId);
		if (this.closed || !this.canAnchorBase("timeline_range") || !this.permission(scopeId)?.comment ||
			binding.definition_id !== context.definition_id || binding.generation !== context.generation || binding.registry_revision !== context.registry_revision ||
			context.definition_id !== selection.definition_id || context.generation !== selection.generation ||
			context.axis.id !== selection.axis.id || context.axis.revision !== selection.axis.revision ||
			context.axis.fingerprint !== selection.axis.fingerprint) throw new Error("The timeline axis changed. Select the range again; your draft is retained.");
		const anchor = parseAnchor({ version: 1, type: "base", definition_id: context.definition_id, view_id: context.view_id,
			generation: context.generation, registry_revision: context.registry_revision, target: { type: "timeline_range",
				axis_definition_id: context.axis.id, axis_definition_revision: context.axis.revision, axis: context.axis.axis, range,
				...(lane?.type === "base" ? { lane: lane.target } : {}) } }) as BaseAnchor;
		if (lane?.type === "base_group_pending") {
			if (!this.canAnchorBaseGroup(lane.property)) throw new Error("Lane comments are no longer enabled. Your selection is retained.");
			return parseLocalDiscussionAnchor({ ...lane, range: anchor.target }) as PendingBaseGroupAnchor;
		}
		return anchor;
	}
	async baseDefinitionStatus(scopeId: string, anchor: BaseAnchor): Promise<string> {
		if (anchor.target.type === "timeline_marker") {
			try {
				const catalog = await this.readTimelineMarkers(scopeId), target = anchor.target;
				if (catalog.definition_id !== anchor.definition_id || catalog.generation !== anchor.generation || catalog.view_id !== anchor.view_id) return "This marker belongs to an earlier saved-view identity. The captured marker and discussion are retained.";
				const marker = catalog.markers.find(item => item.id === target.marker_id);
				if (!marker) return "This marker is absent from the latest verified catalog. The captured marker and discussion are retained.";
				if (!marker.active || !marker.placement.active) return "This marker was archived or removed from the view in the latest verified catalog. The captured marker and discussion are retained.";
				if (JSON.stringify(marker.target) !== JSON.stringify(target)) return "This marker changed since capture. The discussion retains its original label and position.";
				return this.statusValue === "ready" ? "Matches the latest verified marker revision." : "Matches the last verified marker revision. Reconnect to check for changes.";
			} catch { return "The current marker could not be verified. The captured marker and discussion are retained."; }
		}
		if (anchor.target.type === "timeline_range") {
			try {
				const context = await this.readTimelineAxis(scopeId), target = anchor.target;
				if (context.definition_id !== anchor.definition_id || context.generation !== anchor.generation || context.view_id !== anchor.view_id ||
					context.axis.id !== target.axis_definition_id || context.axis.revision !== target.axis_definition_revision) return "The timeline axis has changed. The original range and discussion are retained.";
				return this.statusValue === "ready" ? "Matches the latest verified timeline axis." : "Matches the last verified timeline axis. Reconnect to check for changes.";
			} catch { return "The current timeline axis could not be verified. The original range and discussion are retained."; }
		}
		if (anchor.target.type !== "formula" && anchor.target.type !== "summary" && anchor.target.type !== "formula_cell" && anchor.target.type !== "group" && anchor.target.type !== "group_summary") return "";
		try {
			const catalog = await this.readBaseDefinitions(scopeId), target = anchor.target;
			if (catalog.definition_id !== anchor.definition_id || catalog.generation !== anchor.generation || catalog.view_id !== anchor.view_id) return "This discussion belongs to an earlier saved-view identity. Its original target is retained.";
			const found = catalog.targets.find(item => item.id === target.definition_id && item.kind === (target.type === "formula_cell" ? "formula" : target.type === "group_summary" ? "summary" : target.type));
			if (!found) return this.statusValue === "ready" ? "This definition is no longer available in the saved view. The original discussion is retained." : "This definition is absent from the cached view. Reconnect to verify it.";
			if (found.revision !== target.definition_revision) return "The definition has changed since this discussion was created. The original discussion is retained.";
			if (target.type === "group_summary") {
				const group = catalog.targets.find(item => item.kind === "group" && item.id === target.group.definition_id);
				if (!group || group.revision !== target.group.definition_revision) return "The grouping definition changed. The original group summary and discussion are retained.";
			}
			return this.statusValue === "ready" ? "Matches the latest verified definition." : "Matches the last verified definition. Reconnect to check for changes.";
		} catch { return "The current definition could not be verified. The original discussion and target are retained."; }
	}
	async pendingReattachment(scopeId: string, threadId: string): Promise<OnlineOperation | undefined> {
		if (this.closed || !this.permission(scopeId)?.read) return;
		return this.trackLocal(this.reattachments.pending(scopeId, threadId));
	}
	async prepareReattachment(scopeId: string, threadId: string, revision: number, input: LocalDiscussionAnchor, visible: () => boolean = () => true): Promise<OnlineOperation> {
		const local = parseLocalDiscussionAnchor(input), epoch = this.authenticationEpoch, binding = this.restoreBinding;
		const current = () => visible() && epoch === this.authenticationEpoch && this.canReattach && this.permission(scopeId)?.comment === true;
		return this.trackLocal((async () => {
			if (!current()) throw new Error("Reconnect with comment access before moving this discussion.");
			let anchor: DiscussionAnchor;
			if (local.type === "base_group_pending") {
				const scope = parseDiscussionScope(scopeId);
				if (scope?.entryId !== local.entry_id || scope.viewId !== local.capture.view_id) throw new Error("Choose a target in the same saved view.");
				const verified = await this.transport.captureBaseGroup(scopeId, local.capture);
				if (!current() || verified.target.type !== "group" || verified.target.property.source !== local.property.source || verified.target.property.name !== local.property.name) throw new Error("The group selection changed. Select it again.");
				anchor = resolvePendingBaseGroupAnchor(local, verified);
			} else anchor = local;
			return this.reattachments.prepare(scopeId, threadId, revision, anchor, current, binding);
		})());
	}
	async sendReattachment(operation: OnlineOperation, visible: () => boolean = () => true): Promise<void> {
		const epoch = this.authenticationEpoch;
		const current = () => visible() && epoch === this.authenticationEpoch && this.online && this.permission(operation.scopeId)?.comment === true;
		return this.trackLocal(this.reattachments.send(operation, current).finally(() => {
			if (!this.closed) { this.invalidate(); this.broadcast(); this.notify(); }
		}));
	}
	async recoverReattachment(operation: OnlineOperation, visible: () => boolean = () => true): Promise<"accepted" | "withdrawn"> {
		const epoch = this.authenticationEpoch;
		const current = () => visible() && epoch === this.authenticationEpoch && this.online && this.permission(operation.scopeId)?.comment === true;
		return this.trackLocal(this.reattachments.recover(operation, current).finally(() => {
			if (!this.closed) { this.invalidate(); this.broadcast(); this.notify(); }
		}));
	}
	async anchorHistory(scopeId: string, threadId: string, after = 0) {
		const epoch = this.authenticationEpoch, generation = this.knownDocumentGeneration(scopeId);
		const current = () => epoch === this.authenticationEpoch && this.online && this.permission(scopeId)?.read === true && this.knownDocumentGeneration(scopeId) === generation;
		return this.trackLocal((async () => {
			if (!current()) throw new Error("Reconnect with read access to view target history.");
			const page = await this.transport.anchorHistory(scopeId, threadId, after);
			if (!current()) throw new Error("History access changed.");
			return page;
		})());
	}
	async onlineAction(operation: OnlineOperation): Promise<void> {
		if (!this.online || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect before changing this discussion.");
		operation = JSON.parse(JSON.stringify(operation)) as OnlineOperation;
		const epoch = this.authenticationEpoch, current = () => this.online && epoch === this.authenticationEpoch && this.permission(operation.scopeId)?.comment === true;
		const flight = (async () => {
			await this.store.requireRestoreBinding(operation);
			if (!current()) throw new DiscussionFailure("pause", "action_context_changed");
			await this.transport.sendOnline(operation, current);
			if (!current()) throw new DiscussionFailure("pause", "action_context_changed");
		})();
		this.onlineFlights.add(flight);
		try { await flight; } finally {
			this.onlineFlights.delete(flight);
			if (!this.closed) { this.invalidate(); this.broadcast(); this.notify(); }
		}
	}
	async retryRejected(operation: OutboxOperation): Promise<boolean> {
		if (!this.online || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect and check comment permission before retrying.");
		if (operation.type === "picture.upload") parsePictureUpload(operation.payload);
		else if (operation.type === "base.group.create") parsePendingBaseGroupCommand(operation);
		else queuedEnvelope(this.identity.shareId, operation);
		const retried = await this.trackLocal(this.store.retryRejected(operation.operationId, operation.scopeId, operation.attempt));
		if (!this.closed) { this.broadcast(); this.outbox.wake(); this.notify(); }
		return retried;
	}
	async cancelSavedReaction(operation: OutboxOperation, visible: () => boolean): Promise<"accepted" | "withdrawn"> {
		const epoch = this.authenticationEpoch, alive = () => visible() && !this.closed && epoch === this.authenticationEpoch;
		const dispatch = () => alive() && this.canRecoverSavedCommand && this.permission(operation.scopeId)?.comment === true;
		return this.trackLocal((async () => {
			if (!alive() || operation.type !== "reaction.set") throw new Error("This saved reaction is unavailable.");
			queuedEnvelope(this.identity.shareId, operation);
			const local = await this.store.retireReaction(operation, false, alive);
			if (local !== "uncertain") return local;
			if (!dispatch()) throw new Error("Reconnect with comment permission to check this reaction's delivery before cancelling.");
			let result;
			try { result = await this.transport.withdraw(operation, dispatch); }
			catch (error) { if (error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication(); throw error; }
			if (result.status === "accepted") { await this.store.accept(operation.operationId, protocolJson(result.result)); return "accepted" as const; }
			if (!alive()) throw new Error("Delivery was checked on the server. Reopen this reaction to finish recovery.");
			const retired = await this.store.retireReaction(operation, true, alive);
			if (retired === "uncertain") throw new Error("The reaction needs another delivery review.");
			return retired;
		})().finally(() => { if (!this.closed) { this.broadcast(); this.invalidate(); this.notify(); } }));
	}
	async recoverSavedCommand(operation: OutboxOperation, visible: () => boolean = () => true): Promise<{ status: "accepted" | "requeued" } | { status: "editable"; draft: Draft; operation: OutboxOperation }> {
		const epoch = this.authenticationEpoch;
		const alive = () => visible() && !this.closed && epoch === this.authenticationEpoch;
		const dispatch = () => alive() && this.canRecoverSavedCommand && this.permission(operation.scopeId)?.comment === true;
		return this.trackLocal((async () => {
			if (!alive()) throw new Error("This discussion account is closed.");
			const saved = await this.store.getOperation(operation.operationId);
			if (!alive() || !saved || saved.scopeId !== operation.scopeId) throw new Error("Saved change is unavailable.");
			if (saved.state === "accepted") return { status: "accepted" as const };
			if (saved.state === "withdrawn" && saved.replacementId) return { status: "requeued" as const };
			if (saved.state === "review" && saved.reviewDraftId) {
				const draft = await this.store.getDraft(saved.reviewDraftId);
				if (!alive() || !draft || draft.scopeId !== saved.scopeId) throw new Error("Recovered draft is unavailable.");
				return { status: "editable" as const, draft, operation: saved };
			}
			if (!dispatch()) throw new Error("Reconnect with comment permission to check delivery before editing this saved change.");
			if (!["thread.create", "base.group.create", "reply.create", "message.edit"].includes(saved.type) || !isRecord(saved.payload)) throw new Error("This kind of saved change cannot be edited.");
			const body = editableCommentDraft(parseBody(saved.payload.body), id => this.displayName(saved.scopeId, id));
			if (saved.type === "message.edit") body.editBaseRevision = saved.payload.expected_revision as number;
			const unprepared = saved.type === "base.group.create" && saved.preparedAnchor === undefined;
			if (unprepared) parsePendingBaseGroupCommand(saved);
			else {
				const wire = saved.type === "base.group.create" ? prepareBaseGroupCommand(saved, saved.preparedAnchor) : saved;
				let result;
				try { result = await this.transport.withdraw(wire, dispatch); }
				catch (error) { if (error instanceof DiscussionFailure && error.action === "authenticate") this.requireAuthentication(); throw error; }
				if (result.status === "accepted") { await this.store.accept(saved.operationId, protocolJson(result.result)); return { status: "accepted" as const }; }
			}
			if (!alive()) throw new Error("Recovery is saved on the server. Reopen this change to continue.");
			const draft = await this.store.restoreCommandForReview(saved, protocolJson(body), unprepared);
			return { status: "editable" as const, draft, operation: { ...saved, state: "review" as const, reviewDraftId: draft.id } };
		})().finally(() => { if (!this.closed) { this.broadcast(); this.invalidate(); this.notify(); } }));
	}
	async reviewAbandonment(operationId: string): Promise<ReviewedAbandonment> {
		if (this.closed) throw new Error("This discussion account is closed.");
		return this.trackLocal(this.store.reviewAbandonment(operationId));
	}
	async abandonReviewedWork(review: ReviewedAbandonment, visible: () => boolean): Promise<void> {
		const epoch = this.authenticationEpoch, current = () => !this.closed && visible() && epoch === this.authenticationEpoch;
		if (!current()) throw new Error("This discussion account is closed.");
		return this.trackLocal(this.store.abandonReviewedWork(review, current).then(() => { for (const draft of review.drafts) this.draftDiscarded(draft.id); })
			.finally(() => { if (!this.closed) { this.broadcast(); this.invalidate(); this.notify(); } }));
	}
	async repairPictures(operation: OutboxOperation): Promise<"accepted" | "requeued"> {
		if (!this.canRepairPictures || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect with picture and comment permission before repairing uploads.");
		if (operation.type === "base.group.create") parsePendingBaseGroupCommand(operation);
		else queuedEnvelope(this.identity.shareId, operation);
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
			if (current.type === "base.group.create" && current.preparedAnchor === undefined) {
				await this.store.replacePicturesAfterWithdrawal(operation, uuid(), replacements, Date.now(), true);
				return "requeued" as const;
			}
			const wire = current.type === "base.group.create" ? prepareBaseGroupCommand(current, current.preparedAnchor) : operation;
			const outcome = await this.transport.withdraw(wire);
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
		operation = JSON.parse(JSON.stringify(operation)) as OnlineOperation;
		const epoch = this.authenticationEpoch, current = () => epoch === this.authenticationEpoch && this.online;
		if (!this.online || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect before changing this discussion.");
		await this.trackLocal((async () => {
			const saved = await this.store.getDraft(draft.id);
			if (!saved || saved.scopeId !== operation.scopeId || saved.revision !== draft.revision) throw new Error("Draft changed in another view");
			// Upload before locking the online receipt. A rejected picture leaves the
			// draft editable; a lost reply acknowledgment retries the exact command.
			if (!await this.store.preference("online:" + draft.id)) {
				await this.store.requireRestoreBinding(operation);
				if (!current()) throw new DiscussionFailure("pause", "action_context_changed");
				for (const pictureId of commandPictures(operation.payload)) {
					const source = await this.store.pictureSource(pictureId, operation.scopeId);
					if (!source) continue; // Existing published picture; the server checks scope/access.
					if (!current() || !this.canAttachPictures || !this.permission(operation.scopeId)?.comment) throw new Error("Reconnect and check picture permission before sending.");
					await this.transport.uploadPicture(operation.scopeId, { type: "picture.upload", picture_id: pictureId, sha256: source.sha256, size: source.size }, source.bytes);
				}
			}
			if (!current()) throw new DiscussionFailure("pause", "action_context_changed");
			const exact = await this.store.prepareOnlineDraft(draft.id, draft.revision, operation);
			if (!current()) throw new Error("This discussion account is closed.");
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
		const inboxClosing = this.inbox.close();
		this.outbox.stop(); for (const entry of this.entries.values()) entry.sync.stop();
		this.channel?.close(); this.channel = undefined; this.notify(); this.listeners.clear(); this.discardedDraftListeners.clear();
		await Promise.allSettled([inboxClosing, this.startFlight, this.outbox.settled(), ...this.onlineFlights,
			...[...this.entries.values()].flatMap(entry => [entry.sync.settled(), entry.permissionFlight])]);
		this.entries.clear(); this.store.close();
	}
}
