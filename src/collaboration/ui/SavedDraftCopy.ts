import { Modal, type App } from "obsidian";
import { v4 as uuid } from "uuid";
import type { DiscussionSession } from "../DiscussionSession";
import type { LocalDiscussionAnchor } from "../LocalDiscussionAnchor";
import type { SavedDraftCopyReview } from "../SavedDraftCopy";
import { reviewedDraftBody } from "../SavedDraftReview";
import { commentTargetDescription } from "./CommentTargetDescription";
import { renderCommentBody } from "./CommentBody";

/** Choose own saved content for the already selected destination. This creates
 * a separate draft; the normal composer still owns any subsequent send. */
export class SavedDraftCopyModal extends Modal {
	private live = true;
	private busy = false;
	private generation = 0;
	private pages: (string | undefined)[] = [undefined];
	private stop?: () => void;
	private status?: HTMLElement;
	private body?: HTMLElement;
	private documentGeneration: string | undefined;
	constructor(app: App, private session: DiscussionSession, private scopeId: string, private target: LocalDiscussionAnchor,
		private activeDraft: string | undefined, private context: () => boolean, private destinationLabel: string) {
		super(app); this.documentGeneration = session.knownDocumentGeneration(scopeId);
	}
	private current = () => this.live && this.context() && this.session.canCopySavedDraft(this.scopeId, this.target) && this.session.knownDocumentGeneration(this.scopeId) === this.documentGeneration;
	validate(): void { if (this.live && !this.current()) this.close(); }
	async onOpen(): Promise<void> {
		if (!this.current()) { this.close(); return; }
		this.setTitle("Use saved work at this target");
		this.contentEl.createEl("p", { text: this.destinationLabel });
		this.contentEl.createEl("p", { text: commentTargetDescription(this.target).slice(0, 1000) });
		this.contentEl.createEl("p", { text: "Choose a saved draft from this shared folder to copy into a new discussion draft at this target. Its source stays saved. Review and send the new draft from the comment composer." });
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } }); this.body = this.contentEl.createDiv();
		const close = this.contentEl.createEl("button", { text: "Cancel copy", attr: { type: "button" } }); close.onclick = () => this.close();
		this.stop = this.session.onChange(() => this.validate()); await this.showPage();
	}
	private controls(): void { for (const control of Array.from(this.body?.querySelectorAll<HTMLInputElement | HTMLButtonElement>("button, input") ?? [])) control.disabled = this.busy; }
	private async showPage(): Promise<void> {
		if (!this.current() || this.busy) return;
		const generation = ++this.generation; this.busy = true; this.body?.empty(); this.status?.setText("Reading saved drafts…");
		try {
			const page = await this.session.trackLocal(this.session.store.localDraftPage(this.pages[this.pages.length - 1]));
			if (!this.current() || generation !== this.generation) return;
			for (const item of page.items) {
				const card = this.body!.createEl("section", { cls: "relay-comment-saved-work" });
				card.createEl("h3", { text: item.imported ? "Imported draft" : "Saved draft" });
				if (item.pendingSend || item.recovery || item.draft.id.startsWith("recovery:")) { card.createEl("p", { text: "Check this saved request's delivery before copying it." }); continue; }
				try { card.createEl("p", { text: reviewedDraftBody(item.draft.body).text.slice(0, 200) || "Draft with no text." }); }
				catch { card.createEl("p", { text: "This saved format needs review in a recovery copy." }); continue; }
				const review = card.createEl("button", { text: "Review this draft", attr: { type: "button" } }); review.onclick = () => { void this.review(item.draft.id); };
			}
			this.status?.setText(page.items.length ? `Page ${this.pages.length} · ${page.items.length} drafts` : "No saved drafts on this page.");
			if (this.pages.length > 1) { const back = this.body!.createEl("button", { text: "Previous drafts", attr: { type: "button" } }); back.onclick = () => { if (!this.busy) { this.pages.pop(); void this.showPage(); } }; }
			if (page.next) { const next = this.body!.createEl("button", { text: "More drafts", attr: { type: "button" } }); next.onclick = () => { if (!this.busy) { this.pages.push(page.next); void this.showPage(); } }; }
		} catch { if (this.current()) this.status?.setText("Saved drafts could not be read. Close this panel and try again."); }
		finally { this.busy = false; if (this.current()) this.controls(); }
	}
	private async review(id: string): Promise<void> {
		if (!this.current() || this.busy) return;
		const generation = ++this.generation, current = () => this.current() && generation === this.generation;
		let restoreControls: (() => void) | undefined;
		this.busy = true; this.controls();
		try {
			const review = await this.session.reviewSavedDraftCopy(id, this.scopeId, this.target, this.activeDraft, current);
			if (!current()) return;
			this.body!.empty(); const body = reviewedDraftBody(review.source.body);
			if (body.rich) renderCommentBody(this.body!, body.rich, () => "Member"); else this.body!.createEl("p", { text: body.text.slice(0, 8000) || "Draft with no text." });
			if (!body.rich && body.text.length > 8000) this.body!.createEl("p", { text: "Preview shortened. The complete text will be copied." });
			this.body!.createEl("p", { text: `${review.originals.length} retained originals will be copied. This creates a new discussion draft, including when the saved content began as a reply or edit.` });
			if (review.source.id.startsWith("restored:")) this.body!.createEl("p", { text: "This copy comes from a request saved before the service was restored. Check the current discussion and any saved receipt before sending; creating a new discussion may duplicate an earlier change." });
			let omit: HTMLInputElement | undefined;
			const required = review.source.scopeId !== review.destinationScope && review.missingOriginals.length > 0;
			if (review.missingOriginals.length) {
				this.body!.createEl("p", { text: `${review.missingOriginals.length} picture references have no retained original.${required ? " They must be omitted to copy to this target." : " They can stay as references in this same discussion scope."}` });
				const label = this.body!.createEl("label"); omit = label.createEl("input", { attr: { type: "checkbox" } }); label.createSpan({ text: " Leave out pictures without retained originals" });
			}
			const destinationId = "selection:" + this.scopeId + ":" + uuid();
			const copy = this.body!.createEl("button", { text: "Create discussion draft", attr: { type: "button" } });
			const enabled = () => { copy.disabled = this.busy || required && !omit?.checked; };
			restoreControls = enabled;
			if (omit) omit.onchange = enabled;
			copy.onclick = () => { if (!required || omit?.checked) void this.apply(review, destinationId, !!omit?.checked, current, enabled); };
			const back = this.body!.createEl("button", { text: "Choose another draft", attr: { type: "button" } }); back.onclick = () => { void this.showPage(); };
			this.status?.setText("Review this content and the destination above before creating the new draft.");
			this.busy = false; enabled();
		} catch (error) { if (current()) this.status?.setText(error instanceof Error ? error.message : "This saved draft could not be reviewed."); }
		finally { this.busy = false; if (current()) { this.controls(); restoreControls?.(); } }
	}
	private async apply(review: SavedDraftCopyReview, id: string, omit: boolean, current: () => boolean, enabled: () => void): Promise<void> {
		if (!current() || this.busy) return;
		this.busy = true; this.controls(); this.status?.setText("Creating the discussion draft…");
		try { await this.session.copySavedDraft(review, id, omit, current); if (this.live) this.close(); }
		catch (error) { if (current()) this.status?.setText(error instanceof Error ? error.message : "The draft could not be copied. The source stays saved."); }
		finally { this.busy = false; if (this.current()) { this.controls(); enabled(); } }
	}
	onClose(): void { this.live = false; this.generation++; this.stop?.(); this.stop = undefined; this.contentEl.empty(); }
}
