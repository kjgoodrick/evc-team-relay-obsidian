import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { type TAbstractFile, TFolder } from "obsidian";
import { FolderIndex } from "../src/FolderIndex";
import { VaultShare } from "../src/VaultShare";
import { TrackedFolder } from "../src/TrackedFolder";
import { makeFolderRecord } from "../src/ItemKinds";
import type { AttachmentSyncSettings } from "../src/AttachmentSyncSettings";

function folderNode(path: string, children: TFolder[] = []): TFolder {
	const node: TFolder = Object.create(TFolder.prototype);
	node.path = path;
	node.children = children;
	return node;
}

function fixture(entryPath = "late", missingParent = false) {
	const crdtDoc = new Y.Doc();
	const folderIndex = new FolderIndex(crdtDoc, "Shared", new Map(), {
		subscribe: () => () => {},
	} as unknown as AttachmentSyncSettings);
	const share = Object.create(VaultShare.prototype) as VaultShare;
	const nodes = new Map<string, TFolder>();
	if (entryPath.includes("/") && !missingParent) nodes.set("Shared/late", folderNode("Shared/late"));
	const createEvents: Promise<void>[] = [];
	let resume!: (node: TFolder) => void;
	const creation = new Promise<TFolder>((resolve) => { resume = resolve; });
	const trashFolder = jest.fn(async (node: TAbstractFile) => {
		expect(node).toBeInstanceOf(TFolder);
		if (!(node instanceof TFolder)) throw new Error("expected a folder");
		expect(node.children).toHaveLength(0);
		if (nodes.get(node.path) === node) nodes.delete(node.path);
		if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
	});
	Object.assign(share, {
		path: "Shared",
		crdtDoc,
		folderIndex,
		trackedEntries: new Map(),
		pathSet: { include: jest.fn(), delete: jest.fn() },
		awaitingDelete: new Set(),
		deletedEntries: new WeakSet(),
		log: jest.fn(),
		subscribe: () => () => {},
		awaitReady: () => Promise.resolve(share),
		_localDb: { synced: true },
		_liveProvider: {},
		vaultApi: {
			getAbstractFileByPath: (path: string) => nodes.get(path) ?? null,
			createFolder: jest.fn(() => creation),
			// Desktop Vault.delete(folder, false) cannot remove even an empty
			// folder: Node rm without recursion returns EISDIR.
			delete: jest.fn(async () => { throw new Error("EISDIR"); }),
		},
		fileOps: { trashFile: trashFolder },
	});
	folderIndex.put("late", makeFolderRecord("parent"));
	folderIndex.put(entryPath, makeFolderRecord("old-folder"));
	const folder = new TrackedFolder(entryPath, "old-folder", share);
	share.trackedEntries.set("old-folder", folder);
	return {
		share, folder, folderIndex, nodes, trashFolder,
		async remove() {
			// The filesystem operation has started before the ordinary delete completes.
			await Promise.resolve();
			share.markDeletePending("late");
			share.removeEntry("late", true);
			share.clearDeletePending("late");
			nodes.delete("Shared/late");
		},
		emitCreate(node: TFolder) {
			nodes.set(node.path, node);
			// Normal main.ts vault create callback calls this actual entry point.
			const event = share.claimAndUploadFile(node);
			createEvents.push(event);
			return event;
		},
		async finish(node: TFolder) {
			resume(node);
			await folder.creation?.catch((error: unknown) => {
				expect(error).toEqual(new Error("folder entry was deleted during creation"));
			});
			await Promise.all(createEvents);
			await Promise.resolve();
		},
	};
}

