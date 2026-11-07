import { Modal, type App } from "obsidian";
import type { DiscussionSession } from "../DiscussionSession";
import { DiscussionFailure } from "../DiscussionTransport";
import { isRecord, protocolJson, type MessageBody } from "../DiscussionProtocol";
import { parseDiscussionScope } from "../DiscussionScope";
import type { LocalDiscussionAnchor } from "../LocalDiscussionAnchor";
import type { Draft, OutboxOperation } from "../storage/DiscussionStore";
import { CommentComposer, type ComposerCommand } from "./CommentComposer";
import { editableCommentDraft, readCommentDraft } from "./CommentDraft";

type Editable = Extract<Awaited<ReturnType<DiscussionSession["recoverSavedCommand"]>>, { status: "editable" }>;
type Hooks = { current(): boolean; choose(operation: OutboxOperation, draft: Draft): void;
	reveal(anchor: LocalDiscussionAnchor): void; label(anchor: LocalDiscussionAnchor): string };

/** A new operation ID retains the original thread/message identities. Storage
 * atomically fences the old send and transfers its unsent dependents. */
export function recoveredCommand(operation: OutboxOperation, body: MessageBody, anchor?: LocalDiscussionAnchor, revision?: number): ComposerCommand {
	const original = operation.payload;
	if (!isRecord(original)) throw new Error("Saved change is unavailable.");
	const common = { thread_id: original.thread_id, message_id: original.message_id, body: protocolJson(body) };
	if (operation.type === "thread.create" || operation.type === "base.group.create") {
		if (!anchor) throw new Error("Choose a target before sending.");
		const type = anchor.type === "base_group_pending" ? "base.group.create" : "thread.create";
		return { type, payload: { type, ...common, anchor: protocolJson(anchor) } };
	}
	if (operation.type === "reply.create") return { type: "reply.create", payload: { type: "reply.create", ...common } };
	if (operation.type === "message.edit" && Number.isSafeInteger(revision) && revision! > 0) {
		return { type: "message.edit", payload: { type: "message.edit", ...common, expected_revision: revision! } };
	}
	throw new Error("Review the current comment before sending this edit.");
}

/** Opening first resolves delivery. Only a server-fenced original becomes an
 * editable draft; closing, reconnecting and choosing a target never send it. */
