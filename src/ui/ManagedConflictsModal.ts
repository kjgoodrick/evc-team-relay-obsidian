import { App, Modal, Notice, Setting } from "obsidian";
import type { VaultShare } from "../VaultShare";
import { CONFLICTS, select, type StructuralConflict } from "../client/managedRecovery";
import { RECOVERY_FOLDER } from "../conflictCopyPath";
import type { ManagedRestoreReview, ManagedRestoreInspection } from "../client/ManagedIndexTransport";
import { compareRestoreInventory, type RestoreInventoryStatus } from "../client/managedRestoreInspection";

export class ManagedConflictsModal extends Modal {
	private busy = false;
	private error = "";
	private savedPath = "";
	private opened = false;
	private inspecting = false;
	private inspection?: ManagedRestoreInspection;
	private inspectionRequest = 0;
	private page = 0;
	private detachAuth?: () => void;
	private readonly changed = () => { this.inspectionRequest++; this.inspection = undefined; this.page = 0; if (!this.busy) this.render(); };
	constructor(app: App, private share: VaultShare) { super(app); }
	onOpen(): void { this.opened = true; this.contentEl.addClass("evc-managed-conflicts"); this.share.crdtDoc.getMap(CONFLICTS).observe(this.changed); this.share.crdtDoc.getMap("managed_base_v1").observe(this.changed); this.share.crdtDoc.getMap("filemeta_v0").observe(this.changed); this.detachAuth = this.share.authSession?.on(this.changed); this.render(); }
	onClose(): void { this.opened = false; this.inspectionRequest++; this.inspection = undefined; this.detachAuth?.(); this.detachAuth = undefined; this.share.crdtDoc.getMap(CONFLICTS).unobserve(this.changed); this.share.crdtDoc.getMap("managed_base_v1").unobserve(this.changed); this.share.crdtDoc.getMap("filemeta_v0").unobserve(this.changed); this.contentEl.empty(); }
	private render(): void {
		if (!this.opened) return;
		try { this.inspection?.check?.(); }
		catch { this.inspection = undefined; this.page = 0; this.error = "The connection or inventory changed. Refresh the comparison."; }
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
				.addButton(button => button.setButtonText(this.busy && !this.inspecting ? "Saving recovery copy…" : "Save local recovery copy").setDisabled(this.busy).onClick(() => this.saveRestoreCopy()));
			new Setting(this.contentEl).setName("Compare current server inventory")
				.setDesc("Read the entries currently visible to your account and compare their locations with this device’s retained inventory. Files and queued changes stay paused.")
				.addButton(button => button.setButtonText(this.inspecting ? "Loading comparison…" : "Compare server inventory").setDisabled(this.busy).onClick(() => this.inspectRestore()));
			if (this.inspection?.reviewId === restore.id) this.renderInspection(this.inspection);
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
	private renderInspection(inspection: ManagedRestoreInspection): void {
		const rows = compareRestoreInventory(inspection.local, inspection.server.records), size = 50;
		this.page = Math.min(this.page, Math.max(0, Math.ceil(rows.length / size) - 1));
		this.contentEl.createEl("h3", { text: "Inventory comparison" });
		this.contentEl.createEl("p", { text: `Checked ${new Date(inspection.checkedAt).toLocaleString()}. ${rows.length} entries. File contents, unsaved text and untracked local files are not compared.` });
		this.contentEl.createEl("p", { text: "An entry missing from the visible server inventory may have been removed or may no longer be accessible. This comparison does not authorize resuming synchronization." });
		const labels: Record<RestoreInventoryStatus, string> = { same: "Same entry and location; contents not compared", "metadata-changed": "Recorded file metadata differs",
			moved: "Same entry at different locations", "local-only": "Retained locally; not currently visible on server", "server-only": "Visible on server; absent from local inventory", ambiguous: "Ambiguous identity or type; manual review needed" };
		for (const row of rows.slice(this.page * size, (this.page + 1) * size)) {
			this.contentEl.createEl("p", { text: `${row.localPaths.join(", ") || "No local inventory entry"} → ${row.serverPaths.join(", ") || "Not visible on server"}: ${labels[row.status]}${row.occupiedPath ? ". A different entry also uses this path." : ""}` });
		}
		if (rows.length > size) new Setting(this.contentEl).setName(`Page ${this.page + 1} of ${Math.ceil(rows.length / size)}`)
			.addButton(button => button.setButtonText("Previous page").setDisabled(this.page === 0 || this.busy).onClick(() => { this.page--; this.render(); }))
			.addButton(button => button.setButtonText("Next page").setDisabled((this.page + 1) * size >= rows.length || this.busy).onClick(() => { this.page++; this.render(); }));
	}
	private async inspectRestore(): Promise<void> {
		if (this.busy) return;
		this.busy = true; this.inspecting = true; this.error = ""; this.inspection = undefined; this.page = 0; this.render();
		const request = ++this.inspectionRequest;
		try {
			const inspection = await this.share.inspectManagedRestore();
			inspection.check?.();
			compareRestoreInventory(inspection.local, inspection.server.records);
			if (this.opened && request === this.inspectionRequest) this.inspection = inspection;
		} catch (error) { if (this.opened && request === this.inspectionRequest) this.error = error instanceof Error ? error.message : String(error); }
		finally { this.busy = false; this.inspecting = false; this.render(); }
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
