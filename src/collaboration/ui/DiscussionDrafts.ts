import { v4 as uuid } from "uuid";
import { parseAnchor, protocolJson, type DiscussionAnchor } from "../DiscussionProtocol";
import type { DiscussionSession } from "../DiscussionSession";
import { CommentComposer } from "./CommentComposer";

/** Durable new-thread drafts, with a separate identity for every captured target.
 * Switching drafts never changes an anchor and never discards unsent text. */
export class DiscussionDrafts {
	private select: HTMLSelectElement;
	private controls: HTMLElement;
	private editor: HTMLElement;
	private status: HTMLElement;
	private composer?: CommentComposer;
	private currentId = "";
	private after?: string;
	private pages: (string | undefined)[] = [];
	private closed = false;
	private refreshing?: Promise<void>;
	private again = false;
	private changing = false;
	private navigation = 0;
	constructor(parent: HTMLElement, private session: DiscussionSession, private entryId: string,
		private reveal: (anchor: DiscussionAnchor) => void) {
		this.controls = parent.createDiv({ cls: "relay-comment-drafts" });
		this.select = this.controls.createEl("select", { attr: { "aria-label": "Discussion draft" } });
		this.select.onchange = () => { void this.choose(this.select.value); };
		this.status = parent.createDiv({ attr: { role: "status" } });
		this.editor = parent.createDiv();
		this.update();
	}
	private get key(): string { return "activeNewDraft:" + this.entryId; }
	private get wholeNoteId(): string { return "new:" + this.entryId; }
	private async choose(id: string): Promise<void> {
		if (this.closed || this.changing) return;
		this.changing = true; this.navigation++; this.select.disabled = true;
		try {
			if (this.composer && !await this.composer.flush()) throw new Error("Draft needs review");
			if (this.closed) return;
			await this.session.trackLocal(this.session.store.setPreference(this.key, id));
		} catch { if (!this.closed) { this.status.setText("Could not switch drafts. Copy any unsaved text before reopening comments."); this.select.value = this.currentId; } }
		finally { this.changing = false; this.select.disabled = false; this.update(); }
	}
	private async activate(id: string, navigation: number): Promise<void> {
		if (this.closed || id === this.currentId) return;
		if (this.composer && !await this.composer.flush()) throw new Error("Draft needs review");
		if (this.closed || navigation !== this.navigation || this.changing) return;
		this.composer?.dispose(); this.currentId = id;
		this.composer = new CommentComposer(this.editor, this.session, this.entryId, id,
			(body, anchor) => ({ type: "thread.create", payload: { type: "thread.create", thread_id: uuid(), message_id: uuid(),
				anchor: protocolJson(anchor ?? { version: 1, type: "note" }), body: protocolJson(body) } }),
			id === this.wholeNoteId ? "New discussion on this note" : "Comment on selected text", "", () => {
				// Sending retired this exact draft atomically. Return to the note
				// draft, never keep a stale selection active for the next comment.
				void this.session.trackLocal(this.session.store.comparePreference(this.key, id, this.wholeNoteId))
					.then(() => { this.update(); }).catch(() => {});
			});
		this.composer.onRevealTarget(this.reveal);
	}
	update(): void {
		if (this.closed) return;
		this.composer?.update();
		if (this.changing) { this.again = true; return; }
		if (this.refreshing) { this.again = true; return; }
		this.refreshing = this.refresh().catch(() => { if (!this.closed) this.status.setText("Drafts could not be loaded. Your saved drafts have been kept."); })
			.finally(() => { this.refreshing = undefined; if (this.again) { this.again = false; this.update(); } });
	}
	private async refresh(): Promise<void> {
		const store = this.session.store, navigation = this.navigation;
		const saved = await store.preference(this.key);
		let active = typeof saved === "string" && saved.startsWith("selection:" + this.entryId + ":") ? saved : this.wholeNoteId;
		const activeDraft = active !== this.wholeNoteId ? await store.getDraft(active) : undefined;
		if (active !== this.wholeNoteId && (!activeDraft || activeDraft.scopeId !== this.entryId)) active = this.wholeNoteId;
		const page = await store.selectionDrafts(this.entryId, this.after);
		if (this.closed || navigation !== this.navigation || this.changing) return;
		await this.activate(active, navigation);
		if (this.closed || navigation !== this.navigation || this.changing) return;
		const drafts = [...page.drafts];
		if (activeDraft && !drafts.some(d => d.id === activeDraft.id)) drafts.unshift(activeDraft);
		const options: [string, string][] = [[this.wholeNoteId, "Whole-note draft"]];
		for (const draft of drafts) {
			let label = "Selection needs review", prefix = "Selection";
			try { const anchor = parseAnchor(draft.target); if (anchor.type === "text") {
				label = anchor.context.quote ? anchor.context.quote.slice(0, 80) : "Selected position";
				if (anchor.structure) prefix = "Blocks";
			} } catch { /* Keep damaged drafts discoverable. */ }
			options.push([draft.id, prefix + ": " + label]);
		}
		const signature = JSON.stringify(options);
		if (this.select.dataset.options !== signature) {
			this.select.dataset.options = signature; this.select.empty();
			for (const [value, text] of options) this.select.createEl("option", { text, attr: { value } });
		}
		this.select.value = this.currentId;
		this.controls.querySelectorAll("button").forEach(button => button.remove());
		if (this.pages.length) {
			const previous = this.controls.createEl("button", { text: "Previous drafts" });
			previous.onclick = () => { this.after = this.pages.pop(); this.update(); };
		}
		if (page.hasMore) {
			const next = this.controls.createEl("button", { text: "More drafts" });
			next.onclick = () => { this.pages.push(this.after); this.after = page.drafts[page.drafts.length - 1].id; this.update(); };
		}
	}
	dispose(): void { this.closed = true; this.composer?.dispose(); this.controls.remove(); this.editor.remove(); this.status.remove(); }
}
