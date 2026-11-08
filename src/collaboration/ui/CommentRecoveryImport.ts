import { Modal, type App } from "obsidian";
import type { DiscussionSession } from "../DiscussionSession";
import { inspectLocalWorkRecovery, type InspectedLocalWork, type LocalWorkImportIO } from "../LocalWorkImport";
import { recoveryDraftReview, type RecoveryDraftReview } from "../LocalDraftImport";
import { renderCommentBody } from "./CommentBody";
import { commentTargetDescription } from "./CommentTargetDescription";
import { CommentLocalWorkModal } from "./CommentLocalWork";

export function commentImportIO(app: App): LocalWorkImportIO {
	return { stat: path => app.vault.adapter.stat(path), read: path => app.vault.adapter.read(path), readBinary: path => app.vault.adapter.readBinary(path) };
}

/** Explicit, bounded review of a selected local directory. Opening the panel
 * reads no file. Only one selected draft can be copied by each explicit action. */
export class CommentRecoveryImportModal extends Modal {
	private live = true;
	private busy = false;
	private generation = 0;
	private page = 0;
	private stop?: () => void;
	private copy?: InspectedLocalWork;
	private path?: HTMLInputElement;
	private inspect?: HTMLButtonElement;
	private status?: HTMLElement;
	private results?: HTMLElement;
	private work?: CommentLocalWorkModal;
	constructor(app: App, private session: DiscussionSession, private context: () => boolean, private io: LocalWorkImportIO = commentImportIO(app)) { super(app); }
	private current = () => this.live && this.context() && this.session.status !== "closed";
	validate(): void { if (this.live && !this.current()) this.close(); else this.work?.validate(); }
	onOpen(): void {
		this.setTitle("Review a recovery copy");
		this.contentEl.createEl("p", { text: "Choose a completed local recovery folder in this vault. Review and restore ordinary drafts for the same account and shared folder. Waiting requests and unconfirmed actions stay in the source copy; their delivery must be checked separately." });
		const label = this.contentEl.createEl("label", { text: "Recovery folder path " });
		this.path = label.createEl("input", { attr: { type: "text", "aria-label": "Recovery folder path", placeholder: "Path relative to this vault", maxlength: "2048" } });
		this.path.oninput = () => { this.generation++; this.copy = undefined; this.results?.empty(); this.status?.setText(""); };
		this.inspect = this.contentEl.createEl("button", { text: "Inspect recovery copy", attr: { type: "button" } });
		this.inspect.onclick = () => { void this.inspectCopy(); };
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.results = this.contentEl.createDiv();
		const browse = this.contentEl.createEl("button", { text: "Browse restored drafts", attr: { type: "button" } });
		browse.onclick = () => { if (!this.current() || this.busy) return; this.work?.close(); this.work = new CommentLocalWorkModal(this.app, this.session, this.current); this.work.open(); };
		const close = this.contentEl.createEl("button", { text: "Close recovery review", attr: { type: "button" } }); close.onclick = () => this.close();
		this.stop = this.session.onChange(() => this.validate());
	}
	private controls(): void {
		if (this.path) this.path.disabled = this.busy;
		if (this.inspect) this.inspect.disabled = this.busy;
		for (const button of Array.from(this.results?.querySelectorAll("button") ?? [])) button.disabled = this.busy;
	}
	private async inspectCopy(): Promise<void> {
		if (!this.current() || this.busy) return;
		const generation = ++this.generation, current = () => this.current() && generation === this.generation;
		this.busy = true; this.copy = undefined; this.results?.empty(); this.controls(); this.status?.setText("Verifying recovery files…");
		try {
			const copy = await this.session.trackLocal(inspectLocalWorkRecovery(this.io, this.path!.value, current, text => { if (current()) this.status?.setText(text); }));
			if (!current()) return;
			this.copy = copy; this.page = 0; this.renderPage();
			this.status?.setText("Recovery files verified. Review a draft before restoring. Checksums do not establish delivery status.");
		} catch (error) { if (current()) this.status?.setText(error instanceof Error ? error.message : "This recovery copy could not be verified."); }
		finally { this.busy = false; if (this.current()) this.controls(); }
	}
	private renderPage(): void {
		if (!this.current() || !this.copy) return;
		const copy = this.copy, parent = this.results!; parent.empty();
		parent.createEl("p", { text: `Captured ${new Date(copy.snapshot.createdAt).toLocaleString()} · ${copy.snapshot.drafts.length} drafts · ${copy.snapshot.operations.length} waiting requests · ${copy.snapshot.pictures.length} originals` });
		parent.createEl("p", { text: `Source vault: ${copy.snapshot.identity.vaultId} · Server: ${copy.snapshot.identity.serverId}` });
		parent.createEl("p", { text: "Restored copies appear in saved comment work. To use one in a new discussion, open the destination's comments, select its target, then choose use saved work at this target. Review and send from the new draft's composer." });
		for (const draft of copy.snapshot.drafts.slice(this.page * 10, this.page * 10 + 10)) {
			const card = parent.createEl("section", { cls: "relay-comment-saved-work" });
			card.createEl("h3", { text: "Saved draft" });
			let review: RecoveryDraftReview;
			try { review = recoveryDraftReview(copy, draft.id, this.session.identity); }
			catch (error) { card.createEl("p", { text: error instanceof Error ? error.message : "This draft cannot yet be restored." }); continue; }
			card.createEl("p", { text: review.target ? commentTargetDescription(review.target).slice(0, 1000) : "Saved reply or note draft; review its discussion before sending." });
			if (review.body.rich) renderCommentBody(card, review.body.rich, () => "Member");
			else { card.createEl("p", { text: review.body.text.slice(0, 4000) || "Draft with no text." }); if (review.body.text.length > 4000) card.createEl("p", { text: "Text preview shortened. The complete text will be restored." }); }
			card.createEl("p", { text: `${review.originalPictures} original pictures will be copied. ${review.missingPictures} picture references have no original in this recovery copy. Picture previews are available after restore; shared pictures are not downloaded here.` });
			const restore = card.createEl("button", { text: "Restore as a local draft", attr: { type: "button" } });
			restore.onclick = () => { void this.restoreDraft(copy, draft.id); };
		}
		if (!copy.snapshot.drafts.length) parent.createEl("p", { text: "This copy contains no drafts. Waiting requests and actions cannot be restored from this panel yet." });
		parent.createEl("p", { text: `Page ${this.page + 1} of ${Math.max(1, Math.ceil(copy.snapshot.drafts.length / 10))}` });
		if (this.page > 0) { const previous = parent.createEl("button", { text: "Previous drafts", attr: { type: "button" } }); previous.onclick = () => { if (!this.busy) { this.page--; this.renderPage(); } }; }
		if ((this.page + 1) * 10 < copy.snapshot.drafts.length) { const next = parent.createEl("button", { text: "Next drafts", attr: { type: "button" } }); next.onclick = () => { if (!this.busy) { this.page++; this.renderPage(); } }; }
	}
	private async restoreDraft(copy: InspectedLocalWork, draftId: string): Promise<void> {
		if (!this.current() || this.busy || this.copy !== copy) return;
		const generation = this.generation, current = () => this.current() && generation === this.generation && this.copy === copy;
		this.busy = true; this.controls(); this.status?.setText("Rechecking the reviewed copy…");
		try {
			const result = await this.session.restoreLocalDraft(this.io, copy, draftId, current, text => { if (current()) this.status?.setText(text); });
			if (current()) this.status?.setText(result.created ? "Local draft restored with its original pictures. Open Saved comment work to edit or copy it. Nothing was sent." : "This draft was already restored. Its current local copy may have been edited or discarded; another copy was not created.");
		} catch (error) { if (current()) this.status?.setText(error instanceof Error ? error.message : "The local draft could not be restored. Inspect the recovery copy again."); }
		finally { this.busy = false; if (this.current()) this.controls(); }
	}
	onClose(): void { this.live = false; this.generation++; this.copy = undefined; this.stop?.(); this.stop = undefined; this.work?.close(); this.work = undefined; this.contentEl.empty(); }
}
