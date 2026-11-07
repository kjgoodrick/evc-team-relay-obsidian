import type { DiscussionHost } from "../DiscussionHost";
import type { DiscussionSession } from "../DiscussionSession";
import { searchRequest, searchItemScope, type DiscussionSearchRequest, type DiscussionSearchPage } from "../DiscussionSearchProtocol";
import { DiscussionFailure } from "../DiscussionTransport";

/** Explicit search, bounded pages, one in-flight request, and no persisted
 * excerpts. Refresh only while visible; account changes dispose the panel. */
export class DiscussionSearchPanel {
	readonly el: HTMLElement;
	private form: HTMLFormElement;
	private query: HTMLInputElement;
	private scope: HTMLSelectElement;
	private state: HTMLSelectElement;
	private mine: HTMLInputElement;
	private mentions: HTMLInputElement;
	private submit: HTMLButtonElement;
	private status: HTMLElement;
	private results: HTMLElement;
	private pages: HTMLElement;
	private unsubscribe: () => void;
	private disposed = false;
	private serial = 0;
	private busy = false;
	private queued?: { request: DiscussionSearchRequest; serial: number; focus: boolean };
	private active?: DiscussionSearchRequest;
	private page?: DiscussionSearchPage;
	private history: (string | null)[] = [];
	private timer?: number;
	private rendered = "";
	private win: Window;
	private visibility: () => void;
	constructor(parent: HTMLElement, private session: DiscussionSession, private scopeId: string, private host: DiscussionHost) {
		this.el = parent.createEl("section", { cls: "relay-comment-search", attr: { "aria-label": "Comment search" } });
		this.win = parent.ownerDocument.defaultView ?? window;
		this.form = this.el.createEl("form", { cls: "relay-comment-search-form" });
		const queryLabel = this.form.createEl("label", { text: "Comment text" });
		this.query = queryLabel.createEl("input", { attr: { type: "search", placeholder: "Match all words", maxlength: "512" } });
		const scopeLabel = this.form.createEl("label", { text: "Search in" }); this.scope = scopeLabel.createEl("select");
		this.scope.createEl("option", { text: "Current note or saved view", attr: { value: "current" } }); this.scope.createEl("option", { text: "Shared folder", attr: { value: "share" } });
		const stateLabel = this.form.createEl("label", { text: "Discussion state" }); this.state = stateLabel.createEl("select");
		for (const [value, label] of [["all", "Open and resolved"], ["open", "Open"], ["resolved", "Resolved"]]) this.state.createEl("option", { text: label, attr: { value } });
		const filters = this.form.createDiv({ cls: "relay-comment-search-filters" });
		const mineLabel = filters.createEl("label", { text: "Written by me" }); this.mine = mineLabel.createEl("input", { attr: { type: "checkbox" } });
		const mentionLabel = filters.createEl("label", { text: "Mentions me" }); this.mentions = mentionLabel.createEl("input", { attr: { type: "checkbox" } });
		this.submit = this.form.createEl("button", { text: "Search comments", attr: { type: "submit" } });
		this.form.onsubmit = event => { event.preventDefault(); this.history = []; this.request(null, true); };
		this.form.oninput = () => this.invalidate("Filters changed. Search again to update the results.");
		this.form.onchange = () => this.invalidate("Filters changed. Search again to update the results.");
		this.status = this.el.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.results = this.el.createDiv({ cls: "relay-comment-search-results" });
		this.pages = this.el.createDiv({ cls: "relay-comment-search-pages" });
		this.unsubscribe = session.onChange(() => this.availability());
		this.visibility = () => { if (this.el.ownerDocument.hidden) this.invalidate("Search again when this window is visible."); else this.availability(); };
		this.el.ownerDocument.addEventListener("visibilitychange", this.visibility);
		this.availability();
	}
	private usable(): boolean { return !this.disposed && !this.el.ownerDocument.hidden && !!this.el.getClientRects().length && this.session.canSearch && this.session.permission(this.scopeId)?.read === true; }
	private availability(): void {
		if (this.disposed) return;
		this.submit.disabled = !this.usable();
		if (!this.usable()) this.invalidate(this.session.status === "authentication_required" ? "Sign in again to search comments." :
			!this.session.permission(this.scopeId)?.read ? "Access to this discussion changed." : !this.session.canSearch ?
				"Search requires a connection and server support. Cached discussions remain available offline." : "Search is paused while this panel is hidden.");
		else if (this.page?.items.some(item => this.session.permission(searchItemScope(item))?.read === false)) this.invalidate("Access changed. Search again for current results.");
		else if (!this.active && !this.busy) this.status.setText("Search current comment text, or leave it empty to filter discussions.");
	}
	private stopTimer(): void { if (this.timer !== undefined) this.win.clearTimeout(this.timer); this.timer = undefined; }
	private invalidate(message: string): void {
		this.serial++; this.queued = undefined; this.active = undefined; this.page = undefined; this.rendered = ""; this.stopTimer();
		this.results.empty(); this.pages.empty(); this.status.setText(message);
	}
	private request(cursor: string | null, focus = false): void {
		if (!this.usable()) { this.availability(); return; }
		let request: DiscussionSearchRequest;
		try { request = searchRequest({ query: this.query.value, state: this.state.value as DiscussionSearchRequest["state"], mine: this.mine.checked,
			mentions: this.mentions.checked, ...(this.scope.value === "current" ? { scopeId: this.scopeId } : {}), cursor, limit: 30 }); }
		catch { this.invalidate("Use up to 256 printable characters in your search."); return; }
		const serial = ++this.serial; this.stopTimer(); this.active = request;
		if (focus) { this.results.empty(); this.pages.empty(); this.rendered = ""; }
		this.status.setText("Searching comments…"); this.queued = { request, serial, focus };
		if (!this.busy) void this.drain();
	}
	private async drain(): Promise<void> {
		if (this.busy || this.disposed) return; this.busy = true;
		try {
			while (this.queued && this.usable()) {
				const work = this.queued; this.queued = undefined;
				try {
					const page = await this.session.search(work.request);
					if (!this.usable() || work.serial !== this.serial) continue;
					this.page = page; this.render(page, work.focus);
					this.timer = this.win.setTimeout(() => { this.timer = undefined; if (this.active && this.usable()) this.request(this.active.cursor); }, 15_000);
				} catch (error) {
					if (this.disposed || work.serial !== this.serial) continue;
					this.results.empty(); this.pages.empty(); this.rendered = ""; this.page = undefined; this.stopTimer();
					this.status.setText(error instanceof DiscussionFailure && error.code === "discussion_search_cursor_reset" ? "The search changed or expired. Search again from the beginning." :
						error instanceof DiscussionFailure && error.code === "invalid_search_query" ? "Use one to 32 words, or leave the text empty to filter discussions." :
						error instanceof DiscussionFailure && error.action === "authenticate" ? "Sign in again to search comments." : "Search could not be completed. Check your connection and access, then try again.");
				}
			}
		} finally { this.busy = false; }
	}
	private render(page: DiscussionSearchPage, focus: boolean): void {
		this.status.setText(page.items.length ? "Results from current comments. Updates are checked while this panel is visible." :
			page.next_cursor ? "No matches in this batch. Continue searching the remaining discussions." : "No matching comments on this page.");
		const key = JSON.stringify([page, this.history.length]); if (key === this.rendered) return; this.rendered = key;
		this.results.empty(); this.pages.empty();
		for (const item of page.items) {
			const article = this.results.createEl("article", { cls: "relay-comment-search-result" });
			article.createEl("p", { text: item.path + (item.kind === "base" ? " · Saved view" : "") + " · " + (item.thread.state === "resolved" ? "Resolved" : "Open") });
			article.createEl("p", { cls: "relay-comment-search-excerpt", text: item.excerpt || "Picture or mention comment" });
			const open = article.createEl("button", { text: "Open matching comment" });
			open.onclick = () => {
				open.disabled = true; this.stopTimer();
				void this.host.openSearchResult(this.session, item, () => !this.disposed && this.usable()).catch(error => {
					if (!this.disposed) { this.status.setText(error instanceof Error ? error.message : "This discussion could not be opened."); open.disabled = false; }
				});
			};
		}
		if (this.history.length) {
			const previous = this.pages.createEl("button", { text: "Previous results" });
			previous.onclick = () => { const cursor = this.history.pop() ?? null; this.request(cursor, true); };
		}
		if (page.next_cursor) {
			const next = this.pages.createEl("button", { text: page.items.length ? "Next results" : "Continue searching" });
			next.onclick = () => { this.history.push(this.active?.cursor ?? null); if (this.history.length > 50) this.history.shift(); this.request(page.next_cursor, true); };
		}
		if (focus) { this.results.tabIndex = -1; this.results.focus({ preventScroll: true }); }
	}
	dispose(): void {
		if (this.disposed) return; this.disposed = true; this.serial++; this.queued = undefined; this.active = undefined; this.page = undefined;
		this.stopTimer(); this.unsubscribe(); this.el.ownerDocument.removeEventListener("visibilitychange", this.visibility); this.el.remove();
	}
}
