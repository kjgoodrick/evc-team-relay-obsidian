import { ItemView, Modal, type App, type WorkspaceLeaf } from "obsidian";
import { v4 as uuid } from "uuid";
import type { DiscussionHost } from "../DiscussionHost";
import type { AnchoredThread, DiscussionSession } from "../DiscussionSession";
import { isRecord, protocolJson, REACTIONS, type DiscussionMessage } from "../DiscussionProtocol";
import type { OnlineOperation } from "../DiscussionTransport";
import { CommentComposer } from "./CommentComposer";
import { renderCommentBody } from "./CommentBody";
import { PendingComments } from "./PendingComments";
import { DiscussionDrafts } from "./DiscussionDrafts";
import { CommentPicture } from "./CommentPicture";
import { editableCommentDraft, type CommentDraft } from "./CommentDraft";

export const COMMENTS_VIEW = "team-relay-comments";

class AccountModal extends Modal {
	private stopWatching: () => void;
	constructor(app: App, session: DiscussionSession) {
		super(app); this.stopWatching = session.onChange(() => { if (session.status === "closed") this.close(); });
	}
	onClose(): void { this.stopWatching(); this.contentEl.empty(); }
}

class HistoryModal extends AccountModal {
	private closed = false;
	private after = 0;
	private pictures: CommentPicture[] = [];
	constructor(app: App, private session: DiscussionSession, private entryId: string, private threadId: string, private messageId: string) { super(app, session); }
	onOpen(): void { this.setTitle("Comment history"); void this.more(); }
	private async more(): Promise<void> {
		try {
			const page = await this.session.transport.history(this.entryId, this.threadId, this.messageId, this.after);
			if (this.closed || this.session.status === "closed") return;
			for (const revision of page.revisions) {
				const article = this.contentEl.createEl("article", { cls: "relay-comment-history" });
				article.createEl("h3", { text: `Revision ${revision.revision} · ${new Date(revision.created_at).toLocaleString()}` });
				renderCommentBody(article, revision.body, id => this.session.displayName(this.entryId, id),
					(parent, picture) => this.pictures.push(new CommentPicture(parent, this.session, this.entryId, picture)));
				if (revision.reason) article.createEl("p", { text: revision.reason });
			}
			this.after = page.next_after;
			if (page.has_more) { const more = this.contentEl.createEl("button", { text: "Load more history" }); more.onclick = () => { more.remove(); void this.more(); }; }
		} catch { if (!this.closed) this.contentEl.createEl("p", { text: "History could not be loaded. Reconnect or check access to this note.", attr: { role: "alert" } }); }
	}
	onClose(): void { this.closed = true; this.pictures.forEach(p => p.dispose()); this.pictures = []; super.onClose(); }
}

class DeleteCommentModal extends AccountModal {
	private operation?: OnlineOperation;
	constructor(app: App, private session: DiscussionSession, private entryId: string, private threadId: string, private message: DiscussionMessage) { super(app, session); }
	onOpen(): void {
		this.setTitle("Remove comment");
		this.contentEl.createEl("p", { text: "The comment will be replaced by a removal marker. Its edit history remains available to its author and moderators." });
		const reason = this.contentEl.createEl("textarea", { attr: { rows: "2", placeholder: "Reason (required when removing someone else’s comment)", "aria-label": "Removal reason" } });
		const status = this.contentEl.createDiv({ attr: { role: "status" } });
		const button = this.contentEl.createEl("button", { text: "Remove comment", cls: "mod-warning" });
		button.onclick = () => {
			if (this.message.author_id !== this.session.identity.accountId && !reason.value.trim()) { status.setText("Enter a reason for the removal."); return; }
			this.operation ??= { operationId: uuid(), scopeId: this.entryId, payload: {
				type: "message.delete", thread_id: this.threadId, message_id: this.message.id, expected_revision: this.message.revision,
				...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
			} };
			button.disabled = true; reason.disabled = true;
			void this.session.onlineAction(this.operation).then(() => this.close()).catch(() => {
				status.setText("Removal was not confirmed. Retry uses the same request."); button.disabled = false; button.setText("Retry removal");
			});
		};
	}
}

