import { Component, FileView, MarkdownView, Modal, Notice, Setting, setIcon, type Plugin, type TFile, type WorkspaceLeaf } from "obsidian";
import * as Y from "yjs";
import { v4 as uuidv4 } from "uuid";
import type { RelayOnPremSettings } from "../../RelayOnPremConfig";
import { LocationHost, type NoteImageObserver } from "./LocationHost";
import { baseFollowPosition } from "./BasePresenceMotion";
import { sameNote, type LocationEvent, type SurfaceLocation } from "./LocationProtocol";
import type { AuthSession } from "../../AuthSession";
import { DocumentViewBinding, type ViewBindingRegistry } from "../../ViewBindings";
import type { SettingsScope } from "../../SettingsPersistence";
import type { YSweetProvider } from "../../client/provider";
import { readingCommentBinding, onReadingBindingChange } from "../ReadingTextBinding";
import type { NotePresenceSurface, PresenceSettings } from "./PresenceSettings";
import { NotePresenceSurfaces } from "./NotePresenceSurfaces";
import { isNotePeer, peerLocation, presencePeers, type ActivePresencePeer, type PresenceLocation, type PresencePeer, type SurfacePresencePeer } from "./PresencePeers";
import { PresenceRoster } from "./PresenceRoster";
import type { ReadingPresenceScope } from "./ReadingPresenceLayer";

type Binding = DocumentViewBinding<MarkdownView>;
export type PresenceStatus = "hidden" | "idle" | "waiting" | "offline" | "ready" | "recovering" | "capacity" | "unavailable";
const descriptions: Record<PresenceStatus, string> = {
	hidden: "Your presence is hidden.",
	idle: "Open a shared note, image or Bases view to share your presence.",
	waiting: "Waiting for this note’s shared view and account to be ready.",
	offline: "Presence is offline. It will return when this note reconnects.",
	ready: "Your presence is visible in this note.",
	recovering: "Reconnecting your presence…",
	capacity: "This note’s presence room is full. Retrying automatically; note sync remains available.",
	unavailable: "Presence is unavailable. You can retry; note sync remains available.",
};

/** One owner across leaves/popouts. Note sync retains its existing lifecycle;
 * the optional location channel carries only authorized active-note descriptors. */
export class PresenceController extends Component {
	readonly instanceId = uuidv4();
	private active?: { binding: Binding; surface: NotePresenceSurface };
	private candidate?: Binding;
	private observed?: YSweetProvider;
	private stopProvider?: () => void;
	private windows = new Map<Document, () => void>();
	private blurred = new WeakSet<Document>();
	private listeners = new Set<() => void>();
	private action?: HTMLElement;
	private actionView?: FileView;
	private stopped = false;
	private refreshing = false;
	private surfaces!: NotePresenceSurfaces;
	private peersTimer?: number;
	private followTimer?: number;
	private followBar?: HTMLElement;
	private followLabel?: HTMLElement;
	private followView?: FileView;
	private lastFollowPosition?: string;
	private navigationVersion = 0;
	private followBusy = false;
	private pendingSurfaceTarget?: { key: string; target: string | undefined };
	private followingMode?: string;
	private controls?: PresenceControls;
	private locations?: LocationHost;
	private crossFollow?: { subscriptionId: string; peer: ActivePresencePeer; location: SurfaceLocation; file: TFile;
		leaf: WorkspaceLeaf; opening?: TFile; busy: boolean; waitUntil: number };
	peers: ActivePresencePeer[] = [];
	following?: ActivePresencePeer;
	navigationMessage = "";
	status: PresenceStatus = "idle";
	visible = true;

	constructor(private plugin: Plugin, private registry: ViewBindingRegistry, private auth: AuthSession,
		private settings: SettingsScope<PresenceSettings>, private serverSettings?: SettingsScope<RelayOnPremSettings>) { super(); }

