import { Modal, type App } from "obsidian";
import { diffWordsWithSpace } from "diff";
import type { DiscussionSession } from "../DiscussionSession";
import type { HistoryRevision, HistoryWindow, MessageBody } from "../DiscussionProtocol";
import { CommentPicture } from "./CommentPicture";
import { commentBodyText, renderCommentBody } from "./CommentBody";

/** A bounded text comparison. Full structured revisions remain available when
 * large or highly divergent text exceeds the foreground comparison budget. */
export function historyTextChanges(before: MessageBody | null, after: MessageBody | null, name: (id: string) => string) {
	const oldText = before ? commentBodyText(before, name) : "";
	const newText = after ? commentBodyText(after, name) : "";
	if (oldText.length + newText.length > 24_000) return undefined;
	return diffWordsWithSpace(oldText, newText, { timeout: 20, maxEditLength: 500 });
}

/** Keeps only the selected revision and predecessor. No history is persisted;
 * navigation and refresh share one request, and hidden windows stop reading. */
export class CommentHistoryPanel {
	readonly el: HTMLElement;
	private status: HTMLElement;
	private controls: HTMLElement;
	private content: HTMLElement;
	private selected?: number;
	private current?: HistoryWindow;
	private rendered = "";
	private pictures: CommentPicture[] = [];
	private stopWatching: () => void;
	private disposed = false;
	private serial = 0;
	private busy = false;
	private queued?: { selected?: number; serial: number; focus: boolean };
	private checking = false;
	private checkAgain = false;
	private timer?: number;
	private win: Window;
	private visibility: () => void;
	constructor(parent: HTMLElement, private session: DiscussionSession, private scopeId: string, private threadId: string, private messageId: string) {
		this.el = parent.createEl("section", { cls: "relay-comment-history-panel", attr: { "aria-label": "Comment edit history" } });
		this.win = parent.ownerDocument.defaultView ?? window;
		this.status = this.el.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.controls = this.el.createDiv({ cls: "relay-comment-history-controls" });
		this.content = this.el.createDiv({ cls: "relay-comment-history-content" });
		this.stopWatching = session.onChange(() => this.availability());
		this.visibility = () => {
			if (this.el.ownerDocument.hidden) this.invalidate("History is paused while this window is hidden.");
			else this.load(this.selected);
		};
		this.el.ownerDocument.addEventListener("visibilitychange", this.visibility);
		this.load();
	}
	private allowed(): boolean { return !this.disposed && this.session.online && this.session.permission(this.scopeId)?.read === true && !this.el.ownerDocument.hidden; }
	private stopTimer(): void { if (this.timer !== undefined) this.win.clearTimeout(this.timer); this.timer = undefined; }
	private clearContent(): void {
		for (const picture of this.pictures) picture.dispose(); this.pictures = [];
		this.current = undefined; this.rendered = ""; this.controls.empty(); this.content.empty();
	}
	private unavailable(): string {
		return this.session.status === "closed" || this.session.status === "authentication_required" ? "Sign in again to view comment history." :
			!this.session.permission(this.scopeId)?.read ? "Access to this discussion changed." : "Reconnect to view comment history.";
	}
	private invalidate(message: string): void {
		this.serial++; this.queued = undefined; this.stopTimer(); this.clearContent(); this.status.setText(message);
		if (!this.disposed && this.session.status !== "closed") this.retry();
	}
	private retry(): void {
		const retry = this.controls.createEl("button", { text: "Refresh history", attr: { type: "button" } });
		retry.disabled = !this.allowed(); retry.onclick = () => this.load(this.selected, true);
	}
	private availability(): void {
		if (this.disposed) return;
		if (!this.allowed()) { this.invalidate(this.unavailable()); return; }
		if (!this.current) {
			for (const button of Array.from(this.controls.querySelectorAll("button"))) button.disabled = false;
			if (!this.busy) this.status.setText("Refresh to load comment history with current access.");
			return;
		}
		// A known removal must not remain visible until the next server poll.
		// Coalesce cache checks when several discussion events arrive together.
		this.checkAgain = true;
		if (!this.checking) void this.checkLocal();
	}
	private async checkLocal(): Promise<void> {
		this.checking = true;
		try {
			while (this.checkAgain && this.allowed() && this.current) {
				this.checkAgain = false;
				const serial = this.serial;
				const [thread, message] = await Promise.all([this.session.cachedThread(this.scopeId, this.threadId), this.session.cachedMessage(this.scopeId, this.threadId, this.messageId)]);
				if (!this.allowed() || serial !== this.serial || !this.current) continue;
				if (!thread || message?.deleted) {
					this.invalidate("This comment or its history is no longer available. Refresh to check access.");
				} else if (message && message.revision > this.current.latest) this.load(this.selected);
			}
		} catch { if (!this.disposed) this.invalidate("History could not be checked. Refresh to check access."); }
		finally { this.checking = false; }
	}
	private load(selected?: number, focus = false): void {
		if (!this.allowed()) { this.invalidate(this.unavailable()); return; }
		this.selected = selected; this.stopTimer(); const serial = ++this.serial;
		if (focus) this.clearContent();
		this.status.setText("Loading comment history…"); this.queued = { selected, serial, focus };
		if (!this.busy) void this.drain();
	}
	private async drain(): Promise<void> {
		if (this.busy || this.disposed) return;
		this.busy = true;
		try {
			while (this.queued && this.allowed()) {
				const work = this.queued; this.queued = undefined;
				try {
					const page = await this.session.historyWindow(this.scopeId, this.threadId, this.messageId, work.selected);
					if (!this.allowed() || work.serial !== this.serial) continue;
					this.render(page, work.focus);
					this.timer = this.win.setTimeout(() => { this.timer = undefined; this.load(this.selected); }, 15_000);
				} catch {
					if (!this.disposed && work.serial === this.serial) this.invalidate("History could not be loaded. Reconnect or check access, then refresh.");
				}
			}
		} finally { this.busy = false; }
	}
	private render(page: HistoryWindow, focus: boolean): void {
		this.status.setText(`Revision ${page.selected.revision} of ${page.latest}${page.selected.revision === page.latest ? " · Current revision" : ""}`);
		const key = JSON.stringify(page); if (key === this.rendered) return;
		const active = this.el.ownerDocument.activeElement;
		const oldInput = this.controls.querySelector("input");
		const inputValue = !focus && oldInput && active === oldInput ? oldInput.value : undefined;
		const buttonLabel = !focus && active?.tagName === "BUTTON" && this.controls.contains(active) ? active.textContent : undefined;
		const readingContent = !focus && !!active && this.content.contains(active);
		this.clearContent(); this.current = page; this.rendered = key;
		const button = (label: string, disabled: boolean, select?: number) => {
			const control = this.controls.createEl("button", { text: label, attr: { type: "button" } }); control.disabled = disabled;
			control.onclick = () => this.load(select, true);
		};
		button("Previous revision", page.selected.revision === 1, page.selected.revision - 1);
		button("Next revision", page.selected.revision === page.latest, page.selected.revision + 1);
		button("Latest revision", false);
		const jump = this.controls.createEl("form", { cls: "relay-comment-history-jump" });
		const label = jump.createEl("label", { text: "Revision" });
		const number = label.createEl("input", { attr: { type: "number", min: "1", max: String(page.latest), step: "1", "aria-label": "Revision number" } });
		number.value = inputValue ?? String(page.selected.revision);
		jump.createEl("button", { text: "Go to revision", attr: { type: "submit" } });
		jump.onsubmit = event => {
			event.preventDefault(); const value = Number(number.value);
			if (!Number.isSafeInteger(value) || value < 1 || value > page.latest) { this.status.setText(`Choose a revision from 1 to ${page.latest}.`); return; }
			this.load(value, true);
		};
		if (page.previous) this.comparison(page.previous.body, page.selected.body);
		else this.content.createEl("p", { text: "This is the original comment." });
		const revisions = this.content.createDiv({ cls: "relay-comment-history-revisions" });
		if (page.previous) this.revision(revisions, page.previous, "Previous revision");
		this.revision(revisions, page.selected, page.selected.revision === page.latest ? "Current revision" : "Selected revision");
		if (inputValue !== undefined) number.focus({ preventScroll: true });
		else if (buttonLabel) {
			const control = Array.from(this.controls.querySelectorAll("button")).find(item => item.textContent === buttonLabel);
			if (control && !control.disabled) control.focus({ preventScroll: true });
			else { this.content.tabIndex = -1; this.content.focus({ preventScroll: true }); }
		} else if (focus || readingContent) { this.content.tabIndex = -1; this.content.focus({ preventScroll: true }); }
	}
	private comparison(before: MessageBody | null, after: MessageBody | null): void {
		const section = this.content.createEl("section", { cls: "relay-comment-history-diff", attr: { "aria-label": "Text changes" } });
		section.createEl("h3", { text: "Text changes" });
		const changes = historyTextChanges(before, after, id => this.session.displayName(this.scopeId, id));
		if (!changes) section.createEl("p", { text: "This change is too large for an inline comparison. Both full revisions are shown below." });
		else if (!changes.some(change => change.added || change.removed)) section.createEl("p", { text: "No text changes. Compare the full revisions below for formatting, links, mentions or pictures." });
		else {
			section.createEl("p", { text: "Added text is underlined; removed text is struck through. Compare the full revisions below for formatting and pictures." });
			const diff = section.createDiv({ cls: "relay-comment-history-diff-text" });
			for (const change of changes) {
				const span = diff.createEl(change.added ? "ins" : change.removed ? "del" : "span", { text: change.value });
				if (change.added || change.removed) span.setAttribute("aria-label", (change.added ? "Added: " : "Removed: ") + change.value);
			}
		}
	}
	private revision(parent: HTMLElement, revision: HistoryRevision, label: string): void {
		const article = parent.createEl("article", { cls: "relay-comment-history" });
		article.createEl("h3", { text: `${label} · ${revision.revision}` });
		article.createEl("p", { text: `${revision.actor_id === this.session.identity.accountId ? "You" : this.session.displayName(this.scopeId, revision.actor_id)} · ${new Date(revision.created_at).toLocaleString()}` });
		renderCommentBody(article, revision.body, id => this.session.displayName(this.scopeId, id),
			(element, picture) => this.pictures.push(new CommentPicture(element, this.session, this.scopeId, picture)));
		if (revision.reason) article.createEl("p", { text: "Reason: " + revision.reason });
	}
	dispose(): void {
		if (this.disposed) return; this.disposed = true; this.serial++; this.queued = undefined; this.checkAgain = false;
		this.stopTimer(); this.stopWatching(); this.el.ownerDocument.removeEventListener("visibilitychange", this.visibility); this.clearContent(); this.el.remove();
	}
}

export class CommentHistoryModal extends Modal {
	private panel?: CommentHistoryPanel;
	private stopWatching?: () => void;
	constructor(app: App, private session: DiscussionSession, private scopeId: string, private threadId: string, private messageId: string) { super(app); }
	onOpen(): void {
		this.setTitle("Comment history");
		this.panel = new CommentHistoryPanel(this.contentEl, this.session, this.scopeId, this.threadId, this.messageId);
		this.stopWatching = this.session.onChange(() => { if (this.session.status === "closed") this.close(); });
	}
	onClose(): void { this.stopWatching?.(); this.stopWatching = undefined; this.panel?.dispose(); this.panel = undefined; this.contentEl.empty(); }
}
