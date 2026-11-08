import { Modal, type App } from "obsidian";
import type { DiscussionSession } from "../DiscussionSession";
import type { Draft, OutboxOperation } from "../storage/DiscussionStore";
import type { LocalDraftItem, WaitingCursor } from "../storage/LocalWorkPage";
import { isRecord, parseBody, REACTIONS } from "../DiscussionProtocol";
import { commentBodyText } from "./CommentBody";
import { readCommentDraft } from "./CommentDraft";
import { CancelReactionModal } from "./CancelReaction";
import { CommentComposer } from "./CommentComposer";
import { copyToClipboard } from "../../utils/clipboard";

const operationLabels: Record<OutboxOperation["type"], string> = {
	"thread.create": "New discussion", "reply.create": "Reply", "message.edit": "Comment edit",
	"reaction.set": "Reaction", "picture.upload": "Picture upload", "base.group.create": "Saved group target",
};
const stateLabels: Record<string, string> = { review: "Delivery reviewed", rejected: "Needs review", sending: "Delivery pending", queued: "Waiting to send" };
function draftText(draft: Draft): string {
	try { return readCommentDraft(draft.body).text; } catch { return "This draft could not be read. Save a recovery copy before changing it."; }
}
function operationText(operation: OutboxOperation): string {
	if (operation.type === "reaction.set" && isRecord(operation.payload)) {
		const emoji = REACTIONS[String(operation.payload.emoji) as keyof typeof REACTIONS];
		return `${operation.payload.present ? "Add" : "Remove"} reaction${emoji ? ": " + emoji : ""}`;
	}
	if (!isRecord(operation.payload) || operation.payload.body === undefined) return operationLabels[operation.type];
	try { return commentBodyText(parseBody(operation.payload.body), () => "Member"); }
	catch { return "This saved change could not be displayed. Save a recovery copy before changing it."; }
}

/** Own saved work is accessible without a surviving remote target. Never reads
 * shared discussion/people caches or retries a queued operation from this view. */
