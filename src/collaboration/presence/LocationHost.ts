import { Component, MarkdownView, type Plugin, type TFile } from "obsidian";
import { decodeJwt } from "jose";
import type { AuthSession } from "../../AuthSession";
import type { RelayOnPremSettings } from "../../RelayOnPremConfig";
import type { SettingsScope } from "../../SettingsPersistence";
import type { ShareRegistry, VaultShare } from "../../VaultShare";
import { LocationChannel, type LocationChannelStatus, type LocationIdentity } from "./LocationChannel";
import { locationId, type NoteLocationEvent, type NoteLocation } from "./LocationProtocol";
import type { PresencePeer } from "./PresencePeers";

type Context = { key: string; serverId: string; identity: LocationIdentity; location: NoteLocation };
type Callbacks = { changed: () => void; location: (event: NoteLocationEvent) => void; stopped: () => void };

/** Maps the authorized inventory to one ephemeral foreground connection. Never
 * creates entries, retrieves background note contents, or guesses a path. */
export class LocationHost extends Component {
	private channel?: LocationChannel;
	private context?: Context;
	private folders = new Map<VaultShare, () => void>();
	private closed = false;
	constructor(private plugin: Plugin, private shares: ShareRegistry, private auth: AuthSession,
		private settings: SettingsScope<RelayOnPremSettings>, private instanceId: string, private callbacks: Callbacks,
		private createChannel: (identity: LocationIdentity, options: ConstructorParameters<typeof LocationChannel>[1]) => LocationChannel = (identity, options) => new LocationChannel(identity, options)) { super(); }
	onload(): void {
		this.register(this.settings.subscribe(() => this.callbacks.changed()));
		this.register(this.shares.on(() => { this.watchFolders(); this.callbacks.changed(); }));
		this.register(this.auth.onTokenRefreshed(() => { this.callbacks.changed(); this.channel?.credentialsChanged(); }));
		this.watchFolders();
	}
	get status(): LocationChannelStatus { return this.channel?.status ?? "idle"; }
	get currentLocation(): NoteLocation | undefined { return this.context?.location; }
	get ready(): boolean { return this.channel?.ready === true; }
	retry(): void { this.channel?.retry(); }
	unfollow(): void { this.channel?.unfollow(); }
	follow(peer: PresencePeer): string | undefined {
		if (!this.context || !peer.instanceId) return;
		try { return this.channel?.follow({ user_id: peer.userId, session_id: peer.sessionId, instance_id: peer.instanceId }, this.context.location); }
		catch { return; } // Previous plugin/server versions retain current-note navigation.
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
	private entry(file?: TFile | null): { folder: VaultShare; id: string } | undefined {
		if (!file || file.extension !== "md" || this.plugin.app.vault.getFileByPath(file.path) !== file) return;
		const folder = this.shares.shareFor(file.path);
		if (!folder?.wantsConnection || folder.isRecoveringStructure) return;
		const path = folder.toVirtualPath(file.path), record = folder.folderIndex.recordFor(path), index = folder._liveProvider.managedIndex;
		const base = folder.crdtDoc.getMap<{ owner: boolean; permissions: Record<string, string> }>("managed_base_v1").get("snapshot");
		if (!record || record.type !== "markdown" || !locationId(record.id) || !locationId(folder.entityGuid) ||
			!index?.registered(path, record.id) || index.isBlocked(path, record.id) || !base || !base.owner && !["read", "write"].includes(base.permissions[path])) return;
		return { folder, id: record.id };
	}
	private identify(view?: MarkdownView | null): Context | undefined {
		const entry = this.entry(view?.file), settings = this.settings.readValue();
		const server = entry && settings.enabled ? settings.servers.find(server => server.id === entry.folder.config.onpremServerId) : undefined;
		const provider = server && this.auth.getAuthProviderForServer(server.id), user = provider?.getCurrentUser();
		if (!entry || !server || !provider?.isLoggedIn() || !user || !locationId(user.id)) return;
		try {
			const claims = decodeJwt(provider.getToken() ?? "");
			if (claims.sub !== user.id || !locationId(claims.session_id) || claims.scope !== undefined) return;
			const identity = { serverUrl: server.controlPlaneUrl, accountId: user.id, loginSessionId: claims.session_id, instanceId: this.instanceId };
			return { key: JSON.stringify([server.id, identity]), serverId: server.id, identity,
				location: { kind: "note", share_id: entry.folder.entityGuid, entry_id: entry.id, surface: view?.getMode() === "preview" ? "reading" : "editor" } };
		} catch { return; }
	}
	update(view: MarkdownView | null | undefined, foreground: boolean, visible: boolean): void {
		if (this.closed) return;
		const context = foreground ? this.identify(view) : undefined;
		if (this.context?.key !== context?.key) {
			const previous = this.channel; this.channel = undefined; this.context = undefined; previous?.stop();
		}
		this.context = context;
		if (!context) return;
		if (!this.channel) {
			const current = () => !this.closed && this.context?.key === context.key && this.identify(this.plugin.app.workspace.getActiveViewOfType(MarkdownView))?.key === context.key;
			try {
				this.channel = this.createChannel(context.identity, {
					credential: async () => {
						if (!current()) return;
						const accessToken = await this.auth.getAuthProviderForServer(context.serverId)?.getValidToken();
						return current() && accessToken ? { accountId: context.identity.accountId, accessToken } : undefined;
					}, status: () => { if (!this.closed) this.callbacks.changed(); }, location: event => {
						if (event.location === null || event.location.kind === "note") this.callbacks.location({ subscriptionId: event.subscriptionId, location: event.location });
						else this.callbacks.stopped();
					}, followStopped: this.callbacks.stopped,
				});
			} catch { return; }
		}
		this.channel.start(context.location.share_id, visible ? context.location : null);
	}
	/** Only the currently authenticated server/account's unique authorized local
 	 * entry can be opened. Directory events never supply a filesystem path. */
	fileFor(location: NoteLocation): TFile | undefined {
		const context = this.context; if (!context || !this.ready) return;
		if (this.identify(this.plugin.app.workspace.getActiveViewOfType(MarkdownView))?.key !== context.key) return;
		const matches: TFile[] = [];
		for (const folder of this.shares.toArray()) if (folder.entityGuid === location.share_id && folder.config.onpremServerId === context.serverId) {
			folder.folderIndex.eachRecord((record, path) => {
				if (record.id !== location.entry_id || record.type !== "markdown") return;
				const file = this.plugin.app.vault.getFileByPath(folder.absolutePath(path));
				if (file && this.entry(file)?.folder === folder) matches.push(file);
			});
		}
		return matches.length === 1 ? matches[0] : undefined;
	}
	onunload(): void {
		this.closed = true; this.channel?.stop(); this.channel = undefined; this.context = undefined;
		for (const stop of this.folders.values()) stop(); this.folders.clear();
	}
}
