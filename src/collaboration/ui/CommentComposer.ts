import { canonical } from "../storage/DiscussionStore";
import { Menu } from "obsidian";
import { commentButton } from "./CommentControls";
import type { RestoreBinding } from "../RestoreGeneration";
import { timelineRangeLabel } from "../TimelineRange";
import { parseLocalDiscussionAnchor, type LocalDiscussionAnchor } from "../LocalDiscussionAnchor";
import { v4 as uuid } from "uuid";
import { sourceAnchor, protocolJson, type MessageBody } from "../DiscussionProtocol";
import { parseDiscussionScope } from "../DiscussionScope";
import type { DiscussionSession } from "../DiscussionSession";
import type { Draft, Json, QueuedCommand } from "../storage/DiscussionStore";
import { prepareLocalPicture, type PictureBlock } from "../PictureProtocol";
import { inspectPicture, PictureInputError, readPictureFile } from "../PictureInput";
import { CommentPicture } from "./CommentPicture";
import { commentDraftBody, readCommentDraft, updateMentionSpans, type CommentDraft, type MentionSpan } from "./CommentDraft";
import { RichCommentEditor } from "./RichCommentEditor";
import { renderCommentBody } from "./CommentBody";

export type ComposerCommand = { type: QueuedCommand["type"]; payload: Json; dependsOn?: string[] };

/** A draft editor owns its DOM across incoming renders, so updates never steal
 * the selection or discard composition/unsent text. IndexedDB CAS detects edits
 * in another window; enqueue and draft removal happen in one transaction.
 */
export class CommentComposer {
	readonly el: HTMLFormElement;
	readonly textarea: HTMLTextAreaElement;
	private status: HTMLElement;
	private send: HTMLButtonElement;
	private revision = -1;
	private savedValue = "";
	private previousText = "";
	private mentions: MentionSpan[] = [];
	private pictures: PictureBlock[] = [];
	private pictureList: HTMLElement;
	private attach: HTMLButtonElement;
	private refreshPictures: HTMLButtonElement;
	private recoverSend: HTMLButtonElement;
	private fileInput: HTMLInputElement;
	private pictureViews = new Map<string, { el: HTMLElement; view: CommentPicture; alt: HTMLInputElement; remove: HTMLButtonElement }>();
	private people: HTMLSelectElement;
	private peopleSignature = "";
	private chain: Promise<void> = Promise.resolve();
	private ready: Promise<void>;
	private attachmentFlight?: Promise<void>;
	private saveFailed = false;
	private busy = false;
	private onlinePending = false;
	private disposed = false;
	private composing = false;
	private extra?: HTMLButtonElement;
	private extraAvailable: () => boolean = () => true;
	private target?: LocalDiscussionAnchor;
	private targetEl: HTMLElement;
	private reveal?: (anchor: LocalDiscussionAnchor) => void;
	private targetLabel?: (anchor: LocalDiscussionAnchor) => string | undefined;
	private rich?: RichCommentEditor;
	private richHost: HTMLElement;
	private formatting: HTMLButtonElement;
	private editBaseRevision?: number;
	private needsEditReview = false;
	private reviewButton?: HTMLButtonElement;
	private sendAvailable: () => boolean = () => true;
	private editingAvailable: () => boolean = () => true;
	private discardButton: HTMLButtonElement;
	private discardPanel: HTMLElement;
	private discardReview?: Draft;
	private recoveryDraft = false;
	private discarding = false;
	private retiredTarget = false;
	private stopDiscard?: () => void;