export class CommentLocalWorkModal extends Modal {
	private live = true;
	private generation = 0;
	private stop?: () => void;
	private composer?: CommentComposer;
	private reaction?: CancelReactionModal;
	private mode: "drafts" | "waiting" = "drafts";
	private draftPages: (string | undefined)[] = [undefined];
	private waitingPages: (WaitingCursor | undefined)[] = [undefined];
	private list?: HTMLElement;
	private status?: HTMLElement;
	private navigation?: HTMLElement;
	constructor(app: App, private session: DiscussionSession, private context: () => boolean) { super(app); }
	private accountCurrent = () => this.context() && this.session.status !== "closed";
	private current = () => this.live && this.accountCurrent();
	validate(): void { if (this.live && !this.current()) this.close(); else this.reaction?.validate(); }
	async onOpen(): Promise<void> {
		this.setTitle("Saved comment work");
		this.stop = this.session.onChange(() => { this.validate(); if (this.current()) this.composer?.update(); });
		await this.showList();
	}
	private async showList(): Promise<void> {
		if (!this.current()) return;
		const editor = this.composer;
		if (editor) {
			if (!await editor.flush()) { this.status?.setText("Some text could not be saved. Copy the text before closing this editor."); return; }
			if (!this.current() || this.composer !== editor) return;
			editor.dispose(); this.composer = undefined;
		}
		this.contentEl.empty();
		this.contentEl.createEl("p", { text: "Your local drafts and waiting changes for this shared folder. A note or saved view can be missing or inaccessible. Pages show current saved state; refresh after changes in another window." });
		const tabs = this.contentEl.createDiv({ attr: { role: "group", "aria-label": "Saved work type" } });
		for (const mode of ["drafts", "waiting"] as const) {
			const button = tabs.createEl("button", { text: mode === "drafts" ? "Drafts" : "Waiting changes", attr: { type: "button", "aria-pressed": String(this.mode === mode) } });
			button.onclick = () => { this.mode = mode; void this.showList(); };
		}
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.list = this.contentEl.createDiv(); this.navigation = this.contentEl.createDiv();
		const refresh = this.contentEl.createEl("button", { text: "Refresh saved work", attr: { type: "button" } });
		refresh.onclick = () => { this.draftPages = [undefined]; this.waitingPages = [undefined]; void this.showList(); };
		const close = this.contentEl.createEl("button", { text: "Close saved work", attr: { type: "button" } }); close.onclick = () => this.close();
		await this.loadPage();
	}
	private async loadPage(): Promise<void> {
		if (!this.current()) return;
		const generation = ++this.generation, mode = this.mode;
		this.status?.setText("Reading saved work…");
		try {
			if (mode === "drafts") {
				const page = await this.session.trackLocal(this.session.store.localDraftPage(this.draftPages[this.draftPages.length - 1]));
				if (!this.current() || generation !== this.generation) return;
				for (const item of page.items) this.renderDraft(item);
				this.paging(page.items.length, page.next, this.draftPages);
			} else {
				const page = await this.session.trackLocal(this.session.store.waitingWorkPage(this.waitingPages[this.waitingPages.length - 1]));
				if (!this.current() || generation !== this.generation) return;
				for (const operation of page.items) this.renderOperation(operation);
				this.paging(page.items.length, page.next, this.waitingPages);
			}
		} catch { if (this.current() && generation === this.generation) this.status?.setText("Saved work could not be read. Close this panel and try again; saved records are retained."); }
	}
	private paging<C>(count: number, next: C | undefined, pages: (C | undefined)[]): void {
		this.status?.setText(count ? `${count} items · page ${pages.length}` : "No saved items on this page.");
		const previous = this.navigation!.createEl("button", { text: "Previous page", attr: { type: "button" } }); previous.disabled = pages.length < 2;
		previous.onclick = () => { if (pages.length > 1) { pages.pop(); void this.showList(); } };
		const following = this.navigation!.createEl("button", { text: "Next page", attr: { type: "button" } }); following.disabled = next === undefined;
		following.onclick = () => { if (next !== undefined) { pages.push(next); void this.showList(); } };
	}
	private copy(parent: HTMLElement, text: () => string): void {
		const button = parent.createEl("button", { text: "Copy text", attr: { type: "button" } });
		button.onclick = () => {
			if (!this.current()) return;
			void copyToClipboard(text()).then(() => { if (this.current()) this.status?.setText("Text copied. Pictures and target details are included in a recovery copy, not in copied text."); })
				.catch(() => { if (this.current()) this.status?.setText("Could not copy. Select the text and use your device's copy action."); });
		};
	}
	private renderDraft(item: LocalDraftItem): void {
		const { draft } = item, card = this.list!.createEl("section", { cls: "relay-comment-saved-work" });
		card.createEl("h3", { text: item.pendingSend ? "Draft · delivery unconfirmed" : item.recovery ? "Recovered draft" : item.imported ? "Imported local draft" : "Saved draft" });
		card.createEl("p", { text: draftText(draft).slice(0, 1000) || "Draft with no text; it may contain pictures." });
		card.createEl("p", { text: `Saved revision ${draft.revision}` });
		if (item.pendingSend) card.createEl("p", { text: "Editing is locked until delivery is checked from the original discussion. Copy or export remains available." });
		if (item.recovery) card.createEl("p", { text: "Review the original discussion before sending. Discard requires review of dependent waiting work." });
		if (item.imported) card.createEl("p", { text: "Restored from a recovery copy. You can edit or copy it here. To create a discussion draft, open the destination's comments and choose use saved work at this target." });
		const open = card.createEl("button", { text: item.pendingSend ? "Inspect saved draft" : "Open saved draft", attr: { type: "button" } });
		open.onclick = () => { this.openDraft(draft); }; this.copy(card, () => draftText(draft));
	}
	private renderOperation(operation: OutboxOperation): void {
		const card = this.list!.createEl("section", { cls: "relay-comment-saved-work" });
		card.createEl("h3", { text: `${operationLabels[operation.type]} · ${stateLabels[operation.state]}` });
		card.createEl("p", { text: operationText(operation).slice(0, 1000) });
		card.createEl("p", { text: `Saved ${new Date(operation.createdAt).toLocaleString()} · ${operation.dependsOn.length} dependencies` });
		card.createEl("p", { text: operation.type === "reaction.set" ? "Cancellation checks delivery before retiring this change. It never sends an opposite reaction." : "This saved command is read-only here. Check delivery and review recovery from the original discussion before changing or sending it again." });
		if (operation.type === "reaction.set") {
			const cancel = card.createEl("button", { text: "Cancel saved reaction", attr: { type: "button" } });
			cancel.onclick = () => { if (!this.current()) return; this.reaction?.close(); this.reaction = new CancelReactionModal(this.app, this.session, operation, this.current); this.reaction.open(); };
		}
		this.copy(card, () => operationText(operation));
	}
	private openDraft(draft: Draft): void {
		if (!this.current() || this.composer) return;
		this.generation++; this.contentEl.empty();
		this.contentEl.createEl("p", { text: draft.id.startsWith("imported:") ? "Edit this imported draft on this device. Its captured target is retained for later review. To use it in a new discussion, open the destination's comments and choose Use saved work at this target. Only retained original pictures are shown here." : "Edit this saved draft on this device. Its saved target stays attached. To send it, review the target from the original discussion. Only retained original pictures are shown here; shared pictures are not downloaded. Unconfirmed sends remain locked." });
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		const back = this.contentEl.createEl("button", { text: "Back to saved work", attr: { type: "button" } }); back.onclick = () => { void this.showList(); };
		this.composer = new CommentComposer(this.contentEl, this.session, draft.scopeId, draft.id,
			() => { throw new Error("Review the original discussion before sending."); }, "Saved comment draft", "", () => { void this.showList(); }, { current: this.accountCurrent });
		this.composer.setEditingAvailable(this.current);
		this.copy(this.contentEl, () => this.composer?.textarea.value ?? "");
	}
	onClose(): void {
		this.live = false; this.reaction?.close(); this.reaction = undefined; this.generation++; this.stop?.(); this.stop = undefined;
		this.composer?.dispose(); this.composer = undefined; this.contentEl.empty();
	}
}