class EditCommentModal extends AccountModal {
	private composer?: CommentComposer;
	constructor(app: App, private session: DiscussionSession, private entryId: string, private threadId: string, private message: DiscussionMessage, private draft: CommentDraft) { super(app, session); }
	onOpen(): void {
		this.setTitle("Edit comment");
		this.composer = new CommentComposer(this.contentEl, this.session, this.entryId, `edit:${this.entryId}:${this.message.id}`,
			body => ({ type: "message.edit", payload: { type: "message.edit", thread_id: this.threadId, message_id: this.message.id,
				expected_revision: this.message.revision, body: protocolJson(body) } }), "Comment", this.draft, () => this.close());
	}
	onClose(): void { this.composer?.dispose(); super.onClose(); }
}

class ThreadCard {
	readonly el: HTMLElement;
	private content: HTMLElement;
	private controls: HTMLElement;
	private summary: HTMLElement;
	private composer?: CommentComposer;
	private composerContainer: HTMLElement;
	private expanded = false;
	private count = 1;
	private after = 0;
	private pages: number[] = [];
	private generation = 0;
	private pendingReopen?: OnlineOperation;
	private stateOperation?: OnlineOperation;
	private error: HTMLElement;
	private disposed = false;
	private renderedKey = "";
	private pictures: CommentPicture[] = [];
	constructor(parent: HTMLElement, private app: App, private session: DiscussionSession, private entryId: string, private thread: AnchoredThread,
		private host: DiscussionHost) {
		this.el = parent.createEl("article", { cls: "relay-comment-thread" });
		this.summary = this.el.createDiv({ cls: "relay-comment-thread-heading" });
		this.controls = this.el.createDiv({ cls: "relay-comment-thread-controls" });
		this.content = this.el.createDiv({ cls: "relay-comment-messages" });
		this.error = this.el.createDiv({ attr: { role: "status" } });
		this.composerContainer = this.el.createDiv();
		void this.session.store.preference(`online:reply:${entryId}:${thread.id}`).then(saved => {
			if (!this.disposed && isRecord(saved) && isRecord(saved.operation)) {
				this.pendingReopen = saved.operation as unknown as OnlineOperation;
				this.composer?.update();
			}
		}).catch(() => {});
	}
	async update(thread: AnchoredThread): Promise<void> {
		this.thread = thread;
		const key = JSON.stringify([thread.activity_sequence, this.count, this.after, this.expanded,
			this.session.permission(this.entryId), this.session.online, this.session.canQueue, this.session.participants(this.entryId)]);
		this.composer?.update();
		if (key === this.renderedKey) return;
		const generation = ++this.generation;
		this.summary.setText(`${thread.state === "resolved" ? "Resolved" : "Open"} · ${this.session.displayName(this.entryId, thread.author_id)} · ${new Date(thread.created_at).toLocaleString()}`);
		this.controls.empty();
		if (thread.anchor?.type === "image" || thread.anchor?.type === "image_file") {
			const target = this.controls.createEl("button", { text: "Show image " + (thread.anchor.geometry.type === "whole" ? "discussion" : thread.anchor.geometry.type) });
			target.onclick = () => { if (thread.anchor) void this.host.revealTarget(this.session, this.entryId, thread.anchor); };
		} else if (thread.anchor?.type === "text") {
			const target = this.controls.createEl("button", { text: thread.anchor.structure ? "Show selected blocks" : thread.anchor.context.quote ? "Show selected text" : "Show selected position" });
			target.title = thread.anchor.context.quote;
			target.onclick = () => { if (thread.anchor) void this.host.revealTarget(this.session, this.entryId, thread.anchor); };
		}
		const toggle = this.controls.createEl("button", { text: this.expanded ? "Hide replies" : "Show replies", attr: { "aria-expanded": String(this.expanded) } });
		toggle.onclick = () => { this.expanded = !this.expanded; this.count = this.expanded ? 20 : 1; this.after = 0; this.pages = []; void this.update(this.thread); };
		const permission = this.session.permission(this.entryId);
		if (permission?.comment) {
			const state = thread.state === "open" ? "resolved" : "open";
			const button = this.controls.createEl("button", { text: state === "resolved" ? "Resolve" : "Reopen" });
			button.disabled = !this.session.online;
			button.onclick = () => {
				if (!this.stateOperation || !isRecord(this.stateOperation.payload) || this.stateOperation.payload.expected_state_revision !== thread.state_revision) {
					this.stateOperation = { operationId: uuid(), scopeId: this.entryId, payload: { type: "thread.state", thread_id: thread.id, expected_state_revision: thread.state_revision, state } };
				}
				button.disabled = true;
				void this.session.onlineAction(this.stateOperation).then(() => { this.stateOperation = undefined; this.error.empty(); }).catch(() => {
					this.error.setText("Change was not confirmed. Reconnect and retry, or refresh this discussion."); button.disabled = !this.session.online;
				});
			};
		}
		if (this.expanded && !this.composer) {
			this.composer = new CommentComposer(this.composerContainer, this.session, this.entryId, `reply:${this.entryId}:${thread.id}`,
				body => ({ type: "reply.create", payload: { type: "reply.create", thread_id: thread.id, message_id: uuid(), body: protocolJson(body) } }), "Reply");
			this.composer.addOnlineAction("Send and reopen", async (body, draft) => {
				if (this.thread.state !== "resolved" && !this.pendingReopen) throw new Error("This discussion is already open.");
				const serialized = JSON.stringify(body);
				if (this.pendingReopen && isRecord(this.pendingReopen.payload) && JSON.stringify(this.pendingReopen.payload.body) !== serialized) throw new Error("Review the unconfirmed reply before changing it.");
				this.pendingReopen ??= { operationId: uuid(), scopeId: this.entryId, payload: { type: "reply.create", thread_id: this.thread.id,
					message_id: uuid(), body: protocolJson(body), reopen: true, expected_state_revision: this.thread.state_revision } };
				try { await this.session.onlineDraft(draft, this.pendingReopen); this.pendingReopen = undefined; }
				catch (error) {
					// Picture preflight/upload failed before a reply could be submitted.
					if (!await this.session.store.preference("online:" + draft.id)) this.pendingReopen = undefined;
					throw error;
				}
			}, () => this.thread.state === "resolved" || !!this.pendingReopen);
		}
		this.composerContainer.hidden = !this.expanded; this.composer?.update();
		const result = await this.session.messages(this.entryId, thread.id, this.after, this.count);
		if (this.disposed || generation !== this.generation || this.session.status === "closed") return;
		this.pictures.forEach(p => p.dispose()); this.pictures = []; this.content.empty();
		for (const message of result.messages) this.message(message);
		if (!result.messages.length) this.content.createEl("p", { text: "Loading discussion…", cls: "relay-comment-muted" });
		if (this.expanded && result.hasMore) {
			const more = this.content.createEl("button", { text: "Next replies" });
			more.onclick = () => { this.pages.push(this.after); this.after = result.messages[result.messages.length - 1].created_sequence; void this.update(this.thread); };
		}
		if (this.expanded && this.pages.length) {
			const previous = this.content.createEl("button", { text: "Previous replies" });
			previous.onclick = () => { this.after = this.pages.pop() ?? 0; void this.update(this.thread); };
		}
		this.renderedKey = key;
	}
	async focus(): Promise<void> { this.expanded = true; this.count = 20; await this.update(this.thread); this.el.scrollIntoView({ block: "nearest" }); }
	private message(message: DiscussionMessage): void {
		const article = this.content.createDiv({ cls: "relay-comment-message" });
		article.createDiv({ cls: "relay-comment-author", text: `${message.author_id === this.session.identity.accountId ? "You" : this.session.displayName(this.entryId, message.author_id)} · ${new Date(message.created_at).toLocaleString()}${message.revision > 1 ? " · edited" : ""}` });
		renderCommentBody(article, message.body, id => this.session.displayName(this.entryId, id),
			(parent, picture) => this.pictures.push(new CommentPicture(parent, this.session, this.entryId, picture)));
		const permission = this.session.permission(this.entryId), actions = article.createDiv({ cls: "relay-comment-message-actions" });
		if (!message.deleted) for (const [emoji, label] of Object.entries(REACTIONS)) {
			const reaction = message.reactions.find(r => r.emoji === emoji);
			if (!permission?.comment && !reaction) continue;
			const button = actions.createEl("button", { text: label + (reaction ? " " + reaction.count : ""), cls: "relay-comment-reaction",
				attr: { "aria-label": emoji.replace(/_/g, " ") + (reaction ? `, ${reaction.count}` : ""), "aria-pressed": String(reaction?.mine ?? false) } });
			button.disabled = !permission?.comment || !this.session.canQueue;
			button.onclick = () => {
				button.disabled = true;
				void this.session.queue({ operationId: uuid(), scopeId: this.entryId, type: "reaction.set", dependsOn: [], payload: {
					type: "reaction.set", thread_id: this.thread.id, message_id: message.id, emoji, present: !reaction?.mine,
				} }).catch(() => { this.error.setText("Reaction could not be saved. Check your connection and permissions."); button.disabled = false; });
			};
		}
		if (!message.deleted || message.author_id === this.session.identity.accountId || permission?.moderate) {
			const history = actions.createEl("button", { text: "History" }); history.onclick = () => new HistoryModal(this.app, this.session, this.entryId, this.thread.id, message.id).open();
		}
		if (!message.deleted && permission?.comment) {
			const draft = message.body ? editableCommentDraft(message.body, id => this.session.displayName(this.entryId, id)) : undefined;
			if (message.author_id === this.session.identity.accountId && draft !== undefined) {
				const edit = actions.createEl("button", { text: "Edit" }); edit.onclick = () => new EditCommentModal(this.app, this.session, this.entryId, this.thread.id, message, draft).open();
			}
			if (message.author_id === this.session.identity.accountId || permission.moderate) {
				const remove = actions.createEl("button", { text: "Remove" }); remove.disabled = !this.session.online;
				remove.onclick = () => new DeleteCommentModal(this.app, this.session, this.entryId, this.thread.id, message).open();
			}
		}
	}
	dispose(): void { this.disposed = true; this.generation++; this.pictures.forEach(p => p.dispose()); this.pictures = []; this.composer?.dispose(); this.el.remove(); }
}

