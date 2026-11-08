import { Modal, type App } from "obsidian";
import type { AnchoredThread, DiscussionSession } from "../DiscussionSession";
import { DiscussionFailure, type OnlineOperation } from "../DiscussionTransport";
import { parseLocalDiscussionAnchor, type LocalDiscussionAnchor } from "../LocalDiscussionAnchor";
import { reattachmentAnchor, type AnchorHistoryPage } from "../ReattachmentProtocol";

export { commentTargetDescription } from "./CommentTargetDescription";

function failureMessage(error: unknown): string {
	if (error instanceof DiscussionFailure) {
		const messages: Record<string, string> = {
			stale_anchor_revision: "Someone moved this discussion. Check the outcome and cancel this request before choosing a new target.",
			reattach_readers_changed: "That target has different readers. Choose a target with the same underlying record or group access.",
			reattach_scope_changed: "Choose a target in the same note or saved Bases view.",
			reattach_target_unanchored: "The selected content changed before the move. Cancel this request and select the target again.",
		};
		return messages[error.code] ?? "The move was not confirmed. Retry sends the same request. Check its outcome before replacing it.";
	}
	return error instanceof Error ? error.message : "The move could not be confirmed.";
}

type Hooks = { current(): boolean; choose(thread: AnchoredThread): void; saved(): void; label(anchor: LocalDiscussionAnchor): string };

/** Every Save captures one immutable online intent. Closing never resends it;
 * reopening exposes the stored retry/withdrawal instead of overwriting it. */
