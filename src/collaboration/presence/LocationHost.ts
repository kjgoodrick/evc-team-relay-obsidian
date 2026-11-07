import { Component, FileView, MarkdownView, type Plugin, type TFile } from "obsidian";
import { decodeJwt } from "jose";
import type { AuthSession } from "../../AuthSession";
import type { RelayOnPremSettings } from "../../RelayOnPremConfig";
import type { SettingsScope } from "../../SettingsPersistence";
import type { ShareRegistry, VaultShare } from "../../VaultShare";
import { ImageAssets } from "../ImageAssets";
import { ImagePresenceSurface } from "./ImagePresenceSurface";
import { LocationChannel, type LocationChannelStatus, type LocationIdentity } from "./LocationChannel";
import { locationId, type LocationEvent, type NoteLocation, type SurfaceLocation, type SurfaceRosterEvent } from "./LocationProtocol";
import type { ActivePresencePeer, SurfacePresencePeer } from "./PresencePeers";
import type { ImagePresenceState, ImageStatesEvent } from "./LocationProtocol";
import type * as Y from "yjs";
import { EmbeddedImageSurface } from "./EmbeddedImageSurface";
import type { EmbeddedImagesEvent } from "./EmbeddedImageProtocol";
import type { ImageOccurrence } from "../anchors/images";
import type { RenderedImageTarget } from "../anchors/renderedImages";
import type { PresencePeer } from "./PresencePeers";

type Context = { key: string; serverId: string; identity: LocationIdentity; file: TFile; folder: VaultShare; id: string; kind: "note" | "image"; location?: NoteLocation };
type Callbacks = { changed: () => void; location: (event: LocationEvent) => void; stopped: () => void; interacted?: () => void; positions?: () => void };

/** One foreground connection across notes and image files. Inventory and local
 * rendering are verified independently of discussions and comment permission. */
