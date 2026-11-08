import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { FolderIndex } from "../src/FolderIndex";
import { VaultShare } from "../src/VaultShare";
import { Document } from "../src/Document";
import { TrackedFolder } from "../src/TrackedFolder";
import { AttachmentFile } from "../src/AttachmentFile";
import { ItemKind } from "../src/ItemKinds";
import { TFolder } from "obsidian";
import { makeDocumentRecord, makeFolderRecord } from "../src/ItemKinds";
import type { AttachmentSyncSettings } from "../src/AttachmentSyncSettings";
import type { SyncableEntry } from "../src/SyncableEntry";
import { DocumentAddress } from "../src/ResourceAddress";

const attachmentSettings = {
	subscribe: () => () => {},
} as unknown as AttachmentSyncSettings;

function fixture() {
	const crdtDoc = new Y.Doc();
	const folderIndex = new FolderIndex(crdtDoc, "Shared", new Map(), attachmentSettings);
	const share = Object.create(VaultShare.prototype) as VaultShare;
	Object.assign(share, {
		path: "Shared",
		entityGuid: "test-share",
		credentialCache: {},
		crdtDoc,
		folderIndex,
		trackedEntries: new Map(),
		pathSet: new Set(),
		awaitingDelete: new Set(),
		deletedEntries: new WeakSet(),
		log: jest.fn(),
	});
	Object.defineProperty(share, "config", { value: {} });
	return { share, folderIndex, crdtDoc };
}

function trackedDoc(path: string, guid: string) {
	const doc = Object.create(Document.prototype) as Document;
	Object.assign(doc, {
		entryPath: path,
		entityGuid: guid,
		scheduleSave: { cancel: jest.fn() },
		_obsidianFile: {},
		dispose: jest.fn(),
		goOffline: jest.fn(),
		dismantle: jest.fn(),
	});
	return doc;
}