export class ReattachCommentModal extends Modal {
	private live = true;
	private busy = false;
	private stop?: () => void;
	private operation?: OnlineOperation;
	private selectedTarget?: LocalDiscussionAnchor;
	private issue = "";
	private rendered?: readonly unknown[];
	constructor(app: App, private session: DiscussionSession, private scopeId: string, private thread: AnchoredThread, private hooks: Hooks, selected?: LocalDiscussionAnchor) {
		super(app); this.selectedTarget = selected ? parseLocalDiscussionAnchor(selected) : undefined;
	}
	private current = () => this.live && this.hooks.current() && this.session.permission(this.scopeId)?.read === true && this.session.status !== "closed";
	validate(): void { if (this.live && !this.current()) this.close(); }
	async onOpen(): Promise<void> {
		this.setTitle("Move discussion target");
		this.stop = this.session.onChange(() => { if (!this.current()) this.close(); else if (!this.busy) this.render(); });
		await this.load();
	}
	private async load(): Promise<void> {
		this.busy = true; this.render();
		try {
			const pending = await this.session.pendingReattachment(this.scopeId, this.thread.id);
			if (!this.current()) return;
			this.operation = pending;
			if (this.session.online) {
				const current = await this.session.linkedThread(this.scopeId, this.thread.id);
				if (!this.current()) return;
				if (!current || current.thread.removed) { this.close(); return; }
				// A selected target was reviewed against the captured revision.
				// Keep that expectation; a concurrent move must fail its CAS.
				if (!this.selectedTarget && !pending) this.thread = current.thread;
			}
		} catch (error) {
			if (error instanceof DiscussionFailure && (error.status === 403 || error.status === 404)) this.close();
			else this.issue = failureMessage(error);
		}
		finally { this.busy = false; if (this.current()) this.render(); }
	}
	private button(label: string, run: () => void, disabled = false): void {
		const button = this.contentEl.createEl("button", { text: label, attr: { type: "button" } });
		button.disabled = disabled || this.busy;
		button.onclick = () => { if (this.current() && !this.busy) run(); };
	}
	private render(): void {
		if (!this.live) return;
		const state = [this.busy, this.issue, this.thread, this.operation, this.selectedTarget,
			this.session.online, this.session.canReattach, this.session.permission(this.scopeId)?.comment];
		// Background sync notifications must not destroy a keyboard user's
		// focused button when the displayed move has not changed.
		if (this.rendered?.every((value, index) => value === state[index])) return;
		this.rendered = state;
		this.contentEl.empty();
		this.contentEl.createEl("p", { text: "The discussion, replies and resolved state stay together. Previous targets and the person who moved them remain in target history. The move must preserve access and stay in the same note or saved view." });
		if (this.thread.anchor) this.contentEl.createEl("p", { text: "Previous target: " + this.hooks.label(this.thread.anchor) });
		this.contentEl.createEl("p", { text: this.busy ? "Checking the discussion…" : this.issue, attr: { role: "status", "aria-live": "polite" } });
		const allowed = this.session.online && this.session.permission(this.scopeId)?.comment === true;
		if (this.operation) {
			this.contentEl.createEl("p", { text: "Unconfirmed target: " + this.hooks.label(reattachmentAnchor(this.operation)) });
			this.contentEl.createEl("p", { text: "Checking the outcome confirms an accepted move or cancels this exact request, including any delayed retry. It does not undo a move already accepted." });
			this.button("Retry move", () => { void this.save(); }, !allowed);
			this.button("Check outcome and cancel retry", () => { void this.recover(); }, !allowed);
		} else if (this.selectedTarget) {
			this.contentEl.createEl("p", { text: "New target: " + this.hooks.label(this.selectedTarget) });
			this.button("Move discussion", () => { void this.save(); }, !allowed || !this.session.canReattach);
		} else {
			this.button("Choose new target", () => { this.close(); this.hooks.choose(this.thread); }, !allowed || !this.session.canReattach);
			if (this.thread.anchor?.type !== "image_file") this.button(this.thread.anchor?.type === "base" ? "Use entire saved view" : "Use entire note", () => { void this.whole(); }, !allowed || !this.session.canReattach);
		}
		this.button("Refresh discussion", () => { this.issue = ""; void this.load(); }, !this.session.online);
		this.button("Close", () => this.close());
	}
	private async whole(): Promise<void> {
		this.busy = true; this.render();
		try { this.selectedTarget = this.thread.anchor?.type === "base" ? await this.session.captureBaseTarget(this.scopeId, { type: "view" }) : { version: 1, type: "note" }; }
		catch (error) { this.issue = failureMessage(error); }
		finally { this.busy = false; if (this.current()) this.render(); }
	}
	private async save(): Promise<void> {
		this.busy = true; this.render();
		try {
			if (!this.operation) {
				if (!this.selectedTarget) throw new Error("Choose a target first.");
				this.operation = await this.session.prepareReattachment(this.scopeId, this.thread.id, this.thread.anchor_revision, this.selectedTarget, this.current);
			}
			if (!this.current()) return;
			await this.session.sendReattachment(this.operation, this.current);
			if (this.current()) { this.hooks.saved(); this.close(); }
		} catch (error) { this.issue = failureMessage(error); }
		finally { this.busy = false; if (this.current()) this.render(); }
	}
	private async recover(): Promise<void> {
		if (!this.operation) return;
		this.busy = true; this.render();
		try {
			const outcome = await this.session.recoverReattachment(this.operation, this.current);
			if (!this.current()) return;
			this.operation = undefined; this.selectedTarget = undefined;
			if (outcome === "accepted") { this.hooks.saved(); this.close(); }
			else { this.issue = "The old request is cancelled. Checking the current target…"; await this.load();
				if (this.current() && this.issue === "The old request is cancelled. Checking the current target…") this.issue = "The old request is cancelled. Choose a new target.";
			}
		} catch (error) { this.issue = failureMessage(error); }
		finally { this.busy = false; if (this.current()) this.render(); }
	}
	onClose(): void { this.live = false; this.stop?.(); this.stop = undefined; this.contentEl.empty(); }
}

/** History is bounded to one page and kept in memory only. Losing live read
 * access clears historical quotes; returning requires an explicit refresh. */