export class RecoverCommentModal extends Modal {
	private live = true;
	private busy = false;
	private stop?: () => void;
	private composer?: CommentComposer;
	private recovered?: Editable;
	private issue?: HTMLElement;
	private editor?: HTMLElement;
	private actions?: HTMLElement;
	private editReviewed = false;
	constructor(app: App, private session: DiscussionSession, private operation: OutboxOperation, private hooks: Hooks) { super(app); }
	private current = () => this.live && this.hooks.current() && this.session.status !== "closed" && this.session.permission(this.operation.scopeId)?.read === true;
	validate(): void { if (this.live && !this.current()) this.close(); }
	async onOpen(): Promise<void> {
		this.setTitle("Review saved comment");
		this.contentEl.createEl("p", { text: "Delivery is checked before editing. Your saved text, pictures and waiting replies are retained. Send explicitly when your changes are ready." });
		this.issue = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.actions = this.contentEl.createDiv(); this.editor = this.contentEl.createDiv();
		this.stop = this.session.onChange(() => { this.validate(); if (this.live) { this.composer?.update(); this.updateActions(); } });
		await this.load();
	}
	private async load(): Promise<void> {
		if (this.busy || !this.current()) return;
		this.busy = true; this.issue?.setText("Checking delivery…"); this.updateActions();
		try {
			const recovered = await this.session.recoverSavedCommand(this.operation, this.current);
			if (!this.current()) return;
			if (recovered.status !== "editable") {
				this.issue?.setText(recovered.status === "accepted" ? "The original change was already delivered. Review it in the discussion; no replacement was created." : "This change was already replaced in another window.");
				return;
			}
			this.recovered = recovered; this.operation = recovered.operation;
			this.showComposer();
			this.issue?.setText("The original send is cancelled. Edit the saved draft and send when ready.");
		} catch (error) { if (this.current()) this.issue?.setText(error instanceof Error ? error.message : "Could not check delivery. Your saved work is retained."); }
		finally { this.busy = false; if (this.current()) this.updateActions(); }
		if (this.recovered && this.operation.type === "message.edit" && this.session.online) await this.reviewEdit();
	}
	private showComposer(currentBody?: MessageBody, currentRevision?: number): void {
		if (!this.recovered || !this.editor) return;
		this.composer?.dispose();
		const initial = currentBody ? { ...editableCommentDraft(currentBody, id => this.session.displayName(this.operation.scopeId, id)), editBaseRevision: currentRevision } : readCommentDraft(this.recovered.draft.body);
		this.composer = new CommentComposer(this.editor, this.session, this.operation.scopeId, this.recovered.draft.id,
			(body, anchor, revision) => recoveredCommand(this.operation, body, anchor, revision), "Recovered comment", initial, () => this.close());
		this.composer.onRevealTarget(this.hooks.reveal, this.hooks.label);
		this.composer.setEditingAvailable(() => this.current() && !this.busy);
		this.composer.setSendAvailable(() => this.current() && !this.busy && (this.operation.type !== "message.edit" || this.editReviewed));
	}
	private async reviewEdit(): Promise<void> {
		if (!this.recovered || this.busy || !this.current() || !this.session.online || !isRecord(this.operation.payload)) return;
		this.busy = true; this.composer?.update(); this.updateActions();
		try {
			if (!await this.composer?.flush()) throw new Error("Save this draft before reviewing the current comment.");
			const linked = await this.session.linkedThread(this.operation.scopeId, String(this.operation.payload.thread_id), String(this.operation.payload.message_id));
			if (!this.current()) return;
			if (!linked?.message?.body || linked.thread.removed || linked.message.deleted || linked.message.author_id !== this.session.identity.accountId) throw new Error("The original comment is unavailable for editing. Your saved draft is retained.");
			this.editReviewed = true; this.showComposer(linked.message.body, linked.message.revision);
			this.issue?.setText("Compare your saved edit with the current comment before sending. A later change will still require another review.");
		} catch (error) {
			this.editReviewed = false;
			if (error instanceof DiscussionFailure && (error.status === 403 || error.status === 404)) this.close();
			else if (this.current()) this.issue?.setText(error instanceof Error ? error.message : "Reconnect to review the current comment. Your draft is saved.");
		} finally { this.busy = false; if (this.current()) { this.composer?.update(); this.updateActions(); } }
	}
	private updateActions(): void {
		if (!this.actions || !this.live) return;
		// Keep focused controls across routine session notifications.
		const signature = JSON.stringify([!!this.recovered, this.busy, this.session.online, this.session.canRecoverSavedCommand, this.session.permission(this.operation.scopeId)?.comment]);
		if (this.actions.dataset.state === signature) return;
		this.actions.dataset.state = signature; this.actions.empty();
		const button = (label: string, run: () => void, disabled = false) => {
			const item = this.actions!.createEl("button", { text: label, attr: { type: "button" } }); item.disabled = this.busy || disabled;
			item.onclick = () => { if (this.current() && !this.busy) run(); };
		};
		if (!this.recovered) button("Check delivery again", () => { void this.load(); }, !this.session.canRecoverSavedCommand);
		else if (this.operation.type === "message.edit") button("Review current comment", () => { void this.reviewEdit(); }, !this.session.online);
		else if (this.operation.type === "thread.create" || this.operation.type === "base.group.create") {
			button("Choose replacement target", () => { void this.choose(); }, !this.session.permission(this.operation.scopeId)?.comment);
			if (!isRecord(this.recovered.draft.target) || this.recovered.draft.target.type !== "image_file") {
				const base = !!parseDiscussionScope(this.operation.scopeId)?.viewId;
				button(base ? "Use entire saved view" : "Use entire note", () => { void this.whole(); }, !this.session.permission(this.operation.scopeId)?.comment || base && !this.session.online);
			}
		}
		button("Close", () => this.close());
	}
	private async whole(): Promise<void> {
		if (!this.recovered || this.busy) return;
		this.busy = true; this.composer?.update(); this.updateActions();
		try {
			if (!await this.composer?.flush()) throw new Error("Save this draft before replacing its target.");
			const draft = await this.session.store.getDraft(this.recovered.draft.id);
			if (!draft) throw new Error("This draft changed in another window. Reopen the saved change.");
			const anchor: LocalDiscussionAnchor = parseDiscussionScope(this.operation.scopeId)?.viewId ?
				await this.session.captureBaseTarget(this.operation.scopeId, { type: "view" }) : { version: 1, type: "note" };
			if (!this.current()) return;
			const updated = await this.session.trackLocal(this.session.store.retargetRecoveredDraft(draft.id, draft.revision, protocolJson(anchor)));
			if (!this.current()) return;
			this.recovered.draft = updated; this.showComposer();
			this.issue?.setText("Draft target updated. Review the comment before sending.");
		} catch (error) { if (this.current()) this.issue?.setText(error instanceof Error ? error.message : "Could not replace the target. Your saved draft is retained."); }
		finally { this.busy = false; if (this.current()) { this.composer?.update(); this.updateActions(); } }
	}
	private async choose(): Promise<void> {
		if (!this.recovered || this.busy) return;
		this.busy = true; this.composer?.update(); this.updateActions();
		try {
			if (!await this.composer?.flush()) throw new Error("Save this draft before selecting a new target.");
			const draft = await this.session.store.getDraft(this.recovered.draft.id);
			if (!this.current()) return;
			if (!draft) throw new Error("This draft changed in another window. Reopen the saved change.");
			this.close(); this.hooks.choose(this.operation, draft);
		} catch (error) { if (this.current()) this.issue?.setText(error instanceof Error ? error.message : "Could not save this draft."); }
		finally { this.busy = false; if (this.current()) { this.composer?.update(); this.updateActions(); } }
	}
	onClose(): void { this.live = false; this.stop?.(); this.stop = undefined; this.composer?.dispose(); this.composer = undefined; this.contentEl.empty(); }
}