export class CommentsView extends ItemView {
	private session?: DiscussionSession;
	private entryId?: string;
	private watch?: () => void;
	private unsubscribe?: () => void;
	private drafts?: DiscussionDrafts;
	private focusedSerial = 0;
	private cards = new Map<string, ThreadCard>();
	private generation = 0;
	private timer?: number;
	private count = 20;
	private after = 0;
	private pages: number[] = [];
	private status?: HTMLElement;
	private list?: HTMLElement;
	private pending?: HTMLElement;
	private pendingView?: PendingComments;
	private closed = false;
	constructor(leaf: WorkspaceLeaf, private host: DiscussionHost) { super(leaf); }
	getViewType(): string { return COMMENTS_VIEW; }
	getDisplayText(): string { return "Comments"; }
	getIcon(): string { return "message-square"; }
	async onOpen(): Promise<void> {
		this.contentEl.addClass("relay-comments-view");
		this.unsubscribe = this.host.onChange(() => {
			const next = this.host.current();
			// Clear the old account/note synchronously; debounce only subsequent rendering.
			if (this.session && (next.session !== this.session || next.entryId !== this.entryId || this.session.status === "closed")) this.reset();
			this.schedule();
		});
		this.registerEvent(this.app.workspace.on("layout-change", () => this.schedule()));
		this.schedule();
	}
	private schedule(): void {
		if (this.closed) return;
		if (this.timer !== undefined) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => { this.timer = undefined; void this.render().catch(() => { this.status?.setText("Comments could not be loaded. Refresh to retry."); }); }, 50);
	}
	private reset(): void {
		this.generation++; this.session = undefined; this.entryId = undefined;
		const watch = this.watch; this.watch = undefined; watch?.(); this.drafts?.dispose(); this.drafts = undefined; this.focusedSerial = 0;
		for (const card of this.cards.values()) card.dispose(); this.cards.clear();
		this.pendingView?.dispose(); this.pendingView = undefined;
		this.contentEl.empty(); this.status = undefined; this.list = undefined; this.pending = undefined; this.count = 20; this.after = 0; this.pages = [];
	}
	private async render(): Promise<void> {
		if (!this.containerEl.getClientRects().length) { const watch = this.watch; this.watch = undefined; watch?.(); return; }
		const target = this.host.current();
		if (!target.session || !target.entryId || target.session.status === "closed") {
			this.reset(); this.session = undefined; this.entryId = undefined;
			this.contentEl.createEl("p", { text: target.message ?? "Sign in to use comments." });
			if (target.entryId) { const retry = this.contentEl.createEl("button", { text: "Retry opening comments" }); retry.onclick = () => this.host.retry(); }
			return;
		}
		if (target.session !== this.session || target.entryId !== this.entryId) {
			this.reset(); this.session = target.session; this.entryId = target.entryId;
			this.contentEl.createEl("h2", { text: target.path.split("/").pop() ?? "Comments" });
			this.status = this.contentEl.createDiv({ cls: "relay-comment-status", attr: { role: "status", "aria-live": "polite" } });
			const refresh = this.contentEl.createEl("button", { text: "Refresh comments" }); refresh.onclick = () => { void this.session?.refresh(); };
			this.pending = this.contentEl.createDiv({ cls: "relay-comment-pending" });
			this.pendingView = new PendingComments(this.pending, this.session, this.entryId);
			this.list = this.contentEl.createDiv({ cls: "relay-comment-thread-list" });
			const session = this.session, entryId = this.entryId;
			this.drafts = new DiscussionDrafts(this.contentEl, session, entryId, anchor => { void this.host.revealTarget(session, entryId, anchor); },
				target.kind === "image" ? () => this.host.commentCurrentImage(session, entryId) : undefined);
		}
		this.watch ??= this.session.watch(this.entryId, () => this.schedule(), target.kind ?? "note");
		this.contentEl.querySelector("h2")?.setText(target.path.split("/").pop() ?? "Comments");
		const session = this.session, entryId = this.entryId, generation = ++this.generation;
		const permission = session.permission(entryId), sync = session.syncStatus(entryId);
		const statuses: Record<string, string> = { starting: "Connecting…", ready: "Comments are up to date", offline: "Offline — comments are saved to send when connected",
			unavailable: "Comments are not enabled on this server.", authentication_required: "Sign in again to continue.", error: "Comments need attention. Refresh to retry." };
		this.status!.setText(sync === "unavailable" ? "You no longer have access to this file’s comments." : sync === "syncing" ? "Updating comments…" :
			statuses[session.status] + (permission?.read && !permission.comment ? " · You can read comments" : ""));
		this.drafts?.update();
		const canRead = !!permission?.read && session.status !== "authentication_required" && session.status !== "unavailable";
		if (!canRead) {
			for (const card of this.cards.values()) card.dispose(); this.cards.clear(); this.list!.empty();
		}
		// Local authored work remains recoverable after read access is revoked;
		// only remote entities require the current note permission.
		const local = canRead ? await session.local(entryId, this.after, this.count) :
			{ threads: [], pending: await session.store.pending(entryId), hasMore: false, nextAfter: this.after };
		if (this.closed || generation !== this.generation || session.status === "closed") return;
		this.pendingView!.update(local.pending);
		if (!canRead) return;
		const focus = this.host.focusedThread(session, entryId);
		if (focus && !local.threads.some(thread => thread.id === focus.threadId)) {
			const thread = await session.cachedThread(entryId, focus.threadId);
			if (this.closed || generation !== this.generation) return;
			if (thread) local.threads.unshift(thread);
		}
		const retained = new Set(local.threads.map(thread => thread.id));
		for (const [id, card] of this.cards) if (!retained.has(id)) { card.dispose(); this.cards.delete(id); }
		for (const thread of local.threads) {
			let card = this.cards.get(thread.id);
			if (!card) { card = new ThreadCard(this.list!, this.app, session, entryId, thread, this.host); this.cards.set(thread.id, card); }
			await card.update(thread);
			if (this.closed || generation !== this.generation) return;
			if (focus?.threadId === thread.id && focus.serial !== this.focusedSerial) { this.focusedSerial = focus.serial; await card.focus(); }
		}
		this.list!.querySelectorAll(".relay-comment-more").forEach(el => el.remove());
		if (local.hasMore) {
			const more = this.list!.createEl("button", { text: "Next discussions", cls: "relay-comment-more" });
			more.onclick = () => { this.pages.push(this.after); this.after = local.nextAfter; this.schedule(); };
		}
		if (this.pages.length) { const previous = this.list!.createEl("button", { text: "Previous discussions", cls: "relay-comment-more" });
			previous.onclick = () => { this.after = this.pages.pop() ?? 0; this.schedule(); }; }
		if (!local.threads.length && !local.pending.length && sync === "current") this.list!.createEl("p", { cls: "relay-comment-more", text: "No comments yet. Start a discussion below." });
	}
	async onClose(): Promise<void> {
		this.closed = true; if (this.timer !== undefined) window.clearTimeout(this.timer);
		this.unsubscribe?.(); this.reset();
	}
}