	onload(): void {
		const workspace = this.plugin.app.workspace;
		this.surfaces = this.addChild(new NotePresenceSurfaces(this.plugin, location => this.publishLocation(location), () => this.stopFollowing("Following stopped because you interacted with the note.")));
		if (this.serverSettings) this.locations = this.addChild(new LocationHost(this.plugin, this.registry.shareRegistry, this.auth,
			this.serverSettings, this.instanceId, { changed: () => this.refresh(), location: event => this.remoteLocation(event),
				stopped: () => this.stopFollowing("Following stopped because the connection changed."),
				interacted: () => this.stopFollowing("Following stopped because you interacted with the view."),
				positions: () => {
					if (this.canObserveSurface()) this.peers = this.locations!.surfacePeers;
					else if (!this.canNavigate()) return;
					const pending = this.pendingSurfaceTarget;
					if (pending) {
						const peer = this.peers.find(peer => peer.key === pending.key);
						if (!peer || isNotePeer(peer) || JSON.stringify(baseFollowPosition(peer.baseState, true)?.target) !== pending.target) this.locations?.cancelSurfaceNavigation();
					}
					// Pointer motion updates the overlay and Follow, not roster labels
					// or the complete note/host lifecycle.
					if (this.following) this.scheduleFollow();
				} }));
		this.register(this.registry.onViewsChanged(() => this.refresh()));
		this.register(this.auth.on(() => this.refresh()));
		this.register(this.auth.onTokenRefreshed(() => this.refresh()));
		this.register(onReadingBindingChange(() => this.refresh()));
		this.register(this.settings.subscribe(value => { this.visible = value?.visible !== false; this.refresh(); }));
		this.registerEvent(workspace.on("active-leaf-change", () => this.refresh()));
		this.registerEvent(workspace.on("file-open", () => this.refresh()));
		this.registerEvent(workspace.on("layout-change", () => this.refresh()));
		this.registerEvent(this.plugin.app.vault.on("rename", () => this.refresh()));
		this.registerEvent(this.plugin.app.vault.on("delete", () => this.refresh()));
		this.registerEvent(this.plugin.app.vault.on("modify", () => { if (this.locations?.surfaceActive) this.refresh(); else this.locations?.refreshEmbeds(); }));
		this.registerEvent(workspace.on("window-open", () => this.refresh()));
		this.registerEvent(workspace.on("window-close", (_host, win) => {
			this.blurred.add(win.document); this.clearActive(win.document);
			this.windows.get(win.document)?.(); this.windows.delete(win.document); this.refresh();
		}));
		this.plugin.addCommand({ id: "presence-controls", name: "Presence controls", callback: () => this.openControls() });
		this.plugin.addCommand({ id: "toggle-presence", name: "Toggle presence visibility", callback: () => { void this.setVisible(!this.visible); } });
		this.plugin.addCommand({ id: "stop-following", name: "Stop following collaborator", checkCallback: checking => {
			if (!this.following) return false; if (!checking) this.stopFollowing(); return true;
		} });
		this.refresh();
	}

	onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	get surfaceName(): "note" | "image" | "Bases view" { return this.locations?.baseActive ? "Bases view" : this.locations?.imageActive ? "image" : "note"; }
	get description(): string { return this.surfaceName !== "note" && this.status !== "idle" ? descriptions[this.status].replace(/\bnote\b/g, this.surfaceName) : descriptions[this.status]; }
	get canRetry(): boolean { return this.visible && !!this.active && ["unavailable", "capacity"].includes(this.status) ||
		!!this.locations && (["authentication", "unavailable", "unsupported"].includes(this.locations.status) || this.locations.surfaceActive && this.locations.surfaceState === "unavailable" || this.locations.embeddedUnavailable || this.locations.imageObserverUnavailable); }
	get navigationDescription(): string {
		return this.locations?.ready ? (this.locations.supportsBases ? "Follow can move between shared notes, supported images and saved Bases views." : this.locations.supportsImages ? "Follow can move between shared notes and images." : "Follow can move between shared notes.") : this.locations?.status === "connecting" || this.locations?.status === "reconnecting" ?
			"Connecting across notes. Current-note navigation is available." : "Follow is currently limited to this note.";
	}
	async setVisible(visible: boolean): Promise<void> {
		// Apply privacy immediately, including if saving preferences fails.
		this.visible = visible; this.refresh();
		try { await this.settings.mutateValue(current => ({ ...current, visible })); }
		catch { new Notice("Presence visibility changed for this session, but the preference could not be saved."); }
	}
	retry(): void { if (this.canRetry) { this.active?.binding.boundDocument._liveProvider.presence.retry(); this.locations?.retry(); this.refresh(); } }
	openControls(): void {
		if (this.stopped) return;
		this.controls?.close(); this.controls = new PresenceControls(this.plugin, this); this.controls.open();
	}

