import { Component, TFile, type Plugin } from "obsidian";
import type { AuthSession } from "../AuthSession";
import type { ShareRegistry } from "../VaultShare";
import type { RelayOnPremSettings } from "../RelayOnPremConfig";
import type { SettingsScope } from "../SettingsPersistence";
import { DiscussionSession } from "./DiscussionSession";
import { DiscussionTransport } from "./DiscussionTransport";
import { DiscussionStore } from "./storage/DiscussionStore";
import { isId } from "./DiscussionProtocol";
import { CommentsView, COMMENTS_VIEW } from "./ui/CommentsView";

type Slot = { cancelled: boolean; session?: DiscussionSession; pending?: Promise<void>; failed?: boolean };
export type CommentTarget = { path: string; entryId?: string; session?: DiscussionSession; message?: string };

/** Native Obsidian adapter. Note IDs come from the managed inventory; never
 * create a document, alter Markdown, or mint a new target ID just to comment.
 */
export class DiscussionHost extends Component {
	private slots = new Map<string, Slot>();
	private folderListeners = new Map<string, () => void>();
	private listeners = new Set<() => void>();
	private stopped = false;
	private lastFile?: TFile;

	constructor(private plugin: Plugin, private auth: AuthSession, private shares: ShareRegistry,
		private settings: SettingsScope<RelayOnPremSettings>, private vaultId: string) { super(); }
	onload(): void {
		this.plugin.registerView(COMMENTS_VIEW, leaf => new CommentsView(leaf, this));
		this.plugin.addCommand({ id: "open-comments", name: "Open comments", callback: () => { void this.open(); } });
		this.register(this.auth.on(() => this.reconcile()));
		this.register(this.auth.onTokenRefreshed(() => { this.reconcile(); for (const slot of this.slots.values()) void slot.session?.refresh(); }));
		this.register(this.shares.on(() => this.reconcile()));
		this.register(this.settings.subscribe(() => this.reconcile()));
		this.registerEvent(this.plugin.app.workspace.on("file-open", file => { if (file) this.lastFile = file; this.notify(); }));
		this.registerEvent(this.plugin.app.vault.on("rename", () => this.notify()));
		this.registerEvent(this.plugin.app.vault.on("delete", file => { if (file === this.lastFile) this.lastFile = undefined; this.notify(); }));
		this.registerEvent(this.plugin.app.workspace.on("file-menu", (menu, file) => {
			if (file instanceof TFile && file.extension === "md" && this.shares.shareFor(file.path)) menu.addItem(item =>
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
	private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* Isolate view failures. */ } } }
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
		const file = this.lastFile;
		if (!file || file.extension !== "md") return { path: "", message: "Open a shared Markdown note to see its comments." };
		const folder = this.shares.shareFor(file.path);
		if (!folder) return { path: file.path, message: "This note is not in a shared folder." };
		const server = this.settings.readValue().servers.find(s => s.id === folder.config.onpremServerId);
		const provider = server ? this.auth.getAuthProviderForServer(server.id) : undefined;
		const account = provider?.isLoggedIn() ? provider.getCurrentUser() : undefined;
		if (!server || !account) return { path: file.path, message: "Sign in to this shared folder’s server to use comments." };
		const record = folder.folderIndex.recordFor(folder.toVirtualPath(file.path));
		if (!record || record.type !== "markdown" || !isId(record.id)) return { path: file.path, message: "Waiting for this note’s shared identity…" };
		const slot = this.slots.get(this.key(server.controlPlaneUrl, account.id, folder.entityGuid)), session = slot?.session;
		return { path: file.path, entryId: record.id, session, message: session ? undefined : slot?.failed ? "Local comments could not be opened. Retry after checking storage and server settings." : "Opening comments…" };
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
	onunload(): void {
		this.stopped = true;
		for (const slot of this.slots.values()) { slot.cancelled = true; void slot.session?.close(); }
		for (const unsubscribe of this.folderListeners.values()) unsubscribe();
		this.slots.clear(); this.folderListeners.clear(); this.notify(); this.listeners.clear();
	}
}
