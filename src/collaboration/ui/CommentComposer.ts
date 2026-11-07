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

	constructor(parent: HTMLElement, private session: DiscussionSession, private entryId: string, private draftId: string,
		private command: (body: MessageBody, anchor?: LocalDiscussionAnchor) => ComposerCommand, label = "Comment", initialText: string | CommentDraft = "",
		private onSent: () => void = () => {}) {
		this.el = parent.createEl("form", { cls: "relay-comment-composer" });
		this.el.createEl("label", { text: label, attr: { for: draftId } });
		this.targetEl = this.el.createDiv({ cls: "relay-comment-draft-target" });
		this.textarea = this.el.createEl("textarea", { attr: { id: draftId, rows: "3", maxlength: "65536", "aria-label": label, placeholder: "Write a comment…" } });
		this.textarea.disabled = true;
		this.pictureList = this.el.createDiv({ cls: "relay-comment-draft-pictures" });
		const actions = this.el.createDiv({ cls: "relay-comment-composer-actions" });
		this.attach = actions.createEl("button", { text: "Add pictures", attr: { type: "button" } });
		this.fileInput = actions.createEl("input", { attr: { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: "", "aria-label": "Choose comment pictures" } });
		this.fileInput.hidden = true;
		this.attach.onclick = () => this.fileInput.click();
		this.fileInput.onchange = () => { const files = Array.from(this.fileInput.files ?? []); this.fileInput.value = ""; void this.addPictures(files); };
		this.people = actions.createEl("select", { attr: { "aria-label": "Mention a member" } });
		this.people.addEventListener("change", () => {
			const person = this.session.participants(this.entryId).find(p => p.id === this.people.value);
			if (!person || this.busy) return;
			const start = this.textarea.selectionStart, end = this.textarea.selectionEnd, label = "@" + person.name;
			const before = this.textarea.value, after = before.slice(0, start) + label + " " + before.slice(end);
			this.mentions = updateMentionSpans(before, after, this.mentions);
			this.mentions.push({ start, end: start + label.length, userId: person.id }); this.mentions.sort((a, b) => a.start - b.start);
			this.textarea.value = after; this.previousText = after;
			this.textarea.focus(); this.textarea.setSelectionRange(start + label.length + 1, start + label.length + 1);
			this.people.value = ""; this.persist();
		});
		this.send = actions.createEl("button", { text: "Send", cls: "mod-cta", attr: { type: "submit" } });
		this.send.disabled = true;
		this.refreshPictures = actions.createEl("button", { text: "Refresh picture uploads", attr: { type: "button", title: "Keep the saved pictures and prepare fresh uploads for your next send." } });
		this.refreshPictures.onclick = () => { void this.recover(true); };
		this.recoverSend = actions.createEl("button", { text: "Check delivery and edit", attr: { type: "button", title: "Check whether the reply was sent before making this draft editable again." } });
		this.recoverSend.onclick = () => { void this.recover(false); };
		this.refreshPictures.hidden = this.recoverSend.hidden = true;
		this.status = this.el.createDiv({ cls: "relay-comment-save-status", attr: { role: "status", "aria-live": "polite" } });
		this.el.addEventListener("submit", event => { event.preventDefault(); if (!this.composing) void this.submit(); });
		this.textarea.addEventListener("compositionstart", () => { this.composing = true; });
		this.textarea.addEventListener("compositionend", () => { this.composing = false; this.persist(); });
		this.textarea.addEventListener("input", () => {
			this.mentions = updateMentionSpans(this.previousText, this.textarea.value, this.mentions);
			this.previousText = this.textarea.value; this.persist();
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
			this.revision = draft?.revision ?? -1;
			const restored = readCommentDraft(draft?.body ?? initialText);
			this.savedValue = JSON.stringify(restored); this.mentions = restored.mentions;
			this.pictures = restored.pictures ?? [];
			this.textarea.value = restored.text; this.previousText = this.textarea.value;
			if (draft?.target !== undefined) {
				this.target = parseLocalDiscussionAnchor(draft.target);
				if (this.target.type === "base_group_pending" && (this.target.entry_id !== parseDiscussionScope(this.entryId)?.entryId ||
					this.target.capture.view_id !== parseDiscussionScope(this.entryId)?.viewId)) throw new Error("Draft target does not match this saved view");
				if (this.target.type !== "base_group_pending" && sourceAnchor(this.target) && sourceAnchor(this.target)!.document_id !== this.entryId) throw new Error("Draft target does not match this note");
				if (this.target.type === "image_file" && this.target.asset.entry_id !== this.entryId) throw new Error("Draft target does not match this image");
				if (this.target.type === "base" && this.target.view_id !== parseDiscussionScope(this.entryId)?.viewId) throw new Error("Draft target does not match this saved view");
			}
			this.onlinePending = !!await session.store.preference("online:" + draftId);
			if (this.disposed) return;
			this.textarea.disabled = false;
			this.textarea.readOnly = this.onlinePending;
			if (this.onlinePending) this.status.setText("A previous send is unconfirmed. Reconnect to retry it or check delivery before editing.");
			if (!draft && (restored.text || restored.pictures?.length)) this.persist();
			this.update();
		}).catch(() => {
			this.saveFailed = true; this.textarea.disabled = false; this.textarea.readOnly = true;
			this.status.setText("Could not restore this draft or its selection. Copy your text before reopening comments."); this.update();
		}));
	}
	onRevealTarget(reveal: (anchor: LocalDiscussionAnchor) => void, label?: (anchor: LocalDiscussionAnchor) => string | undefined): void { this.reveal = reveal; this.targetLabel = label; }
	get hasUnconfirmedSend(): boolean { return this.onlinePending; }
	async flush(): Promise<boolean> { await this.ready; await this.attachmentFlight; await this.chain; return !this.saveFailed; }
	addOnlineAction(label: string, action: (body: MessageBody, draft: { id: string; revision: number }) => Promise<void>, available: () => boolean = () => true): void {
		this.extraAvailable = available;
		this.extra = this.send.parentElement!.createEl("button", { text: label, attr: { type: "button" } });
		this.extra.addEventListener("click", () => { void this.submit(action); });
		this.update();
	}
	update(): void {
		const blocked = this.busy || this.saveFailed || !this.session.canQueue || !this.session.permission(this.entryId)?.comment;
		this.send.disabled = blocked || this.onlinePending;
		if (this.extra) { this.extra.hidden = !this.extraAvailable(); this.extra.disabled = blocked || !this.session.online || !this.extraAvailable();
			this.extra.setText(this.onlinePending ? "Retry send and reopen" : "Send and reopen"); }
		const people = this.session.participants(this.entryId), signature = JSON.stringify(people);
		if (signature !== this.peopleSignature) {
			const selected = this.people.value; this.peopleSignature = signature;
			this.people.empty(); this.people.createEl("option", { text: "Mention…", attr: { value: "" } });
			for (const person of people) this.people.createEl("option", { text: person.name, attr: { value: person.id } });
			this.people.value = selected;
		}
		this.people.disabled = this.busy || this.onlinePending || this.textarea.disabled || !people.length;
		this.attach.hidden = !this.session.canAttachPictures;
		this.attach.disabled = blocked || this.onlinePending || this.textarea.disabled || this.pictures.length >= 10;
		this.refreshPictures.hidden = !this.pictures.length || this.onlinePending;
		this.refreshPictures.disabled = blocked || this.textarea.disabled || !this.session.canAttachPictures;
		this.recoverSend.hidden = !this.onlinePending;
		this.recoverSend.disabled = blocked || !this.session.canRecoverOnlineDraft;
		this.renderPictures();
		const label = (this.target && this.targetLabel?.(this.target)) ?? (this.target?.type === "base_group_pending" ? "Group: " + this.target.property.name + " (verification pending)" : this.target?.type === "image_file" ? "Image file: " + (this.target.geometry.type === "whole" ? "whole image" : this.target.geometry.type) : this.target?.type === "image" ? "Image " + (this.target.geometry.type === "whole" ? "discussion" : this.target.geometry.type) + ": “" + this.target.occurrence.context.quote + "”" : this.target?.type === "text" ? (this.target.structure ? "Selected blocks (" + this.target.structure.blocks.map(block => block.kind.replace(/_/g, " ")).join(", ") + "): “" + this.target.context.quote + "”" :
			this.target.context.quote ? "Selected text: “" + this.target.context.quote + "”" : "Selected position") : this.target?.type === "base" ?
			(this.target.target.type === "view" ? "Entire saved view" : this.target.target.type === "item" ? "Record in this view" : this.target.target.type === "timeline_range" ? timelineRangeLabel(this.target.target.range) :
				(this.target.target.type === "formula_cell" ? "Formula cell: " : this.target.target.type === "cell" ? "Cell: " : this.target.target.type === "formula" ? "Formula definition: " : this.target.target.type === "summary" ? "Summary: " : this.target.target.type === "group" ? "Group: " : "Property header: ") + this.target.target.property.name) : "");
		if (this.targetEl.dataset.target !== label) {
			this.targetEl.dataset.target = label; this.targetEl.empty();
			if (label) {
				this.targetEl.createEl("p", { text: label });
				const reveal = this.targetEl.createEl("button", { text: (this.target?.type === "base" || this.target?.type === "base_group_pending") ? "Target details" : "Show selection", attr: { type: "button" } });
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
	}
	private async recover(pictures: boolean): Promise<void> {
		await this.ready;
		if (this.disposed || this.busy || this.saveFailed || this.composing || !this.session.permission(this.entryId)?.comment ||
			(pictures ? this.onlinePending || !this.session.canAttachPictures : !this.onlinePending || !this.session.canRecoverOnlineDraft)) return;
		if (pictures) this.persist();
		this.busy = true; this.textarea.readOnly = true; this.update();
		try {
			await this.chain; if (this.saveFailed) return;
			const draft = { id: this.draftId, scopeId: this.entryId, revision: this.revision };
			this.status.setText(pictures ? "Preparing saved pictures…" : "Checking whether your reply was sent…");
			if (pictures) {
				const refreshed = await this.session.refreshDraftPictures(draft);
				if (this.disposed) return;
				this.restoreRecoveredDraft(refreshed);
				this.status.setText("Pictures refreshed. Your draft is saved; send it when ready.");
			} else {
				const result = await this.session.recoverOnlineDraft(draft);
				if (this.disposed) return;
				this.onlinePending = false;
				if (result.status === "accepted") {
					this.revision = -1; this.savedValue = ""; this.textarea.value = this.previousText = ""; this.mentions = []; this.pictures = [];
					this.status.setText("Your reply was already sent. The saved draft has been cleared."); this.onSent();
				} else {
					this.restoreRecoveredDraft(result.draft);
					this.status.setText("Your draft is ready to edit. Review it and send again when ready.");
				}
			}
		} catch (error) {
			if (!this.disposed) this.status.setText(error instanceof Error && error.message.includes("100 MiB") ?
				"Local picture storage is full. Your draft is retained. Send or remove other draft pictures before retrying." :
				error instanceof Error && error.message.includes("No saved picture originals") ? "No saved originals are available. Remove and add the affected pictures again." :
				"Recovery was not confirmed. Your draft is retained. Check the connection and permissions, or reopen it if another window changed it.");
		} finally {
			try { this.onlinePending = !!await this.session.store.preference("online:" + this.draftId); } catch { /* Keep locked if storage/account is unavailable. */ }
			this.busy = false; this.textarea.readOnly = this.onlinePending; if (!this.disposed) this.update();
		}
	}
	private renderPictures(): void {
		for (const [id, card] of this.pictureViews) if (!this.pictures.some(p => p.picture_id === id)) {
			card.view.dispose(); card.el.remove(); this.pictureViews.delete(id);
		}
		for (const picture of this.pictures) {
			let card = this.pictureViews.get(picture.picture_id);
			if (!card) {
				const el = this.pictureList.createDiv({ cls: "relay-comment-draft-picture" });
				const view = new CommentPicture(el, this.session, this.entryId, picture, true);
				const alt = el.createEl("input", { attr: { type: "text", maxlength: "1024", placeholder: "Picture description", "aria-label": "Picture description" } });
				alt.value = picture.alt ?? "";
				alt.oninput = () => { picture.alt = alt.value; view.setAlt(alt.value); this.persist(); };
				const remove = el.createEl("button", { text: "Remove picture", attr: { type: "button" } });
				remove.onclick = () => {
					if (this.busy || this.onlinePending || this.saveFailed) return;
					this.pictures = this.pictures.filter(p => p !== picture); this.persist(); this.update();
				};
				card = { el, view, alt, remove }; this.pictureViews.set(picture.picture_id, card);
			}
			card.alt.disabled = card.remove.disabled = this.busy || this.onlinePending || this.saveFailed;
		}
	}
	/** Bytes and references commit before the attachment appears in the draft.
	 * One file is read at a time; a failed file preserves earlier successful picks.
	 */
	async addPictures(files: readonly File[]): Promise<void> {
		await this.ready;
		if (!files.length || this.disposed || this.busy || this.onlinePending || this.saveFailed || !this.session.canAttachPictures || !this.session.permission(this.entryId)?.comment) return;
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
					const pictures = [...this.pictures, { type: "picture" as const, picture_id: source.id, alt: "" }];
					const draft = { text: this.textarea.value, mentions: this.mentions.map(m => ({ ...m })), pictures };
					await this.session.store.saveDraft({ id: this.draftId, scopeId: this.entryId, revision: this.revision + 1, body: protocolJson(draft),
						...(this.target ? { target: protocolJson(this.target) } : {}) }, this.revision < 0 ? null : this.revision, [source]);
					this.revision++; this.savedValue = JSON.stringify(draft); this.pictures = pictures;
					if (!this.disposed) this.update();
				}
				if (!this.disposed) this.status.setText("Draft and pictures saved on this device");
			} catch (error) {
				if (this.disposed) return;
				if (error instanceof PictureInputError) this.status.setText(error.message);
				else if (error instanceof Error && error.message.includes("100 MiB")) this.status.setText("Local picture storage is full. Send or remove other draft pictures before adding more.");
				else {
					this.saveFailed = error instanceof Error && error.message.includes("another view");
					this.status.setText(this.saveFailed ? "This draft changed in another window. Reopen it before adding pictures." : "Could not save this picture. Check device storage and try again. Earlier saved pictures are retained.");
				}
			} finally { this.busy = false; this.textarea.readOnly = this.onlinePending; if (!this.disposed) this.update(); }
		})());
		await this.attachmentFlight;
	}
	private persist(): void {
		if (this.disposed || this.textarea.disabled || this.busy || this.onlinePending) return;
		const text = this.textarea.value;
		const draft = { text, mentions: this.mentions.map(m => ({ ...m })), ...(this.pictures.length ? { pictures: this.pictures.map(p => ({ ...p })) } : {}) }, value = JSON.stringify(draft);
		this.status.setText("Saving draft…");
		this.chain = this.session.trackLocal(this.chain.then(async () => {
			if (this.saveFailed) return;
			if (value !== this.savedValue || this.revision < 0) {
				await this.session.store.saveDraft({ id: this.draftId, scopeId: this.entryId, revision: this.revision + 1, body: protocolJson(draft),
					...(this.target ? { target: protocolJson(this.target) } : {}) }, this.revision < 0 ? null : this.revision);
				this.revision++; this.savedValue = value;
			}
			if (!this.disposed && this.textarea.value === text) this.status.setText("Draft saved on this device");
		}).catch(() => {
			this.saveFailed = true;
			if (!this.disposed) this.status.setText("Could not save, or this draft changed in another window. Copy your text before reopening comments.");
		}).finally(() => { if (!this.disposed) this.update(); }));
	}
	async submit(onlineAction?: (body: MessageBody, draft: { id: string; revision: number }) => Promise<void>): Promise<void> {
		if (this.busy || this.disposed || this.composing) return;
		await this.ready;
		if (this.busy || this.disposed || this.saveFailed || !this.session.canQueue || !this.session.permission(this.entryId)?.comment) return;
		if (this.onlinePending && !onlineAction) return;
		let body: MessageBody;
		try { body = commentDraftBody({ text: this.textarea.value, mentions: this.mentions, pictures: this.pictures }); } catch { this.status.setText("The comment is empty or too long. Edit it before sending."); return; }
		this.persist(); this.busy = true; this.textarea.readOnly = true; this.update();
		try {
			await this.chain;
			if (this.saveFailed) return;
			if (onlineAction) {
				await onlineAction(body, { id: this.draftId, revision: this.revision });
			} else {
				const command = this.command(body, this.target);
				await this.session.queue({ operationId: uuid(), scopeId: this.entryId, type: command.type,
					payload: protocolJson(command.payload), dependsOn: command.dependsOn ?? [] }, { id: this.draftId, revision: this.revision });
			}
			this.revision = -1; this.savedValue = ""; this.textarea.value = ""; this.previousText = ""; this.mentions = []; this.onlinePending = false;
			this.pictures = [];
			this.status.setText(onlineAction ? "Sent" : "Saved to send"); this.onSent();
		} catch {
			this.status.setText("Not confirmed. Your draft is saved. Check the connection or permissions before retrying.");
		} finally {
			try { this.onlinePending = !!await this.session.store.preference("online:" + this.draftId); } catch { /* Preserve the previous pending state on shutdown. */ }
			this.busy = false; this.textarea.readOnly = this.onlinePending; this.update();
		}
	}
	dispose(): void { this.disposed = true; for (const card of this.pictureViews.values()) card.view.dispose(); this.pictureViews.clear(); this.el.remove(); }
}
