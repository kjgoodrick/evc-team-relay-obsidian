import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { DiscussionHost } from "../DiscussionHost";
import type { DiscussionSession } from "../DiscussionSession";
import type { InboxItem } from "../InboxProtocol";
import { DiscussionFailure } from "../DiscussionTransport";

export const INBOX_VIEW = "team-relay-inbox";
type Filter = "unread" | "all" | "mentions" | "muted" | "dismissed";
type Row = { session: DiscussionSession; label: string; item: InboxItem };
function key(row: Row): string { return JSON.stringify([row.session.identity.serverId, row.session.identity.accountId, row.session.identity.shareId, row.item.thread_id]); }

/** Text-only notification references; message bodies use the ordinary discussion
 * surface after navigation and its permission checks. Opening never marks read. */
export class InboxView extends ItemView {
	private stop?: () => void;
	private filter: Filter = "unread";
	private shown = 100;
	private list?: HTMLElement;
	private status?: HTMLElement;
	private pending?: HTMLElement;
	private pages?: HTMLElement;
	private error?: HTMLElement;
	private closed = false;
	private cards = new Map<string, { el: HTMLElement; fingerprint: string }>();
	constructor(leaf: WorkspaceLeaf, private host: DiscussionHost) { super(leaf); }
	getViewType(): string { return INBOX_VIEW; }
	getDisplayText(): string { return "Comment inbox"; }
	getIcon(): string { return "inbox"; }
	async onOpen(): Promise<void> {
		this.contentEl.addClass("relay-inbox-view"); this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Comment inbox" });
		const toolbar = this.contentEl.createDiv({ cls: "relay-inbox-toolbar" });
		const select = toolbar.createEl("select", { attr: { "aria-label": "Filter notifications" } });
		for (const [value, label] of [["unread", "Unread"], ["all", "All"], ["mentions", "Mentions"], ["muted", "Muted"], ["dismissed", "Dismissed"]]) select.createEl("option", { attr: { value }, text: label });
		select.onchange = () => { this.filter = select.value as Filter; this.shown = 100; this.render(); };
		const refresh = toolbar.createEl("button", { text: "Refresh" });
		refresh.onclick = () => { for (const { session } of this.host.inboxSources()) void session.refresh(); };
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.error = this.contentEl.createDiv({ attr: { role: "alert" } });
		this.list = this.contentEl.createDiv({ cls: "relay-inbox-list", attr: { "aria-label": "Notifications" } });
		this.pages = this.contentEl.createDiv({ cls: "relay-inbox-pages" });
		this.pending = this.contentEl.createDiv({ cls: "relay-inbox-pending" });
		this.stop = this.host.onChange(() => this.render()); this.render();
		for (const { session } of this.host.inboxSources()) session.inbox.wake();
	}
	private accepts(item: InboxItem): boolean {
		if (this.filter === "dismissed") return item.dismissed_version >= item.version;
		if (item.dismissed_version >= item.version) return false;
		if (this.filter === "muted") return item.subscription.muted;
		if (item.subscription.muted) return false;
		return this.filter === "all" || this.filter === "mentions" && item.reason === "mention" || this.filter === "unread" && item.unread;
	}
	private action(button: HTMLButtonElement, work: () => Promise<unknown>): void {
		button.onclick = () => {
			button.disabled = true; this.error?.empty();
			void work().catch(error => { if (!this.closed) this.error?.setText(error instanceof DiscussionFailure ? "The discussion could not be reached. Reconnect and refresh the inbox." : error instanceof Error ? error.message : "The change could not be saved. Try again."); })
				.finally(() => { if (!this.closed) { button.disabled = false; this.render(); } });
		};
	}
	private render(): void {
		if (this.closed || !this.list || !this.status || !this.pending || !this.pages) return;
		const sources = this.host.inboxSources();
		const rows = sources.flatMap(source => source.session.inbox.items.filter(item => this.accepts(item)).map(item => ({ ...source, item })))
			.sort((a, b) => Date.parse(b.item.activity_at) - Date.parse(a.item.activity_at) || key(a).localeCompare(key(b)));
		const visible = rows.slice(0, this.shown), wanted = new Set(visible.map(key));
		for (const [id, card] of this.cards) if (!wanted.has(id)) { card.el.remove(); this.cards.delete(id); }
		const updating = sources.some(source => source.session.inbox.status === "refreshing");
		const offline = sources.some(source => source.session.inbox.status === "offline");
		const available = sources.filter(source => source.session.inbox.available);
		this.status.setText(!sources.length ? "Sign in to a shared folder to see its comment notifications." : !available.length ?
			"The inbox is unavailable. Check your connection, sign-in and server inbox setting." :
			(updating ? "Refreshing notifications… " : offline ? "Showing saved notifications. Changes will send when connected. " : "") +
			(visible.length ? `${visible.length} ${visible.length === 1 ? "notification" : "notifications"} shown.` : "No notifications in this filter."));
		let position = 0;
		for (const row of visible) {
			const { session, item } = row, id = key(row);
			const pending = session.inbox.pending.filter(op => op.threadId === item.thread_id);
			const fingerprint = JSON.stringify([item, row.label, pending, session.inbox.status]);
			let card = this.cards.get(id);
			if (!card) { card = { el: this.list.createEl("article", { cls: "relay-inbox-item" }), fingerprint: "" }; this.cards.set(id, card); }
			if (card.fingerprint !== fingerprint) {
				const focused = card.el.contains(card.el.ownerDocument.activeElement) ? (card.el.ownerDocument.activeElement as HTMLElement).dataset.inboxAction : undefined;
				card.el.empty(); card.fingerprint = fingerprint;
				card.el.classList.toggle("is-unread", item.unread);
				const open = card.el.createEl("button", { text: `${item.reason === "mention" ? "Mention" : "Reply"} in ${item.path}`, cls: "relay-inbox-open" });
				open.dataset.inboxAction = "open";
				this.action(open, () => this.host.openInboxItem(session, item));
				card.el.createEl("p", { text: row.label + " · " + new Date(item.activity_at).toLocaleString() + (item.kind === "base" ? " · Saved view discussion" : "") });
				const controls = card.el.createDiv({ cls: "relay-inbox-controls" });
				const read = controls.createEl("button", { text: item.unread ? "Mark read" : "Mark unread" }); read.dataset.inboxAction = "read";
				this.action(read, () => session.inbox.queue(item, { type: "state", seen_version: item.version, action: item.unread ? "read" : "unread" }));
				const dismiss = controls.createEl("button", { text: item.dismissed_version >= item.version ? "Restore unread" : "Dismiss" }); dismiss.dataset.inboxAction = "dismiss";
				this.action(dismiss, () => session.inbox.queue(item, { type: "state", seen_version: item.version, action: item.dismissed_version >= item.version ? "unread" : "dismiss" }));
				const follow = controls.createEl("button", { text: item.subscription.following ? "Unfollow" : "Follow" }); follow.dataset.inboxAction = "follow";
				this.action(follow, () => session.inbox.queue(item, { type: "subscription", expected_version: item.subscription.version, following: !item.subscription.following, muted: item.subscription.muted }));
				const mute = controls.createEl("button", { text: item.subscription.muted ? "Unmute" : "Mute" }); mute.dataset.inboxAction = "mute";
				this.action(mute, () => session.inbox.queue(item, { type: "subscription", expected_version: item.subscription.version, following: item.subscription.following, muted: !item.subscription.muted }));
				if (pending.length) card.el.createEl("p", { text: pending.some(op => op.state === "rejected") ? "A pending change needs review below." : "Change saved; waiting for server confirmation.", cls: "setting-item-description" });
				if (focused) card.el.querySelector<HTMLElement>(`[data-inbox-action="${focused}"]`)?.focus();
			}
			if (this.list.children[position] !== card.el) {
				const focused = card.el.contains(card.el.ownerDocument.activeElement) ? card.el.ownerDocument.activeElement as HTMLElement : undefined;
				this.list.insertBefore(card.el, this.list.children[position] ?? null); focused?.focus();
			}
			position++;
		}
		this.pages.empty();
		if (rows.length > visible.length) { const button = this.pages.createEl("button", { text: "Show more loaded notifications" }); button.onclick = () => { this.shown += 100; this.render(); }; }
		for (const source of available) if (source.session.inbox.viewingOlder) {
			this.pages.createEl("p", { text: source.label + ": viewing older notifications." });
			const button = this.pages.createEl("button", { text: "Latest notifications: " + source.label });
			button.disabled = source.session.inbox.status === "offline" || updating;
			this.action(button, () => source.session.inbox.latest());
		}
		for (const source of available) if (source.session.inbox.hasMore) {
			const button = this.pages.createEl("button", { text: "Load older: " + source.label });
			button.disabled = source.session.inbox.status === "offline" || updating;
			button.onclick = () => source.session.inbox.loadMore();
		}
		this.pending.empty();
		for (const source of sources) for (const op of source.session.inbox.pending) if (op.state === "rejected") {
			const line = this.pending.createDiv();
			line.createEl("p", { text: source.label + ": " + (op.error === "stale_subscription_version" ? "Preferences changed on another device. Review the current state before trying again." :
				["stale_inbox_version", "inbox_version_unavailable"].includes(op.error ?? "") ? "New activity arrived before this change. Review the notification before trying again." :
				"This inbox change could not be applied. Check discussion access and review the current state.") });
			const discard = line.createEl("button", { text: "Keep server state" }); this.action(discard, () => source.session.inbox.discard(op.id));
		}
	}
	async onClose(): Promise<void> { this.closed = true; this.stop?.(); this.cards.clear(); this.contentEl.empty(); }
}
