import { ReactionPicker } from "./ReactionPicker";
import { safeAvatarUrl } from "../../presenceAvatar";
import { commentButton } from "./CommentControls";
import { DiscussionExportModal } from "./DiscussionExport";
import { SavedDraftCopyModal } from "./SavedDraftCopy";
import { targetNeedsReview, uncheckedTarget, type CommentTargetStatus } from "../CommentTargetStatus";
import { ItemView, Modal, Menu, type App, type WorkspaceLeaf } from "obsidian";
import { v4 as uuid } from "uuid";
import type { DiscussionHost } from "../DiscussionHost";
import type { AnchoredThread, DiscussionSession } from "../DiscussionSession";
import { isRecord, protocolJson, REACTIONS, type DiscussionMessage } from "../DiscussionProtocol";
import type { OnlineOperation } from "../DiscussionTransport";
import { CommentComposer } from "./CommentComposer";
import { renderCommentBody } from "./CommentBody";
import { PendingComments } from "./PendingComments";
import { DiscussionDrafts } from "./DiscussionDrafts";
import { ThreadSubscription } from "./ThreadSubscription";
import { CommentPicture } from "./CommentPicture";
import { editableCommentDraft, type CommentDraft } from "./CommentDraft";
import { copyToClipboard } from "../../utils/clipboard";
import { DiscussionSearchPanel } from "./DiscussionSearchPanel";
import { CommentHistoryModal } from "./CommentHistory";
import { RemovedCommentsModal } from "./RemovedComments";
import { TargetHistoryModal, commentTargetDescription } from "./ReattachComment";
import { TimelineMarkerComparisonModal } from "./TimelineMarkerComparison";

export const COMMENTS_VIEW = "team-relay-comments";

class AccountModal extends Modal {
	private stopWatching: () => void;
	constructor(app: App, session: DiscussionSession) {
		super(app); this.stopWatching = session.onChange(() => { if (session.status === "closed") this.close(); });
	}
	onClose(): void { this.stopWatching(); this.contentEl.empty(); }
}

