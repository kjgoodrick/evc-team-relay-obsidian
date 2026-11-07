import { Modal, type App } from "obsidian";
import type { DiscussionSession } from "../DiscussionSession";
import type { OutboxOperation } from "../storage/DiscussionStore";
import { isRecord, REACTIONS } from "../DiscussionProtocol";

/** Cancellation never creates an opposite reaction. If delivery won the race,
 * retain that posted reaction and explain how to change it deliberately. */
export class CancelReactionModal extends Modal {
	private live = true;
	private busy = false;
	private finished = false;
	private stop?: () => void;
	private status?: HTMLElement;
	private confirm?: HTMLButtonElement;
	private check?: HTMLInputElement;
	constructor(app: App, private session: DiscussionSession, private operation: OutboxOperation, private context: () => boolean) { super(app); }
	private current = () => this.live && this.context() && this.session.status !== "closed";
	validate(): void { if (this.live && !this.current()) this.close(); }
	onOpen(): void {
		if (!this.current() || this.operation.type !== "reaction.set") { this.close(); return; }
		this.setTitle("Cancel a saved reaction");
		const payload = this.operation.payload, emoji = isRecord(payload) && typeof payload.emoji === "string" ? REACTIONS[payload.emoji as keyof typeof REACTIONS] : undefined;
		this.contentEl.createEl("p", { text: `${isRecord(payload) && payload.present ? "Add" : "Remove"} reaction${emoji ? ": " + emoji : ""}` });
		this.contentEl.createEl("p", { text: "Cancel this saved change? An unsent local reaction can be cancelled offline. If delivery has started, a connection and comment permission are required to check it. An already-delivered reaction stays as posted; change it from the comment if needed." });
		const label = this.contentEl.createEl("label"); this.check = label.createEl("input", { attr: { type: "checkbox" } });
		label.createSpan({ text: " Cancel this pending reaction change after checking whether it was delivered." });
		this.check.onchange = () => { if (this.confirm) this.confirm.disabled = this.busy || this.finished || !this.check?.checked; };
		this.confirm = this.contentEl.createEl("button", { text: "Confirm cancellation", attr: { type: "button" } }); this.confirm.disabled = true;
		this.confirm.onclick = () => { void this.cancel(); };
		const close = this.contentEl.createEl("button", { text: "Close", attr: { type: "button" } }); close.onclick = () => this.close();
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.stop = this.session.onChange(() => this.validate());
	}
	private async cancel(): Promise<void> {
		if (!this.current() || this.busy || this.finished || !this.check?.checked) return;
		this.busy = true; this.confirm!.disabled = this.check.disabled = true; this.status?.setText("Checking the saved reaction…");
		try {
			const result = await this.session.cancelSavedReaction(this.operation, this.current);
			if (!this.current()) return;
			this.finished = true;
			this.status?.setText(result === "accepted" ? "This change was already delivered. Its posted reaction is unchanged. Open the comment to change it deliberately." : "Saved reaction change cancelled. No opposite reaction was sent.");
		} catch (error) {
			if (this.current()) this.status?.setText(`Cancellation is not confirmed. The saved change is retained for recovery. ${error instanceof Error ? error.message : "Reconnect and try again."}`);
		} finally { this.busy = false; if (this.current()) { this.confirm!.disabled = this.finished || !this.check?.checked; this.check!.disabled = this.finished; } }
	}
	onClose(): void { this.live = false; this.stop?.(); this.stop = undefined; this.contentEl.empty(); }
}