export class LocationHost extends Component {
	private channel?: LocationChannel;
	private context?: Context;
	private view?: FileView;
	private image?: ImagePresenceSurface;
	private roster?: SurfaceRosterEvent;
	private imageStates?: ImageStatesEvent;
	private embedded?: EmbeddedImageSurface;
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
	get currentLocation(): SurfaceLocation | undefined { return this.context?.kind === "image" ? this.image?.location : this.context?.location; }
	get ready(): boolean { return this.channel?.ready === true; }
	get supportsImages(): boolean { return this.channel?.supportsImageContext === true && this.channel.supportsSurfaceRoster; }
	get embeddedUnavailable(): boolean { return this.embedDenied || this.embedded?.unavailable === true; }
	get imageActive(): boolean { return this.context?.kind === "image"; }
	get imageState(): ImagePresenceSurface["state"] { return this.image?.state ?? "waiting"; }
	get imagePeers(): SurfacePresencePeer[] {
		const scope = this.currentLocation, roster = this.roster;
		if (scope?.kind !== "image" || roster?.status !== "available" || JSON.stringify(scope) !== JSON.stringify(roster.scope)) return [];
		const positions = this.imageStates?.status === "available" && JSON.stringify(this.imageStates.scope) === JSON.stringify(scope) ?
			new Map(this.imageStates.peers.map(peer => [JSON.stringify(peer.target), peer.state])) : undefined;
		return roster.peers.map(peer => ({ key: JSON.stringify(["surface", peer.target.user_id, peer.target.session_id, peer.target.instance_id]),
			userId: peer.target.user_id, sessionId: peer.target.session_id, instanceId: peer.target.instance_id, name: peer.name, surface: "image" as const, location: scope, imageState: positions?.get(JSON.stringify(peer.target)) }))
			.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
	}
	retry(): void { this.embedDenied = false; this.channel?.retry(); this.image?.retry(); this.embedded?.retry(); }
	unfollow(): void { this.channel?.unfollow(); }
	follow(peer: ActivePresencePeer): string | undefined {
		const location = this.currentLocation;
		if (!location || !peer.instanceId) return;
		try { return this.channel?.follow({ user_id: peer.userId, session_id: peer.sessionId, instance_id: peer.instanceId }, location); }
		catch { return; }
	}
	revealImage(current: () => boolean, state?: ImagePresenceState, follow = false): boolean { return this.image?.reveal(current, state, follow) === true; }
	embedPosition(peer: PresencePeer, follow = false): ReturnType<EmbeddedImageSurface["position"]> { return this.embedded?.position(peer, follow); }
	revealEmbed(peer: PresencePeer, follow: boolean, current: () => boolean): boolean { return this.embedded?.reveal(peer, follow, current) === true; }
	async materializeEmbed(peer: PresencePeer, follow: boolean, current: () => boolean): Promise<boolean> { return await this.embedded?.revealAfterLayout(peer, follow, current) === true; }
	refreshEmbeds(): void { this.embedded?.refresh(); }
	setNotePeers(peers: readonly PresencePeer[]): void {
		this.notePeers = peers;
		const scope = this.currentLocation, event = this.embeds;
		this.embedded?.setPeers(scope?.kind === "note" && event?.status === "available" &&
			event.scope?.share_id === scope.share_id && event.scope.entry_id === scope.entry_id ? event.peers : [], peers);
	}
	setNoteSurface(view: MarkdownView | undefined, text: Y.Text | undefined, targets: (images: ImageOccurrence[]) => RenderedImageTarget[], permitted: () => boolean): void {
		const context = this.context, mode = view?.getMode();
		if (this.embedded && (this.embedded.view !== view || this.embedded.text !== text || this.embedMode !== mode || !permitted() || !this.channel?.supportsEmbeddedImages)) {
			this.embedded.close(); this.embedded = undefined;
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
			const change = () => this.callbacks.changed(), base = folder.crdtDoc.getMap("managed_base_v1");
			const stop = folder.folderIndex.on(change); base.observe(change);
			this.folders.set(folder, () => { stop(); base.unobserve(change); });
		}
	}
	private entry(file?: TFile | null): { folder: VaultShare; id: string; kind: "note" | "image"; hash?: string } | undefined {
		if (!file || this.plugin.app.vault.getFileByPath(file.path) !== file) return;
		const folder = this.shares.shareFor(file.path);
		if (!folder?.wantsConnection || folder.isRecoveringStructure) return;
		const path = folder.toVirtualPath(file.path), record = folder.folderIndex.recordFor(path), index = folder._liveProvider.managedIndex;
		const base = folder.crdtDoc.getMap<{ owner: boolean; permissions: Record<string, string> }>("managed_base_v1").get("snapshot");
		if (!record || !["markdown", "image"].includes(record.type) || !locationId(record.id) || !locationId(folder.entityGuid) ||
			!index?.registered(path, record.id) || index.isBlocked(path, record.id) || !base || !base.owner && !["read", "write"].includes(base.permissions[path])) return;
		if (record.type === "markdown" && file.extension !== "md" || record.type === "image" && (!record.hash || !/^[0-9a-f]{64}$/.test(record.hash))) return;
		return { folder, id: record.id, kind: record.type === "image" ? "image" : "note", hash: record.hash };
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
		if (this.context?.key !== context?.key || this.view !== view || this.context?.file !== context?.file || this.context?.id !== context?.id) {
			this.image?.close(); this.image = undefined; this.roster = undefined; this.imageStates = undefined;
			this.embedded?.close(); this.embedded = undefined; this.embeds = undefined; this.notePeers = []; this.embedDenied = false;
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
					surfaceLocations: true,
					credential: async () => {
						if (!current()) return;
						const accessToken = await this.auth.getAuthProviderForServer(context.serverId)?.getValidToken();
						return current() && accessToken ? { accountId: context.identity.accountId, accessToken } : undefined;
					}, status: () => { if (!this.closed) this.callbacks.changed(); }, location: this.callbacks.location, followStopped: this.callbacks.stopped,
					roster: event => {
						if (!current()) return;
						this.roster = event;
						if (event.scope && event.status === "unavailable" && JSON.stringify(event.scope) === JSON.stringify(this.currentLocation)) { this.image?.deny(); this.callbacks.stopped(); }
						this.callbacks.changed();
					},
					imageStates: event => {
						if (!current()) return;
						this.imageStates = event; this.image?.setPeers(this.imagePeers);
						if (event.scope && event.status === "unavailable" && JSON.stringify(event.scope) === JSON.stringify(this.currentLocation)) { this.image?.deny(); this.callbacks.stopped(); this.callbacks.changed(); }
						else this.callbacks.positions?.();
					},
					imageEmbeds: event => {
						if (!current()) return;
						this.embeds = event; this.setNotePeers(this.notePeers);
						if (event.scope && event.status === "unavailable" && event.scope.entry_id === this.context?.id && event.scope.share_id === this.context.folder.entityGuid) {
							this.embedDenied = true; this.embedded?.close(); this.embedded = undefined; this.callbacks.stopped(); this.callbacks.changed();
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
		const location = this.currentLocation;
		this.channel.start(context.folder.entityGuid, visible ? location ?? null : null);
		if (location?.kind === "image") this.channel.watch(location);
		else if (!this.embedded) this.channel.watch(null);
		this.image?.refreshMovement();
		this.image?.setPeers(this.imagePeers);
	}
	/** Resolve only a unique authorized local entry. Remote events never provide
	 * paths, and images must match the advertised synchronized content hash. */
	fileFor(location: SurfaceLocation): TFile | undefined {
		const context = this.context; if (!context || !this.ready || location.kind === "base") return;
		if (this.identify(this.plugin.app.workspace.getActiveViewOfType(FileView))?.key !== context.key) return;
		const matches: TFile[] = [];
		for (const folder of this.shares.toArray()) if (folder.entityGuid === location.share_id && folder.config.onpremServerId === context.serverId) {
			folder.folderIndex.eachRecord((record, path) => {
				if (record.id !== location.entry_id || record.type !== (location.kind === "image" ? "image" : "markdown") || location.kind === "image" && record.hash !== location.content_sha256) return;
				const file = this.plugin.app.vault.getFileByPath(folder.absolutePath(path));
				if (file && this.entry(file)?.folder === folder) matches.push(file);
			});
		}
		return matches.length === 1 ? matches[0] : undefined;
	}
	onunload(): void {
		this.closed = true; this.image?.close(); this.image = undefined; this.roster = undefined; this.imageStates = undefined;
		this.embedded?.close(); this.embedded = undefined; this.embeds = undefined; this.notePeers = [];
		this.channel?.stop(); this.channel = undefined; this.context = undefined; this.view = undefined;
		for (const stop of this.folders.values()) stop(); this.folders.clear();
	}
}
