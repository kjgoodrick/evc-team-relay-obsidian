/** @jest-environment jsdom */
import type { App } from "obsidian";
import { PermissionPolicyModal } from "../../src/ui/PermissionPolicyModal";
import { PermissionPolicyError, type PermissionPolicy, type PermissionRules } from "../../src/collaboration/PermissionPolicy";
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
jest.mock("obsidian", () => ({ Modal: class {
	contentEl = document.createElement("div"); setTitle() {} close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
Object.assign(HTMLElement.prototype, { addClass(this: HTMLElement, value: string) { this.classList.add(value); }, empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = (): PermissionPolicy => ({ version: 1, share_id: id(1), actor_id: id(2), owner_id: id(2), revision: "a".repeat(64), comment_revision: 0,
	file_rules: [{ user_id: id(3), path: "Existing.md", recursive: false, permission: "read" }], comment_rules: [], members: [{ user_id: id(3), email: "reviewer@example.test", active: true, administrator: false }] });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function fixture() {
	let current = true, watch!: () => void;
	const stop = jest.fn(), legacy = jest.fn();
	const client = { read: jest.fn().mockResolvedValue(base()), save: jest.fn(async (_base: PermissionPolicy, rules: PermissionRules) => ({ ...base(), ...rules, revision: "b".repeat(64) })) };
	const modal = new PermissionPolicyModal({} as App, client, { current: () => current, watch: check => { watch = check; return stop; }, legacy });
	document.body.append(modal.contentEl); await modal.onOpen();
	const field = (name: string) => modal.contentEl.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${name}"]`)!;
	const change = (name: string, value: string | boolean) => { const el = field(name); if (typeof value === "boolean") (el as HTMLInputElement).checked = value; else el.value = value; el.dispatchEvent(new Event(el.tagName === "SELECT" || typeof value === "boolean" ? "change" : "input")); };
	const button = (label: string) => [...modal.contentEl.querySelectorAll("button")].find(b => b.textContent === label)!;
	return { modal, client, stop, legacy, field, change, button, click: (label: string) => button(label).click(), invalidate: () => { current = false; watch(); }, cleanup: () => { modal.invalidate(); modal.contentEl.remove(); } };
}

test("reviewer preset requires review, saves both lists once, preserves unrelated rules and explains exact access", async () => {
	const f = await fixture(); try {
		f.change("Rule path", "Projects"); f.change("Preset", "reviewer"); f.change("Preview file path", "Projects/Note.md");
		expect(f.modal.contentEl.textContent).toContain("Read, no edit, comment");
		f.click("Add or update proposal"); expect(f.client.save).not.toHaveBeenCalled();
		f.click("Review changes"); expect(f.modal.contentEl.textContent).toContain("Inherit → Read");
	} finally { f.cleanup(); }
});

test("successful save commits the reviewed proposal and closing clean state disposes watchers", async () => {
	const f = await fixture(); try {
		f.change("Rule path", "Projects"); f.click("Add or update proposal"); f.click("Review changes");
		expect(f.modal.contentEl.textContent).toContain("Review 2 rule changes"); f.click("Save permissions"); await flush();
		expect(f.client.save).toHaveBeenCalledTimes(1); expect(f.client.save.mock.calls[0][1]).toMatchObject({ file_rules: [{ path: "Existing.md" }, { path: "Projects", permission: "read" }], comment_rules: [{ path: "Projects", allowed: true }] });
		expect(f.modal.contentEl.textContent).toContain("Permissions saved."); f.modal.close(); expect(f.stop).toHaveBeenCalledTimes(1);
	} finally { f.cleanup(); }
});

test("lost successful save reconciles by read without resubmitting", async () => {
	const f = await fixture(); try {
		f.client.save.mockImplementationOnce(async (_base, rules) => { f.client.read.mockResolvedValue({ ...base(), ...rules, revision: "b".repeat(64) }); throw new PermissionPolicyError("unconfirmed"); });
		f.change("Rule path", "Projects"); f.click("Add or update proposal"); f.click("Review changes"); f.click("Save permissions"); await flush();
		expect(f.modal.contentEl.textContent).toContain("may already have completed"); expect(f.button("Save permissions")).toBeUndefined();
		f.click("Read current permissions"); await flush(); expect(f.modal.contentEl.textContent).toContain("No additional save was sent"); expect(f.client.save).toHaveBeenCalledTimes(1);
	} finally { f.cleanup(); }
});

test("concurrent change requires per-rule resolution, retains a new remote member rule and saves against the fresh revision", async () => {
	const f = await fixture(); try {
		f.click("Edit rule"); f.change("File override", "write"); f.click("Add or update proposal"); f.click("Review changes");
		f.client.save.mockRejectedValueOnce(new PermissionPolicyError("changed", 409)); f.click("Save permissions"); await flush();
		const remote = base(); remote.revision = "c".repeat(64); remote.file_rules[0].permission = "none"; remote.file_rules.push({ user_id: id(4), path: "Other.md", recursive: false, permission: "read" });
		f.client.read.mockResolvedValue(remote); f.click("Read current permissions"); await flush();
		expect(f.button("Review merged proposal").disabled).toBe(true);
		const conflict = f.modal.contentEl.querySelector("select")!; conflict.value = "mine"; conflict.dispatchEvent(new Event("change"));
		f.click("Review merged proposal"); expect(f.client.save).toHaveBeenCalledTimes(1); f.click("Review changes"); f.click("Save permissions"); await flush();
		expect(f.client.save.mock.calls[1][0].revision).toBe(remote.revision);
		expect(f.client.save.mock.calls[1][1].file_rules).toContainEqual(remote.file_rules[1]);
	} finally { f.cleanup(); }
});

test("account loss clears visible rules and rejects a delayed save response; no network diagnostics are shown", async () => {
	const f = await fixture(); try {
		let finish!: (value: PermissionPolicy) => void; f.client.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.change("Rule path", "Projects"); f.click("Add or update proposal"); f.click("Review changes"); f.click("Save permissions");
		f.invalidate(); finish(base()); await flush(); expect(f.modal.contentEl.textContent).toBe(""); expect(f.stop).toHaveBeenCalledTimes(1);
	} finally { f.cleanup(); }
});

test("unsaved close asks to discard, keeps the form if cancelled, and unavailable APIs offer only an explicit legacy choice", async () => {
	const f = await fixture(); try {
		f.change("Rule path", "Projects"); f.click("Add or update proposal"); f.modal.close();
		expect(f.modal.contentEl.textContent).toContain("Unsaved changes will be discarded"); f.click("Keep editing"); expect(f.button("Review changes").disabled).toBe(false);
		f.client.save.mockRejectedValueOnce(new PermissionPolicyError("unavailable")); f.click("Review changes"); f.click("Save permissions"); await flush();
		expect(f.modal.contentEl.textContent).not.toContain("reviewer@example.test"); expect(f.legacy).not.toHaveBeenCalled(); f.click("Open file-only permissions"); expect(f.legacy).toHaveBeenCalledTimes(1);
	} finally { f.cleanup(); }
});

test("unapplied fields survive removing a different row and prevent accidental close or incomplete review", async () => {
	const f = await fixture(); try {
		f.change("Rule path", "日本語/Note.md"); f.change("Include descendants", false); f.change("File override", "write");
		f.click("Remove overrides"); expect(f.field("Rule path").value).toBe("日本語/Note.md"); expect(f.field("File override").value).toBe("write");
		f.click("Review changes"); expect(f.modal.contentEl.textContent).toContain("Add or update the proposal first"); expect(f.button("Save permissions")).toBeUndefined();
		f.modal.close(); expect(f.button("Keep editing")).toBeDefined(); f.click("Keep editing");
		f.click("Add or update proposal"); f.click("Review changes"); f.click("Save permissions"); await flush();
		expect(f.client.save.mock.calls[0][1].file_rules).toEqual([{ user_id: id(3), path: "日本語/Note.md", recursive: false, permission: "write" }]);
	} finally { f.cleanup(); }
});

test("replacing narrower exceptions is explicit and the review lists each removal", async () => {
	const f = await fixture(); try {
		f.change("Preview file path", "Existing.md"); expect(f.modal.contentEl.textContent).toContain("1 narrower overrides are preserved");
		f.change("Replace narrower exceptions", true); expect(f.modal.contentEl.textContent).toContain("will be removed");
		f.click("Add or update proposal"); f.click("Review changes"); expect(f.modal.contentEl.textContent).toContain("Existing.md"); expect(f.modal.contentEl.textContent).toContain("Read → Inherit");
		f.click("Save permissions"); await flush(); expect(f.client.save.mock.calls[0][1].file_rules).toEqual([{ user_id: id(3), path: "", recursive: true, permission: "read" }]);
	} finally { f.cleanup(); }
});

test("a restore preserves the proposal and requires a current read and explicit review before a new save", async () => {
	const f = await fixture(); try {
		f.change("Rule path", "Projects"); f.click("Add or update proposal"); f.click("Review changes");
		f.client.save.mockRejectedValueOnce(new PermissionPolicyError("restore_changed", 409)); f.click("Save permissions"); await flush();
		expect(f.modal.contentEl.textContent).toContain("share was restored"); expect(f.modal.contentEl.textContent).toContain("proposal is preserved");
		expect(f.button("Save permissions")).toBeUndefined();
		const restored = { ...base(), restore_guard: true, restore_generation: id(8), revision: "d".repeat(64) };
		restored.file_rules.push({ user_id: id(3), path: "Projects/Secret.md", recursive: false, permission: "none" });
		f.client.read.mockResolvedValue(restored); f.click("Read current permissions"); await flush();
		expect(f.client.save).toHaveBeenCalledTimes(1); f.click("Review merged proposal");
		expect(f.client.save).toHaveBeenCalledTimes(1); f.click("Review changes"); f.click("Save permissions"); await flush();
		expect(f.client.save.mock.calls[1][0]).toMatchObject({ restore_generation: id(8), revision: restored.revision });
		expect(f.client.save.mock.calls[1][1].file_rules).toContainEqual(restored.file_rules[1]);
		expect(f.client.save.mock.calls[1][1].comment_rules).toContainEqual({ user_id: id(3), path: "Projects", recursive: true, allowed: true });
	} finally { f.cleanup(); }
});
