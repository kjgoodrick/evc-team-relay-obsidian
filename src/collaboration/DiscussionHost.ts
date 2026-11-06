import { Component, MarkdownView, Notice, TFile, type Editor, type Plugin } from "obsidian";
import { v4 as uuid } from "uuid";
import type { AuthSession } from "../AuthSession";
import type { ShareRegistry } from "../VaultShare";
import type { RelayOnPremSettings } from "../RelayOnPremConfig";
import type { SettingsScope } from "../SettingsPersistence";
import { DiscussionSession } from "./DiscussionSession";
import { DiscussionTransport } from "./DiscussionTransport";
import { DiscussionStore } from "./storage/DiscussionStore";
import { isId, protocolJson, type DiscussionAnchor } from "./DiscussionProtocol";
import { CommentsView, COMMENTS_VIEW } from "./ui/CommentsView";
import { commentEditorExtension, type CommentEditorSurface, type CapturedCommentSelection } from "./CommentEditor";
import { BlockSelectionError } from "./anchors/blocks";
import { ReadingComments } from "./CommentReading";

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
	private editors = new Set<CommentEditorSurface>();
	private focus?: { session: DiscussionSession; entryId: string; threadId: string; serial: number };
	private focusSerial = 0;
	private reading?: ReadingComments;

	constructor(private plugin: Plugin, private auth: AuthSession, private shares: ShareRegistry,
		private settings: SettingsScope<RelayOnPremSettings>, private vaultId: string) { super(); }
	onload(): void {
		this.reading = this.addChild(new ReadingComments(this, this.plugin));
		this.plugin.registerView(COMMENTS_VIEW, leaf => new CommentsView(leaf, this));
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
		return this.targetFor(this.lastFile);
	}
	targetFor(file?: TFile): CommentTarget {
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
	registerEditor(surface: CommentEditorSurface): () => void { this.editors.add(surface); return () => this.editors.delete(surface); }
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
	async saveCommentSelection({ session, entryId, file, anchor }: CapturedCommentSelection): Promise<void> {
		try {
			const current = () => !this.stopped && session.status !== "closed" && this.targetFor(file).session === session && this.targetFor(file).entryId === entryId && session.permission(entryId)?.comment;
			if (!current()) return;
			const draftId = "selection:" + entryId + ":" + uuid();
			await session.trackLocal(session.store.saveDraft({ id: draftId, scopeId: entryId, revision: 0,
				body: { text: "", mentions: [] }, target: protocolJson(anchor) }, null));
			if (!current()) return;
			await session.trackLocal(session.store.setPreference("activeNewDraft:" + entryId, draftId));
			if (!current()) return;
			this.lastFile = file; this.focus = undefined; await this.open();
		} catch { new Notice("The selection draft could not be saved. Check local storage and comment access, then try again."); }
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
	async revealTarget(session: DiscussionSession, entryId: string, anchor: DiscussionAnchor): Promise<void> {
		const available = () => !this.stopped && session.status !== "closed" && session.permission(entryId)?.read;
		if (!available()) return;
		const workspace = this.plugin.app.workspace;
		try {
			let file: TFile | undefined;
			for (const folder of this.shares.toArray()) if (folder.entityGuid === session.identity.shareId) {
				const paths: string[] = []; folder.folderIndex.eachRecord((record, path) => { if (record.id === entryId) paths.push(path); });
				if (paths.length !== 1) break;
				file = this.plugin.app.vault.getFileByPath(folder.absolutePath(paths[0])) ?? undefined;
			}
			if (!file || this.targetFor(file).session !== session || this.targetFor(file).entryId !== entryId) return;
			const existing = workspace.getLeavesOfType("markdown").find(leaf => leaf.view instanceof MarkdownView && leaf.view.file === file);
			if (existing?.view instanceof MarkdownView && existing.view.getMode() === "preview") {
				await workspace.revealLeaf(existing);
				if (anchor.type === "note" || this.reading?.reveal(existing.view, session, entryId, anchor)) return;
			}
			const leaf = existing ?? workspace.getLeaf("tab");
			await leaf.setViewState({ type: "markdown", active: true, state: { file: file.path, mode: "source" } });
			await workspace.revealLeaf(leaf);
			if (anchor.type === "note") return;
			for (let attempt = 0; attempt < 20; attempt++) {
				if (!available()) return;
				const surface = [...this.editors].find(item => item.file === file && leaf.view instanceof MarkdownView && item.editor === leaf.view.editor);
				if (surface?.reveal(session, entryId, anchor)) return;
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
	onunload(): void {
		this.stopped = true;
		this.focus = undefined; this.editors.clear();
		for (const slot of this.slots.values()) { slot.cancelled = true; void slot.session?.close(); }
		for (const unsubscribe of this.folderListeners.values()) unsubscribe();
		this.slots.clear(); this.folderListeners.clear(); this.notify(); this.listeners.clear();
	}
}
