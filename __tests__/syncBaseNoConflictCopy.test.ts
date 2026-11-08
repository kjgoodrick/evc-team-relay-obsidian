/**
 * Regression test: — spurious relay-conflict-copy on a normal
 * remote edit, and its sibling (same underlying mechanism).
 *
 * Root cause (traced live against the self-hosted stand, see task
 * comments): `TransferQueue.reconcileRelayContent()` treated ANY divergence
 * between the synced Y.Doc text and the on-disk vault file as a potential
 * conflict and always preserved a copy before overwriting. But a plain text
 * diff can't tell "only THIS client edited since we last agreed with the
 * relay" (safe to apply directly — e.g. `app.vault.modify()` with no live
 * editor binding, which writes straight to disk without going through the
 * Y.Doc first) apart from "the relay moved too" (a genuine conflict). Every
 * no-live-editor local edit was hitting the first case and being treated
 * like the second, producing a `(relay conflict …).md` file nobody asked
 * for even though nothing actually diverged from another client.
 *
 * Fix: `Document.getSyncBase()/setSyncBase()` record what this client's
 * Y.Doc last agreed with the relay on. `reconcileRelayContent()` now only
 * preserves a conflict copy when the synced text no longer matches that
 * base — i.e. when the relay has genuinely moved since we last synced.
 *
 * These tests exercise the real `TransferQueue.uploadDocumentViaSocket()`
 * against a minimal duck-typed Document (real `Document.prototype` in its
 * chain, real `Y.Doc` for the CRDT operations applyDiffToYText/
 * reconcileWithConflictCopy actually touch) — same pattern as
 * uploadDocumentViaSocketOrdering.test.ts.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import { SystemClock } from "../src/Clock";

interface FakeDocOptions {
	/** What `doc.content` reads as when uploadDocumentViaSocket starts (post-connect synced content). */
	syncedText: string;
	/** What's currently on disk. */
	vaultContents: string;
	/** The last text this client recorded as agreeing with the relay on, or undefined if never set. */
	initialBase: string | undefined;
	/** Successive disk reads after the first; the last one repeats. Defaults to `vaultContents`. */
	laterVaultReads?: string[];
	/** Whether the note is being deleted. */
	deletePending?: boolean;
}

function makeFakeDoc(opts: FakeDocOptions) {
	const ydoc = new Y.Doc();
	ydoc.getText("contents").insert(0, opts.syncedText);

	let base = opts.initialBase;
	const writeConflictCopy = jest
		.fn<(doc: unknown, content: string, label: string) => Promise<string>>()
		.mockResolvedValue("note (relay conflict TIMESTAMP).md");
	const writeContents = jest
		.fn<(doc: unknown, content: string) => Promise<void>>()
		.mockResolvedValue(undefined);
	const reads = [opts.vaultContents, ...(opts.laterVaultReads ?? [])];
	let readCount = 0;

	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "path", { value: "note.md" });
	Object.defineProperty(fakeDoc, "entityGuid", { value: "test-guid" });
	Object.defineProperty(fakeDoc, "crdtDoc", { value: ydoc });
	Object.defineProperty(fakeDoc, "editLock", { value: false, writable: true });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(fakeDoc, "content", {
		get: () => ydoc.getText("contents").toJSON(),
	});
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			workspaceId: "test-relay-id",
			readContents: async () => reads[Math.min(readCount++, reads.length - 1)],
			writeConflictCopy,
			writeContents,
			isDeletePending: () => opts.deletePending ?? false,
		},
	});
	Object.defineProperty(fakeDoc, "onceEverSynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "onceFreshlySynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "connected" });
	Object.defineProperty(fakeDoc, "bringOnline", { value: async () => true });
	Object.defineProperty(fakeDoc, "_liveProvider", { value: { ws: null } });
	Object.defineProperty(fakeDoc, "getSyncBase", {
		value: async () => base,
	});
	Object.defineProperty(fakeDoc, "setSyncBase", {
		value: async (text: string) => {
			base = text;
		},
	});

	return { fakeDoc, ydoc, writeConflictCopy, writeContents, getBase: () => base };
}

function makeQueue(): TransferQueue {
	return new TransferQueue({} as never, new SystemClock(), {} as never);
}