export class TargetHistoryModal extends Modal {
	private live = true;
	private busy = false;
	private serial = 0;
	private stop?: () => void;
	private after = 0;
	private prior: number[] = [];
	private page?: AnchorHistoryPage;
	private issue = "";
	private timer?: number;
	private checking = false;
	constructor(app: App, private session: DiscussionSession, private scopeId: string, private threadId: string,
		private label: (anchor: LocalDiscussionAnchor) => string, private reveal: (anchor: LocalDiscussionAnchor) => void) { super(app); }
	private allowed = () => this.live && !this.contentEl.ownerDocument.hidden && this.session.online && this.session.permission(this.scopeId)?.read === true;
	private stopTimer(): void { if (this.timer !== undefined) this.contentEl.ownerDocument.defaultView!.clearTimeout(this.timer); this.timer = undefined; }
	private availability = (): void => {
		if (!this.allowed()) {
			this.serial++; this.stopTimer(); this.page = undefined; this.issue = "Reconnect with read access to view target history."; this.render();
		} else if (!this.busy) {
			this.render();
			if (this.page && !this.checking) void this.checkCached();
		}
	};
	private async checkCached(): Promise<void> {
		this.checking = true; const serial = this.serial;
		try {
			const current = await this.session.cachedThread(this.scopeId, this.threadId);
			if (!this.allowed() || serial !== this.serial) return;
			if (!current) { this.page = undefined; this.stopTimer(); this.issue = "The discussion is no longer available. Refresh to check access."; this.render(); }
			else if (current.anchor_revision !== this.page?.thread.anchor_revision) void this.load();
		} catch {
			if (this.allowed() && serial === this.serial) { this.page = undefined; this.stopTimer(); this.issue = "The discussion could not be checked. Refresh to check access."; this.render(); }
		} finally { this.checking = false; }
	}
	onOpen(): void {
		this.setTitle("Discussion target history");
		this.stop = this.session.onChange(this.availability);
		this.contentEl.ownerDocument.addEventListener("visibilitychange", this.availability);
		void this.load();
	}
	private async load(): Promise<void> {
		if (this.busy || !this.allowed()) { if (!this.allowed()) this.render("Reconnect with read access to view target history."); return; }
		this.stopTimer(); const serial = ++this.serial; this.busy = true; this.issue = ""; this.render("Loading target history…");
		try { const page = await this.session.anchorHistory(this.scopeId, this.threadId, this.after); if (this.allowed() && serial === this.serial) this.page = page; }
		catch { if (this.live && serial === this.serial) { this.page = undefined; this.issue = "Target history is unavailable. Refresh to check access."; } }
		finally {
			this.busy = false;
			if (this.allowed() && serial === this.serial) {
				this.render();
				if (this.page) this.timer = this.contentEl.ownerDocument.defaultView!.setTimeout(() => { this.timer = undefined; void this.load(); }, 15000);
			}
		}
	}
	private render(issue = ""): void {
		if (!this.live) return;
		this.contentEl.empty(); this.contentEl.createEl("p", { text: issue || this.issue, attr: { role: "status" } });
		if (this.allowed()) for (const revision of this.page?.revisions ?? []) {
			const row = this.contentEl.createEl("section");
			row.createEl("h3", { text: `Target revision ${revision.revision}${revision.revision === this.page?.thread.anchor_revision ? " · Current" : ""}` });
			row.createEl("p", { text: this.session.displayName(this.scopeId, revision.actor_id) + " · " + new Date(revision.created_at).toLocaleString() });
			row.createEl("p", { text: revision.anchor ? this.label(revision.anchor) : "This historical target is no longer available with your current access." });
			if (revision.anchor) { const anchor = revision.anchor; this.button(row, "Show saved target", () => this.reveal(anchor)); }
		}
		this.button(this.contentEl, "Previous page", () => { this.after = this.prior.pop() ?? 0; this.page = undefined; void this.load(); }, !this.prior.length);
		this.button(this.contentEl, "Next page", () => { this.prior.push(this.after); this.after = this.page!.next_after; this.page = undefined; void this.load(); }, !this.page?.has_more);
		this.button(this.contentEl, "Refresh target history", () => { void this.load(); });
	}
	private button(parent: HTMLElement, label: string, action: () => void, disabled = false): void {
		const button = parent.createEl("button", { text: label, attr: { type: "button" } });
		button.disabled = disabled || this.busy || !this.allowed(); button.onclick = () => { if (this.allowed() && !this.busy) action(); };
	}
	onClose(): void { this.live = false; this.serial++; this.stopTimer(); this.stop?.(); this.contentEl.ownerDocument.removeEventListener("visibilitychange", this.availability); this.page = undefined; this.contentEl.empty(); }
}