	private clearActive(owner?: Document): void {
		if (!this.active || owner && this.active.binding.hostView?.containerEl.ownerDocument !== owner) return;
		const previous = this.active; this.active = undefined;
		previous.binding.boundDocument?.setPresenceActive();
	}
	private observe(provider?: YSweetProvider): void {
		if (provider === this.observed) return;
		if (!this.crossFollow) this.stopFollowing("Following stopped because the active note changed.");
		this.stopProvider?.(); this.observed = provider;
		if (!provider) { this.stopProvider = undefined; return; }
		const changed = () => this.refresh();
		const peersChanged = (event: { added: number[]; updated: number[]; removed: number[] }) => {
			if (!event.added.concat(event.updated, event.removed).some(id => id !== provider.awareness.clientID)) return;
			if (event.removed.length) this.refreshPeers();
			else if (this.peersTimer === undefined) this.peersTimer = window.setTimeout(() => { this.peersTimer = undefined; this.refreshPeers(); }, 100);
		};
		provider.on("status", changed); provider.on("sync", changed); provider.on("presence-status", changed);
		provider.awareness.on("change", peersChanged);
		this.stopProvider = () => {
			provider.off("status", changed); provider.off("sync", changed); provider.off("presence-status", changed);
			provider.awareness.off("change", peersChanged);
			if (this.peersTimer !== undefined) window.clearTimeout(this.peersTimer); this.peersTimer = undefined;
		};
	}
	private watchWindows(): void {
		const wanted = new Set<Document>([document]);
		const activeView = this.plugin.app.workspace.getActiveViewOfType(FileView);
		if (activeView?.containerEl.isConnected) wanted.add(activeView.containerEl.ownerDocument);
		for (const binding of this.registry.trackedViews) if (binding.hostView?.containerEl?.isConnected) wanted.add(binding.hostView.containerEl.ownerDocument);
		for (const [doc, stop] of this.windows) if (!wanted.has(doc)) { stop(); this.windows.delete(doc); }
		for (const doc of wanted) {
			if (this.windows.has(doc) || !doc.defaultView) continue;
			const win = doc.defaultView;
			const blur = () => { this.blurred.add(doc); this.clearActive(doc); this.refresh(); };
			const focus = () => { this.blurred.delete(doc); this.refresh(); };
			const visibility = () => { if (doc.hidden) blur(); else focus(); };
			win.addEventListener("blur", blur); win.addEventListener("pagehide", blur);
			win.addEventListener("focus", focus); win.addEventListener("pageshow", focus);
			doc.addEventListener("visibilitychange", visibility);
			this.windows.set(doc, () => {
				win.removeEventListener("blur", blur); win.removeEventListener("pagehide", blur);
				win.removeEventListener("focus", focus); win.removeEventListener("pageshow", focus);
				doc.removeEventListener("visibilitychange", visibility);
			});
		}
	}

