import { timelineRangeLabel, type TimelineRange } from "./TimelineRange";
import type { TimelineAxisContext } from "./TimelineRangeProtocol";
import { rangeLane, timelineTargetMatchesAxis, readNativeTimelineAxis, timelineAxisMatches } from "./NativeTimelineRanges";
import { TimelineRangeWorkflow } from "./ui/TimelineRangeWorkflow";
import { TimelineMarkerPicker } from "./ui/TimelineMarkerPicker";
import { timelineMarkerAnchor, type TimelineMarkerCatalog } from "./TimelineMarkerProtocol";
import { NativeBaseGroupComments, nativeGroupTargetKey } from "./NativeBaseGroupComments";
import { retainedBaseGroupSources } from "./RetainedBaseGroupSources";
import { baseGroupValueLabel } from "./BaseGroupValueBridge";
import { isDocument } from "../Document";
import { pendingRangeLocation, type LocalDiscussionAnchor } from "./LocalDiscussionAnchor";
import { Component, FileView, MarkdownView, Notice, TFile, type Editor, type Plugin, type WorkspaceLeaf } from "obsidian";
import { v4 as uuid } from "uuid";
import type { AuthSession } from "../AuthSession";
import type { ShareRegistry } from "../VaultShare";
import type { RelayOnPremSettings } from "../RelayOnPremConfig";
import type { SettingsScope } from "../SettingsPersistence";
import { DiscussionSession, type BaseTargetSelection } from "./DiscussionSession";
import type { BaseDefinitionCatalog } from "./BaseDefinitionProtocol";
import { DiscussionTransport } from "./DiscussionTransport";
import { DiscussionStore } from "./storage/DiscussionStore";
import { isId, isBaseRecordType, protocolJson, type BaseAnchor } from "./DiscussionProtocol";
import { CommentsView, COMMENTS_VIEW } from "./ui/CommentsView";
import { InboxView, INBOX_VIEW } from "./ui/InboxView";
import { inboxScope, parseInboxItem, type InboxItem } from "./InboxProtocol";
import { commentEditorExtension, type CommentEditorSurface, type CapturedCommentSelection, type ImageCommentContext } from "./CommentEditor";
import { BlockSelectionError } from "./anchors/blocks";
import { ReadingComments } from "./CommentReading";
import { readingCommentBinding } from "./ReadingTextBinding";
import { ImageComments } from "./ImageComments";
import type { ImageOccurrence } from "./anchors/images";
import type { RenderedImageTarget } from "./anchors/renderedImages";
import { baseDiscussionScope, parseDiscussionScope } from "./DiscussionScope";
import { BaseDiscussionPicker, type BaseDiscussionChoice } from "./ui/BaseDiscussionPicker";
import { BaseTargetPicker, type BaseRecordChoice } from "./ui/BaseTargetPicker";
import type { BaseSyncHost } from "../bases/BaseSyncHost";
import type { BaseRegistrySnapshot } from "../bases/BaseRegistryProtocol";
import { isAttachmentFile } from "../AttachmentFile";
import { isRecord } from "./DiscussionProtocol";
import type { NativeBasesSurface, NativeBaseHandle, NativeBaseTarget, NativeBaseGroupHandle } from "../bases/NativeBasesSurface";
import { baseSelectionKey, type BaseCommentContext } from "./BaseCommentContext";
import { BaseComments } from "./BaseComments";

type Slot = { cancelled: boolean; session?: DiscussionSession; pending?: Promise<void>; failed?: boolean };
export type CommentTarget = { path: string; kind?: "note" | "image" | "base"; entryId?: string; session?: DiscussionSession; message?: string;
	baseEntryId?: string; baseViewName?: string };
export type ImageFileCommentContext = { file: TFile; session: DiscussionSession; entryId: string; generation?: string; current: () => boolean };

/** Native Obsidian adapter. Note IDs come from the managed inventory; never
 * create a document, alter Markdown, or mint a new target ID just to comment.
 */
export class DiscussionHost extends Component {
	private slots = new Map<string, Slot>();
	private folderListeners = new Map<string, () => void>();
	private listeners = new Set<() => void>();
	private stopped = false;
	private lastFile?: TFile;
	private editors = new Set<CommentEditorSurface>();
	private focus?: { session: DiscussionSession; entryId: string; threadId: string; serial: number };
	private focusSerial = 0;
	private reading?: ReadingComments;
	private images?: ImageComments;
	private baseComments?: BaseComments;
	private baseSelections = new WeakMap<DiscussionSession, Map<string, { choice?: BaseDiscussionChoice }>>();
	private baseAction = 0;
	private rangeWorkflow?: TimelineRangeWorkflow;
	private markerPicker?: TimelineMarkerPicker;
	private inboxAction = 0;