describe("folder creation racing the normal vault create handler", () => {
	test("normal synchronous create events settle without deadlocking or changing the tracked identifier", async () => {
		const f = fixture();
		const node = folderNode("Shared/late");
		f.share.vaultApi.createFolder = jest.fn(async () => {
			f.emitCreate(node);
			return node;
		});
		await f.finish(node);
		expect(f.nodes.get(node.path)).toBe(node);
		expect(f.folderIndex.guidFor("late")).toBe("old-folder");
		expect(f.trashFolder).not.toHaveBeenCalled();
	});

	test("a cancelled creation cannot reupload metadata or leave its empty folder on disk", async () => {
		const f = fixture();
		await f.remove();
		const stale = folderNode("Shared/late");
		f.emitCreate(stale);
		await f.finish(stale);
		expect(f.folderIndex.tracks("late")).toBe(false);
		expect(f.nodes.has(stale.path)).toBe(false);
		expect(f.trashFolder).toHaveBeenCalledWith(stale);
		expect(f.share.vaultApi.delete).not.toHaveBeenCalled();
		// A deliberate creation after the old operation settles remains uploadable.
		const replacement = folderNode(stale.path);
		await f.emitCreate(replacement);
		await Promise.resolve();
		expect(f.folderIndex.guidFor("late")).not.toBe("old-folder");
		expect(f.folderIndex.recordFor("late")?.type).toBe("folder");
	});

	test("a user replacement object winning before stale completion is never removed", async () => {
		const f = fixture();
		await f.remove();
		const stale = folderNode("Shared/late");
		f.emitCreate(stale);
		const replacement = folderNode(stale.path);
		f.emitCreate(replacement);
		await f.finish(stale);
		expect(f.nodes.get(stale.path)).toBe(replacement);
		expect(f.trashFolder).not.toHaveBeenCalled();
		expect(f.folderIndex.recordFor("late")?.type).toBe("folder");
	});

	test("an in-flight nested create cannot recreate and reupload its deleted ancestor", async () => {
		const f = fixture("late/nested");
		await f.remove();
		const parent = folderNode("Shared/late");
		const child = folderNode("Shared/late/nested");
		child.parent = parent;
		parent.children = [child];
		f.emitCreate(parent);
		f.emitCreate(child);
		await f.finish(child);
		expect(f.folderIndex.tracks("late")).toBe(false);
		expect(f.folderIndex.tracks("late/nested")).toBe(false);
		expect(f.nodes.has(parent.path)).toBe(false);
		expect(f.nodes.has(child.path)).toBe(false);
	});

	test("a nested creation stops after its cancelled ancestor step", async () => {
		const f = fixture("late/nested", true);
		await f.remove();
		const parent = folderNode("Shared/late");
		f.emitCreate(parent);
		await f.finish(parent);
		expect(f.share.vaultApi.createFolder).toHaveBeenCalledTimes(1);
		expect(f.nodes.has(parent.path)).toBe(false);
		expect(f.folderIndex.tracks("late")).toBe(false);
		expect(f.folderIndex.tracks("late/nested")).toBe(false);
	});

	test("a replacement ancestor outside the returned chain is preserved", async () => {
		const f = fixture("late/nested");
		await f.remove();
		const staleParent = folderNode("Shared/late");
		const child = folderNode("Shared/late/nested");
		child.parent = staleParent;
		staleParent.children = [child];
		f.emitCreate(staleParent);
		f.emitCreate(child);
		const replacement = folderNode(staleParent.path);
		f.emitCreate(replacement);
		await f.finish(child);
		expect(f.nodes.get(replacement.path)).toBe(replacement);
		expect(f.folderIndex.recordFor("late")?.type).toBe("folder");
		expect(f.trashFolder).toHaveBeenCalledTimes(1);
		expect(f.trashFolder).toHaveBeenCalledWith(child);
	});

	test("cleanup preserves new content inside a returned ancestor", async () => {
		const f = fixture("late/nested");
		await f.remove();
		const userFolder = folderNode("Shared/late/user-folder");
		const parent = folderNode("Shared/late", [userFolder]);
		const child = folderNode("Shared/late/nested");
		child.parent = parent;
		parent.children.push(child);
		f.emitCreate(parent);
		f.emitCreate(child);
		await f.finish(child);
		expect(f.nodes.get(parent.path)).toBe(parent);
		expect(parent.children).toEqual([userFolder]);
		expect(f.folderIndex.recordFor("late")?.type).toBe("folder");
		expect(f.trashFolder).toHaveBeenCalledTimes(1);
	});

	test("cleanup preserves user content added to the returned stale folder", async () => {
		const f = fixture();
		await f.remove();
		const child = folderNode("Shared/late/user-folder");
		const stale = folderNode("Shared/late", [child]);
		f.emitCreate(stale);
		await f.finish(stale);
		expect(f.nodes.get(stale.path)).toBe(stale);
		expect(stale.children).toEqual([child]);
		expect(f.trashFolder).not.toHaveBeenCalled();
		expect(f.folderIndex.tracks("late")).toBe(false);
	});
});
