import * as Y from "yjs";
import { Document } from "../src/Document";
import { CanvasDocument } from "../src/CanvasDocument";
import { VaultShare } from "../src/VaultShare";
import { RemoteDocumentAddress } from "../src/ResourceAddress";
import { RelayRestoreRequiredError } from "../src/auth/RelayOnPremTokenProvider";

function fields<T>(target: T, values: Record<string, unknown>): T {
	for (const [key, value] of Object.entries(values)) Object.defineProperty(target, key, { value, writable: true, configurable: true });
	return target;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
	let account = true;
	const adapter = { write: jest.fn(async () => {}) }, crdt = new Y.Doc();
	const share = fields(Object.create(VaultShare.prototype) as VaultShare, {
		path: "Team", entityGuid: "11111111-1111-4111-8111-111111111111", config: { onpremServerId: "fixture" }, _liveProvider: {},
		isTornDown: false, isRecoveringStructure: false, deletedEntries: new Set(), isDeletePending: jest.fn(() => false),
		credentialCache: { captureFileContext: () => () => { if (!account) throw new Error("account changed"); } },
		vaultApi: { adapter }, folderIndex: {}, log: jest.fn(), usesBaseSync: () => false, _commitMeta: jest.fn(),
	});
	const doc = fields(Object.create(Document.prototype) as Document, {
		_parent: share, entryPath: "Note.md", entityGuid: "22222222-2222-4222-8222-222222222222", crdtDoc: crdt,
		resourceAddress: new RemoteDocumentAddress("relay-onprem", share.entityGuid, "22222222-2222-4222-8222-222222222222"),
		restoreReviewRequired: false, assertNoRestoreReview: jest.fn(async () => {}), _obsidianFile: {},
		obsidianVault: { modify: jest.fn(async () => {}) }, warn: jest.fn(),
	});
	return { share, doc, adapter, revokeAccount: () => { account = false; }, close: () => crdt.destroy() };
}

test("ordinary native writes and metadata still complete when their captured context stays current", async () => {
	const f = fixture();
	try {
		await f.share.writeContents(f.doc, "current text");
		expect(f.adapter.write).toHaveBeenCalledWith("Team/Note.md", "current text");
		await f.share.noteUploaded(f.doc);
		expect((f.share as unknown as { _commitMeta: jest.Mock })._commitMeta).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});

test.each(["restore", "path", "folder", "server", "provider", "delete", "recovery", "account", "unload"])(
	"a pending native write retains the original file when %s changes during review", async reason => {
		const f = fixture(), wait = deferred();
		jest.spyOn(f.doc, "assertNoRestoreReview").mockReturnValue(wait.promise);
		try {
			const writing = f.share.writeContents(f.doc, "stale text");
			switch (reason) {
				case "restore": fields(f.doc, { restoreReviewRequired: true }); break;
				case "path": f.doc.entryPath = "Renamed.md"; break;
				case "folder": fields(f.share, { path: "Other" }); break;
				case "server": f.share.config.onpremServerId = "other"; break;
				case "provider": fields(f.share, { _liveProvider: {} }); break;
				case "delete": fields(f.share, { isDeletePending: () => true }); break;
				case "recovery": f.share.isRecoveringStructure = true; break;
				case "account": f.revokeAccount(); break;
				case "unload": fields(f.share, { isTornDown: true }); break;
			}
			wait.resolve(); await expect(writing).rejects.toThrow(); expect(f.adapter.write).not.toHaveBeenCalled();
		} finally { f.close(); }
	},
);

test("durable review blocks a source write even before its in-memory flag is populated", async () => {
	const f = fixture();
	try {
		jest.spyOn(f.doc, "assertNoRestoreReview").mockRejectedValue(new RelayRestoreRequiredError());
		await expect(f.share.writeContents(f.doc, "stale")).rejects.toThrow("restore review");
		expect(f.adapter.write).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("restore during metadata preparation cannot acknowledge the old upload", async () => {
	const f = fixture(), wait = deferred();
	const internal = f.share as unknown as { _metaForUpload(): Promise<unknown>; _commitMeta: jest.Mock };
	jest.spyOn(internal, "_metaForUpload").mockImplementation(async () => { await wait.promise; return { id: f.doc.entityGuid, type: "markdown" }; });
	try {
		const pending = f.share.noteUploaded(f.doc); await Promise.resolve();
		fields(f.doc, { restoreReviewRequired: true }); wait.resolve();
		await expect(pending).rejects.toThrow("restore review"); expect(internal._commitMeta).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test.each(["restore", "newer text"])("an editor save does not write its old snapshot after %s", async reason => {
	const f = fixture(), wait = deferred();
	jest.spyOn(f.doc, "assertNoRestoreReview").mockReturnValue(wait.promise);
	f.doc.crdtText.insert(0, "old text");
	try {
		const pending = f.doc.syncToVault();
		if (reason === "restore") fields(f.doc, { restoreReviewRequired: true });
		else f.doc.crdtText.insert(0, "newer ");
		wait.resolve(); await pending; expect(f.doc.obsidianVault.modify).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test.each([Document, CanvasDocument])("an original cache pauses when fresh inventory already belongs to a restored share: %p", Type => {
	const item = fields(Object.create(Type.prototype) as Document | CanvasDocument, {
		_parent: { _liveProvider: { managedIndex: { snapshot: { restore_generation: "restored" } } } },
	});
	expect(item.restoreReviewRequired).toBe(true);
});
