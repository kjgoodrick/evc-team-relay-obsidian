import type { DiscussionSession } from "../DiscussionSession";
import { isRecord, parseBody, REACTIONS } from "../DiscussionProtocol";
import type { OutboxOperation } from "../storage/DiscussionStore";
import { commentBodyText, renderCommentBody } from "./CommentBody";
import { commandPictures } from "../storage/PictureRecords";

const failureHelp: Record<string, string> = {
	anchor_generation_mismatch: "This note was rebuilt or restored. Review and reattach this comment before sending.",
	invalid_anchor: "The saved selection could not be validated. Keep your text and select a new target.",
	comment_forbidden: "Comment permission was denied. Restore access before retrying.",
	target_unavailable: "The note or discussion could not be reached. Sync the note or restore access before retrying.",
	stale_message_revision: "This comment changed elsewhere. Review the current version before editing again.",
	author_required: "Only the comment’s author can make this change.",
	mention_unavailable: "A mentioned member no longer has access to this note.",
	too_many_mentions: "This comment contains too many mentions.",
	command_too_large: "This comment exceeds the server’s size limit.",
	invalid_command: "The server could not accept this comment’s format.",
	operation_id_conflict: "The server could not confirm this saved request. Keep your text and contact support.",
	identifier_unavailable: "This comment’s target could not be used. Keep your text and review the discussion.",
	pictures_disabled: "Pictures are disabled on this server. The picture and comment remain saved here.",
	picture_expired: "The picture upload expired. Its original bytes remain saved here for recovery.",
	operation_withdrawn: "The original send was retired during recovery. Refresh picture uploads to finish restoring this saved comment.",
	picture_staging_quota: "The server’s pending-picture allowance is full. Your picture remains saved here.",
	picture_too_many_pixels: "This picture exceeds 20 million pixels. Keep the original and choose a smaller copy.",
	picture_output_too_large: "The processed picture is too large. Keep the original and choose a smaller copy.",
	invalid_picture: "This file could not be decoded as a supported picture. Its original bytes remain saved here.",
	animated_picture_unsupported: "Animated pictures are not supported by this server yet. The original remains saved here.",
	picture_source_unavailable: "The saved picture bytes could not be found. The comment is kept for recovery.",
	picture_digest_mismatch: "The picture does not match its saved identity. The original command is kept for recovery.",
};

/** Keyed cards preserve text selection while incoming polling refreshes the
 * sidebar. A replacement requires definitive server withdrawal of the original.
 */