	constructor(parent: HTMLElement, private session: DiscussionSession, private entryId: string, private draftId: string,
		private command: (body: MessageBody, anchor?: LocalDiscussionAnchor, editBaseRevision?: number) => ComposerCommand, label = "Comment", initialText: string | CommentDraft = "",
		private onSent: () => void = () => {}, private localOptions?: { current: () => boolean }) {
		this.el = parent.createEl("form", { cls: "relay-comment-composer" });
		const inputLabel = this.el.createEl("label", { text: label, attr: { for: draftId } });
		inputLabel.onclick = event => { if (this.rich) { event.preventDefault(); this.rich.focus(); } };
		this.targetEl = this.el.createDiv({ cls: "relay-comment-draft-target" });
		this.textarea = this.el.createEl("textarea", { attr: { id: draftId, rows: "3", maxlength: "65536", "aria-label": label, placeholder: "Write a comment…" } });
		this.textarea.disabled = true;
		this.formatting = commentButton(this.el, { text: "Format comment", attr: { type: "button", title: "Add formatting, links, lists or code" } });
		this.richHost = this.el.createDiv(); this.richHost.hidden = true;
		this.formatting.onclick = () => {
			if (this.busy || this.onlinePending || this.saveFailed || this.textarea.disabled || this.composing) return;
			try {
				const draft = this.snapshot(), from = this.textarea.selectionStart, to = this.textarea.selectionEnd;
				const body = draft.text.trim() || draft.pictures?.length ? commentDraftBody(draft) : { version: 1 as const, blocks: [{ type: "paragraph" as const, children: draft.text ? [{ type: "text" as const, text: draft.text }] : [] }] };
				this.startRich(body, label); this.rich!.focus(from, to); this.persist(); this.update();
			} catch { this.status.setText("This draft is too long to format. Your text is retained."); }
		};
		this.pictureList = this.el.createDiv({ cls: "relay-comment-draft-pictures" });
		const actions = this.el.createDiv({ cls: "relay-comment-composer-actions" });
		actions.appendChild(this.formatting);
		this.attach = commentButton(actions, { text: "Add pictures", attr: { type: "button" } });
		this.fileInput = actions.createEl("input", { attr: { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: "", "aria-label": "Choose comment pictures" } });
		this.fileInput.hidden = true;
		this.attach.onclick = () => this.fileInput.click();
		this.fileInput.onchange = () => { const files = Array.from(this.fileInput.files ?? []); this.fileInput.value = ""; void this.addPictures(files); };
		this.people = actions.createEl("select", { attr: { "aria-label": "Mention a member" } });
		this.people.addEventListener("change", () => {
			const person = this.session.participants(this.entryId).find(p => p.id === this.people.value);
			if (!person || this.people.disabled || this.busy || this.composing || this.rich?.composing) return;
			if (this.rich) { this.rich.insertMention(person.id, person.name); this.people.value = ""; return; }
			const start = this.textarea.selectionStart, end = this.textarea.selectionEnd, label = "@" + person.name;
			const before = this.textarea.value, after = before.slice(0, start) + label + " " + before.slice(end);
			this.mentions = updateMentionSpans(before, after, this.mentions);
			this.mentions.push({ start, end: start + label.length, userId: person.id }); this.mentions.sort((a, b) => a.start - b.start);
			this.textarea.value = after; this.previousText = after;
			this.textarea.focus(); this.textarea.setSelectionRange(start + label.length + 1, start + label.length + 1);
			this.people.value = ""; this.persist();
		});
		this.send = commentButton(actions, { text: "Send", cls: ["mod-cta", "relay-comment-send"], attr: { type: "submit" } });
		this.send.disabled = true;
		this.discardButton = commentButton(actions, { text: "Discard draft", cls: "relay-comment-discard", attr: { type: "button" } });
		this.discardButton.hidden = true; this.discardButton.onclick = () => { void this.reviewDiscard(); };
		this.discardPanel = this.el.createDiv({ cls: "relay-comment-confirm-actions" });
		this.refreshPictures = commentButton(actions, { text: "Refresh picture uploads", attr: { type: "button", title: "Keep the saved pictures and prepare fresh uploads for your next send." } });
		this.refreshPictures.onclick = () => { void this.recover(true); };
		this.recoverSend = commentButton(actions, { text: "Check delivery and edit", attr: { type: "button", title: "Check whether the reply was sent before making this draft editable again." } });
		this.recoverSend.onclick = () => { void this.recover(false); };
		this.refreshPictures.hidden = this.recoverSend.hidden = true;
		this.status = this.el.createDiv({ cls: "relay-comment-save-status", attr: { role: "status", "aria-live": "polite" } });
		this.stopDiscard = session.onDraftDiscarded?.(id => {
			if (id !== this.draftId || this.disposed || this.discarding) return;
			this.saveFailed = true; this.discardReview = undefined; this.discardPanel.empty();
			this.status.setText("This draft was discarded in another view. Any text still shown here is not saved; copy it before closing this editor."); this.update();
		});
		this.el.addEventListener("submit", event => { event.preventDefault(); if (!this.composing) void this.submit(); });
		this.textarea.addEventListener("compositionstart", () => { this.composing = true; });
		this.textarea.addEventListener("compositionend", () => { this.composing = false; this.persist(); });
		this.textarea.addEventListener("input", () => {
			this.mentions = updateMentionSpans(this.previousText, this.textarea.value, this.mentions);
			this.previousText = this.textarea.value; this.persist();
		});
        this.textarea.addEventListener("keyup", event => {
            if (event.key !== "@" || event.isComposing || this.composing || this.textarea.disabled || this.localOptions) return;
            const end = this.textarea.selectionStart, start = end - 1;
            if (start < 0 || this.textarea.value[start] !== "@") return;
            const menu = new Menu();
            for (const person of this.session.participants(this.entryId)) menu.addItem(item => item.setTitle(person.name).onClick(() => {
                if (this.textarea.disabled || this.textarea.value[start] !== "@") return;
                this.textarea.focus(); this.textarea.setSelectionRange(start, end);
                this.people.value = person.id; this.people.dispatchEvent(new Event("change"));
            }));
            const rect = this.textarea.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom });
        });
		this.textarea.addEventListener("paste", event => {
			const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith("image/"));
			if (!files.length || !this.session.canAttachPictures || this.busy || this.onlinePending || this.textarea.disabled || this.saveFailed) return;
			event.preventDefault();
			const text = event.clipboardData?.getData("text/plain");
			if (text) {
				this.textarea.setRangeText(text, this.textarea.selectionStart, this.textarea.selectionEnd, "end");
				this.mentions = updateMentionSpans(this.previousText, this.textarea.value, this.mentions);
				this.previousText = this.textarea.value; this.persist();
			}
			void this.addPictures(files);
		});
		this.textarea.addEventListener("keydown", event => {
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing && !this.composing) {
				event.preventDefault(); void this.submit();
			}
		});
		this.ready = session.trackLocal(session.store.getDraft(draftId).then(async draft => {
			if (this.disposed) return;
			if (this.localOptions && (!draft || draft.scopeId !== this.entryId || !this.localOptions.current())) throw new Error("Saved draft unavailable");
			this.revision = draft?.revision ?? -1;
			const restored = readCommentDraft(draft?.body ?? initialText);
			this.savedValue = JSON.stringify(restored); this.mentions = restored.mentions;
			this.pictures = restored.pictures ?? [];
			this.textarea.value = restored.text; this.previousText = this.textarea.value;
			this.editBaseRevision = restored.editBaseRevision;
			if (restored.rich) this.startRich(restored.rich, label);
			if (draft && typeof initialText !== "string" && initialText.editBaseRevision !== undefined && restored.editBaseRevision !== initialText.editBaseRevision) {
				this.needsEditReview = true;
				const review = this.el.createDiv({ cls: "relay-comment-edit-review" });
				review.createEl("p", { text: (restored.editBaseRevision === undefined ? "This older draft has no saved revision." : `Your draft started from revision ${restored.editBaseRevision}.`) + ` Compare your draft with revision ${initialText.editBaseRevision}, shown when this editor opened, before replacing it.` });
				if (initialText.rich) renderCommentBody(review, initialText.rich, id => this.session.displayName(this.entryId, id));
				this.reviewButton = commentButton(review, { text: "Use this revision for my edit", attr: { type: "button" } });
				this.reviewButton.onclick = () => { if (this.busy || this.saveFailed || this.onlinePending) return; this.editBaseRevision = initialText.editBaseRevision; this.needsEditReview = false; review.remove(); this.reviewButton = undefined; this.persist(); this.update(); };
			}
			if (draft?.target !== undefined) {
				this.target = parseLocalDiscussionAnchor(draft.target);
				if (this.target.type === "base_group_pending" && (this.target.entry_id !== parseDiscussionScope(this.entryId)?.entryId ||
					this.target.capture.view_id !== parseDiscussionScope(this.entryId)?.viewId)) throw new Error("Draft target does not match this saved view");
				if (this.target.type !== "base_group_pending" && sourceAnchor(this.target) && sourceAnchor(this.target)!.document_id !== this.entryId) throw new Error("Draft target does not match this note");
				if (this.target.type === "image_file" && this.target.asset.entry_id !== this.entryId) throw new Error("Draft target does not match this image");
				if (this.target.type === "base" && this.target.view_id !== parseDiscussionScope(this.entryId)?.viewId) throw new Error("Draft target does not match this saved view");
			}
			this.onlinePending = !!await session.store.preference("online:" + draftId);
			this.recoveryDraft = !!await session.store.preference("recovery:" + draftId);
			if (this.disposed) return;
			this.textarea.disabled = false;
			this.textarea.readOnly = this.onlinePending;
			if (this.onlinePending) this.status.setText("A previous send is unconfirmed. Reconnect to retry it or check delivery before editing.");
			// Undo belongs to the previous editor instance. Reopening an editable
			// draft releases its inactive originals, but never rewrites a pending send.
			if (!this.onlinePending && ((!draft && (restored.text || restored.pictures?.length)) || restored.undoPictures?.length)) this.persist();
			this.update();
		}).catch(() => {
			this.saveFailed = true; this.textarea.disabled = false; this.textarea.readOnly = true;
			this.status.setText("Could not restore this draft or its selection. Copy your text before reopening comments."); this.update();
		}));
	}
	private startRich(body: MessageBody, label: string): void {
		this.rich?.dispose();
		this.richHost.hidden = false; this.textarea.hidden = true; this.formatting.hidden = true; this.pictureList.hidden = true;
		for (const card of this.pictureViews.values()) { card.view.dispose(); card.el.remove(); } this.pictureViews.clear();
		this.rich = new RichCommentEditor(this.richHost, this.session, this.entryId, body, () => {
			const draft = this.rich!.draft(); this.textarea.value = this.previousText = draft.text; this.pictures = draft.pictures ?? [];
			this.persist(); this.update();
		}, message => this.status.setText(message), () => { void this.submit(); }, files => { void this.addPictures(files); }, label, !!this.localOptions);
		this.rich.setEditable(!this.busy && !this.onlinePending && !this.textarea.disabled && !this.saveFailed);
	}
	private snapshot(): CommentDraft {
		const draft = this.rich?.draft() ?? { text: this.textarea.value, mentions: this.mentions.map(m => ({ ...m })), ...(this.pictures.length ? { pictures: this.pictures.map(p => ({ ...p })) } : {}) };
		return { ...draft, ...(this.editBaseRevision !== undefined ? { editBaseRevision: this.editBaseRevision } : {}) };
	}
	onRevealTarget(reveal: (anchor: LocalDiscussionAnchor) => void, label?: (anchor: LocalDiscussionAnchor) => string | undefined): void { this.reveal = reveal; this.targetLabel = label; }
	setSendAvailable(available: () => boolean): void { this.sendAvailable = available; this.update(); }
	setEditingAvailable(available: () => boolean): void { this.editingAvailable = available; this.update(); }
	get hasUnconfirmedSend(): boolean { return this.onlinePending; }
	async flush(): Promise<boolean> { await this.ready; await this.attachmentFlight; await this.chain; return !this.saveFailed; }
	addOnlineAction(label: string, action: (body: MessageBody, draft: { id: string; revision: number }, binding: RestoreBinding) => Promise<void>, available: () => boolean = () => true): void {
		this.extraAvailable = available;
		this.extra = commentButton(this.send.parentElement!, { text: label, cls: "relay-comment-send-extra", attr: { type: "button" } });
		this.extra.addEventListener("click", () => { void this.submit(action); });
		this.update();
	}
	update(): void {
		if (this.disposed) return;
		const paused = !!this.localOptions && !this.localOptions.current() || !this.editingAvailable() || !!this.discardReview || this.retiredTarget;
		const blocked = paused || this.busy || this.saveFailed || !this.session.canQueue || !this.session.permission(this.entryId)?.comment;
		this.send.hidden = !!this.localOptions;
		this.send.disabled = !!this.localOptions || blocked || this.textarea.disabled || this.onlinePending || this.needsEditReview || !this.sendAvailable();
		this.textarea.readOnly = paused || this.busy || this.onlinePending || this.saveFailed;
		this.formatting.disabled = paused || this.busy || this.onlinePending || this.textarea.disabled || this.saveFailed;
		this.rich?.setEditable(!paused && !this.busy && !this.onlinePending && !this.textarea.disabled && !this.saveFailed);
		if (this.reviewButton) this.reviewButton.disabled = paused || this.busy || this.onlinePending || this.saveFailed;
		if (this.extra) { this.extra.hidden = !this.extraAvailable(); this.extra.disabled = blocked || !this.session.online || !this.extraAvailable();
			this.extra.setAttribute("aria-label", this.onlinePending ? "Retry send and reopen" : "Send and reopen"); }
		const people = this.localOptions ? [] : this.session.participants(this.entryId), signature = JSON.stringify(people);
		if (signature !== this.peopleSignature) {
			const selected = this.people.value; this.peopleSignature = signature;
			this.people.empty(); this.people.createEl("option", { text: "Mention…", attr: { value: "" } });
			for (const person of people) this.people.createEl("option", { text: person.name, attr: { value: person.id } });
			this.people.value = selected;
		}
		this.people.disabled = paused || this.busy || this.onlinePending || this.saveFailed || this.textarea.disabled || !people.length;
		this.people.hidden = true;
		this.attach.hidden = true;
		this.attach.disabled = blocked || this.onlinePending || this.textarea.disabled || this.pictures.length >= 10;
		this.refreshPictures.hidden = !!this.localOptions || !this.pictures.length || this.onlinePending;
		this.refreshPictures.disabled = blocked || this.textarea.disabled || !this.session.canAttachPictures;
		this.recoverSend.hidden = !!this.localOptions || !this.onlinePending;
		this.recoverSend.disabled = blocked || !this.session.canRecoverOnlineDraft;
		this.discardButton.hidden = this.revision < 0 || this.onlinePending || this.recoveryDraft;
		this.discardButton.disabled = paused || this.busy || this.saveFailed || this.textarea.disabled;
		this.renderPictures();
		const label = (this.target && this.targetLabel?.(this.target)) ?? (this.target?.type === "base_group_pending" ? (this.target.range ? timelineRangeLabel(this.target.range.range) + " · lane: " : "Group: ") + this.target.property.name + " (verification pending)" : this.target?.type === "image_file" ? "Image file: " + (this.target.geometry.type === "whole" ? "whole image" : this.target.geometry.type) : this.target?.type === "image" ? "Image " + (this.target.geometry.type === "whole" ? "discussion" : this.target.geometry.type) + ": “" + this.target.occurrence.context.quote + "”" : this.target?.type === "text" ? (this.target.structure ? "Selected blocks (" + this.target.structure.blocks.map(block => block.kind.replace(/_/g, " ")).join(", ") + "): “" + this.target.context.quote + "”" :
			this.target.context.quote ? "Selected text: “" + this.target.context.quote + "”" : "Selected position") : this.target?.type === "base" ?
			(this.target.target.type === "view" ? "Entire saved view" : this.target.target.type === "item" ? "Record in this view" : this.target.target.type === "timeline_marker" ? "Marker: " + this.target.target.content.label : this.target.target.type === "timeline_range" ? timelineRangeLabel(this.target.target.range) :
				(this.target.target.type === "formula_cell" ? "Formula cell: " : this.target.target.type === "cell" ? "Cell: " : this.target.target.type === "formula" ? "Formula definition: " : this.target.target.type === "summary" ? "Summary: " : this.target.target.type === "group" ? "Group: " : "Property header: ") + this.target.target.property.name) : "");
		if (this.targetEl.dataset.target !== label) {
			this.targetEl.dataset.target = label; this.targetEl.empty();
			if (label) {
				this.targetEl.createEl("p", { text: label });
				const reveal = commentButton(this.targetEl, { text: (this.target?.type === "base" || this.target?.type === "base_group_pending") ? "Target details" : "Show selection", attr: { type: "button" } });
				reveal.hidden = !!this.localOptions;
				reveal.onclick = () => { if (this.target) this.reveal?.(this.target); };
			}
		}
	}
	private restoreRecoveredDraft(draft: Draft): void {
		const restored = readCommentDraft(draft.body);
		for (const card of this.pictureViews.values()) { card.view.dispose(); card.el.remove(); }
		this.pictureViews.clear();
		this.revision = draft.revision; this.savedValue = JSON.stringify(restored);
		this.mentions = restored.mentions; this.pictures = restored.pictures ?? [];
		this.textarea.value = this.previousText = restored.text;
		this.editBaseRevision = restored.editBaseRevision;
		if (restored.rich) { if (this.rich) this.rich.setBody(restored.rich); else this.startRich(restored.rich, "Comment"); }
	}
	private async recover(pictures: boolean): Promise<void> {
		await this.ready;
		if (this.localOptions || this.disposed || this.busy || this.saveFailed || this.composing || this.rich?.composing || !this.session.permission(this.entryId)?.comment ||
			(pictures ? this.onlinePending || !this.session.canAttachPictures : !this.onlinePending || !this.session.canRecoverOnlineDraft)) return;
		if (pictures) this.persist();
		this.busy = true; this.textarea.readOnly = true; this.update();
		let completion: string | undefined;
		try {
			await this.chain; if (this.saveFailed) return;
			const draft = { id: this.draftId, scopeId: this.entryId, revision: this.revision };
			this.status.setText(pictures ? "Preparing saved pictures…" : "Checking whether your reply was sent…");
			if (pictures) {
				const refreshed = await this.session.refreshDraftPictures(draft);
				if (this.disposed) return;
				this.restoreRecoveredDraft(refreshed);
				completion = "Pictures refreshed. Your draft is saved; send it when ready.";
			} else {
				const result = await this.session.recoverOnlineDraft(draft);
				if (this.disposed) return;
				this.onlinePending = false;
				if (result.status === "accepted") {
					this.revision = -1; this.savedValue = ""; this.textarea.value = this.previousText = ""; this.mentions = []; this.pictures = [];
					this.rich?.setBody();
					this.retiredTarget = !!this.target;
					completion = "Your reply was already sent. The saved draft has been cleared."; this.onSent();
				} else {
					this.restoreRecoveredDraft(result.draft);
					completion = "Your draft is ready to edit. Review it and send again when ready.";
				}
			}
		} catch (error) {
			completion = error instanceof Error && error.message.includes("100 MiB") ?
				"Local picture storage is full. Your draft is retained. Send or remove other draft pictures, or finish a retained recovery copy in the storage panel, before retrying." :
				error instanceof Error && error.message.includes("No saved picture originals") ? "No saved originals are available. Remove and add the affected pictures again." :
				"Recovery was not confirmed. Your draft is retained. Check the connection and permissions, or reopen it if another window changed it.";
		} finally {
			try { this.onlinePending = !!await this.session.store.preference("online:" + this.draftId); } catch { /* Keep locked if storage/account is unavailable. */ }
			this.busy = false; this.textarea.readOnly = this.onlinePending; if (!this.disposed) { this.update(); if (completion) this.status.setText(completion); }
		}
	}
	private renderPictures(): void {
		if (this.rich) return;
		for (const [id, card] of this.pictureViews) if (!this.pictures.some(p => p.picture_id === id)) {
			card.view.dispose(); card.el.remove(); this.pictureViews.delete(id);
		}
		for (const picture of this.pictures) {
			let card = this.pictureViews.get(picture.picture_id);
			if (!card) {
				const el = this.pictureList.createDiv({ cls: "relay-comment-draft-picture" });
				const view = new CommentPicture(el, this.session, this.entryId, picture, this.localOptions ? "only" : true);
				const alt = el.createEl("input", { attr: { type: "text", maxlength: "1024", placeholder: "Picture description", "aria-label": "Picture description" } });
				alt.value = picture.alt ?? "";
				alt.oninput = () => { picture.alt = alt.value; view.setAlt(alt.value); this.persist(); };
				const remove = commentButton(el, { text: "Remove picture", attr: { type: "button" } });
				remove.onclick = () => {
					if (this.busy || this.onlinePending || this.saveFailed) return;
					this.pictures = this.pictures.filter(p => p !== picture); this.persist(); this.update();
				};
				card = { el, view, alt, remove }; this.pictureViews.set(picture.picture_id, card);
			}
			card.alt.disabled = card.remove.disabled = this.busy || this.onlinePending || this.saveFailed || !!this.discardReview || this.retiredTarget || !this.editingAvailable();
		}
	}
	/** Bytes and references commit before the attachment appears in the draft.
	 * One file is read at a time; a failed file preserves earlier successful picks.
	 */
	async addPictures(files: readonly File[]): Promise<void> {
		await this.ready;
		if (this.localOptions || !files.length || this.disposed || this.busy || this.discardReview || this.retiredTarget || !this.editingAvailable() || this.onlinePending || this.saveFailed || this.composing || this.rich?.composing || !this.session.canAttachPictures || !this.session.permission(this.entryId)?.comment) return;
		if (files.length + this.pictures.length > 10) { this.status.setText("A comment can contain at most ten pictures."); return; }
		this.busy = true; this.textarea.readOnly = true; this.update();
		this.attachmentFlight = this.session.trackLocal((async () => {
			try {
				await this.chain; if (this.saveFailed) return;
				for (const file of files) {
					this.status.setText("Saving picture on this device…");
					const bytes = await readPictureFile(file); inspectPicture(bytes);
					const source = await prepareLocalPicture(uuid(), this.entryId, bytes);
					if (this.disposed || this.session.status === "closed") return;
					const picture: PictureBlock = { type: "picture", picture_id: source.id, alt: "" };
					const prepared = this.rich?.preparePictures([picture]);
					const draft = { ...(prepared?.draft ?? { ...this.snapshot(), pictures: [...this.pictures, picture] }),
						...(this.editBaseRevision !== undefined ? { editBaseRevision: this.editBaseRevision } : {}) };
					await this.session.store.saveDraft({ id: this.draftId, scopeId: this.entryId, revision: this.revision + 1, body: protocolJson(draft),
						...(this.target ? { target: protocolJson(this.target) } : {}) }, this.revision < 0 ? null : this.revision, [source]);
					this.revision++; this.savedValue = JSON.stringify(draft); this.pictures = draft.pictures ?? [];
					prepared?.apply();
					if (!this.disposed) this.update();
				}
				if (!this.disposed) this.status.setText("");
			} catch (error) {
				if (this.disposed) return;
				if (error instanceof PictureInputError) this.status.setText(error.message);
				else if (error instanceof Error && error.message.includes("100 MiB")) this.status.setText("Local picture storage is full. Send or remove other draft pictures, or finish a retained recovery copy in the storage panel, before adding more.");
				else {
					this.saveFailed = error instanceof Error && error.message.includes("another view");
					this.status.setText(this.saveFailed ? "This draft changed in another window. Reopen it before adding pictures." : "Could not save this picture. Check device storage and try again. Earlier saved pictures are retained.");
				}
			} finally { this.busy = false; this.textarea.readOnly = this.onlinePending; if (!this.disposed) this.update(); }
		})());
		await this.attachmentFlight;
	}
	private persist(): void {
		if (this.localOptions && !this.localOptions.current() || this.disposed || this.textarea.disabled || this.busy || this.discardReview || this.retiredTarget || !this.editingAvailable() || this.onlinePending || this.saveFailed) return;
		const text = this.textarea.value;
		const draft = this.snapshot(), value = JSON.stringify(draft);

		this.chain = this.session.trackLocal(this.chain.then(async () => {
			if (this.saveFailed) return;
			if (value !== this.savedValue || this.revision < 0) {
				await this.session.store.saveDraft({ id: this.draftId, scopeId: this.entryId, revision: this.revision + 1, body: protocolJson(draft),
					...(this.target ? { target: protocolJson(this.target) } : {}) }, this.revision < 0 ? null : this.revision, [], this.localOptions?.current);
				this.revision++; this.savedValue = value;
			}
			if (!this.disposed && this.textarea.value === text) this.status.setText("");
		}).catch(() => {
			this.saveFailed = true;
			if (!this.disposed) this.status.setText("Could not save, or this draft changed in another window. Copy your text before reopening comments.");
		}).finally(() => { if (!this.disposed) this.update(); }));
	}
	async submit(onlineAction?: (body: MessageBody, draft: { id: string; revision: number }, binding: RestoreBinding) => Promise<void>): Promise<void> {
		if (this.localOptions || this.busy || this.disposed || this.discardReview || this.retiredTarget || this.composing || this.rich?.composing || this.needsEditReview || !this.sendAvailable()) return;
		const binding = this.session.restoreBinding;
		await this.ready;
		if (this.busy || this.disposed || this.saveFailed || this.composing || this.rich?.composing || this.needsEditReview || !this.session.canQueue || !this.session.permission(this.entryId)?.comment) return;
		if (this.onlinePending && !onlineAction) return;
		let body: MessageBody;
		try { body = commentDraftBody(this.snapshot()); } catch { this.status.setText("The comment is empty or too long. Edit it before sending."); return; }
		this.persist(); this.busy = true; this.textarea.readOnly = true; this.update();
		try {
			await this.chain;
			if (this.saveFailed || this.disposed || !this.sendAvailable()) return;
			if (onlineAction) {
				await onlineAction(body, { id: this.draftId, revision: this.revision }, binding);
			} else {
				const command = this.command(body, this.target, this.editBaseRevision);
				await this.session.queue({ ...binding, operationId: uuid(), scopeId: this.entryId, type: command.type,
					payload: protocolJson(command.payload), dependsOn: command.dependsOn ?? [] }, { id: this.draftId, revision: this.revision });
			}
			this.revision = -1; this.savedValue = ""; this.textarea.value = ""; this.previousText = ""; this.mentions = []; this.onlinePending = false;
			this.pictures = [];
			this.rich?.setBody();
			this.retiredTarget = !!this.target;
			this.status.setText(onlineAction ? "Sent" : "Saved to send"); this.onSent();
		} catch {
			this.status.setText("Not confirmed. Your draft is saved. Check the connection or permissions before retrying.");
		} finally {
			try { this.onlinePending = !!await this.session.store.preference("online:" + this.draftId); } catch { /* Preserve the previous pending state on shutdown. */ }
			this.busy = false; this.textarea.readOnly = this.onlinePending; this.update();
		}
	}
	private async reviewDiscard(): Promise<void> {
		if (this.disposed || this.busy || this.saveFailed || this.onlinePending || this.recoveryDraft || !this.editingAvailable()) return;
		this.busy = true; this.update();
		try {
			if (!await this.flush()) throw new Error("Save this draft before reviewing discard.");
			const draft = await this.session.store.getDraft(this.draftId);
			if (this.disposed) return;
			if (!draft || draft.scopeId !== this.entryId || draft.revision !== this.revision || canonical(protocolJson(readCommentDraft(draft.body))) !== canonical(protocolJson(readCommentDraft(JSON.parse(this.savedValue))))) throw new Error("This draft changed in another view. Reopen it before discarding.");
			this.discardReview = draft; this.discardPanel.empty();
			const keep = commentButton(this.discardPanel, { text: "Keep editing", attr: { type: "button" } });
			const discard = this.discardPanel.createEl("button", { text: "Discard draft", attr: { type: "button" } });
			keep.onclick = () => { if (this.busy) return; this.discardReview = undefined; this.discardPanel.empty(); this.update(); };
			discard.onclick = () => { void this.discardSavedDraft(keep, discard); };
		} catch (error) { if (!this.disposed) this.status.setText(error instanceof Error ? error.message : "Could not review this draft. Your saved work is retained."); }
		finally { this.busy = false; this.update(); }
	}
	private async discardSavedDraft(keep: HTMLButtonElement, discard: HTMLButtonElement): Promise<void> {
		const draft = this.discardReview; if (!draft || this.disposed || this.busy || this.saveFailed) return;
		this.busy = this.discarding = true; keep.disabled = discard.disabled = true; this.update();
		try {
			await this.session.discardDraft(draft, () => !this.disposed && this.discardReview === draft && (!this.localOptions || this.localOptions.current()));
			if (this.disposed) return;
			this.discardReview = undefined; this.discardPanel.empty();
			this.revision = -1; this.savedValue = ""; this.textarea.value = this.previousText = ""; this.mentions = []; this.pictures = [];
			this.rich?.setBody(); this.retiredTarget = !!this.target;
			this.status.setText(""); this.onSent();
		} catch (error) {
			if (!this.disposed) { this.discardReview = undefined; this.discardPanel.empty(); this.saveFailed = true;
				this.status.setText(error instanceof Error ? error.message : "The draft could not be discarded. Copy your text and reopen it before retrying."); }
		} finally { this.busy = this.discarding = false; this.update(); }
	}
	dispose(): void { this.disposed = true; this.stopDiscard?.(); this.stopDiscard = undefined; this.rich?.dispose(); for (const card of this.pictureViews.values()) card.view.dispose(); this.pictureViews.clear(); this.el.remove(); }
}