	refresh(): void {
		if (this.stopped || this.refreshing) return;
		this.refreshing = true;
		try {
			this.watchWindows();
			const view = this.plugin.app.workspace.getActiveViewOfType(FileView), noteView = view instanceof MarkdownView ? view : undefined;
			const cross = this.crossFollow;
			if (cross && (view?.leaf !== cross.leaf || view.file !== cross.file && view.file !== cross.opening)) this.stopFollowing("Following stopped because you changed notes.");
			const candidate = !this.registry.isShutDown && this.registry.trackedViews.find((item): item is Binding =>
				item instanceof DocumentViewBinding && item.hostView === noteView && !!item.boundDocument &&
				view?.file?.extension === "md" && item.boundDocument._obsidianFile === view.file &&
				this.plugin.app.vault.getFileByPath(view.file.path) === view.file &&
				this.registry.shareRegistry.shareFor(view.file.path) === item.boundDocument.vaultShare);
			this.candidate = candidate || undefined;
			this.observe(this.candidate?.boundDocument._liveProvider);
			const surface: NotePresenceSurface = noteView?.getMode() === "preview" ? "reading" : "editor";
			if (this.following && noteView && !this.crossFollow?.opening) {
				if (this.followingMode !== undefined && noteView.getMode() !== this.followingMode) this.stopFollowing("Following stopped because the view changed.");
				else this.followingMode = noteView.getMode();
			}
			const owner = view?.containerEl.ownerDocument;
			const foreground = !!view?.containerEl.isConnected && !!owner?.hasFocus() && !owner.hidden && !this.blurred.has(owner);
			this.locations?.update(view, foreground && !this.registry.isShutDown, this.visible);
			if (this.locations) {
				const images: FileView[] = [];
				this.plugin.app.workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof FileView) images.push(leaf.view); });
				this.locations.setImageObservers(images);
			}
			const reading = surface === "reading" && noteView ? readingCommentBinding(noteView) : undefined;
			const bound = !!candidate && (surface === "editor" ? candidate.isTracking :
				reading?.documentId === candidate.boundDocument.entityGuid && reading.text === candidate.boundDocument.crdtText);
			const currentAccount = candidate && this.auth.getCurrentUserForServer(candidate.boundDocument.vaultShare.config.onpremServerId);
			const allowed = this.visible && candidate && bound && currentAccount && candidate.connectionAllowed && candidate.wantsConnection &&
				candidate.boundDocument.vaultShare.wantsConnection && view?.containerEl.isConnected && owner?.hasFocus() &&
				!owner.hidden && !this.blurred.has(owner);
			const changed = this.active?.binding !== candidate || this.active?.surface !== surface;
			if (!allowed || changed) this.clearActive();
			if (allowed) {
				this.active = { binding: candidate, surface };
				candidate.boundDocument.setPresenceActive(surface, this.instanceId);
				// Activation may happen after the editor's focus transaction. Capture
				// its actual selection once; Reading never invents an editor caret.
				if (changed && surface === "editor" && noteView!.editor.hasFocus()) this.captureEditor(candidate);
			}
			const navigable = candidate && bound && currentAccount && candidate.connectionAllowed && candidate.wantsConnection &&
				candidate.boundDocument.vaultShare.wantsConnection && view?.containerEl.isConnected && owner?.hasFocus() && !owner.hidden && !this.blurred.has(owner);
			this.surfaces.setActive(navigable ? noteView! : undefined, navigable ? candidate.boundDocument.crdtText : undefined, navigable ? candidate.boundDocument.entityGuid : undefined);
			this.locations?.setNoteSurface(navigable ? noteView! : undefined, navigable ? candidate.boundDocument.crdtText : undefined,
				images => this.surfaces.imageTargets(images), () => this.canNavigate() && this.surfaces.hasCurrentBinding());
			this.refreshReaders();
			if (!foreground || !this.crossFollow && !this.canObserveSurface() && (!navigable || !this.observed?.wsconnected)) this.stopFollowing("Location unavailable.");
			const provider = this.observed;
			this.status = !this.visible ? "hidden" : !candidate || !owner?.hasFocus() || this.blurred.has(owner) || owner.hidden ? "idle" :
				!bound || !currentAccount ? "waiting" : !provider?.wsconnected ? "offline" :
				!this.active || provider.awareness.getLocalState() === null ? "waiting" : provider.presence.availability;
			if (this.locations?.surfaceActive) this.status = !this.visible ? "hidden" : !this.locations.ready ?
				(this.locations.status === "connecting" ? "waiting" : this.locations.status === "reconnecting" ? "recovering" : "unavailable") : this.locations.surfaceState;
			this.updateAction(this.candidate?.hostView ?? (this.locations?.surfaceActive ? view ?? undefined : undefined));
			this.refreshPeers();
		} finally { this.refreshing = false; }
	}

	private refreshReaders(): void {
		const scopes: ReadingPresenceScope[] = [];
		const images: NoteImageObserver[] = [];
		for (const binding of this.registry.trackedViews) {
			if (!(binding instanceof DocumentViewBinding) || !binding.boundDocument) continue;
			const view = binding.hostView as MarkdownView, doc = binding.boundDocument, provider = doc._liveProvider, text = doc.crdtText;
			if (!view) continue;
			const mode = view.getMode();
			const permitted = () => {
				const owner = view.containerEl.ownerDocument, reading = readingCommentBinding(view);
				return !this.stopped && !this.registry.isShutDown && this.registry.trackedViews.includes(binding) && binding.boundDocument === doc && doc.crdtText === text &&
					binding.connectionAllowed && binding.wantsConnection && doc.vaultShare.wantsConnection && doc.hasCurrentPresenceAccount() &&
					!!this.auth.getCurrentUserForServer(doc.vaultShare.config.onpremServerId) && view.containerEl.isConnected && owner.hasFocus() && !owner.hidden && !this.blurred.has(owner) &&
					view.getMode() === mode && !!view.file && view.file.extension === "md" && doc._obsidianFile === view.file &&
					this.plugin.app.vault.getFileByPath(view.file.path) === view.file && this.registry.shareRegistry.shareFor(view.file.path) === doc.vaultShare &&
					(mode === "preview" ? reading?.documentId === doc.entityGuid && reading.text === doc.crdtText : binding.isTracking);
			};
			if (permitted()) {
				const current = () => permitted() && provider.wsconnected;
				if (mode === "preview") scopes.push({ view, text, id: doc.entityGuid, provider, current });
				images.push({ view, text, current, targets: occurrences => this.surfaces.imageTargetsFor(view, text, doc.entityGuid, occurrences) });
			}
		}
		this.surfaces.setReaders(scopes);
		this.locations?.setNoteObservers(images);
	}
	private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* Isolate UI. */ } } }
	private publishLocation(location: PresenceLocation): void {
		const active = this.active, provider = active?.binding.boundDocument._liveProvider, state = provider?.awareness.getLocalState();
		if (active && provider && state && JSON.stringify([state.viewport ?? null, state.selection ?? null]) !== JSON.stringify([location.viewport ?? null, location.selection ?? null])) {
			provider.awareness.setLocalState({ ...state, viewport: location.viewport ?? null, selection: active.surface === "reading" ? location.selection ?? null : null });
		}
		this.scheduleFollow();
		this.locations?.refreshEmbeds();
	}
	private canNavigate(): boolean {
		const candidate = this.candidate, view = candidate?.hostView, owner = view?.containerEl.ownerDocument;
		const reading = view?.getMode() === "preview" ? readingCommentBinding(view) : undefined;
		const bound = !!candidate && (view?.getMode() === "preview" ? reading?.text === candidate.boundDocument.crdtText && reading.documentId === candidate.boundDocument.entityGuid : candidate.isTracking);
		return !!candidate && !this.stopped && !!this.observed?.wsconnected && candidate.connectionAllowed && candidate.wantsConnection &&
			bound && this.registry.trackedViews.includes(candidate) && !this.registry.isShutDown && candidate.boundDocument.hasCurrentPresenceAccount() &&
			candidate.boundDocument.vaultShare.wantsConnection && !!this.auth.getCurrentUserForServer(candidate.boundDocument.vaultShare.config.onpremServerId) &&
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView) === view && !!owner?.hasFocus() && !owner.hidden && !this.blurred.has(owner) &&
			!!view?.file && this.plugin.app.vault.getFileByPath(view.file.path) === view.file &&
			this.registry.shareRegistry.shareFor(view.file.path) === candidate.boundDocument.vaultShare;
	}
	private refreshPeers(): void {
		this.peers = this.canObserveSurface() ? this.locations!.surfacePeers : this.canNavigate() && this.observed ? presencePeers(this.observed.awareness) : [];
		this.locations?.setNotePeers(this.peers.filter(isNotePeer));
		if (this.following) {
			const cross = this.crossFollow;
			const current = cross ? this.peers.find(peer => this.atFollowDestination() && this.sameParticipant(peer, cross.peer)) : this.peers.find(peer => peer.key === this.following!.key);
			if (current) { this.following = current; this.scheduleFollow(); }
			else if (cross) this.scheduleFollow();
			else this.stopFollowing("Location unavailable.");
		}
		this.updateFollowBar(); this.notify();
	}
	private canObserveSurface(): boolean {
		const view = this.plugin.app.workspace.getActiveViewOfType(FileView), owner = view?.containerEl.ownerDocument;
		const location = this.locations?.currentLocation;
		return !this.stopped && !this.registry.isShutDown && !!view?.containerEl.isConnected && !!owner?.hasFocus() && !owner.hidden && !this.blurred.has(owner) &&
			this.locations?.ready === true && !!location && location.kind !== "note";
	}
	canLocate(peer: ActivePresencePeer): boolean {
		return isNotePeer(peer) ? this.canNavigate() && !!this.notePosition(peer, false) :
			this.canObserveSurface() && JSON.stringify(peer.location) === JSON.stringify(this.locations?.currentLocation) && this.peers.some(item => item.key === peer.key);
	}
	private notePosition(peer: PresencePeer, follow: boolean): { from: number; to: number; signature?: string } | undefined {
		return this.locations?.embedPosition(peer, follow) ?? (this.candidate ? peerLocation(peer, this.candidate.boundDocument.crdtText, follow) : undefined);
	}
	private async revealNote(peer: PresencePeer, position: { from: number; to: number }, follow: boolean, current: () => boolean): Promise<boolean> {
		if (this.locations?.revealEmbed(peer, follow, current)) return true;
		if (!await this.surfaces.reveal(position.from, position.to, current) || !current()) return false;
		// Materialize an offscreen widget/Reading section before applying image
		// coordinates. Source view keeps the exact Markdown occurrence fallback.
		if (this.locations?.embedPosition(peer)) await this.locations.materializeEmbed(peer, follow, current);
		return current();
	}
	private surfacePosition(peer: SurfacePresencePeer): string {
		return JSON.stringify([peer.location, peer.surface === "base" ? baseFollowPosition(peer.baseState, true) : peer.imageState?.viewport ?? peer.imageState?.pointer]);
	}
	/** Re-read the selected peer at click time; stale UI cannot navigate. */
	async navigate(key: string, follow: boolean): Promise<boolean> {
		this.refresh();
		this.stopFollowing(); const version = ++this.navigationVersion, candidate = this.candidate;
		const peer = this.peers.find(peer => peer.key === key);
		if (peer && !isNotePeer(peer)) {
			const view = this.plugin.app.workspace.getActiveViewOfType(FileView);
			const current = () => version === this.navigationVersion && this.plugin.app.workspace.getActiveViewOfType(FileView) === view && this.canLocate(peer);
			let revealed = false;
			try { revealed = !!view?.file && current() && await this.locations?.revealSurface(peer, current, follow) === true; } catch { /* A replaced or unsupported native target cannot navigate. */ }
			if (version !== this.navigationVersion) return false;
			if (!view?.file || !current() || !revealed) { this.navigationMessage = "Location unavailable or still synchronizing."; this.notify(); return false; }
			const location = this.locations?.currentLocation, subscriptionId = follow ? this.locations?.follow(peer) : undefined;
			if (follow && (!subscriptionId || !location)) { this.navigationMessage = "Following is unavailable."; this.notify(); return false; }
			this.following = follow ? peer : undefined; this.followingMode = undefined; this.lastFollowPosition = this.surfacePosition(peer);
			if (subscriptionId && location) this.crossFollow = { subscriptionId, peer, location, file: view.file, leaf: view.leaf, busy: false, waitUntil: 0 };
			this.navigationMessage = follow ? `Following ${peer.name}.` : `Jumped to ${peer.name}.`;
			this.updateFollowBar(); this.notify(); this.scheduleFollow(); return true;
		}
		const position = peer && isNotePeer(peer) && this.canNavigate() ? this.notePosition(peer, follow) : undefined;
		const current = () => version === this.navigationVersion && candidate === this.candidate && this.canNavigate() && this.peers.some(item => item.key === key);
		let revealed = false;
		try { revealed = !!position && !!peer && isNotePeer(peer) && await this.revealNote(peer, position, follow, current); } catch { /* Unsupported/unmounted surface. */ }
		if (version !== this.navigationVersion) return false;
		if (!peer || !position || !revealed || !current()) {
			this.navigationMessage = "Location unavailable or still synchronizing."; this.notify(); return false;
		}
		this.following = follow ? this.peers.find(item => item.key === key) : undefined; this.lastFollowPosition = JSON.stringify(position);
		this.followingMode = follow ? candidate?.hostView.getMode() : undefined;
		const subscriptionId = follow ? this.locations?.follow(peer) : undefined, location = this.locations?.currentLocation;
		if (subscriptionId && location && candidate?.hostView.file) this.crossFollow = { subscriptionId, peer, location,
			file: candidate.hostView.file, leaf: candidate.hostView.leaf, busy: false, waitUntil: Date.now() + 8000 };
		this.navigationMessage = follow ? `Following ${peer.name}${this.crossFollow ? "." : " in this note."}` : `Jumped to ${peer.name}.`;
		this.updateFollowBar(); this.notify(); this.scheduleFollow(); return true;
	}
	stopFollowing(message = "Following stopped."): void {
		this.navigationVersion++;
		this.crossFollow = undefined; this.locations?.unfollow();
		this.pendingSurfaceTarget = undefined;
		if (this.followTimer !== undefined) window.clearTimeout(this.followTimer); this.followTimer = undefined;
		if (!this.following) return;
		this.following = undefined; this.followingMode = undefined; this.lastFollowPosition = undefined; this.navigationMessage = message;
		this.updateFollowBar(); this.notify();
	}
	private scheduleFollow(): void {
		if (!this.following || this.followTimer !== undefined || this.followBusy || this.stopped) return;
		this.followTimer = window.setTimeout(() => {
			this.followTimer = undefined;
			void this.advanceFollow();
		}, 100);
	}
	private async advanceFollow(): Promise<void> {
		if (this.crossFollow) {
			const cross = this.crossFollow;
			if (!this.following || !this.locations?.ready) { this.stopFollowing("Location unavailable."); return; }
			const peer = this.peers.find(peer => this.atFollowDestination() && this.sameParticipant(peer, cross.peer));
			if (!peer || !(isNotePeer(peer) ? this.canNavigate() : this.canObserveSurface())) {
				if (!cross.waitUntil) cross.waitUntil = Date.now() + 8000;
				if (Date.now() >= cross.waitUntil) { this.stopFollowing("Following stopped. The shared location is unavailable or still synchronizing."); return; }
				void this.openFollowDestination(cross); this.scheduleFollow(); return;
			}
			this.following = peer;
			if (!isNotePeer(peer)) {
				const version = this.navigationVersion, target = JSON.stringify(baseFollowPosition(peer.baseState, true)?.target);
				const latest = () => this.peers.find(item => item.key === peer.key);
				const current = () => { const now = latest(); return version === this.navigationVersion && this.crossFollow === cross && this.canLocate(peer) &&
					(peer.surface !== "base" || !!now && !isNotePeer(now) && JSON.stringify(baseFollowPosition(now.baseState, true)?.target) === target); };
				const position = this.surfacePosition(peer);
				if (position === this.lastFollowPosition) { cross.waitUntil = 0; return; }
				this.followBusy = true;
				this.pendingSurfaceTarget = peer.surface === "base" ? { key: peer.key, target } : undefined;
				try {
					const revealed = await this.locations.revealSurface(peer, current, true);
					if (!current()) return;
					if (!revealed) { this.stopFollowing("Location unavailable."); return; }
					this.lastFollowPosition = position; cross.waitUntil = 0;
				} catch { if (current()) this.stopFollowing("Location unavailable."); }
				finally {
					this.followBusy = false; this.pendingSurfaceTarget = undefined; const now = latest();
					if (this.crossFollow === cross && this.following && now && !isNotePeer(now) && this.surfacePosition(now) !== this.lastFollowPosition) this.scheduleFollow();
				}
				return;
			}
		}
		if (!this.following || !isNotePeer(this.following) || !this.candidate || !this.canNavigate()) { this.stopFollowing("Location unavailable."); return; }
		const position = this.notePosition(this.following, true);
		if (!position) {
			const cross = this.crossFollow;
			if (cross) {
				if (!cross.waitUntil) cross.waitUntil = Date.now() + 8000;
				if (Date.now() >= cross.waitUntil) this.stopFollowing("Location unavailable or still synchronizing."); else this.scheduleFollow();
			} else this.stopFollowing("Location unavailable.");
			return;
		}
		if (this.crossFollow) this.crossFollow.waitUntil = 0;
		if (JSON.stringify(position) === this.lastFollowPosition) return;
		const version = this.navigationVersion, key = this.following.key;
		const current = () => version === this.navigationVersion && this.following?.key === key && this.canNavigate();
		this.followBusy = true;
		try {
			const revealed = await this.revealNote(this.following, position, true, current);
			if (!current()) return;
			if (!revealed) { this.stopFollowing("Location unavailable or still synchronizing."); return; }
			this.lastFollowPosition = JSON.stringify(position);
		} catch { if (current()) this.stopFollowing("Location unavailable."); }
		finally {
			this.followBusy = false;
			if (this.following && isNotePeer(this.following) && this.candidate && JSON.stringify(this.notePosition(this.following, true)) !== this.lastFollowPosition) this.scheduleFollow();
		}
	}
	private sameParticipant(a: ActivePresencePeer, b: ActivePresencePeer): boolean {
		return a.userId === b.userId && a.sessionId === b.sessionId && !!a.instanceId && a.instanceId === b.instanceId;
	}
	private atFollowDestination(): boolean {
		const cross = this.crossFollow, doc = this.candidate?.boundDocument;
		if (cross && cross.location.kind !== "note") return this.canObserveSurface() && JSON.stringify(cross.location) === JSON.stringify(this.locations?.currentLocation);
		return cross?.location.kind === "note" && !!doc && cross.location.entry_id === doc.entityGuid && cross.location.share_id === doc.vaultShare.entityGuid;
	}
	private remoteLocation(event: LocationEvent): void {
		const cross = this.crossFollow;
		if (!cross || event.subscriptionId !== cross.subscriptionId) return;
		if (!event.location || event.location.kind === "base" && !this.locations?.supportsBases) { this.stopFollowing("Location unavailable."); return; }
		if (!(event.location.kind === "note" && cross.location.kind === "note" ? sameNote(event.location, cross.location) : JSON.stringify(event.location) === JSON.stringify(cross.location))) this.lastFollowPosition = undefined;
		cross.location = event.location; cross.waitUntil = Date.now() + 8000; this.scheduleFollow();
	}
	private async openFollowDestination(cross: NonNullable<PresenceController["crossFollow"]>): Promise<void> {
		if (cross !== this.crossFollow || cross.busy || this.atFollowDestination()) return;
		const location = cross.location, file = this.locations?.fileFor(location);
		if (!file) return;
		const view = this.plugin.app.workspace.getActiveViewOfType(FileView);
		if (!view || view.leaf !== cross.leaf || view.file !== cross.file) { this.stopFollowing("Following stopped because you changed notes."); return; }
		cross.busy = true; cross.opening = file;
		try {
			const state = cross.leaf.getViewState().state;
			if (view.file !== file) await cross.leaf.openFile(file, { active: true, state: location.kind === "note" ? { mode: this.followingMode, ...(typeof state?.source === "boolean" ? { source: state.source } : {}) } : undefined });
			if (cross !== this.crossFollow) return;
			const active = this.plugin.app.workspace.getActiveViewOfType(FileView);
			if (active?.leaf !== cross.leaf || active.file !== file || this.locations?.fileFor(location) !== file) { this.stopFollowing("Location unavailable."); return; }
			cross.file = file; cross.opening = undefined; this.refresh();
			if (cross.location !== location) return; // A newer destination superseded the in-flight open.
			if (location.kind === "base" && cross === this.crossFollow) {
				const current = () => cross === this.crossFollow && cross.location === location && this.plugin.app.workspace.getActiveViewOfType(FileView) === active && this.locations?.fileFor(location) === file;
				const result = this.locations?.activateBase(location, current);
				if (!current()) return;
				if (result === "unavailable") { this.stopFollowing("The saved view is unavailable or has changed."); return; }
				this.refresh();
			}
		} catch { if (cross === this.crossFollow) this.stopFollowing("The shared file could not be opened."); }
		finally { cross.busy = false; if (cross === this.crossFollow) { cross.opening = undefined; this.scheduleFollow(); } }
	}
	private updateFollowBar(): void {
		const view = this.following ? this.candidate?.hostView ?? (this.crossFollow?.leaf.view instanceof FileView ? this.crossFollow.leaf.view : undefined) : undefined;
		if (this.followView !== view) {
			this.followBar?.remove(); this.followBar = undefined; this.followLabel = undefined; this.followView = view;
			if (view) {
				this.followBar = view.containerEl.createDiv({ cls: "relay-presence-follow" });
				this.followLabel = this.followBar.createSpan({ attr: { role: "status", "aria-live": "polite" } });
				this.followBar.createEl("button", { text: "Stop following" }).onclick = () => this.stopFollowing();
			}
		}
		if (this.followLabel && this.following) this.followLabel.setText(`Following ${this.following.name}`);
	}

	private captureEditor(binding: Binding): void {
		const editor = binding.hostView.editor, doc = binding.boundDocument, text = doc.crdtText;
		if (editor.getValue() !== text.toString()) return;
		const selection = editor.listSelections()[0]; if (!selection) return;
		doc._liveProvider.awareness.setLocalStateField("cursor", {
			anchor: Y.createRelativePositionFromTypeIndex(text, editor.posToOffset(selection.anchor)),
			head: Y.createRelativePositionFromTypeIndex(text, editor.posToOffset(selection.head)),
		});
	}
	private updateAction(view?: FileView): void {
		if (view !== this.actionView) {
			this.action?.remove(); this.action = undefined; this.actionView = view;
			if (view) { this.action = view.addAction("users", "Presence controls", () => this.openControls()); this.action.classList.add("relay-presence-action"); }
		}
		if (this.action) {
			setIcon(this.action, this.visible ? "users" : "eye-off");
			this.action.setAttribute("aria-label", "Presence controls. " + this.description);
			this.action.setAttribute("data-presence-status", this.status);
		}
	}
	onunload(): void {
		this.controls?.close(); this.controls = undefined;
		this.stopFollowing(); this.locations?.unload(); this.surfaces?.unload();
		this.stopped = true; this.clearActive(); this.observe();
		for (const stop of this.windows.values()) stop(); this.windows.clear();
		this.action?.remove(); this.action = undefined; this.actionView = undefined;
		this.peers = []; this.notify(); this.listeners.clear(); this.candidate = undefined;
	}
}