describe("shared subfolder deletion", () => {
	test("attachment acknowledgement uses its captured upload, never a newer cached hash", async () => {
		const { share, folderIndex } = fixture();
		const file = Object.create(AttachmentFile.prototype) as AttachmentFile;
		const latestHash = jest.fn(async () => "newer-unuploaded-hash");
		Object.assign(file, { path: "photo.png", _localGuid: "image", contentAddressedCache: { resolveHash: latestHash } });
		jest.spyOn(folderIndex.kinds, "kindForPath").mockReturnValue(ItemKind.Image);
		const check = jest.fn();
		await share.noteUploaded(file, { hash: "uploaded-hash", mtime: 123, check });
		expect(folderIndex.recordFor("photo.png")).toMatchObject({ type: ItemKind.Image, hash: "uploaded-hash", synctime: 123 });
		expect(latestHash).not.toHaveBeenCalled(); expect(check).toHaveBeenCalledTimes(1);
		await expect(share.noteUploaded(file, { hash: "stale", mtime: 456, check: () => { throw new Error("restored"); } })).rejects.toThrow("restored");
		expect(folderIndex.recordFor("photo.png")?.hash).toBe("uploaded-hash");
	});

	test.each(["empty", "empty-tree", "populated", "legacy-only"])("%s tree is deleted on a synced peer and stays deleted after migration", (kind) => {
		const { share, folderIndex, crdtDoc } = fixture();
		if (kind !== "legacy-only") folderIndex.put("notes", makeFolderRecord("folder"));
		if (kind === "populated" || kind === "empty-tree") {
			folderIndex.put("notes/nested", makeFolderRecord("nested"));
			if (kind === "populated") folderIndex.put("notes/nested/a.md", makeDocumentRecord("doc"));
		} else if (kind === "legacy-only") {
			crdtDoc.getMap("docs").set("notes/nested/a.md", "legacy");
		}
		folderIndex.put("notes-old/keep.md", makeDocumentRecord("keep"));
		folderIndex.put("outside.md", makeDocumentRecord("outside"));
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(crdtDoc));
		const before = Y.encodeStateVector(peer);

		share.removeEntry("notes", true);
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(crdtDoc, before));
		const peerIndex = new FolderIndex(peer, "Shared", new Map(), attachmentSettings);
		peerIndex.upgradeLegacy();
		peerIndex.applyStaged();

		for (const name of ["filemeta_v0", "docs"]) {
			const keys = Array.from(peer.getMap(name).keys());
			expect(keys.filter((p) => p === "notes" || p.startsWith("notes/"))).toEqual([]);
			expect(keys).toContain("notes-old/keep.md");
			expect(keys).toContain("outside.md");
		}
	});

	test("pending folder deletion blocks descendant writes while readiness is delayed", async () => {
		const { share } = fixture();
		const write = jest.fn();
		Object.assign(share, { vaultApi: { adapter: { write } } });
		share.markDeletePending("notes");
		expect(share.isDeletePending("notes/nested/a.md")).toBe(true);
		expect(share.isDeletePending("notes-old/a.md")).toBe(false);
		await share.writeContents({ entryPath: "notes/nested/a.md" } as SyncableEntry, "stale");
		expect(write).not.toHaveBeenCalled();
		share.clearDeletePending("notes");
		expect(share.isDeletePending("notes/nested/a.md")).toBe(false);
	});

	test("discarded staged metadata and live descendants cannot resurrect after pending deletion clears", async () => {
		const { share, folderIndex, crdtDoc } = fixture();
		folderIndex.put("notes", makeFolderRecord("folder"));
		folderIndex.put("notes/a.md", makeDocumentRecord("doc"));
		folderIndex.stagedWrites.set("notes/staged.md", makeDocumentRecord("staged"));
		folderIndex.new("notes/pending.md");
		const removed = trackedDoc("notes/a.md", "doc");
		const kept = trackedDoc("notes-old/a.md", "keep");
		share.trackedEntries.set("doc", removed);
		share.trackedEntries.set("keep", kept);
		(share.pathSet as unknown as Set<SyncableEntry>).add(removed);
		(share.pathSet as unknown as Set<SyncableEntry>).add(kept);
		share.markDeletePending("notes");
		// noteUploaded awaits metadata before committing, allowing a delete to overtake it.
		const upload = share.noteUploaded(removed);
		share.removeEntry("notes", true);
		share.clearDeletePending("notes");
		await upload;
		const write = jest.fn();
		Object.assign(share, { vaultApi: { adapter: { write } } });
		await share.writeContents(removed, "stale async content");
		expect(write).not.toHaveBeenCalled();
		folderIndex.applyStaged();
		folderIndex.upgradeLegacy();
		folderIndex.applyStaged();
		expect(Array.from(crdtDoc.getMap("filemeta_v0").keys())).toEqual([]);
		expect(Array.from(crdtDoc.getMap("docs").keys())).toEqual([]);
		expect(folderIndex.guidFor("notes/pending.md")).toBeUndefined();
		expect(share.trackedEntries.has("doc")).toBe(false);
		expect(share.trackedEntries.get("keep")).toBe(kept);
		expect(removed.scheduleSave.cancel).toHaveBeenCalledTimes(1);
		expect(removed.goOffline).toHaveBeenCalledTimes(1);
		expect(removed.dismantle).toHaveBeenCalledTimes(1);
		expect(kept.dismantle).not.toHaveBeenCalled();
		// A newly created instance can reuse the path after deletion.
		const replacement = trackedDoc("notes/a.md", "replacement"), replacementDoc = new Y.Doc();
		Object.assign(replacement, { _parent: share, crdtDoc: replacementDoc });
		Object.defineProperty(replacement, "resourceAddress", { value: new DocumentAddress(share.entityGuid, "replacement") });
		await share.noteUploaded(replacement); replacementDoc.destroy();
		expect(folderIndex.guidFor("notes/a.md")).toBe("replacement");
	});

	test("pending descendant folder creation is suppressed", async () => {
		const { share, folderIndex } = fixture();
		const createdFolder: TFolder = Object.create(TFolder.prototype);
		createdFolder.path = "Shared/notes/nested";
		const createFolder = jest.fn<() => Promise<TFolder>>().mockResolvedValue(createdFolder);
		Object.assign(share, {
			path: "Shared",
			vaultApi: { getAbstractFileByPath: () => null, createFolder },
			subscribe: () => () => {},
		});
		share.markDeletePending("notes");
		const folder = new TrackedFolder("notes/nested", "nested", share);
		await Promise.resolve();
		await Promise.resolve();
		expect(createFolder).not.toHaveBeenCalled();
		expect(folderIndex.tracks("notes/nested")).toBe(false);
		folder.dismantle();
	});

	test("folder creation completing after teardown cannot republish metadata or reattach its wrapper", async () => {
		const { share, folderIndex } = fixture();
		let complete!: (folder: TFolder) => void;
		const creation = new Promise<TFolder>((resolve) => { complete = resolve; });
		Object.assign(share, {
			path: "Shared",
			vaultApi: { getAbstractFileByPath: () => null, createFolder: () => creation },
			subscribe: () => () => {},
		});
		folderIndex.put("notes", makeFolderRecord("folder"));
		const folder = new TrackedFolder("notes/nested", "nested", share);
		share.trackedEntries.set("nested", folder);
		share.removeEntry("notes", true);
		const createdFolder: TFolder = Object.create(TFolder.prototype);
		createdFolder.path = "Shared/notes/nested";
		complete(createdFolder);
		await creation;
		await Promise.resolve();
		expect(folderIndex.tracks("notes/nested")).toBe(false);
		expect(folder.attached).toBe(false);
	});

	test("single-file deletion also discards staged metadata without deleting siblings", () => {
		const { share, folderIndex } = fixture();
		folderIndex.stagedWrites.set("notes/a.md", makeDocumentRecord("staged"));
		folderIndex.put("notes/b.md", makeDocumentRecord("keep"));
		share.removeEntry("notes/a.md");
		folderIndex.applyStaged();
		expect(folderIndex.guidFor("notes/a.md")).toBeUndefined();
		expect(folderIndex.guidFor("notes/b.md")).toBe("keep");
	});
});
