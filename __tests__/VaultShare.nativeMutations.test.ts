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

test.each(["teardown", "root move"])("a callback waiting on a parent directory cannot admit a native move after %s", async change => {
	const s = fixture(), file = Object.assign(Object.create(TFile.prototype) as TFile, { path: "Team/Old.md" });
	let finish!: () => void; s.share.ensureParentDir = jest.fn(() => new Promise<void>(resolve => { finish = resolve; }));
	const moving = s.share._onServerRename(s.doc, "New.md", file);
	Object.assign(s.share, change === "teardown" ? { isTornDown: true } : { path: "Moved team" }); finish();
	await expect(moving).rejects.toThrow("source changed"); expect(s.fileOps.renameFile).not.toHaveBeenCalled(); expect(s.relocate).not.toHaveBeenCalled();
});

test("an admitted move stays drainable after teardown and does not acknowledge its obsolete document", async () => {
	const s = fixture(), file = Object.assign(Object.create(TFile.prototype) as TFile, { path: "Team/Old.md" });
	let finish!: () => void; s.fileOps.renameFile.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
	const moving = s.share._onServerRename(s.doc, "New.md", file);
	await Promise.resolve(); expect(finish).toBeDefined();
	const hold = holdNativeSourceWrites(s.vault, "Team"); Object.assign(s.share, { isTornDown: true });
	try {
		expect(() => hold.release()).toThrow("still running"); finish();
		await expect(moving).rejects.toThrow("source changed"); await hold.wait({ check: () => {} });
		expect(s.fileOps.renameFile).toHaveBeenCalledTimes(1); expect(s.relocate).not.toHaveBeenCalled();
	} finally { hold.release(); }
});

test("old folder, conflict and trash callbacks cannot write after teardown", async () => {
	const s = fixture(), file = Object.assign(Object.create(TFile.prototype) as TFile, { path: "Team/Old.md" });
	Object.assign(s.share, { isTornDown: true });
	await expect(s.share.makeFolder("Subfolder")).rejects.toThrow("source changed");
	await expect(s.share.writeConflictCopy(s.doc, "retained", "local")).rejects.toThrow("source changed");
	await expect(s.share.trashFile(file)).rejects.toThrow("source changed");
	expect(s.vault.adapter.mkdir).not.toHaveBeenCalled(); expect(s.vault.adapter.write).not.toHaveBeenCalled(); expect(s.fileOps.trashFile).not.toHaveBeenCalled();
});

test.each(["before admission", "after admission"])("owned directory creation interrupted %s never adopts a late native folder", async timing => {
	const s = fixture(), nodes = new Map<string, TFolder>(); let finish!: (folder: TFolder) => void;
	const create = jest.fn(() => new Promise<TFolder>(resolve => { finish = resolve; }));
	Object.assign(s.vault, { getAbstractFileByPath: (path: string) => nodes.get(path) ?? null, createFolder: create });
	Object.assign(s.share, { deletedEntries: new WeakSet(), awaitingDelete: new Set() });
	const entry = { entryPath: "New", entityGuid: "synthetic-folder" } as SyncableEntry;
	const creating = s.share.createFolderForEntry(entry);
	if (timing === "after admission") await Promise.resolve();
	Object.assign(s.share, { isTornDown: true });
	if (timing === "after admission") {
		const native = Object.assign(Object.create(TFolder.prototype) as TFolder, { path: "Team/New", children: [] });
		nodes.set(native.path, native); finish(native);
	}
	await expect(creating).rejects.toThrow("source changed"); expect(create).toHaveBeenCalledTimes(timing === "after admission" ? 1 : 0);
	// An already completed OS operation is retained, without acknowledging it
	// as a current folder or trying to delete it from the closed session.
	expect(nodes.size).toBe(timing === "after admission" ? 1 : 0); expect(s.fileOps.trashFile).not.toHaveBeenCalled();
});

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