describe("uploadDocumentViaSocket — sync-base gates the conflict-copy preserve step", () => {
	test("an active editor owns its newer live text while the disk save lags", async () => {
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "hello world!!123", vaultContents: "hello world!!", initialBase: "",
		});
		fakeDoc.editLock = true;
		await makeQueue().uploadDocumentViaSocket(fakeDoc);
		expect(fakeDoc.content).toBe("hello world!!123");
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(writeContents).not.toHaveBeenCalled();
		expect(getBase()).toBe("");
	});

	test("typing during an asynchronous disk read invalidates the older upload snapshot", async () => {
		const { fakeDoc, ydoc, writeConflictCopy, getBase } = makeFakeDoc({
			syncedText: "hello world!!", vaultContents: "hello world!!", initialBase: "",
		});
		let reads = 0;
		fakeDoc.vaultShare.readContents = async () => {
			const snapshot = "hello world!!";
			if (++reads === 2) ydoc.getText("contents").insert(snapshot.length, "123");
			return snapshot;
		};
		expect(await makeQueue().uploadDocumentViaSocket(fakeDoc)).toBe(false);
		expect(fakeDoc.content).toBe("hello world!!123");
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(getBase()).toBe("");
	});

	test("an editor opened during the disk read prevents background reconciliation", async () => {
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "hello world!!123", vaultContents: "hello world!!", initialBase: "",
		});
		let reads = 0;
		fakeDoc.vaultShare.readContents = async () => {
			if (++reads === 2) fakeDoc.editLock = true;
			return "hello world!!";
		};
		await makeQueue().uploadDocumentViaSocket(fakeDoc);
		expect(fakeDoc.content).toBe("hello world!!123");
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(writeContents).not.toHaveBeenCalled();
		expect(getBase()).toBe("");
	});

	test.each(["editor opened", "new text"])("%s during conflict backup cannot be overwritten or acknowledged", async change => {
		const { fakeDoc, ydoc, writeConflictCopy, getBase } = makeFakeDoc({
			syncedText: "remote version", vaultContents: "offline version", initialBase: "base",
		});
		writeConflictCopy.mockImplementation(async () => {
			if (change === "editor opened") fakeDoc.editLock = true;
			else ydoc.getText("contents").insert(14, " + new edit");
			return "preserved.md";
		});
		expect(await makeQueue().uploadDocumentViaSocket(fakeDoc)).toBe(false);
		expect(fakeDoc.content).toBe(change === "editor opened" ? "remote version" : "remote version + new edit");
		expect(getBase()).toBe("base");
	});

	test("a background fetch does not flush over a live editor", async () => {
		const { fakeDoc, writeContents } = makeFakeDoc({
			syncedText: "live editor", vaultContents: "old disk", initialBase: "old disk",
		});
		fakeDoc.editLock = true;
		(fakeDoc.vaultShare as any).folderIndex = { tracks: () => true };
		await (makeQueue() as unknown as { fetchDocument(doc: Document): Promise<void> }).fetchDocument(fakeDoc);
		expect(writeContents).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("live editor");
	});

	test("own not-yet-pushed edit, relay unchanged since last sync: reconciles WITHOUT a conflict copy", async () => {
		// This is the exact trace: base/syncedText = pre-edit content
		// (what we last agreed on with the relay), vaultContents = this
		// client's own edit, written straight to disk with no live editor
		// binding (app.vault.modify()'s !file.connected path).
		const { fakeDoc, writeConflictCopy, getBase } = makeFakeDoc({
			syncedText: "verify272f initial content",
			vaultContents: "verify272f EDITED-FROM-B content",
			initialBase: "verify272f initial content",
		});

		const queue = makeQueue();
		const result = await queue.uploadDocumentViaSocket(fakeDoc);

		expect(result).toBe(true);
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("verify272f EDITED-FROM-B content");
		// The new agreement point is recorded for the next sync.
		expect(getBase()).toBe("verify272f EDITED-FROM-B content");
	});

	test("REGRESSION: relay moved since our last sync (genuine conflict) still preserves a conflict copy", async () => {
		// Our recorded base is the ORIGINAL pre-conflict text, but the synced
		// text we just read (post-connect) already includes another client's
		// edit that merged in over the wire -- a real divergence, not just our
		// own pending write.
		const { fakeDoc, writeConflictCopy, getBase } = makeFakeDoc({
			syncedText: "base content [edit from client A]",
			vaultContents: "base content [edit from client B]",
			initialBase: "base content",
		});

		const queue = makeQueue();
		const result = await queue.uploadDocumentViaSocket(fakeDoc);

		expect(result).toBe(true);
		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(writeConflictCopy).toHaveBeenCalledWith(
			fakeDoc,
			"base content [edit from client A]",
			expect.stringMatching(/^relay conflict /),
		);
		expect(fakeDoc.content).toBe("base content [edit from client B]");
		expect(getBase()).toBe("base content [edit from client B]");
	});

	test("no recorded base yet (first divergence ever seen for this doc): defaults to the safe, preserving path", async () => {
		const { fakeDoc, writeConflictCopy } = makeFakeDoc({
			syncedText: "old synced text",
			vaultContents: "new vault text",
			initialBase: undefined,
		});

		const queue = makeQueue();
		await queue.uploadDocumentViaSocket(fakeDoc);

		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
	});

	test("content already in sync: no conflict copy, and the base is (re)recorded", async () => {
		const { fakeDoc, writeConflictCopy, getBase } = makeFakeDoc({
			syncedText: "same everywhere",
			vaultContents: "same everywhere",
			initialBase: undefined,
		});

		const queue = makeQueue();
		await queue.uploadDocumentViaSocket(fakeDoc);

		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(getBase()).toBe("same everywhere");
	});
});