export class PendingComments {
	private cards = new Map<string, { el: HTMLElement; signature: string }>();
	private heading: HTMLElement;
	private limit: HTMLElement;
	private disposed = false;
	constructor(private parent: HTMLElement, private session: DiscussionSession, private entryId: string) {
		this.heading = parent.createEl("h3", { text: "Saved on this device" });
		this.limit = parent.createEl("p", { cls: "relay-comment-muted" });
	}
	update(operations: OutboxOperation[]): void {
		if (this.disposed) return;
		this.heading.hidden = operations.length === 0;
		this.limit.hidden = operations.length < 100;
		this.limit.setText("Showing the first 100 pending changes. More appear as these are confirmed.");
		const ids = new Set(operations.map(op => op.operationId));
		for (const [id, card] of this.cards) if (!ids.has(id)) { card.el.remove(); this.cards.delete(id); }
		for (const op of operations) {
			const canRetry = this.session.online && !!this.session.permission(this.entryId)?.comment;
			const signature = JSON.stringify([op, canRetry, this.session.canRepairPictures, this.session.participants(this.entryId)]);
			let card = this.cards.get(op.operationId);
			if (!card) {
				card = { el: this.parent.createDiv({ cls: "relay-comment-pending-item" }), signature: "" };
				this.cards.set(op.operationId, card);
			}
			if (signature === card.signature) continue;
			card.signature = signature; card.el.empty();
			this.render(card.el, op, canRetry);
		}
	}
	private render(box: HTMLElement, op: OutboxOperation, canRetry: boolean): void {
		// A rejected retry may follow an accepted request whose acknowledgment was
		// lost. Do not promise "not sent" or offer a fresh-ID resubmission here.
		box.createEl("p", { text: op.state === "rejected" ? "Delivery needs review — your saved work is kept on this device" :
			op.dependsOn.length ? "Waiting for an earlier saved change to be confirmed…" : "Waiting for delivery confirmation…" });
		const payload = op.payload;
		if (isRecord(payload) && op.type === "picture.upload") {
			box.createEl("p", { text: "Picture upload" + (typeof payload.size === "number" ? ` · ${Math.ceil(payload.size / 1024)} KiB` : "") });
		} else if (isRecord(payload) && op.type === "reaction.set") {
			const emoji = typeof payload.emoji === "string" ? REACTIONS[payload.emoji as keyof typeof REACTIONS] : undefined;
			box.createEl("p", { text: `${payload.present ? "Add" : "Remove"} reaction${emoji ? ": " + emoji : ""}` });
		} else if (isRecord(payload)) {
			try {
				const body = parseBody(payload.body), name = (id: string) => this.session.displayName(this.entryId, id);
				renderCommentBody(box, body, name);
				const select = box.createEl("button", { text: "Select text to copy", attr: { type: "button" } });
				const text = box.createEl("textarea", { cls: "relay-comment-recovery-text", attr: { rows: "5", readonly: "", "aria-label": "Saved comment text" } });
				text.hidden = true; text.value = commentBodyText(body, name);
				select.onclick = () => { text.hidden = false; text.focus(); text.select(); };
			} catch { box.createEl("p", { text: "Saved local change could not be displayed. Its original data is still kept on this device." }); }
		}
		let hasPictures = false;
		try { hasPictures = op.type !== "picture.upload" && commandPictures(payload).length > 0; } catch { /* Keep malformed saved work for manual recovery. */ }
		if (hasPictures) {
			const repair = box.createEl("button", { text: "Refresh picture uploads and retry", attr: { type: "button" } });
			repair.disabled = !canRetry || !this.session.canRepairPictures;
			box.createEl("p", { cls: "relay-comment-muted", text: "Keeps your saved text, pictures and target. Checks delivery before retrying to avoid a duplicate comment." });
			const status = box.createDiv({ attr: { role: "status" } });
			repair.onclick = () => {
				repair.disabled = true;
				void this.session.repairPictures(op).then(result => {
					if (!this.disposed) status.setText(result === "accepted" ? "The original comment was already delivered." : "Pictures refreshed. Your saved comment is queued again.");
				}).catch(() => {
					if (!this.disposed) { status.setText("Recovery could not finish. Your saved work is retained. Reconnect and try again; delivery will be checked first."); repair.disabled = !this.session.canRepairPictures || !this.session.permission(this.entryId)?.comment; }
				});
			};
		}
		if (op.state !== "rejected") return;
		box.createEl("p", { text: failureHelp[op.error ?? ""] ?? "The server has not confirmed this change. Check your connection and access to this note." });
		box.createEl("p", { cls: "relay-comment-muted", text: "Retry checks the original request without creating a second comment. If you copy it into a new comment, check the discussion first to avoid duplicates." });
		const retry = box.createEl("button", { text: "Retry original request", attr: { type: "button" } });
		retry.disabled = !canRetry;
		if (!canRetry) box.createEl("p", { cls: "relay-comment-muted", text: "Reconnect with comment permission to retry. You can still select and copy your saved text." });
		const status = box.createDiv({ attr: { role: "status" } });
		retry.onclick = () => {
			retry.disabled = true;
			void this.session.retryRejected(op).then(retried => {
				if (!this.disposed) status.setText(retried ? "Saved for retry" : "This saved change has already been updated. Refresh comments to see its status.");
			}).catch(() => {
				if (!this.disposed) { status.setText("Could not retry. Your saved text is unchanged. Reconnect or refresh permissions and try again."); retry.disabled = !this.session.online || !this.session.permission(this.entryId)?.comment; }
			});
		};
	}
	dispose(): void { this.disposed = true; this.cards.clear(); this.parent.empty(); }
}
