import { App, Modal, Notice, Setting } from "obsidian";
import type { PathRule, RelayOnPremShareClient, ShareMember } from "../RelayOnPremShareClient";

export class PathPermissionsModal extends Modal {
	private rules: PathRule[] = [];
	constructor(app: App, private client: RelayOnPremShareClient, private shareId: string, private members: ShareMember[]) { super(app); }

	async onOpen(): Promise<void> {
		this.contentEl.setText("Loading file permissions…");
		try { this.rules = await this.client.getPathRules(this.shareId); this.render(); }
		catch (error) { this.contentEl.setText(String(error)); }
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "File and folder permissions" });
		this.contentEl.createEl("p", { text: "Members start with no file access. The most specific path wins; an exact file rule overrides a folder rule. Owners and server administrators keep full access." });
		for (const [index, rule] of this.rules.entries()) {
			const member = this.members.find(m => m.user_id === rule.user_id);
			new Setting(this.contentEl).setName(`${member?.user_email ?? rule.user_id} · ${rule.path || "Whole share"}`)
				.setDesc(`${rule.recursive ? "Folder and descendants" : "Exact file"} · ${rule.permission === "none" ? "Hidden" : rule.permission === "read" ? "Read only" : "Read and write"}`)
				.addButton(button => button.setButtonText("Remove rule").onClick(() => { this.rules.splice(index, 1); this.render(); }));
		}
		if (this.members.length) {
			let user = this.members[0].user_id;
			let path = "";
			let recursive = true;
			let permission: PathRule["permission"] = "read";
			new Setting(this.contentEl).setName("Member").addDropdown(dropdown => {
				for (const m of this.members) dropdown.addOption(m.user_id, m.user_email);
				dropdown.setValue(user).onChange(value => { user = value; });
			});
			new Setting(this.contentEl).setName("Path within this share").setDesc("For example Projects or Projects/Budget.md. Leave empty for the whole share.")
				.addText(text => text.setPlaceholder("Projects/Budget.md").onChange(value => { path = value; }));
			new Setting(this.contentEl).setName("Include descendants").setDesc("Enable for a folder rule; disable for one exact file.")
				.addToggle(toggle => toggle.setValue(true).onChange(value => { recursive = value; }));
			new Setting(this.contentEl).setName("Access").addDropdown(dropdown => dropdown
				.addOption("none", "Hidden").addOption("read", "Read only").addOption("write", "Read and write")
				.setValue(permission).onChange(value => { permission = value as PathRule["permission"]; }));
			new Setting(this.contentEl).addButton(button => button.setButtonText("Add rule").onClick(() => {
				const existing = this.rules.find(r => r.user_id === user && r.path === path && r.recursive === recursive);
				if (existing) existing.permission = permission;
				else this.rules.push({ user_id: user, path, recursive, permission });
				this.render();
			}));
		}
		new Setting(this.contentEl).addButton(button => button.setButtonText("Save permissions").setCta().onClick(async () => {
			button.setDisabled(true);
			try { await this.client.setPathRules(this.shareId, this.rules); new Notice("File permissions saved"); this.close(); }
			catch (error) { new Notice(String(error)); button.setDisabled(false); }
		}));
	}
}
