import { apiVersion, Component, FileView, MarkdownView, type Plugin, type TFile } from "obsidian";
import { decodeJwt } from "jose";
import type { AuthSession } from "../../AuthSession";
import type { RelayOnPremSettings } from "../../RelayOnPremConfig";
import type { SettingsScope } from "../../SettingsPersistence";
import type { ShareRegistry, VaultShare } from "../../VaultShare";
import { ImageAssets } from "../ImageAssets";
import { ImagePresenceSurface } from "./ImagePresenceSurface";
import { BasePresenceSurface } from "./BasePresenceSurface";
import { NativeBasesSurface } from "../../bases/NativeBasesSurface";
import { TimelineBridgeClient } from "../../bases/TimelineBridgeClient";
import { LocationChannel, type LocationChannelStatus, type LocationIdentity, type ObservationEvent } from "./LocationChannel";
import { locationId, type BaseLocation, type LocationEvent, type NoteLocation, type SurfaceLocation, type SurfaceRosterEvent } from "./LocationProtocol";
import type { ActivePresencePeer, SurfacePresencePeer } from "./PresencePeers";
import type { ImagePresenceState, ImageStatesEvent } from "./LocationProtocol";
import type * as Y from "yjs";
import { EmbeddedImageSurface } from "./EmbeddedImageSurface";
import type { EmbeddedImagesEvent } from "./EmbeddedImageProtocol";
import type { ImageOccurrence } from "../anchors/images";
import type { RenderedImageTarget } from "../anchors/renderedImages";
import { presencePeers, type PresencePeer } from "./PresencePeers";
import type { YSweetProvider } from "../../client/provider";
import type { BaseStatesEvent } from "./BasePositionProtocol";
import type { BaseLocalRecord } from "./BasePresenceRecords";

type Context = { key: string; serverId: string; identity: LocationIdentity; file: TFile; folder: VaultShare; id: string; kind: "note" | "image" | "base"; location?: NoteLocation };
type Callbacks = { changed: () => void; location: (event: LocationEvent) => void; stopped: () => void; interacted?: () => void; positions?: () => void };
export type NoteImageObserver = { view: MarkdownView; text: Y.Text; provider: YSweetProvider; current: () => boolean;
	targets: (images: ImageOccurrence[]) => RenderedImageTarget[] };
type EmbeddedObserver = { surface: EmbeddedImageSurface; mode: string; scope: NoteImageObserver; context: Context; stop: () => void };
const noteScopeKey = (scope: Pick<NoteLocation, "share_id" | "entry_id">) => JSON.stringify([scope.share_id, scope.entry_id]);

/** One foreground connection across notes, image files and saved Bases views. Inventory and local
 * rendering are verified independently of discussions and comment permission. */
