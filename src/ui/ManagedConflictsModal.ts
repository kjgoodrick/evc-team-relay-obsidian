import { App, Modal, Notice, Setting } from "obsidian";
import type { VaultShare } from "../VaultShare";
import { CONFLICTS, select, type StructuralConflict } from "../client/managedRecovery";
import { RECOVERY_FOLDER } from "../conflictCopyPath";
import type { ManagedRestoreReview } from "../client/ManagedIndexTransport";

export class ManagedConflictsModal extends Modal {
	private busy = false;
	private error = "";
	private savedPath = "";
	private opened = false;
	private readonly changed = () => { if (!this.busy) this.render(); };
	constructor(app: App, private share: VaultShare) { super(app); }
	onOpen(): void { this.opened = true; this.contentEl.addClass("evc-managed-conflicts"); this.share.crdtDoc.getMap(CONFLICTS).observe(this.changed); this.share.crdtDoc.getMap("managed_base_v1").observe(this.changed); this.render(); }
	onClose(): void { this.opened = false; this.share.crdtDoc.getMap(CONFLICTS).unobserve(this.changed); this.share.crdtDoc.getMap("managed_base_v1").unobserve(this.changed); this.contentEl.empty(); }
	private render(): void {
		if (!this.opened) return;
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "File and folder conflicts" });
		if (this.error) this.contentEl.createEl("p", { text: this.error, cls: "mod-warning" });
		if (this.savedPath) this.contentEl.createEl("p", { text: `Verified recovery copy: ${this.savedPath}` });
		const restore = this.share.crdtDoc.getMap<ManagedRestoreReview>("managed_base_v1").get("restoreReview");
		if (restore) {
			this.contentEl.createEl("h3", { text: "Shared folder restored" });
			this.contentEl.createEl("p", { text: "Synchronization is paused for this shared folder. Local files, pending inventory changes and the previous inventory are retained. Ordinary conflict choices cannot resume synchronization after a restore." });
			this.contentEl.createEl("p", { text: `${Object.keys(restore.local).length} local inventory entries were retained when the restore was detected. Further local edits stay on this device.` });
			this.contentEl.createEl("p", { text: "Keep this local copy until recovery of the restored share is complete." });
			new Setting(this.contentEl).setName("Save local recovery copy")
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- Bases is the Obsidian feature name.
				.setDesc("Copy this folder’s local files, unsaved text and known editing histories to a verified archive on this device. Comments and pending Bases changes need their separate recovery exports. Synchronization stays paused.")
				.addButton(button => button.setButtonText(this.busy ? "Saving recovery copy…" : "Save local recovery copy").setDisabled(this.busy).onClick(() => this.saveRestoreCopy()));
			return;
		}
		this.contentEl.createEl("p", { text: `Unrelated files continue syncing. Disputed files stay on this device until you choose. Each decision first saves file contents and local editing history under “${RECOVERY_FOLDER}”. These recovery files never sync.` });
		const index = this.share._liveProvider.managedIndex;
		const conflicts = [...this.share.crdtDoc.getMap<StructuralConflict>(CONFLICTS).values()];
		if (!conflicts.length) this.contentEl.createEl("p", { text: "No file conflicts need a decision." });
		for (const conflict of conflicts) {
			this.contentEl.createEl("h3", { text: Object.keys(conflict.local).join(", ") || conflict.paths.join(", ") });
			this.contentEl.createEl("p", { text: conflict.reason });
			const reviewed = select(index?.snapshot.records ?? {}, conflict);
			this.contentEl.createEl("p", { text: `This device: ${Object.keys(conflict.local).join(", ") || "Deleted locally"}` });
			this.contentEl.createEl("p", { text: `Server (visible to you): ${Object.keys(reviewed).join(", ") || "Deleted or no longer accessible"}` });
			new Setting(this.contentEl).setName("Use server layout")
				.setDesc("Archive the affected local originals, then load the server layout. Local edits remain in the recovery folder and document history.")
				.addButton(button => button.setButtonText("Use server layout").setDisabled(this.busy || !index).onClick(() => this.resolve(conflict.id, "server", reviewed)));
			new Setting(this.contentEl).setName("Keep my local layout")
				.setDesc("Retry your move, deletion, or file change against the current server state. Requires permission at every affected path. A deleted file identity cannot be restored this way; use the recovery copy to create a new file.")
				.addButton(button => button.setButtonText("Keep my local layout").setDisabled(this.busy || !index).onClick(() => this.resolve(conflict.id, "local", reviewed)));
		}
	}
	private async saveRestoreCopy(): Promise<void> {
		if (this.busy) return;
		this.busy = true; this.error = ""; this.savedPath = ""; this.render();
		try {
			this.savedPath = await this.share.saveManagedRestoreRecoveryCopy();
			new Notice(`Local recovery copy saved and verified: ${this.savedPath}`, 12000);
		} catch (error) { this.error = error instanceof Error ? error.message : String(error); }
		finally { this.busy = false; this.render(); }
	}
	private async resolve(id: string, choice: "server" | "local", reviewed: ReturnType<typeof select>): Promise<void> {
		if (this.busy) return;
		this.busy = true; this.error = ""; this.render();
		try {
			const path = await this.share.resolveManagedConflict(id, choice, reviewed);
			new Notice(`Conflict resolved. Recovery files: ${path}`, 12000);
		} catch (error) { this.error = error instanceof Error ? error.message : String(error); }
		finally { this.busy = false; this.render(); }
	}
}
