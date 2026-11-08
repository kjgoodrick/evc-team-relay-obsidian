import { timelineRangeLabel } from "../TimelineRange";
import { parseLocalDiscussionAnchor, type LocalDiscussionAnchor } from "../LocalDiscussionAnchor";
import { v4 as uuid } from "uuid";
import { BASE_TARGET_KINDS, protocolJson } from "../DiscussionProtocol";
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
		private reveal: (anchor: LocalDiscussionAnchor) => void, private imageFile?: () => void, private baseView?: () => Promise<void>,
		private targetLabel?: (anchor: LocalDiscussionAnchor) => string | undefined,
		private copyWork?: (anchor: LocalDiscussionAnchor, active: string | undefined, current: () => boolean) => void) {
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
	private async activate(id: string, navigation: number, target?: unknown): Promise<void> {
		if (this.closed || id === this.currentId) return;
		if (this.composer && !await this.composer.flush()) throw new Error("Draft needs review");
		if (this.closed || navigation !== this.navigation || this.changing) return;
		this.composer?.dispose(); this.currentId = id;
		this.composer = undefined;
		if (id === this.wholeNoteId && this.baseView) {
			this.editor.empty();
			const start = this.editor.createEl("button", { text: "New discussion on this view", cls: "relay-base-view-new" });
			start.onclick = () => { start.disabled = true; void this.baseView?.().finally(() => this.updateImageButton()); };
			this.updateImageButton(); return;
		}
		if (id === this.wholeNoteId && this.imageFile) {
			this.editor.empty();
			const start = this.editor.createEl("button", { text: "New image comment", cls: "relay-image-file-new" });
			start.onclick = () => this.imageFile?.(); this.updateImageButton(); return;
		}
		let label = id === this.wholeNoteId ? "New discussion on this note" : "Comment on selected text";
		try { if (target && ["image", "image_file"].includes(parseLocalDiscussionAnchor(target).type)) label = "Comment on image"; } catch { /* The composer reports malformed targets. */ }
		if (this.baseView) label = "Comment on this saved view";
		this.editor.empty();
		this.composer = new CommentComposer(this.editor, this.session, this.entryId, id,
			(body, anchor) => {
				if (this.imageFile && anchor?.type !== "image_file") throw new Error("Choose this image's comment target again.");
				if (this.baseView && anchor?.type !== "base" && anchor?.type !== "base_group_pending") throw new Error("Choose this saved view’s comment target again.");
				if (anchor?.type === "base_group_pending") return { type: "base.group.create", payload: {
					type: "base.group.create", thread_id: uuid(), message_id: uuid(), anchor: protocolJson(anchor), body: protocolJson(body) } };
				return { type: "thread.create", payload: { type: "thread.create", thread_id: uuid(), message_id: uuid(),
					anchor: protocolJson(anchor ?? { version: 1, type: "note" }), body: protocolJson(body) } };
			},
			label, "", () => {
				// Sending retired this exact draft atomically. Return to the note
				// draft, never keep a stale selection active for the next comment.
				void this.session.trackLocal(this.session.store.comparePreference(this.key, id, this.wholeNoteId))
					.then(() => { this.update(); }).catch(() => {});
			});
		this.composer.onRevealTarget(this.reveal, this.targetLabel);
	}
	private updateImageButton(): void {
		const button = this.editor.querySelector<HTMLButtonElement>(".relay-image-file-new");
		if (button) button.disabled = !this.session.canAnchorImageFiles || !this.session.documentGeneration(this.entryId) || !this.session.permission(this.entryId)?.comment;
		const base = this.editor.querySelector<HTMLButtonElement>(".relay-base-view-new");
		if (base) base.disabled = !BASE_TARGET_KINDS.some(kind => this.session.canAnchorBase(kind)) || !this.session.documentGeneration(this.entryId) || !this.session.permission(this.entryId)?.comment;
	}
	update(): void {
		if (this.closed) return;
		this.composer?.update();
		this.updateImageButton();
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
		await this.activate(active, navigation, activeDraft?.target);
		if (this.closed || navigation !== this.navigation || this.changing) return;
		const drafts = [...page.drafts];
		if (activeDraft && !drafts.some(d => d.id === activeDraft.id)) drafts.unshift(activeDraft);
		const options: [string, string][] = [[this.wholeNoteId, this.baseView ? "New discussion on this view" : this.imageFile ? "New image comment" : "Whole-note draft"]];
		for (const draft of drafts) {
			let label = "Selection needs review", prefix = "Selection";
			try { const anchor = parseLocalDiscussionAnchor(draft.target); if (anchor.type === "text") {
				label = anchor.context.quote ? anchor.context.quote.slice(0, 80) : "Selected position";
				if (anchor.structure) prefix = "Blocks";
			} else if (anchor.type === "image") { prefix = "Image " + (anchor.geometry.type === "whole" ? "discussion" : anchor.geometry.type); label = anchor.occurrence.context.quote.slice(0, 80); }
			else if (anchor.type === "image_file") { prefix = "Image file"; label = anchor.geometry.type === "whole" ? "Whole image" : anchor.geometry.type === "pin" ? "Pin" : "Region"; }
			else if (anchor.type === "base_group_pending") {
				const described = this.targetLabel?.(anchor);
				prefix = described ? "" : anchor.range ? "Range in lane" : "Group";
				label = described ?? (anchor.range ? timelineRangeLabel(anchor.range.range) + " · " : "") + anchor.property.name + " (verification pending)";
			}
			else if (anchor.type === "base") { prefix = "Saved view"; label = this.targetLabel?.(anchor) ?? (anchor.target.type === "view" ? "Entire view" : anchor.target.type === "item" ? "Record" : anchor.target.type === "timeline_marker" ? "Marker: " + anchor.target.content.label : anchor.target.type === "timeline_range" ? timelineRangeLabel(anchor.target.range) : anchor.target.property.name); }
			} catch { /* Keep damaged drafts discoverable. */ }
			options.push([draft.id, prefix ? prefix + ": " + label : label]);
		}
		const signature = JSON.stringify(options);
		if (this.select.dataset.options !== signature) {
			this.select.dataset.options = signature; this.select.empty();
			for (const [value, text] of options) this.select.createEl("option", { text, attr: { value } });
		}
		this.select.value = this.currentId;
		this.controls.querySelectorAll("button").forEach(button => button.remove());
		if (this.copyWork && this.composer && this.session.canCopySavedDraft?.(this.entryId)) {
			try {
				const anchor = active === this.wholeNoteId ? { version: 1 as const, type: "note" as const } : parseLocalDiscussionAnchor(activeDraft?.target);
				const copy = this.controls.createEl("button", { text: "Use saved work at this target", attr: { type: "button" } });
				copy.disabled = !this.session.canCopySavedDraft(this.entryId, anchor);
				copy.onclick = () => {
					if (this.closed || this.changing || !this.session.canCopySavedDraft(this.entryId, anchor)) return;
					this.changing = true; copy.disabled = true; this.select.disabled = true;
					const current = () => !this.closed && navigation === this.navigation && this.currentId === active;
					void this.composer!.flush().then(savedDraft => {
						if (!current()) return;
						if (!savedDraft) { this.status.setText("Save or copy your current text before choosing another saved draft."); return; }
						this.copyWork?.(anchor, typeof saved === "string" ? saved : undefined, current);
					})
					.catch(() => { if (current()) this.status.setText("Save or copy your current text before choosing another saved draft."); })
					.finally(() => { this.changing = false; this.select.disabled = false; this.update(); });
				};
			} catch { /* A malformed target must be recaptured before copying into it. */ }
		}
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