	constructor(private plugin: Plugin, private auth: AuthSession, private shares: ShareRegistry,
		private settings: SettingsScope<RelayOnPremSettings>, private vaultId: string, private bases?: BaseSyncHost) { super(); }
	onload(): void {
		this.reading = this.addChild(new ReadingComments(this, this.plugin));
		this.images = this.addChild(new ImageComments(this, this.plugin, this.shares));
		this.baseComments = this.addChild(new BaseComments(this, this.plugin, this.bases));
		this.plugin.registerView(COMMENTS_VIEW, leaf => new CommentsView(leaf, this));
		this.plugin.registerView(INBOX_VIEW, leaf => new InboxView(leaf, this));
		this.plugin.addCommand({ id: "open-comment-inbox", name: "Open comment inbox", callback: () => { void this.openInbox(); } });
		this.plugin.addCommand({ id: "open-comments", name: "Open comments", callback: () => { void this.open(); } });
		this.plugin.registerEditorExtension(commentEditorExtension(this));
		this.plugin.addCommand({ id: "comment-selection", name: "Comment on selected text", editorCheckCallback: (checking, editor, info) => {
			const available = info.file?.extension === "md" && !!this.shares.shareFor(info.file.path);
			if (available && !checking) void this.commentSelection(editor);
			return available;
		} });
		this.registerEvent(this.plugin.app.workspace.on("editor-menu", (menu, editor, info) => {
			if (info.file?.extension === "md" && this.shares.shareFor(info.file.path)) {
				menu.addItem(item => item.setTitle("Comment on selected text").setIcon("message-square").onClick(() => { void this.commentSelection(editor); }));
				if (this.targetFor(info.file).session?.canAnchorBlocks) menu.addItem(item =>
					item.setTitle("Comment on block(s)").setIcon("message-square").onClick(() => { void this.commentSelection(editor, true); }));
				if (this.targetFor(info.file).session?.canAnchorImages) menu.addItem(item => item.setTitle("Comment on image").setIcon("image").onClick(() => {
					const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView); if (view) this.images?.comment(view);
				}));
			}
		}));
		this.plugin.addCommand({ id: "comment-blocks", name: "Comment on block(s)", editorCheckCallback: (checking, editor, info) => {
			const available = info.file?.extension === "md" && !!this.targetFor(info.file).session?.canAnchorBlocks;
			if (available && !checking) void this.commentSelection(editor, true);
			return available;
		} });
		this.register(this.auth.on(() => this.reconcile()));
		this.register(this.auth.onTokenRefreshed(() => { this.reconcile(); for (const slot of this.slots.values()) void slot.session?.refresh(); }));
		this.register(this.shares.on(() => this.reconcile()));
		this.register(this.settings.subscribe(() => this.reconcile()));
		this.registerEvent(this.plugin.app.workspace.on("file-open", file => { if (file) this.lastFile = file; this.notify(); }));
		this.registerEvent(this.plugin.app.vault.on("rename", () => this.notify()));
		this.registerEvent(this.plugin.app.vault.on("delete", file => { if (file === this.lastFile) this.lastFile = undefined; this.notify(); }));
		this.registerEvent(this.plugin.app.workspace.on("file-menu", (menu, file) => {
			if (file instanceof TFile && (this.targetFor(file).entryId || this.targetFor(file).baseEntryId)) menu.addItem(item =>
				item.setTitle("Comments").setIcon("message-square").onClick(() => { this.lastFile = file; void this.open(); }));
		}));
		this.registerDomEvent(document, "visibilitychange", () => {
			for (const slot of this.slots.values()) slot.session?.setForeground(!document.hidden);
		});
		this.registerDomEvent(window, "online", () => { for (const slot of this.slots.values()) void slot.session?.refresh(); });
		this.lastFile = this.plugin.app.workspace.getActiveFile() ?? undefined;
		this.reconcile();
	}
	onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private notify(): void { this.rangeWorkflow?.validate(); this.markerPicker?.validate(); for (const listener of this.listeners) { try { listener(); } catch { /* Isolate view failures. */ } } }
	private key(serverUrl: string, accountId: string, shareId: string): string {
		return JSON.stringify([serverUrl.replace(/\/+$/, ""), accountId, shareId]);
	}
	private reconcile(): void {
		if (this.stopped) return;
		const settings = this.settings.readValue(), wanted = new Set<string>(), folders = new Set<string>();
		for (const folder of this.shares.toArray()) {
			folders.add(folder.entityGuid);
			if (!this.folderListeners.has(folder.entityGuid)) this.folderListeners.set(folder.entityGuid, folder.folderIndex.on(() => this.notify()));
			const server = settings.enabled ? settings.servers.find(server => server.id === folder.config.onpremServerId) : undefined;
			const provider = server ? this.auth.getAuthProviderForServer(server.id) : undefined;
			const account = provider?.getCurrentUser();
			if (!server || !provider?.isLoggedIn() || !account || !isId(account.id) || !isId(folder.entityGuid)) continue;
			const key = this.key(server.controlPlaneUrl, account.id, folder.entityGuid); wanted.add(key);
			if (this.slots.has(key)) continue;
			const slot: Slot = { cancelled: false }; this.slots.set(key, slot);
			const serverId = server.id, accountId = account.id, shareId = folder.entityGuid, endpoint = server.controlPlaneUrl;
			const stillCurrent = () => !slot.cancelled && !this.stopped && this.settings.readValue().enabled &&
				this.settings.readValue().servers.some(s => s.id === serverId && s.controlPlaneUrl === endpoint) &&
				this.auth.getAuthProviderForServer(serverId)?.isLoggedIn() &&
				this.auth.getAuthProviderForServer(serverId)?.getCurrentUser()?.id === accountId;
			let transport: DiscussionTransport;
			try { transport = new DiscussionTransport({ serverId: endpoint, accountId, shareId }, async () => {
				if (!stillCurrent()) return undefined;
				const accessToken = await this.auth.getAuthProviderForServer(serverId)?.getValidToken();
				return stillCurrent() && accessToken ? { accountId, accessToken } : undefined;
			}); } catch { slot.failed = true; continue; }
			slot.pending = DiscussionStore.open({ ...transport.identity, vaultId: this.vaultId }).then(store => {
				if (!stillCurrent()) { store.close(); return; }
				const session = slot.session = new DiscussionSession(store, transport);
				session.onChange(() => this.notify()); session.setForeground(!document.hidden);
				void session.start(); this.notify();
			}).catch(() => { if (!slot.cancelled) { slot.failed = true; this.notify(); } });
		}
		for (const [key, slot] of this.slots) if (!wanted.has(key)) {
			slot.cancelled = true; void slot.session?.close(); this.slots.delete(key);
		}
		for (const [id, unsubscribe] of this.folderListeners) if (!folders.has(id)) { unsubscribe(); this.folderListeners.delete(id); }
		this.notify();
	}
	current(): CommentTarget {
		return this.targetFor(this.lastFile);
	}
	inboxSources(): { session: DiscussionSession; label: string }[] {
		const result: { session: DiscussionSession; label: string }[] = [];
		for (const slot of this.slots.values()) {
			const session = slot.session; if (!session || slot.cancelled || session.status === "closed") continue;
			const folder = this.shares.toArray().find(folder => folder.entityGuid === session.identity.shareId);
			if (!folder) continue;
			const server = this.settings.readValue().servers.find(server => server.id === folder.config.onpremServerId);
			result.push({ session, label: (server?.name ?? "Server") + " · " + (folder.path || "Shared folder") });
		}
		return result;
	}
	async openInboxItem(session: DiscussionSession, value: InboxItem): Promise<void> {
		const item = parseInboxItem(value), scopeId = inboxScope(item), action = ++this.inboxAction;
		const folder = this.shares.toArray().find(folder => folder.entityGuid === session.identity.shareId);
		if (!folder) throw new Error("This shared folder is no longer connected.");
		const paths: string[] = []; folder.folderIndex.eachRecord((record, path) => { if (record.id === item.entry_id) paths.push(path); });
		const file = paths.length === 1 ? this.plugin.app.vault.getFileByPath(folder.absolutePath(paths[0])) : null;
		const current = () => !this.stopped && action === this.inboxAction && session.inbox.available && !!file &&
			this.plugin.app.vault.getFileByPath(file.path) === file &&
			this.targetFor(file).session === session && this.targetFor(file).kind === item.kind &&
			(item.kind === "base" ? this.targetFor(file).baseEntryId : this.targetFor(file).entryId) === item.entry_id;
		if (!file || !current()) throw new Error("The original shared file is unavailable. Refresh synchronization and try again.");
		const stop = session.watch(scopeId, () => {}, item.kind);
		try {
			await session.scopeReady(scopeId);
			if (!current() || !session.permission(scopeId)?.read) throw new Error("Discussion access changed. Refresh the inbox.");
			const thread = await session.inboxThread(item);
			if (!current() || !thread?.anchor) throw new Error("The discussion is unavailable or has not been saved for offline use.");
			if (item.kind === "base") {
				if (thread.anchor.type !== "base" || thread.anchor.view_id !== item.view_id) throw new Error("The saved discussion view changed.");
				// Keep the authoritative original ID even if its display metadata
				// is not cached. Never redirect a notification to the current view.
				const prior = this.baseSelection(session, item.entry_id);
				const choice: BaseDiscussionChoice = prior?.id === item.view_id ? prior : { id: item.view_id!, name: "Original saved view", type: "unknown", state: "unmatched" };
				await session.trackLocal(session.store.setPreference("activeBaseView:" + item.entry_id, protocolJson(choice)));
				if (!current()) return;
				this.baseSelections.get(session)!.get(item.entry_id)!.choice = choice;
			}
			await this.openThread(file, session, scopeId, item.thread_id);
			if (current()) await this.revealTarget(session, scopeId, thread.anchor);
		} finally { stop(); }
	}
	targetFor(file?: TFile): CommentTarget {
		if (!file) return { path: "", message: "Open a shared note or image to see its comments." };
		const folder = this.shares.shareFor(file.path);
		if (!folder) return { path: file.path, message: "This file is not in a shared folder." };
		const server = this.settings.readValue().servers.find(s => s.id === folder.config.onpremServerId);
		const provider = server ? this.auth.getAuthProviderForServer(server.id) : undefined;
		const account = provider?.isLoggedIn() ? provider.getCurrentUser() : undefined;
		if (!server || !account) return { path: file.path, message: "Sign in to this shared folder’s server to use comments." };
		const record = folder.folderIndex.recordFor(folder.toVirtualPath(file.path));
		const base = record?.type === "file" && file.extension.toLowerCase() === "base";
		if (!record || !["markdown", "image"].includes(record.type) && !base || !isId(record.id)) return { path: file.path, message: "Comments require a shared note, image or Bases file with a synchronized identity." };
		const slot = this.slots.get(this.key(server.controlPlaneUrl, account.id, folder.entityGuid)), session = slot?.session;
		if (base) {
			const selection = session ? this.baseSelection(session, record.id) : undefined;
			return { path: file.path, kind: "base", baseEntryId: record.id, session,
				entryId: selection ? baseDiscussionScope(record.id, selection.id) : undefined, baseViewName: selection?.name,
				message: session ? "Choose a saved view to open its discussions." : "Opening comments…" };
		}
		return { path: file.path, kind: record.type === "image" ? "image" : "note", entryId: record.id, session, message: session ? undefined : slot?.failed ? "Local comments could not be opened. Retry after checking storage and server settings." : "Opening comments…" };
	}
	private baseSelection(session: DiscussionSession, entryId: string): BaseDiscussionChoice | undefined {
		let selections = this.baseSelections.get(session);
		if (!selections) { selections = new Map(); this.baseSelections.set(session, selections); }
		let saved = selections.get(entryId);
		if (!saved) {
			saved = {}; selections.set(entryId, saved); const record = saved;
			void session.trackLocal(session.store.preference("activeBaseView:" + entryId).then(value => {
				if (session.status === "closed" || this.stopped || record.choice) return;
				if (isRecord(value) && isId(value.id) && typeof value.name === "string" && value.name.length <= 512 && typeof value.type === "string" &&
					["active", "unmatched", "archived"].includes(String(value.state))) record.choice = value as BaseDiscussionChoice;
				this.notify();
			})).catch(() => {});
		}
		return saved.choice;
	}
	get nativeBasesCommentsEnabled(): boolean { return this.settings.readValue().nativeBasesComments !== false; }
	baseFile(session: DiscussionSession, entryId: string): TFile | undefined {
		const folder = this.shares.toArray().find(folder => folder.entityGuid === session.identity.shareId); if (!folder) return;
		const paths: string[] = []; folder.folderIndex.eachRecord((record, path) => { if (record.id === entryId) paths.push(path); });
		const file = paths.length === 1 ? this.plugin.app.vault.getFileByPath(folder.absolutePath(paths[0])) : null;
		return file?.extension === "base" && this.targetFor(file).session === session && this.targetFor(file).baseEntryId === entryId ? file : undefined;
	}
	async toggleNativeBasesComments(): Promise<void> {
		await this.settings.mutateValue(value => ({ ...value, nativeBasesComments: !this.nativeBasesCommentsEnabled }));
		this.notify(); new Notice(this.nativeBasesCommentsEnabled ? "Contextual Bases comments enabled on supported views." : "Contextual Bases comments disabled. The comment sidebar remains available.");
	}
	/** Retain one watched scope for a native pane. Registry proof never grants
	 * access: native target capture and server lineage checks remain independent. */
	async baseCommentContext(surface: NativeBasesSurface, alive: () => boolean): Promise<BaseCommentContext | undefined> {
		const file = surface.file, target = this.targetFor(file), session = target.session, baseEntryId = target.baseEntryId;
		const folder = this.shares.shareFor(file.path), tracked = baseEntryId ? folder?.trackedEntries.get(baseEntryId) : undefined;
		if (!session || !baseEntryId || !folder || !tracked || !isAttachmentFile(tracked) || !this.bases) return;
		let released = false, transferred = false; let bootstrap: (() => void) | undefined; const retained: (() => void)[] = [];
		const current = () => !released && !this.stopped && alive() && this.nativeBasesCommentsEnabled && surface.current() &&
			this.plugin.app.vault.getFileByPath(file.path) === file && this.targetFor(file).session === session && this.targetFor(file).baseEntryId === baseEntryId &&
			(session.status === "ready" || session.status === "offline");
		const release = () => { if (released) return; released = true; for (const stop of retained) stop(); retained.length = 0; };
		try {
			if (!current()) return;
			if (session.status === "offline" && target.entryId && !session.permission(target.entryId)?.read) {
				const stop = session.watch(target.entryId, () => this.notify(), "base"); let stopped = false;
				bootstrap = () => { if (!stopped) { stopped = true; stop(); } };
				retained.push(bootstrap); await session.scopeReady(target.entryId);
			}
			let cached = await this.bases.cachedViews(folder, tracked, { identity: session.identity, readable: () => {
				const pinned = this.targetFor(file).entryId;
				return current() && session.status === "offline" && !!pinned && session.permission(pinned)?.read === true;
			} });
			if (session.online) {
				try { cached = await this.bases.refreshViews(folder, tracked); } catch { /* Exact byte proof below refuses unsynchronized edits. */ }
			}
			if (!current() || cached.pending || !cached.snapshot) return;
			const binding = await surface.bind(cached.snapshot, baseEntryId, () => this.plugin.app.vault.read(file), current);
			if (!binding || !current()) return;
			const entryId = baseDiscussionScope(baseEntryId, binding.viewId);
			retained.push(session.watch(entryId, () => this.notify(), "base"));
			await session.scopeReady(entryId);
			const authorized = () => current() && binding.current() && session.permission(entryId)?.read === true &&
				session.knownDocumentGeneration(entryId) === binding.snapshot.generation;
			if (!authorized()) { release(); return; }
			bootstrap?.();
			const proof = await session.readBaseContext(entryId);
			if (!authorized() || proof.definition_id !== binding.snapshot.definition_id || proof.registry_revision !== binding.snapshot.revision) return;
			const recordFor = (recordFile: TFile, counts?: ReadonlyMap<string, number>) => {
				if ((!counts && !authorized()) || this.plugin.app.vault.getFileByPath(recordFile.path) !== recordFile || this.shares.shareFor(recordFile.path) !== folder) return;
				const path = folder.toVirtualPath(recordFile.path), record = folder.folderIndex.recordFor(path), index = folder._liveProvider?.managedIndex;
				if (!record || !isId(record.id) || !isBaseRecordType(record.type)) return;
				if (index && (!index.registered(path, record.id) || !index.snapshot.owner && !["read", "write"].includes(index.snapshot.permissions[path]))) return;
				let count = counts?.get(record.id) ?? 0;
				if (!counts) folder.folderIndex.eachRecord(item => { if (item.id === record.id) count++; });
				return count === 1 ? record : undefined;
			};
			let catalog: BaseDefinitionCatalog | undefined;
			try { catalog = await session.readBaseDefinitions(entryId); } catch { /* Other targets remain usable on older/offline servers. */ }
			if (!authorized()) return;
			if (catalog?.definition_id !== binding.snapshot.definition_id || catalog?.generation !== binding.snapshot.generation || catalog?.registry_revision !== binding.snapshot.revision) catalog = undefined;
			const formulas = new Map(catalog?.targets.filter(item => item.kind === "formula").map(item => [item.property.name, item]));
			const selection = (target: NativeBaseTarget): BaseTargetSelection | undefined => {
				if (!authorized()) return;
				if (target.type === "view") return target;
				if (target.type === "property" || target.type === "cell") {
					const property = target.property;
					if (property.source === "formula") {
						const definition = formulas.get(property.name); if (!definition) return;
						const identity = { definitionId: definition.id, definitionRevision: definition.revision };
						if (target.type === "property") return { type: "formula", ...identity };
						const record = recordFor(target.file);
						return record ? { type: "formula_cell", recordId: record.id, ...identity } : undefined;
					}
					if (target.type === "property") return { type: "property", property: { source: property.source, name: property.name } };
					const record = recordFor(target.file);
					if (!record || property.source === "note" && record.type !== "markdown") return;
					return { type: "cell", recordId: record.id, property: { source: property.source, name: property.name } };
				}
				const record = recordFor(target.file); return record ? { type: "item", recordId: record.id } : undefined;
			};
			const groups = catalog ? new NativeBaseGroupComments({ session, entryId, baseEntryId, surface, binding, current: authorized }, catalog, {
				record: file => { const record = recordFor(file); return record && isBaseRecordType(record.type) ? { id: record.id, type: record.type, path: folder.toVirtualPath(file.path) } : undefined; },
				records: files => {
					if (!authorized()) return [];
					const counts = new Map<string, number>(); folder.folderIndex.eachRecord(record => counts.set(record.id, (counts.get(record.id) ?? 0) + 1));
					return files.map(file => { const record = recordFor(file, counts); return { file,
						record: record && isBaseRecordType(record.type) ? { id: record.id, type: record.type, path: folder.toVirtualPath(file.path) } : undefined }; });
				},
				file: id => {
					const paths: string[] = []; folder.folderIndex.eachRecord((record, path) => { if (record.id === id) paths.push(path); });
					const file = paths.length === 1 ? this.plugin.app.vault.getFileByPath(folder.absolutePath(paths[0])) : null;
					return file && recordFor(file) ? file : undefined;
				},
				fileAtPath: path => this.plugin.app.vault.getFileByPath(path),
				localPath: (path, directory) => {
					if (!authorized() || path.length > 512 || path !== path.normalize("NFC") || /[\\:]/.test(path) || Array.from(path).some(char => char.charCodeAt(0) < 32) ||
						(path === "" ? !directory : path.split("/").some(part => !part || part.startsWith(".")))) return;
					return path ? folder.absolutePath(path) : folder.path || "/";
				},
				read: file => this.plugin.app.vault.read(file),
				resolve: (link, source) => this.plugin.app.metadataCache.getFirstLinkpathDest(link, source),
				retained: (files, selected) => {
					if (!selected() || !authorized()) return Promise.resolve([]);
					const counts = new Map<string, number>(); folder.folderIndex.eachRecord(record => counts.set(record.id, (counts.get(record.id) ?? 0) + 1));
					return retainedBaseGroupSources(files, {
						read: file => this.plugin.app.vault.read(file),
						key: file => {
							const record = recordFor(file, counts), path = file.path, vpath = folder.toVirtualPath(path);
							// An initializing/live wrapper may contain edits not yet on disk.
							// Never substitute its older retained state or create a provider.
							if (!record || record.type !== "markdown" || folder.trackedEntries.has(record.id)) return;
							return { name: `${folder.hostAppId}-relay-doc-${record.id}`, current: () => {
								const index = folder._liveProvider?.managedIndex;
								return authorized() && file.path === path && this.plugin.app.vault.getFileByPath(path) === file &&
									this.shares.shareFor(path) === folder && folder.folderIndex.recordFor(vpath) === record &&
									!folder.trackedEntries.has(record.id) && (!index || index.registered(vpath, record.id) &&
										(index.snapshot.owner || ["read", "write"].includes(index.snapshot.permissions[vpath])));
							} };
						},
					}, selected);
				},
				source: file => {
					if (this.shares.shareFor(file.path) !== folder) return;
					const record = folder.folderIndex.recordFor(folder.toVirtualPath(file.path)), doc = record ? folder.trackedEntries.get(record.id) : undefined;
					if (!record || record.type !== "markdown" || !isDocument(doc) || !doc.isLocallyPersisted) return;
					const path = file.path, current = () => authorized() && file.path === path && recordFor(file)?.id === record.id &&
						folder.trackedEntries.get(record.id) === doc && !doc.crdtDoc.isDestroyed && doc.entryPath === folder.toVirtualPath(path);
					return current() ? { text: doc.crdtText, current } : undefined;
				},
			}) : undefined;
			transferred = true;
			return { file, session, entryId, baseEntryId, surface, binding, groups, current: authorized, release,
				canComment: target => authorized() && session.permission(entryId)?.comment === true && !!selection(target) && session.canAnchorBase(selection(target)!.type) &&
					(!("file" in target) || session.canAnchorBaseRecord(recordFor(target.file)?.type)),
				selection,
				native: anchor => {
					if (!authorized() || anchor.definition_id !== binding.snapshot.definition_id || anchor.view_id !== binding.viewId || anchor.generation !== binding.snapshot.generation || anchor.registry_revision > binding.snapshot.revision) return;
					const target = anchor.target; if (target.type === "view" || target.type === "property") return target;
					if (target.type === "summary" || target.type === "group" || target.type === "timeline_range" || target.type === "timeline_marker") return;
					if (target.type === "formula" || target.type === "formula_cell") {
						const definition = formulas.get(target.property.name);
						if (!definition || definition.id !== target.definition_id || definition.revision !== target.definition_revision) return;
						if (target.type === "formula") return { type: "property", property: target.property };
					}
					const paths: string[] = []; folder.folderIndex.eachRecord((record, path) => { if (record.id === target.record_id) paths.push(path); });
					const recordFile = paths.length === 1 ? this.plugin.app.vault.getFileByPath(folder.absolutePath(paths[0])) : null;
					if (!recordFile || !recordFor(recordFile) || target.type === "cell" && target.property.source === "note" && recordFor(recordFile)?.type !== "markdown") return;
					return target.type === "item" ? { type: "item", file: recordFile } : { type: "cell", file: recordFile, property: target.property };
				} };
		} catch { return; } finally { if (!transferred) release(); }
	}
	private async pinBaseContext(context: BaseCommentContext, current: () => boolean): Promise<boolean> {
		if (!current()) return false;
		const choice: BaseDiscussionChoice = { id: context.binding.viewId, name: context.binding.name, type: context.binding.type, state: "active" };
		await context.session.trackLocal(context.session.store.setPreference("activeBaseView:" + context.baseEntryId, protocolJson(choice)));
		if (!current()) return false;
		this.baseSelection(context.session, context.baseEntryId);
		this.baseSelections.get(context.session)!.get(context.baseEntryId)!.choice = choice;
		this.lastFile = context.file; this.focus = undefined; this.notify(); return true;
	}
	async commentBaseHandle(context: BaseCommentContext, handle: NativeBaseHandle, target: NativeBaseTarget = handle.target): Promise<boolean> {
		const action = ++this.baseAction;
		const current = () => action === this.baseAction && context.current() && handle.current() && context.session.permission(context.entryId)?.comment === true;
		try {
			if (target !== handle.target && !(handle.target.type === "cell" && target.type === "item" && target.file === handle.target.file)) return false;
			const selection = context.selection(target);
			if (!selection || !current() || !context.canComment(target)) return false;
			const anchor = await context.session.captureBaseTarget(context.entryId, selection);
			const latest = context.selection(target);
			if (!current() || !latest || baseSelectionKey(latest) !== baseSelectionKey(selection) || anchor.registry_revision !== context.binding.snapshot.revision || anchor.definition_id !== context.binding.snapshot.definition_id ||
				anchor.view_id !== context.binding.viewId || anchor.generation !== context.binding.snapshot.generation) throw new Error("The saved view changed");
			if (!await this.pinBaseContext(context, current)) return false;
			return await this.saveCommentSelection({ file: context.file, session: context.session, entryId: context.entryId, anchor });
		} catch { new Notice("This Bases target or its access changed. Refresh the view and select it again; existing drafts are retained."); return false; }
	}
	async commentBaseGroupHandle(context: BaseCommentContext, handle: NativeBaseGroupHandle): Promise<boolean> {
		const action = ++this.baseAction, current = () => action === this.baseAction && context.current() && handle.current();
		try {
			if (!current() || !context.groups?.canCapture(handle)) return false;
			const anchor = await context.groups.capture(handle);
			if (!current() || !await this.pinBaseContext(context, current)) return false;
			return await this.saveCommentSelection({ file: context.file, session: context.session, entryId: context.entryId, anchor });
		} catch (error) { new Notice(error instanceof Error ? error.message : "The group selection could not be saved. Existing drafts are retained."); return false; }
	}
	chooseTimelineRange(context: BaseCommentContext): void {
		this.markerPicker?.close(); this.markerPicker = undefined;
		this.rangeWorkflow?.close();
		const action = ++this.baseAction;
		const workflow = new TimelineRangeWorkflow(this.plugin.app, context, () => !this.stopped && action === this.baseAction,
			(proof, range, current, lane) => this.commentTimelineRange(context, proof, range, current, lane));
		this.rangeWorkflow = workflow; void workflow.open();
	}
	chooseTimelineMarker(context: BaseCommentContext, markerId?: string): void {
		this.rangeWorkflow?.close(); this.rangeWorkflow = undefined; this.markerPicker?.close();
		const action = ++this.baseAction, active = () => !this.stopped && action === this.baseAction;
		const picker = new TimelineMarkerPicker(this.plugin.app, context, active, {
			write: (catalog, id, current) => this.commentTimelineMarker(context, catalog, id, current),
			show: async (catalog, id, alive) => {
				const marker = catalog.markers.find(item => item.id === id); if (!marker) return false;
				const anchor = timelineMarkerAnchor(catalog, marker), proof = await readNativeTimelineAxis(context);
				const current = () => active() && alive() && context.session.permission(context.entryId)?.read === true && timelineTargetMatchesAxis(context, anchor, proof);
				if (!current()) return false;
				const result = await context.surface.revealRange(marker.content.range, marker.target.axis, current);
				if (result === "busy") throw new Error("Save or discard the task inspector changes before navigating to this marker.");
				return result === "revealed";
			},
		}, markerId, () => { if (this.markerPicker === picker) this.markerPicker = undefined; });
		this.markerPicker = picker; picker.open();
	}
	async commentTimelineMarker(context: BaseCommentContext, catalog: TimelineMarkerCatalog, markerId: string, alive: () => boolean): Promise<boolean> {
		const action = this.baseAction;
		const current = () => !this.stopped && action === this.baseAction && alive() && context.current() && context.session.canAnchorBase("timeline_marker") && context.session.permission(context.entryId)?.comment === true;
		if (!current()) return false;
		const anchor = await context.session.captureTimelineMarker(context.entryId, catalog, markerId);
		if (!current()) return false;
		const proof = await readNativeTimelineAxis(context);
		if (!current() || !timelineTargetMatchesAxis(context, anchor, proof) || anchor.registry_revision !== context.binding.snapshot.revision) return false;
		if (!await this.pinBaseContext(context, current)) return false;
		return this.saveCommentSelection({ file: context.file, session: context.session, entryId: context.entryId, anchor });
	}
	async commentTimelineRange(context: BaseCommentContext, proof: TimelineAxisContext, range: TimelineRange, alive: () => boolean, lane?: NativeBaseGroupHandle): Promise<boolean> {
		const native = context.surface.rangeContext(), action = this.baseAction;
		const laneKey = lane && nativeGroupTargetKey(lane.target);
		const current = () => !this.stopped && action === this.baseAction && alive() && !!native && timelineAxisMatches(context, proof, native) &&
			context.session.permission(context.entryId)?.comment === true && (!lane || lane.current() && nativeGroupTargetKey(lane.target) === laneKey && context.groups?.canCapture(lane) === true);
		if (!current()) return false;
		const pending = lane ? await context.groups!.capture(lane) : undefined;
		if (!current()) return false;
		const anchor = pending ? await context.session.captureTimelineRange(context.entryId, proof, range, pending) : await context.session.captureTimelineRange(context.entryId, proof, range);
		const location = anchor.type === "base_group_pending" ? pendingRangeLocation(anchor) : anchor;
		if (!current() || !location || !timelineTargetMatchesAxis(context, location, proof) || location.registry_revision !== context.binding.snapshot.revision) return false;
		if (!await this.pinBaseContext(context, current)) return false;
		return this.saveCommentSelection({ file: context.file, session: context.session, entryId: context.entryId, anchor });
	}
	async openBaseThread(context: BaseCommentContext, threadId: string): Promise<void> {
		const action = ++this.baseAction, current = () => action === this.baseAction && context.current();
		try {
			const thread = await context.session.cachedThread(context.entryId, threadId);
			if (!current() || thread?.anchor?.type !== "base") return;
			if (thread.anchor.target.type !== "timeline_range" && thread.anchor.target.type !== "timeline_marker" && (thread.anchor.target.type === "group" ? !await context.groups?.native(thread.anchor) : !context.native(thread.anchor))) return;
			if (!await this.verifyBaseTarget(context, thread.anchor) || !current()) return;
			if (await this.pinBaseContext(context, current)) await this.openThread(context.file, context.session, context.entryId, threadId);
		} catch { new Notice("This discussion is no longer available in the current view."); }
	}
	async openBaseView(context: BaseCommentContext): Promise<void> {
		const action = ++this.baseAction, current = () => action === this.baseAction && context.current();
		try { if (await this.verifyBaseTarget(context) && await this.pinBaseContext(context, current)) await this.open(); }
		catch { new Notice("Refresh this saved view before opening its discussions."); }
	}
	async verifyBaseTarget(context: BaseCommentContext, anchor?: BaseAnchor): Promise<boolean> {
		if (!context.current()) return false;
		const target = anchor?.target, recordId = target && "record_id" in target ? target.record_id : undefined;
		const proof = await context.session.readBaseContext(context.entryId, recordId);
		if (anchor && (target?.type === "timeline_range" || target?.type === "timeline_marker")) {
			const axis = await readNativeTimelineAxis(context);
			if (!timelineTargetMatchesAxis(context, anchor, axis) || target.type === "timeline_range" && target.lane && !await rangeLane(context, anchor)) return false;
		}
		if (target && "definition_id" in target) {
			const catalog = await context.session.readBaseDefinitions(context.entryId);
			if (!context.current() || catalog.registry_revision !== context.binding.snapshot.revision || catalog.generation !== anchor!.generation ||
				catalog.definition_id !== anchor!.definition_id || !catalog.targets.some(item => item.id === target.definition_id &&
					item.revision === target.definition_revision && item.kind === (target.type === "formula_cell" ? "formula" : target.type))) return false;
		}
		return context.current() && proof.definition_id === context.binding.snapshot.definition_id && proof.view_id === context.binding.viewId &&
			proof.registry_revision === context.binding.snapshot.revision && proof.generation === context.binding.snapshot.generation &&
			(!target || !("record_generation" in target) || target.record_generation === proof.record_generation);
	}
	/** A cached target can be revealed even when the currently displayed view has
	 * never had its discussions opened. Authority comes from the requested scope. */
	async activateBaseView(surface: NativeBasesSurface, session: DiscussionSession, scopeId: string, anchor: Pick<BaseAnchor, "definition_id" | "view_id" | "generation" | "registry_revision">, alive: () => boolean): Promise<"unchanged" | "changed" | "unavailable"> {
		const scope = parseDiscussionScope(scopeId), file = surface.file, folder = this.shares.shareFor(file.path);
		const tracked = scope ? folder?.trackedEntries.get(scope.entryId) : undefined;
		const current = () => !this.stopped && this.nativeBasesCommentsEnabled && alive() && surface.current() &&
			!!scope && scope.viewId === anchor.view_id && this.baseFile(session, scope.entryId) === file && session.permission(scopeId)?.read === true &&
			(session.status === "ready" || session.status === "offline");
		if (!scope || !folder || !tracked || !isAttachmentFile(tracked) || !this.bases || !current()) return "unavailable";
		try {
			let cached = await this.bases.cachedViews(folder, tracked, { identity: session.identity, readable: () => current() && session.status === "offline" });
			if (session.online) cached = await this.bases.refreshViews(folder, tracked);
			if (!current() || cached.pending || !cached.snapshot) return "unavailable";
			const binding = await surface.bind(cached.snapshot, scope.entryId, () => this.plugin.app.vault.read(file), current);
			if (!binding || !current()) return "unavailable";
			const proof = await session.readBaseContext(scopeId);
			if (!current() || !binding.current() || proof.definition_id !== anchor.definition_id || proof.generation !== anchor.generation ||
				proof.definition_id !== binding.snapshot.definition_id || proof.generation !== binding.snapshot.generation || proof.registry_revision !== binding.snapshot.revision) return "unavailable";
			if (binding.viewId === anchor.view_id) return "unchanged";
			return surface.activateView(anchor.view_id, binding) ? "changed" : "unavailable";
		} catch { return "unavailable"; }
	}
	chooseBaseView(): void {
		const file = this.lastFile, target = this.current(), session = target.session, entryId = target.baseEntryId;
		const folder = file ? this.shares.shareFor(file.path) : undefined, tracked = entryId ? folder?.trackedEntries.get(entryId) : undefined;
		if (!file || !session || !entryId || !folder || !tracked || !isAttachmentFile(tracked) || !this.bases) { new Notice("Wait for this Bases file to finish synchronizing before choosing its discussion view."); return; }
		const current = () => !this.stopped && session.status !== "closed" && this.lastFile === file && this.targetFor(file).session === session && this.targetFor(file).baseEntryId === entryId;
		const bases = this.bases; let snapshot: BaseRegistrySnapshot | undefined;
		new BaseDiscussionPicker(this.plugin.app, async (state, after) => {
			if (!current()) throw new Error("Discussion context changed");
			if (state) {
				if (!snapshot) throw new Error("Load current views first");
				const page = await bases.savedViewPage(folder, tracked, snapshot, state, after);
				return { choices: page.views, next: page.has_more ? page.next_after ?? undefined : undefined };
			}
			let record = await bases.cachedViews(folder, tracked, { identity: session.identity, readable: () => {
				const scopeId = this.targetFor(file).entryId;
				return current() && session.status === "offline" && !!scopeId && session.permission(scopeId)?.read === true;
			} }), message: string | undefined;
			try { record = await bases.refreshViews(folder, tracked); }
			catch { message = "Showing saved associations. New targets require a previously verified context while offline. Refresh synchronization to see later view changes."; }
			if (!current() || !record.snapshot) throw new Error("Saved views unavailable");
			snapshot = record.snapshot;
			return { choices: [...snapshot.views.flatMap(view => view.id ? [{ id: view.id, name: view.name, type: view.type, state: "active" as const }] : []), ...snapshot.unmatched.views], message };
		}, async choice => {
			if (!current()) throw new Error("Discussion context changed");
			await session.trackLocal(session.store.setPreference("activeBaseView:" + entryId, protocolJson(choice)));
			if (!current()) return;
			this.baseSelection(session, entryId); this.baseSelections.get(session)!.get(entryId)!.choice = choice;
			this.focus = undefined; this.notify(); await this.open();
		}, current, listener => this.onChange(listener)).open();
	}
	async commentCurrentBase(session: DiscussionSession, scopeId: string): Promise<void> {
		const file = this.lastFile, target = this.current();
		if (!file || target.session !== session || target.entryId !== scopeId || target.kind !== "base") return;
		const folder = this.shares.shareFor(file.path); if (!folder) return;
		const current = () => !this.stopped && session.status !== "closed" && this.lastFile === file &&
			this.targetFor(file).session === session && this.targetFor(file).entryId === scopeId && !!session.permission(scopeId)?.comment;
		const records = (): BaseRecordChoice[] => {
			const found = new Map<string, BaseRecordChoice>(), duplicates = new Set<string>(), seen = new Set<string>();
			folder.folderIndex.eachRecord((record, path) => {
				if (seen.has(record.id)) duplicates.add(record.id); seen.add(record.id);
				if (!isBaseRecordType(record.type) || !session.canAnchorBaseRecord(record.type) || !isId(record.id) || !this.plugin.app.vault.getFileByPath(folder.absolutePath(path))) return;
				found.set(record.id, { id: record.id, path, kind: record.type });
			});
			for (const id of duplicates) found.delete(id);
			return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
		};
		const catalog = records();
		new BaseTargetPicker(this.plugin.app, target.baseViewName ?? "Saved view", query => {
			if (!current()) return { records: [], hasMore: false };
			const matches = catalog.filter(record => session.canAnchorBaseRecord(record.kind) && record.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
			return { records: matches.slice(0, 50), hasMore: matches.length > 50 };
		}, recordId => {
			const record = current() ? catalog.find(record => record.id === recordId) : undefined;
			if (!record || record.kind !== "markdown" || folder.folderIndex.recordFor(record.path)?.id !== recordId) return [];
			const note = record ? this.plugin.app.vault.getFileByPath(folder.absolutePath(record.path)) : null;
			return note ? Object.keys(this.plugin.app.metadataCache.getFileCache(note)?.frontmatter ?? {}).filter(name => name !== "position") : [];
		}, async selection => {
			if (!current()) return false;
			if (selection.type === "cell" || selection.type === "item") {
				const record = records().find(record => record.id === selection.recordId);
				if (!record || selection.type === "cell" && selection.property.source === "note" && record.kind !== "markdown") throw new Error("The shared record changed");
			}
			const anchor = await session.captureBaseTarget(scopeId, selection);
			if (!current()) return false;
			return this.saveCommentSelection({ file, session, entryId: scopeId, anchor });
		}, kind => current() && session.canAnchorBase(kind), current, listener => this.onChange(listener),
			() => session.readBaseDefinitions(scopeId)).open();
	}
	imageFileContext(file: TFile, writable = true): ImageFileCommentContext {
		const target = this.targetFor(file), session = target.session, entryId = target.entryId;
		const generation = entryId ? session?.knownDocumentGeneration(entryId) : undefined;
		const current = () => !this.stopped && !!session && !["closed", "authentication_required", "unavailable"].includes(session.status) && !!entryId &&
			this.plugin.app.vault.getFileByPath(file.path) === file && this.targetFor(file).kind === "image" &&
			this.targetFor(file).session === session && this.targetFor(file).entryId === entryId && !!session.permission(entryId)?.read &&
			session.knownDocumentGeneration(entryId) === generation && (!writable || session.canAnchorImageFiles && !!generation && !!session.permission(entryId)?.comment);
		if (target.kind !== "image" || !session || !entryId || !current()) throw new Error("Shared image context unavailable");
		return { file, session, entryId, generation, current };
	}
	commentImageFile(file?: TFile): void { if (file) void this.images?.commentFile(file); }
	commentCurrentImage(session: DiscussionSession, entryId: string): void {
		const target = this.current();
		if (target.session === session && target.entryId === entryId) this.commentImageFile(this.lastFile);
	}
	registerEditor(surface: CommentEditorSurface): () => void { this.editors.add(surface); return () => this.editors.delete(surface); }
	renderedImages(view: MarkdownView, occurrences: ImageOccurrence[]): RenderedImageTarget[] {
		return view.getMode() === "preview" ? this.reading?.renderedImages(view, occurrences) ?? [] :
			[...this.editors].find(surface => surface.editor === view.editor)?.renderedImages?.(occurrences) ?? [];
	}
	imageContext(view: MarkdownView, writable = true): ImageCommentContext {
		if (view.getMode() !== "preview") {
			const context = [...this.editors].find(surface => surface.editor === view.editor)?.imageContext?.(writable);
			if (!context) throw new Error("Shared image context unavailable"); return context;
		}
		const file = view.file, target = this.targetFor(file ?? undefined), session = target.session, id = target.entryId;
		const binding = readingCommentBinding(view), generation = id ? session?.documentGeneration(id) : undefined;
		const current = () => !this.stopped && !!file && view.file === file && this.plugin.app.vault.getFileByPath(file.path) === file &&
			this.targetFor(file).session === session && !!session && (writable ? session.canAnchorImages : session.canAnchorText) && !!id && !!session.permission(id)?.read && (!writable || !!session.permission(id)?.comment) &&
			session.documentGeneration(id) === generation && !!binding && readingCommentBinding(view)?.text === binding.text && view.getViewData() === binding.text.toString();
		if (!file || !session || !id || !binding || binding.documentId !== id || !generation || !current()) throw new Error("Shared image context unavailable");
		return { file, session, entryId: id, text: binding.text, generation, current };
	}
	readingViewFor(root: HTMLElement, sourcePath: string): MarkdownView | undefined {
		if (!root.isConnected || root.closest(".internal-embed,.markdown-embed,.canvas-node")) return undefined;
		return this.plugin.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).find((view): view is MarkdownView =>
			view instanceof MarkdownView && view.getMode() === "preview" && view.file?.path === sourcePath && view.contentEl.contains(root));
	}
	activeReadingView(): MarkdownView | undefined {
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.getMode() === "preview" && view.file && this.targetFor(view.file).session?.canAnchorText ? view : undefined;
	}
	async commentSelection(editor: Editor, blocks = false): Promise<void> {
		try {
			const surface = [...this.editors].find(item => item.editor === editor);
			if (!surface) { new Notice("Open this shared note in editing view and wait for it to synchronize before commenting on a selection."); return; }
			// Capture synchronously, before an asynchronous save or opening the sidebar
			// can move focus, replace the file, or alter the user's selection.
			await this.saveCommentSelection(surface.capture(blocks));
		} catch (error) { new Notice(error instanceof BlockSelectionError ? error.message : "The selection could not be saved. Check comment access and wait for the shared editor to finish synchronizing, then try again."); }
	}
	async saveCommentSelection({ session, entryId, file, anchor }: CapturedCommentSelection<LocalDiscussionAnchor>): Promise<boolean> {
		try {
			const current = () => !this.stopped && session.status !== "closed" && this.targetFor(file).session === session && this.targetFor(file).entryId === entryId && session.permission(entryId)?.comment;
			if (!current()) return false;
			const draftId = "selection:" + entryId + ":" + uuid();
			await session.trackLocal(session.store.saveDraft({ id: draftId, scopeId: entryId, revision: 0,
				body: { text: "", mentions: [] }, target: protocolJson(anchor) }, null));
			if (!current()) return false;
			await session.trackLocal(session.store.setPreference("activeNewDraft:" + entryId, draftId));
			if (!current()) return false;
			this.lastFile = file; this.focus = undefined; await this.open(); return true;
		} catch { new Notice("The selection draft could not be saved. Check local storage and comment access, then try again."); return false; }
	}
	focusedThread(session: DiscussionSession, entryId: string) {
		return this.focus?.session === session && this.focus.entryId === entryId ? this.focus : undefined;
	}
	async openThread(file: TFile, session: DiscussionSession, entryId: string, threadId: string): Promise<void> {
		if (this.stopped || session.status === "closed" || !session.permission(entryId)?.read ||
			this.targetFor(file).session !== session || this.targetFor(file).entryId !== entryId) return;
		this.lastFile = file; this.focus = { session, entryId, threadId, serial: ++this.focusSerial };
		try { await this.open(); } catch { new Notice("The comment sidebar could not be opened."); }
	}
	targetLabel(session: DiscussionSession, entryId: string, anchor: LocalDiscussionAnchor): string | undefined {
		if (anchor.type === "base_group_pending") return (anchor.range ? timelineRangeLabel(anchor.range.range) + " · lane: " : "Group: ") + anchor.property.name + " · " + baseGroupValueLabel(anchor.capture.value) + " (verification pending)";
		if (anchor.type !== "base" || parseDiscussionScope(entryId)?.viewId !== anchor.view_id) return;
		const target = anchor.target;
		if (target.type === "view") return "Entire saved view";
		if (target.type === "property") return "Property header: " + target.property.source + "." + target.property.name;
		if (target.type === "formula") return "Formula definition: " + target.property.name;
		if (target.type === "summary") return "Summary: " + target.property.source + "." + target.property.name + " · " + target.summary;
		if (target.type === "group") return "Group: " + target.property.name + " · " + baseGroupValueLabel(target.value);
		if (target.type === "timeline_range") return timelineRangeLabel(target.range) + (target.lane ? " · lane: " + target.lane.property.name + " · " + baseGroupValueLabel(target.lane.value) : "");
		if (target.type === "timeline_marker") return "Marker: " + target.content.label + " · " + timelineRangeLabel(target.content.range);
		const paths: string[] = [];
		const folder = this.shares.toArray().find(folder => folder.entityGuid === session.identity.shareId);
		folder?.folderIndex.eachRecord((record, path) => { if (isBaseRecordType(record.type) && record.id === target.record_id) paths.push(path); });
		const record = paths.length === 1 ? paths[0] : "Unavailable record (" + target.record_id.slice(0, 8) + ")";
		return target.type === "item" ? "Record: " + record : "Cell: " + record + " · " + target.property.source + "." + target.property.name;
	}
	async revealTarget(session: DiscussionSession, entryId: string, anchor: LocalDiscussionAnchor): Promise<void> {
		const available = () => !this.stopped && session.status !== "closed" && session.permission(entryId)?.read;
		if (!available()) return;
		const workspace = this.plugin.app.workspace;
		try {
			if (anchor.type === "base_group_pending") {
				if (await this.baseComments?.reveal(session, entryId, anchor)) return;
				if (available()) new Notice("This selection and its lane evidence are saved with your draft. Its original location is unavailable in the current view."); return;
			}
			if (anchor.type === "base") {
				const scope = parseDiscussionScope(entryId);
				if (scope?.viewId !== anchor.view_id) return;
				if (anchor.target.type !== "summary" && await this.baseComments?.reveal(session, entryId, anchor)) return;
				if ("definition_id" in anchor.target || anchor.target.type === "timeline_marker") {
					const status = await session.baseDefinitionStatus(entryId, anchor);
					if (available()) new Notice(this.targetLabel(session, entryId, anchor) + ". " + status + " The original target is retained; its exact location cannot be shown in this view.", 10000);
					return;
				}
				new Notice("Discussion view: " + (this.baseSelection(session, scope.entryId)?.name ?? "saved view") + ". " +
					this.targetLabel(session, entryId, anchor) + ". Inline navigation is unavailable here. The discussion and its target are retained.");
				return;
			}
			let file: TFile | undefined;
			for (const folder of this.shares.toArray()) if (folder.entityGuid === session.identity.shareId) {
				const paths: string[] = []; folder.folderIndex.eachRecord((record, path) => { if (record.id === entryId) paths.push(path); });
				if (paths.length !== 1) break;
				file = this.plugin.app.vault.getFileByPath(folder.absolutePath(paths[0])) ?? undefined;
			}
			if (!file || this.targetFor(file).session !== session || this.targetFor(file).entryId !== entryId) return;
			if (anchor.type === "image_file") {
				if (this.targetFor(file).kind !== "image" || anchor.asset.entry_id !== entryId) return;
				let existing: WorkspaceLeaf | undefined;
				workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof FileView && leaf.view.file === file) existing = leaf; });
				const leaf = existing ?? workspace.getLeaf("tab");
				await leaf.openFile(file); await workspace.revealLeaf(leaf);
				if (available()) this.images?.revealFile(file, session, entryId, anchor);
				return;
			}
			const existing = workspace.getLeavesOfType("markdown").find(leaf => leaf.view instanceof MarkdownView && leaf.view.file === file);
			if (anchor.type === "image" && existing?.view instanceof MarkdownView) {
				await workspace.revealLeaf(existing);
				if (this.images?.reveal(existing.view, session, entryId, anchor)) return;
			}
			if (anchor.type !== "image" && existing?.view instanceof MarkdownView && existing.view.getMode() === "preview") {
				await workspace.revealLeaf(existing);
				if (anchor.type === "note" || this.reading?.reveal(existing.view, session, entryId, anchor)) return;
			}
			const leaf = existing ?? workspace.getLeaf("tab");
			await leaf.setViewState({ type: "markdown", active: true, state: { file: file.path, mode: "source" } });
			await workspace.revealLeaf(leaf);
			if (anchor.type === "note") return;
			for (let attempt = 0; attempt < 20; attempt++) {
				if (!available()) return;
				if (anchor.type === "image" && leaf.view instanceof MarkdownView && this.images?.reveal(leaf.view, session, entryId, anchor)) return;
				const surface = [...this.editors].find(item => item.file === file && leaf.view instanceof MarkdownView && item.editor === leaf.view.editor);
				if (anchor.type !== "image" && surface?.reveal(session, entryId, anchor)) return;
				await new Promise(resolve => window.setTimeout(resolve, 50));
			}
			new Notice("This selection is unavailable or still syncing. Its original text remains with the discussion; it has not been moved to a similar passage.");
		} catch { new Notice("This comment’s selection could not be opened."); }
	}
	retry(): void {
		for (const [key, slot] of this.slots) if (slot.failed) { slot.cancelled = true; this.slots.delete(key); }
		this.reconcile();
	}
	async open(): Promise<void> {
		const workspace = this.plugin.app.workspace;
		const leaf = workspace.getLeavesOfType(COMMENTS_VIEW)[0] ?? workspace.getRightLeaf(false) ?? workspace.getRightLeaf(true) ?? workspace.getLeaf(true);
		await leaf.setViewState({ type: COMMENTS_VIEW, active: true }); await workspace.revealLeaf(leaf);
		this.notify();
	}
	async openInbox(): Promise<void> {
		const workspace = this.plugin.app.workspace;
		const leaf = workspace.getLeavesOfType(INBOX_VIEW)[0] ?? workspace.getRightLeaf(false) ?? workspace.getRightLeaf(true) ?? workspace.getLeaf(true);
		await leaf.setViewState({ type: INBOX_VIEW, active: true }); await workspace.revealLeaf(leaf);
	}
	onunload(): void {
		this.stopped = true;
		this.rangeWorkflow?.close(); this.rangeWorkflow = undefined;
		this.markerPicker?.close(); this.markerPicker = undefined;
		this.focus = undefined; this.editors.clear();
		for (const slot of this.slots.values()) { slot.cancelled = true; void slot.session?.close(); }
		for (const unsubscribe of this.folderListeners.values()) unsubscribe();
		this.slots.clear(); this.folderListeners.clear(); this.notify(); this.listeners.clear();
	}
}
