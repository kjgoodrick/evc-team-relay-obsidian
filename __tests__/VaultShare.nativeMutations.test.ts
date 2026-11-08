import { TFile, TFolder } from "obsidian";
import { VaultShare } from "../src/VaultShare";
import type { SyncableEntry } from "../src/SyncableEntry";
import { FileDiffView } from "../src/fileDiff/fileDiffView";
import { holdNativeSourceWrites } from "../src/storage/native-document-writes";

function fixture() {
	const vault = { adapter: { write: jest.fn(async () => {}), mkdir: jest.fn(async () => {}) }, modify: jest.fn(async () => {}) };
	const fileOps = { renameFile: jest.fn(async () => {}), trashFile: jest.fn(async () => {}) };
	const share = Object.create(VaultShare.prototype) as VaultShare;
	Object.assign(share, {
		path: "Team", vaultApi: vault, fileOps, ensureParentDir: jest.fn(async () => {}),
	});
	const relocate = jest.fn(), doc = { entryPath: "Old.md", relocate } as unknown as SyncableEntry;
	return { share, vault, fileOps, doc, relocate };
}

test.each(["Team/Old.md", "Team/New.md"])("a server move blocked at %s does not relocate the document and can retry", async path => {
	const s = fixture(), file = Object.assign(Object.create(TFile.prototype) as TFile, { path: "Team/Old.md" });
	const hold = holdNativeSourceWrites(s.vault, path);
	try {
		await expect(s.share._onServerRename(s.doc, "New.md", file)).rejects.toThrow("paused");
		expect(s.fileOps.renameFile).not.toHaveBeenCalled(); expect(s.relocate).not.toHaveBeenCalled();
	} finally { hold.release(); }
	await s.share._onServerRename(s.doc, "New.md", file);
	expect(s.fileOps.renameFile).toHaveBeenCalledWith(file, "Team/New.md"); expect(s.relocate).toHaveBeenCalledWith("New.md", s.share);
});

test("trashing an ancestor directory cannot bypass a descendant source hold", async () => {
	const s = fixture(), folder = Object.assign(Object.create(TFolder.prototype) as TFolder, { path: "Team" });
	const hold = holdNativeSourceWrites(s.vault, "Team/Subfolder");
	try { await expect(s.share.trashFile(folder)).rejects.toThrow("paused"); expect(s.fileOps.trashFile).not.toHaveBeenCalled(); }
	finally { hold.release(); }
	await s.share.trashFile(folder); expect(s.fileOps.trashFile).toHaveBeenCalledWith(folder);
});

test("folder and conflict-copy writes respect a held shared folder", async () => {
	const s = fixture(), hold = holdNativeSourceWrites(s.vault, "Team");
	try {
		await expect(s.share.makeFolder("Subfolder")).rejects.toThrow("paused");
		await expect(s.share.writeConflictCopy(s.doc, "saved edit", "local")).rejects.toThrow("paused");
		expect(s.vault.adapter.mkdir).not.toHaveBeenCalled(); expect(s.vault.adapter.write).not.toHaveBeenCalled();
	} finally { hold.release(); }
	await s.share.makeFolder("Subfolder"); await s.share.writeConflictCopy(s.doc, "saved edit", "local");
	expect(s.vault.adapter.mkdir).toHaveBeenCalledTimes(1); expect(s.vault.adapter.write).toHaveBeenCalledTimes(1);
});

test("a merge editor native save respects recovery admission", async () => {
	const s = fixture(), file = Object.assign(Object.create(TFile.prototype) as TFile, { path: "Team/Old.md" });
	const view = Object.assign(Object.create(FileDiffView.prototype) as FileDiffView, { app: { vault: s.vault } });
	const hold = holdNativeSourceWrites(s.vault, "Team");
	try { await expect(view.writeFile(file, "merged")).rejects.toThrow("paused"); expect(s.vault.modify).not.toHaveBeenCalled(); }
	finally { hold.release(); }
	await view.writeFile(file, "merged"); expect(s.vault.modify).toHaveBeenCalledWith(file, "merged");
});
