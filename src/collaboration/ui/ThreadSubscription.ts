import { commentButton } from "./CommentControls";
import type { DiscussionSession } from "../DiscussionSession";

/** Explicit following also works for readers who have never received a notice. */
export class ThreadSubscription {
	private stop?: () => void;
	private closed = false;
	private loaded = false;
	private error = "";
	private key = "";
	private el: HTMLElement;
	constructor(parent: HTMLElement, private session: DiscussionSession, private scopeId: string, private threadId: string) {
		this.el = parent.createDiv({ cls: "relay-inbox-controls" });
		this.stop = session.inbox?.onChange(() => this.render()); this.render();
	}
	private render(): void {
		if (this.closed) return;
		const inbox = this.session.inbox;
		if (!inbox?.available) { this.el.empty(); this.key = ""; return; }
		if (!this.loaded && this.session.online) { this.loaded = true; void this.load(); }
		const value = inbox.subscription(this.scopeId, this.threadId);
		const key = JSON.stringify([value, this.error, this.session.online]); if (key === this.key) return;
		this.key = key;
		const focused = this.el.contains(this.el.ownerDocument.activeElement) ? (this.el.ownerDocument.activeElement as HTMLElement).dataset.subscription : undefined;
		this.el.empty();
		if (!value) this.el.createEl("span", { text: this.session.online ? "Loading notification preferences…" : "Reconnect to load notification preferences." });
		else for (const [type, text] of [["follow", value.following ? "Unfollow discussion" : "Follow discussion"], ["mute", value.muted ? "Unmute discussion" : "Mute discussion"]]) {
			const button = commentButton(this.el, { text }); button.dataset.subscription = type;

			button.onclick = () => {
				button.disabled = true;
				void inbox.queueSubscription(this.scopeId, this.threadId, value, type === "follow" ? !value.following : value.following, type === "mute" ? !value.muted : value.muted)
					.catch(() => { this.error = "The preference could not be saved. Review pending changes in the comment inbox, then refresh."; })
					.finally(() => { if (!this.closed) { button.disabled = false; this.render(); } });
			};
		}
		if (this.error) {
			this.el.createEl("span", { text: this.error, attr: { role: "status" } });
			const retry = commentButton(this.el, { text: "Refresh preferences" }); retry.disabled = !this.session.online; retry.onclick = () => { void this.load(); };
		}
		if (focused) this.el.querySelector<HTMLElement>(`[data-subscription="${focused}"]`)?.focus();
	}
	private async load(): Promise<void> {
		try { await this.session.inbox.loadSubscription(this.scopeId, this.threadId); this.error = ""; }
		catch { this.error = "Notification preferences could not be refreshed. Saved preferences remain available while offline."; }
		this.render();
	}
	dispose(): void { this.closed = true; this.stop?.(); this.el.remove(); }
}