describe("uploadDocumentViaSocket — relay moved, file still holds the agreed text", () => {
	test.each([false, true])("a peer clear reaches an unchanged native file (reloaded history: %s)", async reloaded => {
		const { fakeDoc, ydoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "", vaultContents: "last agreed text", initialBase: "last agreed text",
		});
		const history = reloaded ? new Y.Doc() : ydoc;
		history.getText("contents").insert(0, "last agreed text");
		history.getText("contents").delete(0, "last agreed text".length);
		if (reloaded) { Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(history)); history.destroy(); }
		const queue = makeQueue();
		try { expect(await queue.uploadDocumentViaSocket(fakeDoc)).toBe(true); }
		finally { queue.shutdown(); }
		expect(fakeDoc.content).toBe(""); expect(getBase()).toBe("");
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "");
		expect(writeConflictCopy).not.toHaveBeenCalled(); ydoc.destroy();
	});

	test("a local edit arriving during a peer clear is retained", async () => {
		const { fakeDoc, ydoc, writeContents, getBase } = makeFakeDoc({
			syncedText: "", vaultContents: "last agreed text", initialBase: "last agreed text",
			laterVaultReads: ["last agreed text", "new local edit"],
		});
		ydoc.getText("contents").insert(0, "last agreed text");
		ydoc.getText("contents").delete(0, "last agreed text".length);
		const queue = makeQueue();
		try { expect(await queue.uploadDocumentViaSocket(fakeDoc)).toBe(true); }
		finally { queue.shutdown(); }
		expect(fakeDoc.content).toBe("new local edit"); expect(getBase()).toBe("new local edit");
		expect(writeContents).not.toHaveBeenCalled(); ydoc.destroy();
	});

	test("delivers the relay's text to disk instead of reverting the peer's edit", async () => {
		// The receiver's echo upload of its own delivered write: the file
		// holds the last agreed text, a peer's edit arrived while connecting.
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "a1-1 by A",
			vaultContents: "a1-0",
			initialBase: "a1-0",
		});

		const result = await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(result).toBe(true);
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("a1-1 by A");
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "a1-1 by A");
		expect(getBase()).toBe("a1-1 by A");
	});

	test("a local edit made while connecting is reconciled, never overwritten", async () => {
		const { fakeDoc, writeContents } = makeFakeDoc({
			syncedText: "a1-1 by A",
			vaultContents: "a1-0",
			initialBase: "a1-0",
			laterVaultReads: ["a1-0", "a1-0 typed on B"],
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeContents).not.toHaveBeenCalled();
		// The relay moved too, so the safe path keeps the peer's text as a copy.
		expect(fakeDoc.content).toBe("a1-0 typed on B");
	});

	test("REGRESSION: a file off the base still reconciles as a local edit", async () => {
		const { fakeDoc, writeConflictCopy, writeContents } = makeFakeDoc({
			syncedText: "base [peer edit]",
			vaultContents: "base [my edit]",
			initialBase: "base",
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(fakeDoc.content).toBe("base [my edit]");
	});

	test("a failed final read writes nothing and keeps the base at the disk text", async () => {
		// readVaultContents() reads a failed read as "".
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "a1-1 by A",
			vaultContents: "a1-0",
			initialBase: "a1-0",
			laterVaultReads: ["a1-0", ""],
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("a1-1 by A");
		// A base ahead of the disk would push the stale file over the peer next time.
		expect(getBase()).toBe("a1-0");
	});

	test("a note being deleted is not written and its base stays", async () => {
		const { fakeDoc, writeContents, getBase } = makeFakeDoc({
			syncedText: "a1-1 by A",
			vaultContents: "a1-0",
			initialBase: "a1-0",
			deletePending: true,
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeContents).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("a1-1 by A");
		expect(getBase()).toBe("a1-0");
	});
});
