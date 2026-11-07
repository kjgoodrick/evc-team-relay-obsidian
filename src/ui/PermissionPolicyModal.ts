import { Modal, type App } from "obsidian";
import { PermissionPolicyError, permissionRuleKey, type PermissionPolicy, type PermissionPolicyClient, type PermissionRules } from "../collaboration/PermissionPolicy";
import { applyPermissionOverrides, clonePermissionRules, effectivePermission, mergePermissionRules, narrowerPermissionScope, permissionChanges, permissionValue, type PermissionChange, type PermissionOverrides } from "../collaboration/PermissionEditor";

type Hooks = { current: () => boolean; watch: (check: () => void) => () => void; legacy?: () => void };

/** An online administrative form. Never queues permission changes or retries a
 * save automatically. Closing and account changes invalidate all late results. */
export class PermissionPolicyModal extends Modal {
	private base?: PermissionPolicy;
	private proposed?: PermissionRules;
	private remote?: PermissionPolicy;
	private choices = new Map<string, "mine" | "current">();
	private phase: "loading" | "edit" | "review" | "saving" | "recover" | "conflict" | "discard" | "closed" = "loading";
	private previousPhase: typeof this.phase = "edit";
	private stopWatching?: () => void;
	private live = true;
	private generation = 0;
	private page = 0;
	private message = "";
	private previewPath = "";
	private replaceNarrower = false;
	private draftChanged = false;
	private draft: PermissionOverrides = { user_id: "", path: "", recursive: true, file: "read", comment: "allow" };
	constructor(app: App, private client: Pick<PermissionPolicyClient, "read" | "save">, private hooks: Hooks) { super(app); }
	async onOpen(): Promise<void> {
		this.setTitle("File and comment permissions");
		this.contentEl.addClass("evc-permission-editor");
		this.stopWatching = this.hooks.watch(() => { if (!this.hooks.current()) this.invalidate(); });
		await this.load();
	}
	private current(): boolean { if (!this.live) return false; if (!this.hooks.current()) { this.invalidate(); return false; } return true; }
	invalidate(): void { if (!this.live) return; this.live = false; this.phase = "closed"; super.close(); this.onClose(); }
	onClose(): void { this.live = false; this.phase = "closed"; this.generation++; this.stopWatching?.(); this.stopWatching = undefined; this.base = undefined; this.proposed = undefined; this.remote = undefined; this.choices.clear(); this.contentEl.empty(); }
	close(): void {
		if (this.live && this.phase !== "discard" && (this.phase === "saving" || this.phase === "recover" || this.draftChanged || this.dirty())) {
			this.previousPhase = this.phase; this.phase = "discard"; this.render(); return;
		}
		super.close();
	}
	private dirty(): boolean { return !!this.base && !!this.proposed && permissionChanges(this.base, this.proposed).length > 0; }
	private button(parent: HTMLElement, label: string, action: () => void, disabled = false): HTMLButtonElement {
		const b = parent.createEl("button", { text: label }); b.disabled = disabled;
		b.onclick = () => { if (this.current()) action(); }; return b;
	}
	private async load(reconcile = false): Promise<void> {
		if (!this.current() || this.phase === "saving") return;
		const request = ++this.generation; this.phase = "loading"; this.message = ""; this.render();
		try {
			const policy = await this.client.read(); if (!this.current() || request !== this.generation) return;
			if (reconcile && this.base && this.proposed) {
				if (!permissionChanges(policy, this.proposed).length) {
					this.base = policy; this.proposed = clonePermissionRules(policy); this.phase = "edit";
					this.message = "The server currently has your proposed rules. No additional save was sent.";
				} else { this.remote = policy; this.choices.clear(); this.phase = "conflict"; }
			} else { this.base = policy; this.proposed = clonePermissionRules(policy); this.phase = "edit"; }
			this.render();
		} catch (error) { if (!this.current() || request !== this.generation) return; this.fail(error); }
	}
	private fail(error: unknown): void {
		const code = error instanceof PermissionPolicyError ? error.code : "unconfirmed";
		if (code === "account_changed") { this.invalidate(); return; }
		if (code === "forbidden" || code === "authentication_required" || code === "unavailable") {
			this.base = undefined; this.proposed = undefined; this.remote = undefined;
			this.phase = "recover"; this.message = code === "unavailable" ? "Combined file and comment permissions are unavailable on this server." : "Your current account cannot manage these permissions. Sign in as the share owner or a server administrator.";
			this.render();
			if (code === "unavailable" && this.hooks.legacy) this.button(this.contentEl, "Open file-only permissions", () => { const open = this.hooks.legacy; this.invalidate(); open?.(); });
			return;
		}
		this.phase = "recover";
		this.message = code === "changed" ? "Permissions changed since this form was loaded. Read the current policy before continuing." :
			code === "member_changed" ? "A target member changed or is no longer eligible. Read the current policy and review the affected rules." :
			code === "invalid" ? "The request or response could not be validated. Read the current policy before continuing; a save may already have completed." :
			"The server response was not confirmed. If you were saving, the change may already have completed. Read the current policy before deciding what to do next.";
		this.render();
	}
	private async save(): Promise<void> {
		if (!this.current() || this.phase !== "review" || !this.base || !this.proposed || !this.dirty()) return;
		const request = ++this.generation, base = this.base, proposed = clonePermissionRules(this.proposed);
		this.phase = "saving"; this.message = ""; this.render();
		try {
			const result = await this.client.save(base, proposed); if (!this.current() || request !== this.generation) return;
			this.base = result; this.proposed = clonePermissionRules(result); this.phase = "edit"; this.message = "Permissions saved."; this.render();
		} catch (error) { if (!this.current() || request !== this.generation) return; this.fail(error); }
	}
	private summary(parent: HTMLElement, change: PermissionChange): void {
		const user = this.base?.members.find(m => m.user_id === change.scope.user_id);
		parent.createEl("p", { text: `${user?.email ?? change.scope.user_id} · ${change.scope.path || "Whole share"} · ${change.scope.recursive ? "With descendants" : "Exact file"} · ${change.kind === "file_rules" ? "Files" : "Comments"}: ${permissionValue(change.before)} → ${permissionValue(change.after)}` });
	}
	private paged<T>(items: T[], render: (item: T, parent: HTMLElement) => void): void {
		this.page = Math.min(this.page, Math.max(0, Math.ceil(items.length / 50) - 1));
		const list = this.contentEl.createDiv();
		for (const item of items.slice(this.page * 50, (this.page + 1) * 50)) render(item, list);
		if (items.length > 50) {
			list.createEl("p", { text: `Page ${this.page + 1} of ${Math.ceil(items.length / 50)}` });
			this.button(list, "Previous page", () => { this.page--; this.render(); }, this.page === 0);
			this.button(list, "Next page", () => { this.page++; this.render(); }, (this.page + 1) * 50 >= items.length);
		}
	}
	private render(): void {
		if (!this.current()) return;
		const el = this.contentEl; el.empty();
		const status = el.createEl("p", { attr: { role: "status", "aria-live": "polite" }, text: this.message });
		if (this.phase === "loading" || this.phase === "saving") { status.setText(this.phase === "loading" ? "Reading current permissions…" : "Saving permissions…"); return; }
		if (this.phase === "discard") {
			status.setText("Close this editor? Unsaved changes will be discarded. A save already sent may still complete on the server.");
			this.button(el, "Keep editing", () => { this.phase = this.previousPhase; this.render(); });
			this.button(el, "Close editor", () => this.invalidate()); return;
		}
		if (this.phase === "recover") { this.button(el, "Read current permissions", () => { void this.load(!!this.base); }); return; }
		if (!this.base || !this.proposed) return;
		if (this.phase === "conflict" && this.remote) {
			el.createEl("p", { text: "Compare your proposal with the current server policy. Unrelated server changes are retained. Parent and child rules can interact even when they are different rows; review effective access before saving again." });
			const merged = mergePermissionRules(this.base, this.proposed, this.remote, this.choices);
			this.paged(merged.conflicts, (conflict, parent) => {
				this.summary(parent, conflict); parent.createEl("p", { text: `Current server value: ${permissionValue(conflict.current)}` });
				const select = parent.createEl("select", { attr: { "aria-label": `Conflict for ${conflict.scope.path || "whole share"}: ${conflict.kind}` } });
				for (const [value, label] of [["", "Choose a value"], ["mine", "Use my proposal"], ["current", "Keep server value"]]) select.createEl("option", { attr: { value }, text: label });
				select.value = this.choices.get(conflict.id) ?? ""; select.onchange = () => { if (select.value) this.choices.set(conflict.id, select.value as "mine" | "current"); else this.choices.delete(conflict.id); accept.disabled = merged.conflicts.some(c => !this.choices.has(c.id)); };
			});
			const accept = this.button(el, "Review merged proposal", () => {
				const result = mergePermissionRules(this.base!, this.proposed!, this.remote!, this.choices);
				if (result.conflicts.some(c => !this.choices.has(c.id))) return;
				this.base = this.remote; this.remote = undefined; this.proposed = result.rules; this.phase = "edit"; this.page = 0;
				this.message = "Current server changes are included. Check the proposal and effective access, then review changes before saving."; this.render();
			}, merged.conflicts.some(c => !this.choices.has(c.id)));
			this.button(el, "Use server policy and discard my proposal", () => { this.base = this.remote; this.proposed = clonePermissionRules(this.remote!); this.remote = undefined; this.phase = "edit"; this.page = 0; this.message = "Server policy loaded; your proposal was discarded."; this.render(); });
			return;
		}
		if (this.phase === "review") {
			const changes = permissionChanges(this.base, this.proposed);
			el.createEl("h3", { text: `Review ${changes.length} rule ${changes.length === 1 ? "change" : "changes"}` });
			el.createEl("p", { text: "Only saving applies this proposal. Unlisted rules are preserved. More-specific rules may override folder presets. Removing a rule restores inheritance; it does not necessarily remove access. Revocation prevents further server access but cannot recall copies already downloaded." });
			this.paged(changes, (change, parent) => this.summary(parent, change));
			this.button(el, "Back to editing", () => { this.phase = "edit"; this.page = 0; this.render(); });
			this.button(el, "Save permissions", () => { void this.save(); }, !changes.length).addClass("mod-cta"); return;
		}
		this.renderEditor();
	}
	private renderEditor(): void {
		const el = this.contentEl, base = this.base!, proposed = this.proposed!, draft = this.draft;
		el.createEl("p", { text: "File access and commenting are independent. Members start hidden; the most specific path wins, with exact rules winning ties. Editors can comment unless a comment rule denies it. Comment allowance never grants file reading. Owners and administrators keep full access." });
		el.createEl("p", { text: "Changes stay in this editor until saved. A folder preset preserves narrower exceptions unless you explicitly replace them below." });
		const eligible = base.members.filter(m => m.active && !m.administrator && m.user_id !== base.owner_id);
		if (!draft.user_id) draft.user_id = eligible[0]?.user_id ?? "";
		const form = el.createDiv({ cls: "evc-permission-fields" });
		const select = (label: string, values: [string, string][], value: string, change: (v: string) => void) => {
			const wrapper = form.createEl("label", { text: label }); const input = wrapper.createEl("select", { attr: { "aria-label": label } });
			for (const [v, text] of values) input.createEl("option", { attr: { value: v }, text }); input.value = value; input.onchange = () => { if (!this.current()) return; change(input.value); this.draftChanged = true; updatePreview(); }; return input;
		};
		const memberOptions: [string, string][] = eligible.map(m => [m.user_id, m.email]);
		if (draft.user_id && !eligible.some(m => m.user_id === draft.user_id)) memberOptions.unshift([draft.user_id, `${base.members.find(m => m.user_id === draft.user_id)?.email ?? draft.user_id} (unavailable; remove rules only)`]);
		select("Member", memberOptions, draft.user_id, v => { draft.user_id = v; });
		const pathLabel = form.createEl("label", { text: "Path within this share (empty means whole share)" });
		const path = pathLabel.createEl("input", { attr: { type: "text", value: draft.path, "aria-label": "Rule path", placeholder: "Projects or Projects/Note.md" } });
		path.oninput = () => { draft.path = path.value; this.draftChanged = true; updatePreview(); };
		const recurseLabel = form.createEl("label", { text: "Include descendants" });
		const recurse = recurseLabel.createEl("input", { attr: { type: "checkbox", "aria-label": "Include descendants" } }); recurse.checked = draft.recursive;
		recurse.onchange = () => { draft.recursive = recurse.checked; this.draftChanged = true; updatePreview(); };
		select("Preset", [["custom", "Custom"], ["reviewer", "Read and comment"], ["reader", "Read only, no comments"], ["editor", "Edit and comment"], ["hidden", "Hidden"]], "custom", value => {
			if (value === "custom") return;
			draft.file = value === "hidden" ? "none" : value === "editor" ? "write" : "read";
			draft.comment = value === "reviewer" || value === "editor" ? "allow" : "deny";
			files.value = draft.file; comments.value = draft.comment;
		});
		const files = select("File override", [["inherit", "Inherit (remove this override)"], ["none", "Hidden"], ["read", "Read"], ["write", "Edit"]], draft.file, v => { draft.file = v as PermissionOverrides["file"]; });
		const comments = select("Comment override", [["inherit", "Inherit (remove this override)"], ["allow", "Allow comments"], ["deny", "Deny comments"]], draft.comment, v => { draft.comment = v as PermissionOverrides["comment"]; });
		const exceptionLabel = form.createEl("label", { text: "Also remove this member’s narrower file and comment exceptions" });
		const exceptions = exceptionLabel.createEl("input", { attr: { type: "checkbox", "aria-label": "Replace narrower exceptions" } }); exceptions.checked = this.replaceNarrower;
		exceptions.onchange = () => { this.replaceNarrower = exceptions.checked; this.draftChanged = true; updatePreview(); };
		const previewLabel = form.createEl("label", { text: "Preview access to an exact file" });
		const exact = previewLabel.createEl("input", { attr: { type: "text", value: this.previewPath, "aria-label": "Preview file path", placeholder: "Projects/Note.md" } });
		exact.oninput = () => { this.previewPath = exact.value; updatePreview(); };
		const preview = el.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		const updatePreview = () => {
			try {
				const pending = applyPermissionOverrides(proposed, draft, this.replaceNarrower), effective = effectivePermission(base, pending, draft.user_id, this.previewPath || (!draft.recursive ? draft.path : ""));
				const count = [...proposed.file_rules, ...proposed.comment_rules].filter(r => narrowerPermissionScope(r, draft)).length;
				preview.setText(`With this draft: ${effective.read ? "Read" : "No read"}, ${effective.edit ? "edit" : "no edit"}, ${effective.comment ? "comment" : "no comment"}. ${effective.explanation} ${count} narrower overrides ${this.replaceNarrower ? "will be removed" : "are preserved"}. This is a rules preview, not a check that the file exists or that every Bases dependency is readable.`);
			} catch { preview.setText("Choose a member and enter a canonical relative path. Empty paths must include descendants. Hidden path segments and noncanonical text encodings are not supported."); }
		};
		updatePreview();
		this.button(el, "Add or update proposal", () => {
			try {
				const pending = applyPermissionOverrides(proposed, draft, this.replaceNarrower);
				if (!eligible.some(m => m.user_id === draft.user_id) && permissionChanges(proposed, pending).some(c => !!c.after)) throw new Error("unavailable member");
				this.proposed = pending; this.draftChanged = false; this.message = "Proposal updated; nothing has been saved yet."; this.replaceNarrower = false; this.render();
			} catch { preview.setText("Cannot add these rules. Check the member, canonical relative path and 1,000-rule limit per rule type. Unavailable members’ existing rules may only be removed."); }
		}, !draft.user_id);
		el.createEl("h3", { text: "Proposed rules" });
		const keys = new Map([...proposed.file_rules, ...proposed.comment_rules].map(r => [permissionRuleKey(r), r]));
		const rows = [...keys].sort(([a], [b]) => a.localeCompare(b));
		this.paged(rows, ([key, scope], parent) => {
			const file = proposed.file_rules.find(r => permissionRuleKey(r) === key), comment = proposed.comment_rules.find(r => permissionRuleKey(r) === key);
			const member = base.members.find(m => m.user_id === scope.user_id);
			parent.createEl("p", { text: `${member?.email ?? scope.user_id}${!member?.active ? " (unavailable)" : ""} · ${scope.path || "Whole share"} · ${scope.recursive ? "With descendants" : "Exact file"} · ${permissionValue(file)} · ${permissionValue(comment)}` });
			this.button(parent, "Edit rule", () => { if (this.draftChanged) { preview.setText("Add or discard your field changes before editing another rule."); return; } this.draft = { user_id: scope.user_id, path: scope.path, recursive: scope.recursive, file: file?.permission ?? "inherit", comment: comment ? comment.allowed ? "allow" : "deny" : "inherit" }; this.replaceNarrower = false; this.draftChanged = false; this.render(); this.contentEl.querySelector<HTMLInputElement>('[aria-label="Rule path"]')?.focus(); });
			this.button(parent, "Remove overrides", () => { this.proposed = applyPermissionOverrides(proposed, { ...scope, file: "inherit", comment: "inherit" }); this.message = "Overrides removed from the proposal. Inherited rules now apply; nothing has been saved."; this.render(); });
		});
		this.button(el, "Discard field changes", () => { this.draft = { user_id: draft.user_id, path: "", recursive: true, file: "read", comment: "allow" }; this.replaceNarrower = false; this.draftChanged = false; this.render(); });
		this.button(el, "Review changes", () => { if (this.draftChanged) { preview.setText("Add or update the proposal first, or discard the field changes before reviewing."); return; } this.phase = "review"; this.page = 0; this.message = ""; this.render(); }, !this.dirty());
	}
}
