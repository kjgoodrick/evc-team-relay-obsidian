import { Modal, type App } from "obsidian";
import type { DiscussionSession } from "../DiscussionSession";
import { moderationReason, type ModerationCatalog, type ModerationHistory } from "../ModerationProtocol";
import { renderCommentBody } from "./CommentBody";

type Target = { threadId: string; messageId: string };
/** One explicit review, one page and one decoded picture. No ordinary cache,
 * automatic reads or background retries. Hidden/expired reviews release content. */
export class RemovedCommentsPanel {
	readonly el: HTMLElement;
	private reason: HTMLInputElement;
	private start: HTMLButtonElement;
	private status: HTMLElement;
	private content: HTMLElement;
	private controls: HTMLElement;
	private picture: HTMLElement;
	private serial = 0;
	private busy = false;
	private disposed = false;
	private url?: string;
	private timer?: number;
	private stopWatching: () => void;
	private visibility: () => void;
	private generation?: string;
	private win: Window & typeof window;
	constructor(parent: HTMLElement, private session: DiscussionSession, private scopeId: string,
		private available: () => boolean = () => true, private initialTarget?: Target) {
		this.el = parent.createEl("section", { cls: "relay-removed-comments", attr: { "aria-label": "Review removed comments" } });
		this.win = parent.ownerDocument.defaultView ?? window;
		this.el.createEl("p", { text: "Administrative review is online only. A reason is required and each page or picture read is audited. Content stays in this review and clears after two minutes, when hidden, or when access changes." });
		const form = this.el.createEl("form"), label = form.createEl("label", { text: "Reason for review " });
		this.reason = label.createEl("input", { attr: { type: "text", "aria-label": "Reason for review", autocomplete: "off", spellcheck: "false" } });
		this.start = form.createEl("button", { text: "Start review", attr: { type: "submit" } });
		form.onsubmit = event => { event.preventDefault(); this.begin(); };
		this.reason.oninput = () => { this.invalidate("Reason changed. Start a new review."); };
		this.status = this.el.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.controls = this.el.createDiv({ cls: "relay-comment-history-controls" });
		this.content = this.el.createDiv({ cls: "relay-comment-history-content" });
		this.picture = this.el.createDiv({ cls: "relay-comment-picture-frame" });
		this.generation = session.knownDocumentGeneration(scopeId);
		this.stopWatching = session.onChange(() => this.validate());
		this.visibility = () => this.validate(); parent.ownerDocument.addEventListener("visibilitychange", this.visibility);
		this.status.setText("Enter a reason to review retained removed content."); this.validate();
	}
	private allowed(): boolean { return !this.disposed && this.available() && !this.el.ownerDocument.hidden && this.session.canReviewRemoved(this.scopeId); }
	validate(): void {
		if (this.disposed) return;
		const generation = this.session.knownDocumentGeneration(this.scopeId);
		if (!this.allowed() || generation !== this.generation) this.invalidate("Review cleared. Reconnect with moderator access and start again.");
		this.generation = generation; this.start.disabled = this.busy || !this.allowed();
	}
	private clearPicture(): void {
		this.picture.empty();
		if (this.url) this.win.URL.revokeObjectURL(this.url); this.url = undefined;
	}
	private clear(): void {
		if (this.timer !== undefined) this.win.clearTimeout(this.timer); this.timer = undefined;
		this.clearPicture(); this.content.empty(); this.controls.empty();
	}
	private invalidate(message: string): void {
		this.serial++; this.clear(); this.status.setText(message); this.start.disabled = this.busy || !this.allowed();
	}
	private expire(deadline?: string): void {
		if (this.timer !== undefined) this.win.clearTimeout(this.timer);
		const delay = Math.min(120_000, deadline ? Math.max(0, Date.parse(deadline) - Date.now()) : 120_000);
		this.timer = this.win.setTimeout(() => this.invalidate("Review cleared. Start again to check current access and retention."), delay);
	}
	private begin(): void {
		if (this.busy || !this.allowed()) return;
		let reason: string;
		try { reason = moderationReason(this.scopeId, this.reason.value).reason; }
		catch { this.invalidate("Enter a plain-text reason of 1–512 characters."); return; }
		if (this.initialTarget) this.history(this.initialTarget, reason, 0);
		else this.catalog(reason, 0);
	}
	private button(label: string, action: () => void, disabled = false): HTMLButtonElement {
		const button = this.controls.createEl("button", { text: label, attr: { type: "button" } });
		button.disabled = disabled; button.onclick = action; return button;
	}
	private async read<T>(fetch: (current: () => boolean) => Promise<T>, show: (value: T, serial: number) => void): Promise<void> {
		if (this.busy || !this.allowed()) return;
		this.busy = true; const serial = ++this.serial;
		this.clear(); this.start.disabled = true; this.status.setText("Loading audited review…");
		const current = () => serial === this.serial && this.allowed();
		try {
			const value = await fetch(current);
			if (!current()) return;
			show(value, serial); this.content.tabIndex = -1; this.content.focus({ preventScroll: true });
		} catch {
			if (current()) this.invalidate("Review unavailable. Check access and retention, then start again. Each attempt may create an audit record.");
		} finally { this.busy = false; if (!this.disposed) this.start.disabled = !this.allowed(); }
	}
	private catalog(reason: string, after: number): void {
		void this.read(current => this.session.reviewRemovedCatalog(this.scopeId, reason, after, current), page => this.renderCatalog(page, reason));
	}
	private renderCatalog(page: ModerationCatalog, reason: string): void {
		this.status.setText(`Removed comments · Audit ${page.audit_id}`); this.expire();
		this.button("First page", () => this.catalog(reason, 0));
		this.button("Next page", () => this.catalog(reason, page.next_after), !page.has_more);
		if (!page.items.length) this.content.createEl("p", { text: page.has_more ? "No recoverable items on this page. Continue to check the next page." : "No recoverable removed comments on this page." });
		for (const item of page.items) {
			const article = this.content.createEl("article", { cls: "relay-comment-history" });
			article.createEl("h3", { text: item.thread_removed ? "Comment in a removed discussion" : "Removed comment" });
			article.createEl("p", { text: `${item.author_id ? this.session.displayName(this.scopeId, item.author_id) : "Former participant"} · Removed ${new Date(item.removed_at).toLocaleString()} · Retained until ${new Date(item.recoverable_until).toLocaleString()}` });
			const open = article.createEl("button", { text: "Review history", attr: { type: "button" } });
			open.onclick = () => this.history({ threadId: item.thread_id, messageId: item.message_id }, reason, 0);
		}
	}
	private history(target: Target, reason: string, after: number): void {
		void this.read(current => this.session.reviewRemovedHistory(this.scopeId, target.threadId, target.messageId, reason, after, current),
			(page, serial) => this.renderHistory(page, target, reason, serial));
	}
	private renderHistory(page: ModerationHistory, target: Target, reason: string, serial: number): void {
		this.status.setText(`Retained until ${new Date(page.recoverable_until).toLocaleString()} · Audit ${page.audit_id}`);
		this.expire(page.recoverable_until);
		this.button("Removed comments", () => this.catalog(reason, 0));
		this.button("First revisions", () => this.history(target, reason, 0));
		this.button("Next revisions", () => this.history(target, reason, page.next_after), !page.has_more);
		const jump = this.controls.createEl("form"), label = jump.createEl("label", { text: "Start at revision " });
		const input = label.createEl("input", { attr: { type: "number", min: "1", step: "1", "aria-label": "Start at revision" } });
		input.value = String(page.revisions[0]?.revision ?? 1); jump.createEl("button", { text: "Go to revision", attr: { type: "submit" } });
		jump.onsubmit = event => { event.preventDefault(); const n = Number(input.value); if (Number.isSafeInteger(n) && n > 0) this.history(target, reason, n - 1); };
		if (page.thread_removal_reason) this.content.createEl("p", { text: "Discussion removal reason: " + page.thread_removal_reason });
		if (!page.revisions.length) this.content.createEl("p", { text: "No retained revisions on this page." });
		for (const revision of page.revisions) {
			const article = this.content.createEl("article", { cls: "relay-comment-history" });
			article.createEl("h3", { text: `Revision ${revision.revision}` });
			article.createEl("p", { text: `${revision.actor_id ? this.session.displayName(this.scopeId, revision.actor_id) : "Former participant"} · ${new Date(revision.created_at).toLocaleString()}` });
			renderCommentBody(article, revision.body, id => this.session.displayName(this.scopeId, id), (parent, picture) => {
				const load = parent.createEl("button", { text: picture.alt ? "Review picture: " + picture.alt : "Review picture", attr: { type: "button" } });
				load.onclick = () => { void this.loadPicture(target, picture.picture_id, picture.alt ?? "Retained comment picture", reason, "thumbnail", serial); };
			});
			if (revision.reason) article.createEl("p", { text: "Reason: " + revision.reason });
		}
	}
	private async loadPicture(target: Target, pictureId: string, alt: string, reason: string, variant: "content" | "thumbnail", serial: number): Promise<void> {
		const current = () => serial === this.serial && this.allowed();
		if (this.busy || !current()) return;
		this.busy = true; this.start.disabled = true; this.clearPicture(); this.picture.setText("Loading audited picture…");
		try {
			const result = await this.session.reviewRemovedPicture(this.scopeId, target.threadId, target.messageId, pictureId, reason, variant, current);
			if (!current()) return;
			this.clearPicture(); this.url = this.win.URL.createObjectURL(new this.win.Blob([result.bytes], { type: result.mime }));
			const image = this.picture.createEl("img", { attr: { src: this.url, alt } });
			image.width = result.width; image.height = result.height;
			image.onerror = () => { if (current()) this.invalidate("This retained picture could not be displayed. Start again to retry."); };
			this.picture.createEl("p", { text: "Picture audit: " + result.audit_id });
			if (variant === "thumbnail") {
				const full = this.picture.createEl("button", { text: "Review full-size picture", attr: { type: "button" } });
				full.onclick = () => { void this.loadPicture(target, pictureId, alt, reason, "content", serial); };
			}
			this.picture.tabIndex = -1; this.picture.focus({ preventScroll: true });
		} catch { if (current()) this.invalidate("Picture review unavailable. Check access and retention, then start again."); }
		finally { this.busy = false; if (!this.disposed) this.start.disabled = !this.allowed(); }
	}
	dispose(): void {
		if (this.disposed) return; this.disposed = true; this.serial++; this.clear(); this.reason.value = "";
		this.stopWatching(); this.el.ownerDocument.removeEventListener("visibilitychange", this.visibility); this.el.remove();
	}
}

export class RemovedCommentsModal extends Modal {
	private panel?: RemovedCommentsPanel;
	constructor(app: App, private session: DiscussionSession, private scopeId: string, private available: () => boolean, private target?: Target) { super(app); }
	onOpen(): void {
		this.setTitle("Review removed comments");
		this.panel = new RemovedCommentsPanel(this.contentEl, this.session, this.scopeId, this.available, this.target);
	}
	validate(): void { if (!this.available() || this.session.status === "closed") this.close(); else this.panel?.validate(); }
	onClose(): void { this.panel?.dispose(); this.panel = undefined; this.contentEl.empty(); }
}