class DeleteCommentModal extends AccountModal {
	private operation?: OnlineOperation;
	constructor(app: App, private session: DiscussionSession, private entryId: string, private threadId: string, private message: DiscussionMessage) { super(app, session); }
	onOpen(): void {
		this.setTitle("Remove comment");
		this.contentEl.createEl("p", { text: "The comment will be replaced by a removal marker. Its text, history and pictures will no longer be available through ordinary discussion views." });
		const reason = this.contentEl.createEl("textarea", { attr: { rows: "2", placeholder: "Reason (required when removing someone else’s comment)", "aria-label": "Removal reason" } });
		const status = this.contentEl.createDiv({ attr: { role: "status" } });
		const button = commentButton(this.contentEl, { text: "Remove comment", cls: "mod-warning" });
		button.onclick = () => {
			if (this.message.author_id !== this.session.identity.accountId && !reason.value.trim()) { status.setText("Enter a reason for the removal."); return; }
			this.operation ??= { ...this.session.restoreBinding, operationId: uuid(), scopeId: this.entryId, payload: {
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
	private stopEditing?: () => void;
	constructor(app: App, private session: DiscussionSession, private entryId: string, private threadId: string, private message: DiscussionMessage, private draft: CommentDraft) { super(app, session); }
	onOpen(): void {
		this.setTitle("Edit comment");
		this.composer = new CommentComposer(this.contentEl, this.session, this.entryId, `edit:${this.entryId}:${this.message.id}`,
			(body, _anchor, revision) => ({ type: "message.edit", payload: { type: "message.edit", thread_id: this.threadId, message_id: this.message.id,
				expected_revision: revision ?? this.message.revision, body: protocolJson(body) } }), "Comment", { ...this.draft, editBaseRevision: this.message.revision }, () => this.close());
		this.stopEditing = this.session.onChange(() => this.composer?.update());
	}
	onClose(): void { this.stopEditing?.(); this.stopEditing = undefined; this.composer?.dispose(); super.onClose(); }
}

class ThreadCard {
	private removedModal?: RemovedCommentsModal;
	private markerComparison?: TimelineMarkerComparisonModal;
	private targetStatus = uncheckedTarget();
	private subscription: ThreadSubscription;
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
	private stateOperation?: OnlineOperation;
	private error: HTMLElement;
	private disposed = false;
	private renderedKey = "";
	private pictures: CommentPicture[] = [];
	constructor(parent: HTMLElement, private app: App, private session: DiscussionSession, private entryId: string, private thread: AnchoredThread,
		private host: DiscussionHost) {
		this.el = parent.createEl("article", { cls: "relay-comment-thread" });
		this.summary = this.el.createDiv({ cls: "relay-comment-thread-heading" });
		const actions = this.el.createDiv({ cls: "relay-comment-thread-actions" });
		this.controls = actions.createDiv({ cls: "relay-comment-thread-controls" });
		this.subscription = new ThreadSubscription(actions, session, entryId, thread.id);
		this.content = this.el.createDiv({ cls: "relay-comment-messages" });
		this.error = this.el.createDiv({ attr: { role: "status" } });
		this.composerContainer = this.el.createDiv();
	}
	async update(thread: AnchoredThread, targetStatus?: CommentTargetStatus): Promise<void> {
		this.thread = thread; if (targetStatus) this.targetStatus = targetStatus;
		this.markerComparison?.validate();
		const key = JSON.stringify([thread.activity_sequence, this.targetStatus, this.count, this.after, this.expanded,
			this.session.permission(this.entryId), this.session.online, this.session.canQueue, this.session.participants(this.entryId),
			this.session.baseRegistryRevision(this.entryId)]);
		this.composer?.update();
		if (key === this.renderedKey) return;
		const generation = ++this.generation;
		this.summary.empty();
		this.authorHeader(this.summary, thread.author_id, thread.created_at, false, thread.state === "resolved" ? "Resolved" : "Open");
		this.controls.empty();
		if (targetNeedsReview(this.targetStatus)) this.controls.createEl("p", { text: this.targetStatus.message, cls: "relay-comment-thread-target-status" });
		this.copyLink(this.controls, "Copy discussion link");
		if (thread.anchor?.type === "image" || thread.anchor?.type === "image_file") {
			const target = commentButton(this.controls, { text: "Show image " + (thread.anchor.geometry.type === "whole" ? "discussion" : thread.anchor.geometry.type) });
			target.onclick = () => { if (thread.anchor) void this.host.revealTarget(this.session, this.entryId, thread.anchor); };
		} else if (thread.anchor?.type === "text") {
			const target = commentButton(this.controls, { text: thread.anchor.structure ? "Show selected blocks" : thread.anchor.context.quote ? "Show selected text" : "Show selected position" });

			target.onclick = () => { if (thread.anchor) void this.host.revealTarget(this.session, this.entryId, thread.anchor); };
		} else if (thread.anchor?.type === "base") {
			this.controls.createEl("p", { text: this.host.targetLabel(this.session, this.entryId, thread.anchor) ?? "Saved view target" });
			const target = commentButton(this.controls, { text: (thread.anchor.target.type === "summary" || thread.anchor.target.type === "group_summary") ? "Show summary" : thread.anchor.target.type === "timeline_marker" ? "Show captured marker position" : "Show Bases target" });
			target.onclick = () => { if (thread.anchor) void this.host.revealTarget(this.session, this.entryId, thread.anchor); };
			if (thread.anchor.target.type === "timeline_marker") {
				const captured = thread.anchor, revision = thread.anchor_revision;
				const compare = commentButton(this.controls, { text: "Compare marker positions" });
				compare.onclick = () => {
					this.markerComparison?.close();
					this.markerComparison = new TimelineMarkerComparisonModal(this.app, this.session, this.entryId, thread.id, revision, captured,
						() => !this.disposed && this.thread.anchor_revision === revision,
						(anchor, current) => this.host.revealTarget(this.session, this.entryId, anchor, current));
					this.markerComparison.open();
				};
			}
		}
		const toggle = commentButton(this.controls, { text: this.expanded ? "Hide replies" : "Show replies", attr: { "aria-expanded": String(this.expanded) } });
		toggle.createEl("span", { text: "Replies", cls: "relay-comment-replies-label" });
        toggle.onclick = () => { this.expanded = !this.expanded; this.count = this.expanded ? 20 : 1; this.after = 0; this.pages = []; void this.update(this.thread); };
		const permission = this.session.permission(this.entryId);
		if (thread.anchor_revision > 1) {
			const history = commentButton(this.controls, { text: "Target history" }); history.disabled = !this.session.online;
			history.onclick = () => new TargetHistoryModal(this.app, this.session, this.entryId, thread.id,
				anchor => this.host.targetLabel(this.session, this.entryId, anchor) ?? commentTargetDescription(anchor),
				anchor => { void this.host.revealTarget(this.session, this.entryId, anchor); }).open();
		}
		if (permission?.comment) {
			const pendingMove = this.session.canReattach ? undefined : await this.session.pendingReattachment(this.entryId, thread.id);
			if (this.disposed || generation !== this.generation) return;
			if (this.session.canReattach || pendingMove) {
				const move = commentButton(this.controls, { text: pendingMove ? "Review unconfirmed move" : "Move target" });
				move.disabled = !this.session.online;
				move.onclick = () => this.host.openReattachment(this.session, this.entryId, this.thread);
			}
			const state = thread.state === "open" ? "resolved" : "open";
			const button = commentButton(this.controls, { text: state === "resolved" ? "Resolve" : "Reopen" });
			button.disabled = !this.session.online;
			button.onclick = () => {
				if (!this.stateOperation || !isRecord(this.stateOperation.payload) || this.stateOperation.payload.expected_state_revision !== thread.state_revision) {
					this.stateOperation = { ...this.session.restoreBinding, operationId: uuid(), scopeId: this.entryId, payload: { type: "thread.state", thread_id: thread.id, expected_state_revision: thread.state_revision, state } };
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
			this.composer.addOnlineAction("Send and reopen", async (body, draft, binding) => {
				// Read the durable intent for every click. Recovery in this or
				// another pane must not revive an old in-memory request identity.
				const saved = await this.session.store.preference("online:" + draft.id);
				const pending = isRecord(saved) && isRecord(saved.operation) ? saved.operation as unknown as OnlineOperation : undefined;
				if (this.thread.state !== "resolved" && !pending) throw new Error("This discussion is already open.");
				const serialized = JSON.stringify(body);
				if (pending && isRecord(pending.payload) && JSON.stringify(pending.payload.body) !== serialized) throw new Error("Review the unconfirmed reply before changing it.");
				const operation = pending ?? { ...binding, operationId: uuid(), scopeId: this.entryId, payload: { type: "reply.create", thread_id: this.thread.id,
					message_id: uuid(), body: protocolJson(body), reopen: true, expected_state_revision: this.thread.state_revision } };
				await this.session.onlineDraft(draft, operation);
			}, () => this.thread.state === "resolved" || !!this.composer?.hasUnconfirmedSend);
		}
		this.composerContainer.hidden = !this.expanded; this.composer?.update();
		const result = await this.session.messages(this.entryId, thread.id, this.after, this.count);
		if (this.disposed || generation !== this.generation || !this.session.permission(this.entryId)?.read || ["closed", "authentication_required", "unavailable"].includes(this.session.status)) return;
		this.pictures.forEach(p => p.dispose()); this.pictures = []; this.content.empty();
		for (const [index, message] of result.messages.entries()) {
			this.message(message);
			if (index === 0) this.content.appendChild(toggle);
		}
		if (!result.messages.length) this.content.appendChild(toggle);
		if (!result.messages.length) this.content.createEl("p", { text: "Loading discussion…", cls: "relay-comment-muted" });
		if (this.expanded && result.hasMore) {
			const more = commentButton(this.content, { text: "Next replies" });
			more.onclick = () => { this.pages.push(this.after); this.after = result.messages[result.messages.length - 1].created_sequence; void this.update(this.thread); };
		}
		if (this.expanded && this.pages.length) {
			const previous = commentButton(this.content, { text: "Previous replies" });
			previous.onclick = () => { this.after = this.pages.pop() ?? 0; void this.update(this.thread); };
		}
		this.renderedKey = key;
	}
	async focus(messageId?: string, sequence?: number, notice?: string, current: () => boolean = () => true): Promise<boolean> {
		this.expanded = true; this.count = 20;
		if (messageId && sequence !== undefined) { this.after = Math.max(0, sequence - 1); this.pages = this.after ? [0] : []; }
		await this.update(this.thread);
		if (this.disposed || !current() || !this.session.permission(this.entryId)?.read) return false;
		const selected = messageId ? Array.from(this.content.querySelectorAll<HTMLElement>("[data-message-id]")).find(element => element.dataset.messageId === messageId) : undefined;
		const element = selected ?? this.el; element.tabIndex = -1; element.scrollIntoView({ block: "nearest" }); element.focus({ preventScroll: true });
		if (notice || messageId && !selected) this.error.setText(notice ?? "The linked message is unavailable. Showing its discussion.");
		return true;
	}
	private copyLink(parent: HTMLElement, label: string, messageId?: string): void {
		const button = commentButton(parent, { text: label });
		button.onclick = () => {
			button.disabled = true;
			void this.host.discussionUrl(this.session, this.entryId, this.thread.id, messageId).then(async url => {
				if (this.disposed || !this.session.permission(this.entryId)?.read || this.session.status === "closed") return;
				await copyToClipboard(url);
			}).catch(() => { if (!this.disposed) this.error.setText("The comment link could not be copied. Check your access and try again."); })
				.finally(() => { if (!this.disposed) button.disabled = false; });
		};
	}
	private authorHeader(parent: HTMLElement, authorId: string | null, createdAt: string, edited = false, status?: string): void {
		const header = parent.createDiv({ cls: "relay-comment-author-header" });
        const name = this.session.displayName(this.entryId, authorId);
        const avatar = header.createDiv({ cls: "relay-comment-avatar", attr: { "aria-label": name } });
        avatar.setText(name.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase());
        const picture = safeAvatarUrl(this.session.participants(this.entryId).find(person => person.id === authorId)?.picture);
        if (picture) {
            const image = avatar.createEl("img", { attr: { src: picture, alt: name, referrerpolicy: "no-referrer" } });
            image.onerror = () => image.remove();
        }

		const metadata = header.createDiv({ cls: "relay-comment-author-meta" });
		metadata.createDiv({ cls: "relay-comment-author", text: `${authorId === this.session.identity.accountId ? "You" : this.session.displayName(this.entryId, authorId)} · ${new Date(createdAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}${edited ? " · edited" : ""}` });
		if (status) metadata.createDiv({ cls: "relay-comment-thread-state", text: status });
	}
	private message(message: DiscussionMessage): void {
		const article = this.content.createDiv({ cls: "relay-comment-message" });
		article.dataset.messageId = message.id;
		this.authorHeader(article, message.author_id, message.created_at, message.revision > 1);
		renderCommentBody(article, message.body, id => this.session.displayName(this.entryId, id),
			(parent, picture) => this.pictures.push(new CommentPicture(parent, this.session, this.entryId, picture)));
		const permission = this.session.permission(this.entryId), actions = article.createDiv({ cls: "relay-comment-message-actions" });
		this.copyLink(actions, "Copy comment link", message.id);
        if (!message.deleted && permission?.comment) {
            const picker = commentButton(actions, { text: "Add reaction" }); picker.disabled = !this.session.canQueue;
            picker.onclick = () => new ReactionPicker(this.app, this.session.unicodeReactions === true, emoji => {
                const reaction = message.reactions.find(r => r.emoji === emoji);
                void this.session.queue({ ...this.session.restoreBinding, operationId: uuid(), scopeId: this.entryId, type: "reaction.set", dependsOn: [], payload: {
                    type: "reaction.set", thread_id: this.thread.id, message_id: message.id, emoji, present: !reaction?.mine,
                } }).catch(() => this.error.setText("Reaction could not be saved. Check your connection and permissions."));
            }).open();
        }
		if (!message.deleted) for (const reaction of message.reactions) {
			const emoji = reaction.emoji, label = REACTIONS[emoji];
			const button = commentButton(actions, { text: label + (reaction ? " " + reaction.count : ""), cls: "relay-comment-reaction",
				attr: { "aria-label": emoji.replace(/_/g, " ") + (reaction ? `, ${reaction.count}` : ""), "aria-pressed": String(reaction?.mine ?? false) } });
			button.disabled = !permission?.comment || !this.session.canQueue;
			button.onclick = () => {
				button.disabled = true;
				void this.session.queue({ ...this.session.restoreBinding, operationId: uuid(), scopeId: this.entryId, type: "reaction.set", dependsOn: [], payload: {
					type: "reaction.set", thread_id: this.thread.id, message_id: message.id, emoji, present: !reaction?.mine,
				} }).catch(() => { this.error.setText("Reaction could not be saved. Check your connection and permissions."); button.disabled = false; });
			};
		}
		if (!message.deleted) {
			const history = commentButton(actions, { text: "History" }); history.disabled = !this.session.online;

			history.onclick = () => new CommentHistoryModal(this.app, this.session, this.entryId, this.thread.id, message.id).open();
		}
		if (message.deleted && this.session.canReviewRemoved?.(this.entryId)) {
			const review = commentButton(actions, { text: "Review removed comment", attr: { type: "button" } });
			review.onclick = () => {
				this.removedModal?.close();
				this.removedModal = new RemovedCommentsModal(this.app, this.session, this.entryId, () => !this.disposed && this.host.current().session === this.session && this.host.current().entryId === this.entryId,
					{ threadId: this.thread.id, messageId: message.id });
				this.removedModal.open();
			};
		}
		if (!message.deleted && permission?.comment) {
			const draft = message.body ? editableCommentDraft(message.body, id => this.session.displayName(this.entryId, id)) : undefined;
			if (message.author_id === this.session.identity.accountId && draft !== undefined) {
				const edit = commentButton(actions, { text: "Edit" }); edit.onclick = () => new EditCommentModal(this.app, this.session, this.entryId, this.thread.id, message, draft).open();
			}
			if (message.author_id === this.session.identity.accountId || permission.moderate) {
				const remove = commentButton(actions, { text: "Remove" }); remove.disabled = !this.session.online;
				remove.onclick = () => new DeleteCommentModal(this.app, this.session, this.entryId, this.thread.id, message).open();
			}
		}
	}
	dispose(): void { this.disposed = true; this.generation++; this.removedModal?.close(); this.removedModal = undefined; this.markerComparison?.close(); this.markerComparison = undefined; this.subscription.dispose(); this.pictures.forEach(p => p.dispose()); this.pictures = []; this.composer?.dispose(); this.el.remove(); }
}

export class CommentsView extends ItemView {
	private copyModal?: SavedDraftCopyModal;
	private removedModal?: RemovedCommentsModal;
	private removedButton?: HTMLButtonElement;
	private exportModal?: DiscussionExportModal;
	private exportButton?: HTMLButtonElement;
	private session?: DiscussionSession;
	private entryId?: string;
	private watch?: () => void;
	private unsubscribe?: () => void;
	private drafts?: DiscussionDrafts;
	private search?: DiscussionSearchPanel;
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
	private moveSelection?: HTMLElement;
	private pendingView?: PendingComments;
	private targetWatch?: () => void;
	private targetEpoch = 0;
	private targetCheck?: { key: string; epoch: number; pending: boolean };
	private targetStatuses = new Map<string, CommentTargetStatus>();
	private targetFilter?: HTMLSelectElement;
	private closed = false;
	constructor(leaf: WorkspaceLeaf, private host: DiscussionHost) { super(leaf); }
	getViewType(): string { return COMMENTS_VIEW; }
	getDisplayText(): string { return "Comments"; }
	getIcon(): string { return "message-square"; }
	async onOpen(): Promise<void> {
		this.contentEl.addClass("relay-comments-view");
		this.unsubscribe = this.host.onChange(() => {
			this.targetEpoch++;
			const next = this.host.current();
			// Clear the old account/note synchronously; debounce only subsequent rendering.
			if (this.session && (next.session !== this.session || next.entryId !== this.entryId || this.session.status === "closed")) this.reset();
			else if (this.session && this.entryId && (!this.session.permission(this.entryId)?.read || ["authentication_required", "unavailable"].includes(this.session.status))) {
				this.generation++;
				for (const card of this.cards.values()) card.dispose(); this.cards.clear(); this.list?.empty();
			}
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
		this.copyModal?.close(); this.copyModal = undefined;
		this.removedModal?.close(); this.removedModal = undefined; this.removedButton = undefined;
		this.exportModal?.close(); this.exportModal = undefined; this.exportButton = undefined;
		this.search?.dispose(); this.search = undefined;
		this.targetWatch?.(); this.targetWatch = undefined; this.targetEpoch++; this.targetCheck = undefined; this.targetStatuses.clear(); this.targetFilter = undefined;
		this.generation++; this.session = undefined; this.entryId = undefined;
		const watch = this.watch; this.watch = undefined; watch?.(); this.drafts?.dispose(); this.drafts = undefined; this.focusedSerial = 0;
		for (const card of this.cards.values()) card.dispose(); this.cards.clear();
		this.pendingView?.dispose(); this.pendingView = undefined;
		this.contentEl.empty(); this.status = undefined; this.list = undefined; this.pending = undefined; this.moveSelection = undefined; this.count = 20; this.after = 0; this.pages = [];
	}
	private async render(): Promise<void> {
		if (!this.containerEl.getClientRects().length) { const watch = this.watch; this.watch = undefined; watch?.(); return; }
		const target = this.host.current();
		if (target.kind === "base" && target.session && !target.entryId) {
			this.reset();
			this.contentEl.createEl("h2", { text: target.path.split("/").pop() ?? "Bases comments" });
			this.contentEl.createEl("p", { text: "Discussions belong to a saved view. Choose one to see its comments and drafts." });
			const choose = commentButton(this.contentEl, { text: "Choose discussion view" }); choose.onclick = () => this.host.chooseBaseView();
			return;
		}
		if (!target.session || !target.entryId || target.session.status === "closed") {
			this.reset(); this.session = undefined; this.entryId = undefined;
			this.contentEl.createEl("p", { text: target.message ?? "Sign in to use comments." });
			if (target.entryId) { const retry = commentButton(this.contentEl, { text: "Retry opening comments" }); retry.onclick = () => this.host.retry(); }
			return;
		}
		if (target.session !== this.session || target.entryId !== this.entryId) {
			this.reset(); this.session = target.session; this.entryId = target.entryId;
			this.contentEl.createEl("h2", { text: target.path.split("/").pop() ?? "Comments" });
			if (target.message) this.contentEl.createEl("p", { cls: "relay-comment-target-status", text: target.message });
			const toolbar = this.contentEl.createDiv({ cls: "relay-comment-toolbar" });
			const overflow = this.contentEl.createDiv(); overflow.hidden = true;
			const inbox = commentButton(toolbar, { text: "Comment inbox" }); inbox.onclick = () => { void this.host.openInbox(); };
			const storage = commentButton(overflow, { text: "Storage on this device" }); storage.onclick = () => { if (this.session) this.host.openCommentStorage(this.session); };
			this.exportButton = commentButton(overflow, { text: "Export discussions", attr: { type: "button" } });
			this.removedButton = commentButton(overflow, { text: "Review removed comments", attr: { type: "button" } });
			this.removedButton.onclick = () => {
				const session = this.session, scopeId = this.entryId;
				if (!session || !scopeId || !session.canReviewRemoved(scopeId)) return;
				this.removedModal?.close();
				this.removedModal = new RemovedCommentsModal(this.app, session, scopeId, () => !this.closed && this.host.current().session === session && this.host.current().entryId === scopeId);
				this.removedModal.open();
			};
			this.exportButton.onclick = () => {
				const session = this.session, scopeId = this.entryId;
				if (!session || !scopeId || !session.canExport || !session.permission(scopeId)?.read) return;
				this.exportModal?.close();
				this.exportModal = new DiscussionExportModal(this.app, session, scopeId,
					target.path + (target.kind === "base" ? " · " + target.baseViewName : ""), () => {
						const current = this.host.current();
						return !this.closed && current.session === session && current.entryId === scopeId;
					});
				this.exportModal.open();
			};

			const search = commentButton(toolbar, { text: "Search and filter comments", attr: { "aria-expanded": "false" } });
			const searchContainer = this.contentEl.createDiv();
			search.onclick = () => {
				if (this.search) { this.search.dispose(); this.search = undefined; }
				else if (this.session && this.entryId) this.search = new DiscussionSearchPanel(searchContainer, this.session, this.entryId, this.host);
				search.setAttribute("aria-expanded", String(!!this.search));
			};
			if (target.kind === "base") {
				this.contentEl.createEl("p", { cls: "relay-comment-base-view", text: "Discussion view: " + target.baseViewName });
				const choose = commentButton(this.contentEl, { text: "Change discussion view" }); choose.onclick = () => this.host.chooseBaseView();
			}
			this.status = this.contentEl.createDiv({ cls: "relay-comment-status", attr: { role: "status", "aria-live": "polite" } });
			this.moveSelection = this.contentEl.createDiv({ cls: "relay-comment-target-selection", attr: { role: "status", "aria-live": "polite" } });
			const refresh = commentButton(overflow, { text: "Refresh comments" }); refresh.onclick = () => { this.targetEpoch++; this.schedule(); void this.session?.refresh(); };
			this.pending = this.contentEl.createDiv({ cls: "relay-comment-pending" });
			this.pendingView = new PendingComments(this.pending, this.session, this.entryId, operation => this.host.openCommandRecovery(this.session!, operation));
			const more = commentButton(toolbar, { text: "More comment actions" });
            more.onclick = event => { const menu = new Menu();
                for (const button of [this.exportButton!, this.removedButton!, storage, refresh]) {
                    if (button.hidden) continue;
                    menu.addItem(item => item.setTitle(button === storage ? "Local drafts and recovery…" : button.textContent ?? "").setDisabled(button.disabled).onClick(() => button.click()));
                }
                menu.addItem(item => item.setTitle("Recover a saved draft at this location…").setDisabled(!this.drafts?.canRecoverSavedWork).onClick(() => this.drafts?.recoverSavedWork()));
                menu.showAtMouseEvent(event);
            };
            const filter = commentButton(toolbar, { text: "Filter comments", attr: { "aria-expanded": "false" } });
            toolbar.appendChild(more);
            const targetLabel = this.contentEl.createEl("label", { text: "Comment location " }); targetLabel.hidden = true;
            filter.onclick = () => { targetLabel.hidden = !targetLabel.hidden; filter.setAttribute("aria-expanded", String(!targetLabel.hidden)); };

			this.targetFilter = targetLabel.createEl("select", { attr: { "aria-label": "Filter comment targets" } });
			for (const [value, text] of [["all", "All comment locations"], ["review", "Location needs attention"], ["unanchored", "Original content removed"], ["unchecked", "Location not yet verified"]]) this.targetFilter.createEl("option", { text, attr: { value } });
			this.targetFilter.onchange = () => this.schedule();
			// Target counts are internal bookkeeping, not a live announcement.
			this.list = this.contentEl.createDiv({ cls: "relay-comment-thread-list" });
			const session = this.session, entryId = this.entryId;
			this.drafts = new DiscussionDrafts(this.contentEl, session, entryId, anchor => { void this.host.revealTarget(session, entryId, anchor); },
				target.kind === "image" ? () => this.host.commentCurrentImage(session, entryId) : undefined,
				target.kind === "base" ? () => this.host.commentCurrentBase(session, entryId) : undefined,
				target.kind === "base" ? anchor => this.host.targetLabel(session, entryId, anchor) : undefined,
				(anchor, active, current) => {
					this.copyModal?.close();
					this.copyModal = new SavedDraftCopyModal(this.app, session, entryId, anchor, active,
						() => !this.closed && this.session === session && this.entryId === entryId && current(), target.path + (target.baseViewName ? " · " + target.baseViewName : ""));
					this.copyModal.open();
				});
		}
		if (this.exportButton) this.exportButton.disabled = !this.session.canExport || !this.session.permission(this.entryId)?.read;
		if (this.removedButton) this.removedButton.hidden = !this.session.canReviewRemoved?.(this.entryId);
		this.removedModal?.validate();
		this.copyModal?.validate();
		this.exportModal?.validate();

		this.watch ??= this.session.watch(this.entryId, () => this.schedule(), target.kind ?? "note");
		this.targetWatch ??= this.host.watchTargetStatus(this.session, this.entryId, () => { this.targetEpoch++; this.schedule(); });
		this.contentEl.querySelector("h2")?.setText(target.path.split("/").pop() ?? "Comments");
		const targetStatus = this.contentEl.querySelector(".relay-comment-target-status");
		if (targetStatus) { targetStatus.setText(target.message ?? ""); (targetStatus as HTMLElement).hidden = !target.message; }
		else if (target.message) this.contentEl.querySelector("h2")?.insertAdjacentElement("afterend", this.contentEl.createEl("p", { cls: "relay-comment-target-status", text: target.message }));
		this.contentEl.querySelector(".relay-comment-base-view")?.setText("Discussion view: " + target.baseViewName);
		const session = this.session, entryId = this.entryId, generation = ++this.generation;
		if (this.moveSelection) {
			this.moveSelection.empty(); this.moveSelection.hidden = !this.host.choosingReattachment;
			if (this.host.choosingReattachment) {
				this.moveSelection.createEl("p", { text: this.host.selectingReattachment(session, entryId) ? (this.host.choosingCommandRecovery ? "Recovering a saved comment: choose text, blocks, an image or a Bases target using its comment action. You will review the draft before sending." : "Moving a discussion: choose text, blocks, an image or a Bases target using its comment action. You will review the move before saving.") : "A discussion target selection is active in another note or saved view. Return there or cancel the selection." });
				const cancel = commentButton(this.moveSelection, { text: "Cancel target selection" }); cancel.onclick = () => this.host.cancelReattachmentSelection();
			}
		}
		const permission = session.permission(entryId), sync = session.syncStatus(entryId);
		const statuses: Record<string, string> = { starting: "", ready: "", offline: "Offline — comments are saved to send when connected",
			unavailable: "Comments are not enabled on this server.", authentication_required: "Sign in again to continue.", error: "Comments need attention. Refresh to retry." };
		const statusText = sync === "unavailable" ? "You no longer have access to this file’s comments." : statuses[session.status] ?? "";
		this.status!.setText(statusText);
		this.status!.hidden = !statusText;
		this.drafts?.update();
		const canRead = !!permission?.read && session.status !== "authentication_required" && session.status !== "unavailable";
		if (this.targetFilter) this.targetFilter.disabled = !canRead;
		if (!canRead) {
			this.targetCheck = undefined; this.targetStatuses.clear();
			for (const card of this.cards.values()) card.dispose(); this.cards.clear(); this.list!.empty();
		}
		// Local authored work remains recoverable after read access is revoked;
		// only remote entities require the current note permission.
		const local = canRead ? await session.local(entryId, this.after, this.count) :
			{ threads: [], pending: await session.store.pending(entryId), hasMore: false, nextAfter: this.after };
		if (this.closed || generation !== this.generation || session.status === "closed") return;
		this.pendingView!.update(local.pending);
		if (!canRead || !session.permission(entryId)?.read || ["authentication_required", "unavailable"].includes(session.status)) return;
		const focus = this.host.focusedThread(session, entryId);
		if (focus && !local.threads.some(thread => thread.id === focus.threadId)) {
			const thread = await session.cachedThread(entryId, focus.threadId);
			if (this.closed || generation !== this.generation || !session.permission(entryId)?.read || ["authentication_required", "unavailable"].includes(session.status)) return;
			if (thread) local.threads.unshift(thread);
		}
		const current = () => !this.closed && generation === this.generation && session.status !== "closed" && session.permission(entryId)?.read === true && !["authentication_required", "unavailable"].includes(session.status);
		if (!current()) return;
		const targetStatuses = this.checkTargets(session, entryId, local.threads);
		if (focus && focus.serial !== this.focusedSerial && this.targetFilter) this.targetFilter.value = "all";
		const filter = this.targetFilter?.value ?? "all";
		const matches = (status: CommentTargetStatus) => filter === "all" || filter === "review" && targetNeedsReview(status) || filter === "unanchored" && status.state === "unanchored" || filter === "unchecked" && (status.state === "waiting" || status.state === "unknown");
		const retained = new Set(local.threads.map(thread => thread.id));
		for (const [id, card] of this.cards) if (!retained.has(id)) { card.dispose(); this.cards.delete(id); }
		for (const thread of local.threads) {
			let card = this.cards.get(thread.id);
			if (!card) { card = new ThreadCard(this.list!, this.app, session, entryId, thread, this.host); this.cards.set(thread.id, card); }
			const targetStatus = targetStatuses.get(thread.id) ?? uncheckedTarget();
			card.el.hidden = !matches(targetStatus);
			await card.update(thread, targetStatus);
			if (this.closed || generation !== this.generation) return;
			if (focus?.threadId === thread.id && focus.serial !== this.focusedSerial) {
				if (await card.focus(focus.messageId, focus.messageSequence, focus.notice, () => !this.closed && generation === this.generation)) this.focusedSerial = focus.serial;
			}
		}
		this.list!.querySelectorAll(".relay-comment-more").forEach(el => el.remove());
		if (local.hasMore) {
			const more = this.list!.createEl("button", { text: "Next discussions", cls: "relay-comment-more" });
			more.onclick = () => { this.pages.push(this.after); this.after = local.nextAfter; this.schedule(); };
		}
		if (this.pages.length) { const previous = this.list!.createEl("button", { text: "Previous discussions", cls: "relay-comment-more" });
			previous.onclick = () => { this.after = this.pages.pop() ?? 0; this.schedule(); }; }
	}
	private checkTargets(session: DiscussionSession, entryId: string, threads: AnchoredThread[]): Map<string, CommentTargetStatus> {
		const key = JSON.stringify([entryId, session.baseRegistryRevision(entryId), threads.map(thread => [thread.id, thread.anchor_revision, thread.anchor !== undefined])]);
		if (this.targetCheck?.key === key && this.targetCheck.epoch === this.targetEpoch) return this.targetStatuses;
		if (this.targetCheck?.key !== key) this.targetStatuses = new Map();
		const check = { key, epoch: this.targetEpoch, pending: true }; this.targetCheck = check;
		const current = () => !this.closed && this.session === session && this.entryId === entryId && this.targetCheck === check && check.epoch === this.targetEpoch &&
			session.status !== "closed" && !["authentication_required", "unavailable"].includes(session.status) && session.permission(entryId)?.read === true;
		void this.host.targetStatuses(session, entryId, threads, current).then(statuses => {
			if (!current()) return;
			this.targetStatuses = statuses;
		}).catch(() => { if (current()) this.targetStatuses = new Map(); }).finally(() => {
			if (current()) { check.pending = false; this.schedule(); }
		});
		return this.targetStatuses;
	}
	async onClose(): Promise<void> {
		this.closed = true; if (this.timer !== undefined) window.clearTimeout(this.timer);
		this.unsubscribe?.(); this.reset();
	}
}
