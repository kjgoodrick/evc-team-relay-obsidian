/**
 * Regression test: — reconcileRelayContent's claim+settle
 * fast path had no bound of its OWN around awaitReconcileSettled(), only
 * that function's internal contract (documented maxWaitMs=3000ms,
 * initContentClaim.ts). Live CDP console capture during the two-client
 * restart race (task comments) never caught a thrown/swallowed exception on
 * this path -- the original 13+s-silent runs are now understood to be
 * racing pullIfUnchanged's pre-fix silent overwrite (, fixed
 * separately) rather than a defect in awaitReconcileSettled() itself. But
 * that call's behavior under untested interleavings was never independently
 * proven safe either way, and this path has no fallback if it ever DOES
 * outlive its own contract for any reason.
 *
 * Fix: an outer, independent timeout around the whole claimReconcile()+
 * awaitReconcileSettled() call. If it fires, the local edit is treated
 * exactly like "lost the claim" -- routed to the same conflict-preserving
 * fallback (reconcileWithVaultFileSafely()), never silently discarded.
 *
 * These tests exercise the real `TransferQueue.uploadDocumentViaSocket()`
 * against a minimal duck-typed Document (same harness as
 * syncBaseNoConflictCopy.test.ts) with `reconcileClaim`'s
 * claimReconcile()/awaitReconcileSettled()/wonReconcileClaim() mocked, and a
 * MockClock so the outer timeout fires on command instead of costing real
 * wall-clock seconds.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import { MockClock } from "./mocks/MockClock";

const claimReconcileMock = jest.fn<(ydoc: Y.Doc) => void>();
const wonReconcileClaimMock = jest.fn<(ydoc: Y.Doc) => boolean>();
let awaitReconcileSettledImpl: () => Promise<void>;
const awaitReconcileSettledMock = jest.fn<() => Promise<void>>(() => awaitReconcileSettledImpl());

jest.mock("../src/reconcileClaim", () => ({
	claimReconcile: (ydoc: Y.Doc) => claimReconcileMock(ydoc),
	wonReconcileClaim: (ydoc: Y.Doc) => wonReconcileClaimMock(ydoc),
	awaitReconcileSettled: () => awaitReconcileSettledMock(),
}));

interface FakeDocOptions {
	syncedText: string;
	vaultContents: string;
	initialBase: string | undefined;
}

function makeFakeDoc(opts: FakeDocOptions) {
	const ydoc = new Y.Doc();
	ydoc.getText("contents").insert(0, opts.syncedText);

	let base = opts.initialBase;
	const writeConflictCopy = jest
		.fn<(doc: unknown, content: string, label: string) => Promise<string>>()
		.mockResolvedValue("note (relay conflict TIMESTAMP).md");

	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "path", { value: "note.md" });
	Object.defineProperty(fakeDoc, "entryPath", { value: "note.md" });
	Object.defineProperty(fakeDoc, "entityGuid", { value: "test-guid" });
	Object.defineProperty(fakeDoc, "crdtDoc", { value: ydoc });
	Object.defineProperty(fakeDoc, "editLock", { value: false });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(fakeDoc, "content", {
		get: () => ydoc.getText("contents").toJSON(),
	});
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			workspaceId: "test-relay-id",
			readContents: async () => opts.vaultContents,
			writeConflictCopy,
			credentialCache: { dropFromQueue: () => {} },
		},
	});
	Object.defineProperty(fakeDoc, "resourceAddress", { value: {} });
	Object.defineProperty(fakeDoc, "onceEverSynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "onceFreshlySynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "connected" });
	Object.defineProperty(fakeDoc, "bringOnline", { value: async () => true });
	Object.defineProperty(fakeDoc, "goOffline", { value: () => {} });
	Object.defineProperty(fakeDoc, "_liveProvider", { value: { ws: null } });
	Object.defineProperty(fakeDoc, "getSyncBase", {
		value: async () => base,
	});
	Object.defineProperty(fakeDoc, "setSyncBase", {
		value: async (text: string) => {
			base = text;
		},
	});

	return { fakeDoc, ydoc, writeConflictCopy, getBase: () => base };
}

describe("reconcileRelayContent's claim+settle fast path has its own outer bound", () => {
	beforeEach(() => {
		claimReconcileMock.mockClear();
		wonReconcileClaimMock.mockClear();
		awaitReconcileSettledMock.mockClear();
	});

	test("restore while a reconciliation claim waits preserves both source text and the comparison base", async () => {
		const { fakeDoc, ydoc, writeConflictCopy, getBase } = makeFakeDoc({ syncedText: "old CRDT text", vaultContents: "local disk edit", initialBase: "old CRDT text" });
		awaitReconcileSettledImpl = async () => { Object.defineProperty(fakeDoc, "restoreReviewRequired", { value: true }); };
		wonReconcileClaimMock.mockReturnValue(true);
		const queue = new TransferQueue({} as never, new MockClock(), {} as never);
		expect(await queue.uploadDocumentViaSocket(fakeDoc)).toBe(false);
		expect(fakeDoc.content).toBe("old CRDT text"); expect(getBase()).toBe("old CRDT text");
		expect(writeConflictCopy).not.toHaveBeenCalled(); ydoc.destroy();
	});

	test("restore during conflict-copy preservation prevents the subsequent CRDT replacement", async () => {
		const { fakeDoc, ydoc, writeConflictCopy, getBase } = makeFakeDoc({ syncedText: "old CRDT text", vaultContents: "local disk edit", initialBase: undefined });
		writeConflictCopy.mockImplementation(async () => {
			Object.defineProperty(fakeDoc, "restoreReviewRequired", { value: true });
			return "preserved.md";
		});
		const queue = new TransferQueue({} as never, new MockClock(), {} as never);
		expect(await queue.uploadDocumentViaSocket(fakeDoc)).toBe(false);
		expect(writeConflictCopy).toHaveBeenCalledWith(fakeDoc, "old CRDT text", expect.any(String));
		expect(fakeDoc.content).toBe("old CRDT text"); expect(getBase()).toBeUndefined(); ydoc.destroy();
	});

	test("REGRESSION: awaitReconcileSettled never resolves -- outer timeout fires, edit preserved as conflict copy, never silently discarded", async () => {
		const { fakeDoc, writeConflictCopy, getBase } = makeFakeDoc({
			syncedText: "TWO-CLIENT-RESTART-PROBE initial",
			vaultContents: "A-EDIT-DURING-RESTART",
			initialBase: "TWO-CLIENT-RESTART-PROBE initial",
		});
		// Simulates the settle call hanging indefinitely, whatever the cause.
		awaitReconcileSettledImpl = () => new Promise<void>(() => {});

		const clock = new MockClock();
		const queue = new TransferQueue({} as never, clock, {} as never);

		const resultPromise = queue.uploadDocumentViaSocket(fakeDoc);
		// Let the microtask queue drain up to the point where the outer
		// raceTimeout() has registered its clock timer, then fire it.
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}
		clock.setTime(clock.now() + 8_000);

		const result = await resultPromise;

		expect(result).toBe(true);
		expect(claimReconcileMock).toHaveBeenCalledTimes(1);
		// Never consulted -- the outer timeout short-circuits before checking
		// who won, since the claim state never confirmed settled.
		expect(wonReconcileClaimMock).not.toHaveBeenCalled();
		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(writeConflictCopy).toHaveBeenCalledWith(
			fakeDoc,
			"TWO-CLIENT-RESTART-PROBE initial",
			expect.stringMatching(/^relay conflict /),
		);
		expect(fakeDoc.content).toBe("A-EDIT-DURING-RESTART");
		expect(getBase()).toBe("A-EDIT-DURING-RESTART");
	});

	test("settle resolves promptly and this client wins: applies directly, no conflict copy, outer timeout never fires", async () => {
		const { fakeDoc, writeConflictCopy } = makeFakeDoc({
			syncedText: "verify initial content",
			vaultContents: "verify EDITED content",
			initialBase: "verify initial content",
		});
		awaitReconcileSettledImpl = () => Promise.resolve();
		wonReconcileClaimMock.mockReturnValue(true);

		const clock = new MockClock();
		const queue = new TransferQueue({} as never, clock, {} as never);

		const result = await queue.uploadDocumentViaSocket(fakeDoc);

		expect(result).toBe(true);
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("verify EDITED content");
	});

	test("settle resolves promptly but this client lost the claim: preserved as conflict copy via the normal (non-timeout) path", async () => {
		const { fakeDoc, writeConflictCopy } = makeFakeDoc({
			syncedText: "verify initial content",
			vaultContents: "verify EDITED content",
			initialBase: "verify initial content",
		});
		awaitReconcileSettledImpl = () => Promise.resolve();
		wonReconcileClaimMock.mockReturnValue(false);

		const clock = new MockClock();
		const queue = new TransferQueue({} as never, clock, {} as never);

		const result = await queue.uploadDocumentViaSocket(fakeDoc);

		expect(result).toBe(true);
		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
	});
});