class PresenceControls extends Modal {
	constructor(plugin: Plugin, private presence: PresenceController) { super(plugin.app); }
	private stop?: () => void;
	onOpen(): void {
		this.titleEl.setText("Presence");
		const status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		let toggle!: import("obsidian").ToggleComponent;
		new Setting(this.contentEl).setName("Share my presence").setDesc("Show your location in shared notes, images and saved views. Turning this off hides your presence; sync and comments stay available.")
			.addToggle(control => { toggle = control; control.setValue(this.presence.visible).onChange(value => { void this.presence.setVisible(value); }); });
		const retry = this.contentEl.createEl("button", { text: "Retry presence" });
		retry.addEventListener("click", () => this.presence.retry());
		const rosterTitle = this.contentEl.createEl("h3");
		const roster = new PresenceRoster(this.contentEl.createDiv({ cls: "relay-presence-roster" }), this.presence, () => this.close());
		const navigation = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		const navigationScope = this.contentEl.createEl("p");
		const refresh = () => {
			status.setText(this.presence.description); toggle.setValue(this.presence.visible);
			rosterTitle.setText(`People in this ${this.presence.surfaceName}`);
			// Obsidian themes can override the browser's [hidden] display rule.
			retry.style.display = this.presence.canRetry ? "" : "none"; retry.disabled = !this.presence.canRetry;
			roster.update(); navigation.setText(this.presence.navigationMessage); navigationScope.setText(this.presence.navigationDescription);
		};
		this.stop = this.presence.onChange(refresh); refresh();
	}
	onClose(): void { this.stop?.(); this.stop = undefined; this.contentEl.empty(); }
}
