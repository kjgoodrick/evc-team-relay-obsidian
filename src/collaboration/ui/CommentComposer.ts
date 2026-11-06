import { v4 as uuid } from "uuid";
import { parseAnchor, protocolJson, type DiscussionAnchor, type MessageBody } from "../DiscussionProtocol";
import type { DiscussionSession } from "../DiscussionSession";
import type { Json, QueuedCommand } from "../storage/DiscussionStore";
import { commentDraftBody, readCommentDraft, updateMentionSpans, type MentionSpan } from "./CommentDraft";

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
	private people: HTMLSelectElement;
	private peopleSignature = "";
	private chain: Promise<void> = Promise.resolve();
	private ready: Promise<void>;
	private saveFailed = false;
	private busy = false;
	private onlinePending = false;
	private disposed = false;
	private composing = false;
	private extra?: HTMLButtonElement;
	private extraAvailable: () => boolean = () => true;
	private target?: DiscussionAnchor;
	private targetEl: HTMLElement;
	private reveal?: (anchor: DiscussionAnchor) => void;

	constructor(parent: HTMLElement, private session: DiscussionSession, private entryId: string, private draftId: string,
		private command: (body: MessageBody, anchor?: DiscussionAnchor) => ComposerCommand, label = "Comment", initialText = "",
		private onSent: () => void = () => {}) {
		this.el = parent.createEl("form", { cls: "relay-comment-composer" });
		this.el.createEl("label", { text: label, attr: { for: draftId } });
		this.targetEl = this.el.createDiv({ cls: "relay-comment-draft-target" });
		this.textarea = this.el.createEl("textarea", { attr: { id: draftId, rows: "3", maxlength: "65536", "aria-label": label, placeholder: "Write a comment…" } });
		this.textarea.disabled = true;
		const actions = this.el.createDiv({ cls: "relay-comment-composer-actions" });
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
		this.status = this.el.createDiv({ cls: "relay-comment-save-status", attr: { role: "status", "aria-live": "polite" } });
		this.el.addEventListener("submit", event => { event.preventDefault(); if (!this.composing) void this.submit(); });
		this.textarea.addEventListener("compositionstart", () => { this.composing = true; });
		this.textarea.addEventListener("compositionend", () => { this.composing = false; this.persist(); });
		this.textarea.addEventListener("input", () => {
			this.mentions = updateMentionSpans(this.previousText, this.textarea.value, this.mentions);
			this.previousText = this.textarea.value; this.persist();
		});
		this.textarea.addEventListener("keydown", event => {
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing && !this.composing) {
				event.preventDefault(); void this.submit();
			}
		});
		this.ready = session.trackLocal(session.store.getDraft(draftId).then(async draft => {
			if (this.disposed) return;
			this.revision = draft?.revision ?? -1;
			const restored = readCommentDraft(draft?.body);
			this.savedValue = JSON.stringify(restored); this.mentions = restored.mentions;
			this.textarea.value = draft ? restored.text : initialText; this.previousText = this.textarea.value;
			if (draft?.target !== undefined) {
				this.target = parseAnchor(draft.target);
				if (this.target.type === "text" && this.target.document_id !== this.entryId) throw new Error("Draft target does not match this note");
			}
			this.onlinePending = !!await session.store.preference("online:" + draftId);
			if (this.disposed) return;
			this.textarea.disabled = false;
			this.textarea.readOnly = this.onlinePending;
			if (this.onlinePending) this.status.setText("A previous send is unconfirmed. Reconnect and retry the same send.");
			if (!draft && initialText) this.persist();
			this.update();
		}).catch(() => {
			this.saveFailed = true; this.textarea.disabled = false; this.textarea.readOnly = true;
			this.status.setText("Could not restore this draft or its selection. Copy your text before reopening comments."); this.update();
		}));
	}
	onRevealTarget(reveal: (anchor: DiscussionAnchor) => void): void { this.reveal = reveal; }
	async flush(): Promise<boolean> { await this.ready; await this.chain; return !this.saveFailed; }
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
		const label = this.target?.type === "text" ? (this.target.context.quote ? "Selected text: “" + this.target.context.quote + "”" : "Selected position") : "";
		if (this.targetEl.dataset.target !== label) {
			this.targetEl.dataset.target = label; this.targetEl.empty();
			if (label) {
				this.targetEl.createEl("p", { text: label });
				const reveal = this.targetEl.createEl("button", { text: "Show selection", attr: { type: "button" } });
				reveal.onclick = () => { if (this.target) this.reveal?.(this.target); };
			}
		}
	}
	private persist(): void {
		if (this.disposed || this.textarea.disabled || this.busy || this.onlinePending) return;
		const text = this.textarea.value;
		const draft = { text, mentions: this.mentions.map(m => ({ ...m })) }, value = JSON.stringify(draft);
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
		try { body = commentDraftBody({ text: this.textarea.value, mentions: this.mentions }); } catch { this.status.setText("The comment is empty or too long. Edit it before sending."); return; }
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
			this.status.setText(onlineAction ? "Sent" : "Saved to send"); this.onSent();
		} catch {
			this.status.setText("Not confirmed. Your draft is saved. Check the connection or permissions before retrying.");
		} finally {
			try { this.onlinePending = !!await this.session.store.preference("online:" + this.draftId); } catch { /* Preserve the previous pending state on shutdown. */ }
			this.busy = false; this.textarea.readOnly = this.onlinePending; this.update();
		}
	}
	dispose(): void { this.disposed = true; this.el.remove(); }
}