export class LocationHost extends Component {
	private channel?: LocationChannel;
	private context?: Context;
	private view?: FileView;
	private image?: ImagePresenceSurface;
	private imageObservers = new Map<FileView, ImagePresenceSurface>();
	private base?: BasePresenceSurface;
	private timeline?: TimelineBridgeClient;
	private roster?: SurfaceRosterEvent;
	private imageStates?: ImageStatesEvent;
	private baseStates?: BaseStatesEvent;
	private embedded?: EmbeddedImageSurface;
	private embedObservers = new Map<MarkdownView, EmbeddedObserver>();
	private observerEmbeds = new Map<string, EmbeddedImagesEvent>();
	private observerDenied = new Set<string>();
	private embeds?: EmbeddedImagesEvent;
	private embedMode?: string;
	private embedDenied = false;
	private notePeers: readonly PresencePeer[] = [];
	private visible = true;
	private assets: ImageAssets;
	private folders = new Map<VaultShare, () => void>();
	private closed = false;
	constructor(private plugin: Plugin, private shares: ShareRegistry, private auth: AuthSession,
		private settings: SettingsScope<RelayOnPremSettings>, private instanceId: string, private callbacks: Callbacks,
		private createChannel: (identity: LocationIdentity, options: ConstructorParameters<typeof LocationChannel>[1]) => LocationChannel = (identity, options) => new LocationChannel(identity, options)) {
		super(); this.assets = new ImageAssets(plugin.app, shares);
	}
	onload(): void {
		this.register(this.settings.subscribe(() => this.callbacks.changed()));
		this.register(this.shares.on(() => { this.watchFolders(); this.callbacks.changed(); }));
		this.register(this.auth.onTokenRefreshed(() => { this.callbacks.changed(); this.channel?.credentialsChanged(); }));
		this.watchFolders();
	}
	get status(): LocationChannelStatus { return this.channel?.status ?? "idle"; }
	get currentLocation(): SurfaceLocation | undefined { return this.context?.kind === "image" ? this.image?.location : this.context?.kind === "base" ? this.base?.location : this.context?.location; }
	get ready(): boolean { return this.channel?.ready === true; }
	get supportsImages(): boolean { return this.channel?.supportsImageContext === true && this.channel.supportsSurfaceRoster; }
	get supportsBases(): boolean { return this.channel?.supportsBaseContext === true && this.channel.supportsSurfaceRoster; }
	get embeddedUnavailable(): boolean { return this.embedDenied || this.observerDenied.size > 0 || this.embedded?.unavailable === true || [...this.embedObservers.values()].some(({ surface }) => surface.unavailable); }
	get imageActive(): boolean { return this.context?.kind === "image"; }
	get baseActive(): boolean { return this.context?.kind === "base"; }
	get surfaceActive(): boolean { return this.imageActive || this.baseActive; }
	get surfaceState(): ImagePresenceSurface["state"] { return this.baseActive ? this.base?.state ?? "waiting" : this.imageState; }
	get imageState(): ImagePresenceSurface["state"] { return this.image?.state ?? "waiting"; }
	get imageObserverUnavailable(): boolean { return [...this.imageObservers.values()].some(surface => surface.state === "unavailable"); }
	get imagePeers(): SurfacePresencePeer[] { return this.imageActive ? this.surfacePeers : []; }
	get surfacePeers(): SurfacePresencePeer[] {
		const scope = this.currentLocation, roster = this.roster;
		if (!scope || scope.kind === "note" || roster?.status !== "available" || JSON.stringify(scope) !== JSON.stringify(roster.scope)) return [];
		const positions = this.imageStates?.status === "available" && JSON.stringify(this.imageStates.scope) === JSON.stringify(scope) ?
			new Map(this.imageStates.peers.map(peer => [JSON.stringify(peer.target), peer.state])) : undefined;
		const basePositions = this.baseStates?.status === "available" && JSON.stringify(this.baseStates.scope) === JSON.stringify(scope) ?
			new Map(this.baseStates.peers.map(peer => [JSON.stringify(peer.target), peer.state])) : undefined;
		return roster.peers.map(peer => ({ key: JSON.stringify(["surface", peer.target.user_id, peer.target.session_id, peer.target.instance_id]),
			userId: peer.target.user_id, sessionId: peer.target.session_id, instanceId: peer.target.instance_id, name: peer.name, surface: scope.kind, location: scope, imageState: positions?.get(JSON.stringify(peer.target)), baseState: basePositions?.get(JSON.stringify(peer.target)) }))
			.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
	}
	retry(): void { this.embedDenied = false; this.observerDenied.clear(); this.channel?.retry(); this.image?.retry(); this.base?.retry(); this.embedded?.retry(); for (const { surface } of this.embedObservers.values()) surface.retry(); for (const surface of this.imageObservers.values()) surface.retry(); }
	unfollow(): void { this.channel?.unfollow(); this.base?.cancelNavigation(); }
	cancelSurfaceNavigation(): void { this.base?.cancelNavigation(); }
	follow(peer: ActivePresencePeer): string | undefined {
		const location = this.currentLocation;
		if (!location || !peer.instanceId) return;
		try { return this.channel?.follow({ user_id: peer.userId, session_id: peer.sessionId, instance_id: peer.instanceId }, location); }
		catch { return; }
	}
	revealImage(current: () => boolean, state?: ImagePresenceState, follow = false): boolean { return this.image?.reveal(current, state, follow) === true; }
	async revealSurface(peer: SurfacePresencePeer, current: () => boolean, follow = false): Promise<boolean> {
		return peer.surface === "base" ? await this.base?.revealPosition(current, peer.baseState, follow) === true : this.revealImage(current, peer.imageState, follow);
	}
	activateBase(location: BaseLocation, current: () => boolean): "ready" | "waiting" | "unavailable" { return this.base?.activate(location, current) ?? "waiting"; }
	embedPosition(peer: PresencePeer, follow = false): ReturnType<EmbeddedImageSurface["position"]> { return this.embedded?.position(peer, follow); }
	revealEmbed(peer: PresencePeer, follow: boolean, current: () => boolean): boolean { return this.embedded?.reveal(peer, follow, current) === true; }
	async materializeEmbed(peer: PresencePeer, follow: boolean, current: () => boolean): Promise<boolean> { return await this.embedded?.revealAfterLayout(peer, follow, current) === true; }
	refreshEmbeds(): void { this.embedded?.refresh(); for (const { surface } of this.embedObservers.values()) surface.refresh(); }
	setNotePeers(peers: readonly PresencePeer[]): void {
		this.notePeers = peers;
		const scope = this.currentLocation, event = this.embeds;
		const embeds = scope?.kind === "note" && event?.status === "available" &&
			event.scope?.share_id === scope.share_id && event.scope.entry_id === scope.entry_id ? event.peers : [];
		this.embedded?.setPeers(embeds, peers);
		for (const observer of this.embedObservers.values()) this.paintNoteObserver(observer);
	}
	private foregroundNote(context: Context): boolean {
		return this.context?.kind === "note" && context.key === this.context.key && context.folder === this.context.folder && context.id === this.context.id;
	}
	private paintNoteObserver(observer: EmbeddedObserver): void {
		const foreground = this.foregroundNote(observer.context), key = noteScopeKey(observer.context.location!);
		const event = foreground ? this.embeds : this.observerEmbeds.get(key);
		const embeds = event?.status === "available" && event.scope && noteScopeKey(event.scope) === key ? event.peers : [];
		observer.surface.setPeers(embeds, foreground ? this.notePeers : observer.scope.current() ? presencePeers(observer.scope.provider.awareness) : []);
	}
	private syncNoteObservations(): void {
		const wanted = new Map<string, NoteLocation>();
		for (const observer of this.embedObservers.values()) if (!this.foregroundNote(observer.context)) {
			const location = observer.context.location!;
			wanted.set(noteScopeKey(location), location);
		}
		for (const key of this.observerEmbeds.keys()) if (!wanted.has(key)) this.observerEmbeds.delete(key);
		for (const key of this.observerDenied) if (!wanted.has(key)) this.observerDenied.delete(key);
		this.channel?.observe([...wanted.values()]);
	}
	private observation(event: ObservationEvent): void {
		if (event.type === "reset") {
			if (!event.scope) { this.observerEmbeds.clear(); this.observerDenied.clear(); }
			else if (event.scope.kind === "note") { this.observerEmbeds.delete(noteScopeKey(event.scope)); this.observerDenied.delete(noteScopeKey(event.scope)); }
		} else if (event.type === "image_embeds" && event.scope) {
			const key = noteScopeKey(event.scope);
			if (![...this.embedObservers.values()].some(observer => !this.foregroundNote(observer.context) && noteScopeKey(observer.context.location!) === key)) return;
			this.observerEmbeds.set(key, event);
			if (event.status === "unavailable") this.observerDenied.add(key);
		} else return;
		for (const observer of this.embedObservers.values()) this.paintNoteObserver(observer);
		if (event.type !== "reset" && event.status === "unavailable") this.callbacks.changed();
	}
	/** Visible note panes reuse their existing shared binding and account.
	 * Same-note copies share the foreground watch; other notes use bounded
	 * passive subscriptions when supported. None publishes or opens a socket. */
	setNoteObservers(scopes: readonly NoteImageObserver[]): void {
		const context = this.context;
		const eligible = (scope: NoteImageObserver) => {
			if (!context || !this.channel?.supportsEmbeddedImages || this.closed || this.context?.key !== context.key ||
				scope.view === this.view || !scope.current() || !scope.view.contentEl.getClientRects().length) return false;
			const identity = this.identify(scope.view);
			if (!identity || identity.kind !== "note" || identity.key !== context.key) return false;
			return this.foregroundNote(identity) ? !!this.embedded && !this.embedDenied : this.channel.supportsMultiWatch;
		};
		const wanted = new Map(scopes.filter(eligible).slice(0, 8).map(scope => [scope.view, scope]));
		for (const [view, observer] of this.embedObservers) {
			const scope = wanted.get(view), identity = scope && this.identify(view);
			if (!scope || observer.surface.text !== scope.text || observer.mode !== view.getMode() || observer.scope.provider !== scope.provider ||
				identity?.key !== observer.context.key || identity.folder !== observer.context.folder || identity.id !== observer.context.id) {
				observer.stop(); observer.surface.close(); this.embedObservers.delete(view);
			} else observer.scope = scope;
		}
		for (const [view, scope] of wanted) {
			if (this.embedObservers.has(view)) continue;
			const mode = view.getMode(), identity = this.identify(view)!;
			const observer: EmbeddedObserver = { mode, scope, context: identity, stop: () => {}, surface: new EmbeddedImageSurface(view, scope.text, this.assets, {
				current: () => eligible(observer.scope) && view.getMode() === mode && !this.observerDenied.has(noteScopeKey(identity.location!)),
				publishing: () => false, publish: () => {}, targets: images => observer.scope.targets(images),
				read: entryId => this.channel!.readImageLocation(identity.folder.entityGuid, entryId), changed: this.callbacks.changed,
			}) };
			const peersChanged = () => this.paintNoteObserver(observer), statusChanged = this.callbacks.changed;
			scope.provider.awareness.on("change", peersChanged);
			for (const event of ["status", "sync", "presence-status"] as const) scope.provider.on(event, statusChanged);
			observer.stop = () => {
				scope.provider.awareness.off("change", peersChanged);
				for (const event of ["status", "sync", "presence-status"] as const) scope.provider.off(event, statusChanged);
			};
			this.embedObservers.set(view, observer);
		}
		this.syncNoteObservations(); this.setNotePeers(this.notePeers);
	}
	private closeNoteObservers(): void {
		for (const { surface, stop } of this.embedObservers.values()) { stop(); surface.close(); }
		this.embedObservers.clear(); this.observerEmbeds.clear(); this.observerDenied.clear(); this.channel?.observe([]);
	}
	/** Direct-image split panes reuse the foreground version proof and roster.
	 * Every pane still verifies its own native image and local bytes. */
	setImageObservers(views: readonly FileView[]): void {
		const context = this.context;
		const eligible = (view: FileView) => {
			const owner = view.containerEl.ownerDocument;
			if (!context || context.kind !== "image" || !this.image?.location || this.closed || this.context?.key !== context.key ||
				this.context.id !== context.id || this.context.folder !== context.folder || view === this.view || !view.contentEl.isConnected ||
				!owner.hasFocus() || owner.hidden || !view.contentEl.getClientRects().length) return false;
			const identity = this.identify(view);
			return identity?.key === context.key && identity.folder === context.folder && identity.id === context.id;
		};
		const wanted = new Set(views.filter(eligible).slice(0, 8));
		for (const [view, surface] of this.imageObservers) if (!wanted.has(view)) { surface.close(); this.imageObservers.delete(view); }
		for (const view of wanted) {
			let surface = this.imageObservers.get(view);
			if (!surface) {
				surface = new ImagePresenceSurface(view, this.assets, {
					current: () => eligible(view), connected: () => this.ready, supported: () => this.supportsImages,
					read: async () => { const proof = this.image?.location; if (!eligible(view) || !proof) throw new Error("Image presence unavailable"); return proof; },
					changed: this.callbacks.changed, interacted: () => {}, motion: { publishing: () => false, publish: () => {} },
				});
				this.imageObservers.set(view, surface);
			}
			surface.refresh(); surface.setPeers(this.imagePeers);
		}
	}
	private closeImageObservers(): void { for (const surface of this.imageObservers.values()) surface.close(); this.imageObservers.clear(); }
	setNoteSurface(view: MarkdownView | undefined, text: Y.Text | undefined, targets: (images: ImageOccurrence[]) => RenderedImageTarget[], permitted: () => boolean): void {
		const context = this.context, mode = view?.getMode();
		if (this.embedded && (this.embedded.view !== view || this.embedded.text !== text || this.embedMode !== mode || !permitted() || !this.channel?.supportsEmbeddedImages)) {
			this.embedded.close(); this.embedded = undefined;
			this.closeNoteObservers();
		}
		if (!context || context.kind !== "note" || !view?.file || !text || !permitted() || this.embedDenied || !this.channel?.supportsEmbeddedImages) {
			if (context?.kind === "note") this.channel?.watchEmbeds(null);
			return;
		}
		if (!this.embedded) {
			this.embedMode = mode;
			this.embedded = new EmbeddedImageSurface(view, text, this.assets, {
				current: () => !this.closed && this.context?.key === context.key && this.context.id === context.id && this.view === view && view.getMode() === mode && permitted() && this.channel?.supportsEmbeddedImages === true,
				publishing: () => this.visible, targets, read: entryId => this.channel!.readImageLocation(context.folder.entityGuid, entryId),
				publish: embed => this.channel?.publishEmbeddedImage(this.visible ? embed : null), changed: () => { this.callbacks.positions?.(); this.callbacks.changed(); },
			});
		}
		this.channel.watchEmbeds(context.location!); this.setNotePeers(this.notePeers); this.embedded.refresh();
	}
	private watchFolders(): void {
		const wanted = new Set(this.shares.toArray());
		for (const [folder, stop] of this.folders) if (!wanted.has(folder)) { stop(); this.folders.delete(folder); }
		for (const folder of wanted) if (!this.folders.has(folder)) {
			const change = () => { if (this.context?.folder === folder) this.base?.recordsChanged(); this.callbacks.changed(); }, base = folder.crdtDoc.getMap("managed_base_v1");
			const stop = folder.folderIndex.on(change); base.observe(change);
			this.folders.set(folder, () => { stop(); base.unobserve(change); });
		}
	}
	private entry(file?: TFile | null): { folder: VaultShare; id: string; kind: "note" | "image" | "base"; hash?: string } | undefined {
		if (!file || this.plugin.app.vault.getFileByPath(file.path) !== file) return;
		const folder = this.shares.shareFor(file.path);
		if (!folder?.wantsConnection || folder.isRecoveringStructure) return;
		const path = folder.toVirtualPath(file.path), record = folder.folderIndex.recordFor(path), index = folder._liveProvider.managedIndex;
		const base = folder.crdtDoc.getMap<{ owner: boolean; permissions: Record<string, string> }>("managed_base_v1").get("snapshot");
		if (!record || !["markdown", "image", "file"].includes(record.type) || !locationId(record.id) || !locationId(folder.entityGuid) ||
			!index?.registered(path, record.id) || index.isBlocked(path, record.id) || !base || !base.owner && !["read", "write"].includes(base.permissions[path])) return;
		if (record.type === "markdown" && file.extension !== "md" || record.type === "file" && file.extension !== "base" || record.type !== "markdown" && (!record.hash || !/^[0-9a-f]{64}$/.test(record.hash))) return;
		return { folder, id: record.id, kind: record.type === "file" ? "base" : record.type === "image" ? "image" : "note", hash: record.hash };
	}
	private baseRecord(context: Context | undefined, file: TFile): BaseLocalRecord | undefined {
		if (!context) return;
		const folder = context.folder;
		if (this.closed || this.context !== context || !folder.wantsConnection || folder.isRecoveringStructure || this.plugin.app.vault.getFileByPath(file.path) !== file || this.shares.shareFor(file.path) !== folder) return;
		const path = folder.toVirtualPath(file.path), record = folder.folderIndex.recordFor(path), index = folder._liveProvider.managedIndex;
		const permissions = folder.crdtDoc.getMap<{ owner: boolean; permissions: Record<string, string> }>("managed_base_v1").get("snapshot");
		if (!record || !locationId(record.id) || (record.type !== "markdown" && record.type !== "image" && record.type !== "file") || !index?.registered(path, record.id) || index.isBlocked(path, record.id) || !permissions || !permissions.owner && !["read", "write"].includes(permissions.permissions[path])) return;
		return { id: record.id, type: record.type, path };
	}
	private baseRecordFile(context: Context | undefined, id: string): TFile | undefined {
		if (!context) return;
		const matches: TFile[] = [];
		context.folder.folderIndex.eachRecord((record, path) => {
			if (record.id !== id) return;
			const file = this.plugin.app.vault.getFileByPath(context.folder.absolutePath(path));
			if (file && this.baseRecord(context, file)?.id === id) matches.push(file);
		});
		return matches.length === 1 ? matches[0] : undefined;
	}
	private identify(view?: FileView | null): Context | undefined {
		const entry = this.entry(view?.file), settings = this.settings.readValue();
		const server = entry && settings.enabled ? settings.servers.find(server => server.id === entry.folder.config.onpremServerId) : undefined;
		const provider = server && this.auth.getAuthProviderForServer(server.id), user = provider?.getCurrentUser();
		if (!entry || !view?.file || !server || !provider?.isLoggedIn() || !user || !locationId(user.id) || (entry.kind === "note") !== (view instanceof MarkdownView)) return;
		try {
			const claims = decodeJwt(provider.getToken() ?? "");
			if (claims.sub !== user.id || !locationId(claims.session_id) || claims.scope !== undefined) return;
			const identity = { serverUrl: server.controlPlaneUrl, accountId: user.id, loginSessionId: claims.session_id, instanceId: this.instanceId };
			return { key: JSON.stringify([server.id, identity]), serverId: server.id, identity, file: view.file, folder: entry.folder, id: entry.id, kind: entry.kind,
				location: entry.kind === "note" ? { kind: "note", share_id: entry.folder.entityGuid, entry_id: entry.id, surface: (view as MarkdownView).getMode() === "preview" ? "reading" : "editor" } : undefined };
		} catch { return; }
	}
	update(view: FileView | null | undefined, foreground: boolean, visible: boolean): void {
		if (this.closed) return;
		this.visible = visible;
		const context = foreground ? this.identify(view) : undefined;
		if (this.context?.key !== context?.key || this.view !== view || this.context?.file !== context?.file || this.context?.id !== context?.id || this.context?.kind !== context?.kind || this.context?.folder !== context?.folder) {
			this.image?.close(); this.image = undefined; this.roster = undefined; this.imageStates = undefined;
			this.closeImageObservers();
			this.base?.close(); this.base = undefined; this.baseStates = undefined;
			this.timeline?.close(); this.timeline = undefined;
			this.embedded?.close(); this.embedded = undefined; this.embeds = undefined; this.notePeers = []; this.embedDenied = false;
			this.closeNoteObservers();
		}
		if (this.context?.key !== context?.key) {
			const previous = this.channel; this.channel = undefined; this.context = undefined; previous?.stop();
		}
		this.context = context; this.view = view ?? undefined;
		if (!context) return;
		const current = () => !this.closed && this.context?.key === context.key && this.identify(this.plugin.app.workspace.getActiveViewOfType(FileView))?.key === context.key;
		if (!this.channel) {
			try {
				this.channel = this.createChannel(context.identity, {
					surfaceLocations: true, observation: event => { if (!this.closed && this.context?.key === context.key) this.observation(event); },
					credential: async () => {
						if (!current()) return;
						const accessToken = await this.auth.getAuthProviderForServer(context.serverId)?.getValidToken();
						return current() && accessToken ? { accountId: context.identity.accountId, accessToken } : undefined;
					}, status: () => { if (!this.closed) this.callbacks.changed(); }, location: this.callbacks.location, followStopped: this.callbacks.stopped,
					roster: event => {
						if (!current()) return;
						this.roster = event;
						if (event.scope && event.status === "unavailable" && JSON.stringify(event.scope) === JSON.stringify(this.currentLocation)) { this.image?.deny(); this.base?.deny(); this.callbacks.stopped(); }
						this.callbacks.changed();
					},
					imageStates: event => {
						if (!current()) return;
						this.imageStates = event; this.image?.setPeers(this.imagePeers);
						for (const surface of this.imageObservers.values()) surface.setPeers(this.imagePeers);
						if (event.scope && event.status === "unavailable" && JSON.stringify(event.scope) === JSON.stringify(this.currentLocation)) { this.image?.deny(); this.callbacks.stopped(); this.callbacks.changed(); }
						else this.callbacks.positions?.();
					},
					baseStates: event => {
						if (!current()) return;
						this.baseStates = event; this.base?.setPeers(this.baseActive ? this.surfacePeers : []);
						if (event.scope && event.status === "unavailable" && JSON.stringify(event.scope) === JSON.stringify(this.currentLocation)) { this.base?.deny(); this.callbacks.stopped(); this.callbacks.changed(); }
						else this.callbacks.positions?.();
					},
					imageEmbeds: event => {
						if (!current()) return;
						this.embeds = event; this.setNotePeers(this.notePeers);
						if (event.scope && event.status === "unavailable" && event.scope.entry_id === this.context?.id && event.scope.share_id === this.context.folder.entityGuid) {
							this.embedDenied = true; this.embedded?.close(); this.embedded = undefined; this.callbacks.stopped(); this.callbacks.changed();
							this.closeNoteObservers();
						}
						this.callbacks.positions?.();
					},
				});
			} catch { return; }
		}
		if (context.kind === "image" && view) {
			if (!this.image) this.image = new ImagePresenceSurface(view, this.assets, {
				current: () => current() && this.view === view && view.file === context.file && this.context?.id === context.id && this.context?.folder === context.folder,
				connected: () => this.ready, supported: () => this.supportsImages,
				read: () => this.channel!.readImageLocation(context.folder.entityGuid, context.id),
				changed: this.callbacks.changed, interacted: () => this.callbacks.interacted?.(),
				motion: { publishing: () => this.visible && this.channel?.supportsImageStates === true,
					publish: state => this.channel?.publishImageState(this.visible ? state : null) },
			});
			this.image.refresh();
		}
		if (context.kind === "base" && view) {
			if (!this.timeline) {
				this.timeline = new TimelineBridgeClient(this.plugin.app.workspace, () => { this.base?.refresh(); this.callbacks.changed(); });
				this.timeline.start();
			}
			if (!this.base) this.base = new BasePresenceSurface(view, context.folder.entityGuid, context.id, {
				current: () => current() && this.view === view && view.file === context.file && this.context?.id === context.id && this.context?.folder === context.folder,
				connected: () => this.ready, supported: () => this.supportsBases, hash: () => this.entry(context.file)?.hash,
				inspect: () => NativeBasesSurface.inspect(view, apiVersion, true, this.timeline),
				read: () => this.channel!.readBaseContext(context.folder.entityGuid, context.id), readSource: () => this.plugin.app.vault.read(context.file),
				changed: this.callbacks.changed, interacted: () => this.callbacks.interacted?.(),
				motion: {
					current: () => current() && this.view === view && view.file === context.file && this.context?.id === context.id && this.context?.folder === context.folder && this.channel?.supportsBaseStates === true,
					publishing: () => this.visible, local: file => this.baseRecord(this.context, file), file: id => this.baseRecordFile(this.context, id),
					read: id => this.channel!.readBaseRecordContext(context.folder.entityGuid, id), publish: state => this.channel?.publishBaseState(this.visible ? state : null),
					groups: { supported: () => this.channel?.supportsBaseTargetsV2 === true,
						resolve: (link, source) => this.plugin.app.metadataCache.getFirstLinkpathDest(link, source),
						fileAtPath: path => this.plugin.app.vault.getFileByPath(path) },
				},
			});
			this.base.refresh();
		}
		const location = this.currentLocation;
		this.channel.start(context.folder.entityGuid, visible ? location ?? null : null);
		if (location && location.kind !== "note") this.channel.watch(location);
		else if (!this.embedded) this.channel.watch(null);
		this.image?.refreshMovement();
		this.image?.setPeers(this.imagePeers);
		this.base?.refreshMovement(); this.base?.setPeers(this.baseActive ? this.surfacePeers : []);
	}
	/** Resolve only a unique authorized local entry. Remote events never provide
	 * paths, and images must match the advertised synchronized content hash. */
	fileFor(location: SurfaceLocation): TFile | undefined {
		const context = this.context; if (!context || !this.ready) return;
		if (this.identify(this.plugin.app.workspace.getActiveViewOfType(FileView))?.key !== context.key) return;
		const matches: TFile[] = [];
		for (const folder of this.shares.toArray()) if (folder.entityGuid === location.share_id && folder.config.onpremServerId === context.serverId) {
			folder.folderIndex.eachRecord((record, path) => {
				if (record.id !== location.entry_id || record.type !== (location.kind === "base" ? "file" : location.kind === "image" ? "image" : "markdown") || location.kind === "image" && record.hash !== location.content_sha256) return;
				const file = this.plugin.app.vault.getFileByPath(folder.absolutePath(path));
				if (file && this.entry(file)?.folder === folder) matches.push(file);
			});
		}
		return matches.length === 1 ? matches[0] : undefined;
	}
	onunload(): void {
		this.closed = true; this.image?.close(); this.image = undefined; this.roster = undefined; this.imageStates = undefined;
		this.closeImageObservers();
		this.base?.close(); this.base = undefined; this.baseStates = undefined; this.timeline?.close(); this.timeline = undefined;
		this.embedded?.close(); this.embedded = undefined; this.embeds = undefined; this.notePeers = [];
		this.closeNoteObservers();
		this.channel?.stop(); this.channel = undefined; this.context = undefined; this.view = undefined;
		for (const stop of this.folders.values()) stop(); this.folders.clear();
	}
}
