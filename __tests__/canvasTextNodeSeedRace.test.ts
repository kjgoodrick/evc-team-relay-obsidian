/**
 * Regression test: — CanvasDocument.nodeText has the same unguarded
 * empty-check-then-seed race as (not yet exploited).
 *
 * Root cause: `CanvasDocument.nodeText()` reads a node's `Y.Text` and treats
 * `ytext.toJSON() === ""` as "genuinely new node, safe to seed from the
 * local Obsidian view's `node.text`" -- exactly the same shape as the P0
 * for `TransferQueue.uploadDocumentViaSocket`. If this
 * canvas's own IndexedDB-persisted history hasn't replayed yet
 * (`isLocallyPersisted === false`), an empty read is a false negative: the
 * real content just hasn't arrived. Seeding on that false premise, then
 * having the real persisted history land a moment later, duplicates the
 * node's text (Yjs concatenates, doesn't dedupe) -- same symptom class as
 *, one CRDT node instead of one file.
 *
 * Two call sites into `nodeText()` were confirmed reachable before sync:
 *   1. CanvasDocument.mergeCanvasData() <- CanvasViewPatch's patched requestSave/applyHistory
 *      -- fixed by gating CanvasViewPatch construction on
 *      `CanvasViewBinding.attach()`'s `awaitFullyConnected()` (ViewBindings.ts), which
 *      awaits `awaitFirstSync()` first. Not exercised here: ViewBindings.ts pulls
 *      in Svelte components, y-protocols (ESM), and a yjs deep-import
 *      outside yjs's package.json `exports` map, none of which this
 *      repo's Jest setup can currently load (a pre-existing gap, unrelated
 *      to this fix) -- verified by direct import attempt and confirmed by
 *      reading the source (ViewBindings.ts:318-351).
 *   2. LiveNodePlugin.ts's `getYText()` -- a CodeMirror extension
 *      registered globally whenever any view is open
 *      (ViewBindingRegistry.load()), independent of any single view's
 *      readiness, so it isn't covered by fix #1. Fixed by routing through
 *      the new `CanvasDocument.textNodeSafe()` (this file) instead of calling
 *      `nodeText()` directly.
 *
 * `textNodeSafe()` is deliberately a separate method rather than a guard
 * inside `nodeText()` itself: `CanvasDocument.mergeCanvasData()` marks a node as "known"
 * (added to `crdtNodes`) in the same pass that seeds it, regardless of
 * whether the seed happened -- so if `nodeText()` itself silently declined
 * to seed while unsynced, that node's text would never be retried and
 * would stay empty forever. `textNodeSafe()` sidesteps this: it doesn't
 * participate in `crdtNodes` bookkeeping at all, so a later real `nodeText()`
 * call (once synced) can still seed the node normally. See CanvasDocument.ts's
 * doc comment on `textNodeSafe()` for the full reasoning.
 *
 * These tests exercise the REAL, unmodified `CanvasDocument.nodeText()` and the
 * real `CanvasDocument.textNodeSafe()` against real `Y.Doc` instances -- no
 * reimplementation of the seeding logic -- using `Object.create
 * (CanvasDocument.prototype)` to get the real prototype methods without needing
 * the full ProviderBacked/VaultShare/IndexedDB construction machinery, the
 * same pattern `uploadDocumentViaSocketOrdering.test.ts` established for
 * `Document` in the fix.
 */

import { describe, test, expect } from "@jest/globals";
import * as Y from "yjs";
import { CanvasDocument } from "../src/CanvasDocument";
import type { CanvasNodeData } from "../src/HostCanvasView";

function makeNode(id: string, text: string): CanvasNodeData {
	return { id, type: "text", text, x: 0, y: 0, width: 200, height: 100 };
}

/** A duck-typed CanvasDocument: real prototype methods, minimal own state. */
function makeCanvas(ydoc: Y.Doc, isLocallyPersisted: boolean): CanvasDocument {
	const canvas = Object.create(CanvasDocument.prototype) as CanvasDocument;
	Object.defineProperty(canvas, "crdtDoc", { value: ydoc, writable: true });
	Object.defineProperty(canvas, "isLocallyPersisted", {
		value: isLocallyPersisted,
		writable: true,
	});
	return canvas;
}

describe("CanvasDocument node text-seed race — own not-yet-loaded persistence (, sibling of)", () => {
	test.each([false, true])("a deliberately cleared card stays empty through export and editor access (reloaded: %s)", reloaded => {
		const node = makeNode("cleared-card", "older metadata text"), original = new Y.Doc();
		original.getMap("nodes").set(node.id, node);
		const text = original.getText(node.id); text.insert(0, "newer text"); text.delete(0, text.length);
		const doc = reloaded ? new Y.Doc() : original;
		if (reloaded) Y.applyUpdate(doc, Y.encodeStateAsUpdate(original));
		const before = Y.encodeStateAsUpdate(doc), canvas = makeCanvas(doc, true);
		expect(CanvasDocument.exportData(doc).nodes[0].text).toBe("");
		expect(canvas.nodeText(node).toString()).toBe("");
		expect(canvas.textNodeSafe(node).toString()).toBe("");
		expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
		doc.destroy(); if (doc !== original) original.destroy();
	});

	test("legacy metadata remains visible and initializes a card without text history", () => {
		const node = makeNode("legacy-card", "legacy metadata text"), doc = new Y.Doc();
		doc.getMap("nodes").set(node.id, node);
		expect(CanvasDocument.exportData(doc).nodes[0].text).toBe(node.text);
		expect(makeCanvas(doc, true).textNodeSafe(node).toString()).toBe(node.text);
		expect(CanvasDocument.exportData(doc).nodes[0].text).toBe(node.text); doc.destroy();
	});

	test("BUG (unguarded nodeText(), demonstrates the underlying mechanism is real): seeding before persisted history applies duplicates the node's text", () => {
		const nodeText = "content that already existed in a prior session";
		const node = makeNode("node-1", nodeText);

		// Real persisted CRDT history for this exact node, from a prior
		// session -- the shape IndexedDB's fetchUpdates() replays.
		const priorSession = new Y.Doc();
		priorSession.getText(node.id).insert(0, nodeText);
		const persistedUpdate = Y.encodeStateAsUpdate(priorSession);

		// A fresh Y.Doc for this session, before its IndexedDB history has
		// loaded -- what `ydoc.getText(id).toJSON()` reads as at the moment
		// nodeText() checks it pre-sync.
		const ydoc = new Y.Doc();
		const canvas = makeCanvas(ydoc, /* isLocallyPersisted */ false);
		expect(ydoc.getText(node.id).toJSON()).toBe(""); // looks empty, but ISN'T

		// Calling the real, unmodified nodeText() directly (as a caller with
		// no readiness gate of its own would) seeds from the local view.
		canvas.nodeText(node);
		expect(ydoc.getText(node.id).toJSON()).toBe(nodeText);

		// A moment later the real persisted history lands, as it legitimately
		// must.
		Y.applyUpdate(ydoc, persistedUpdate);

		// BUG: the node's text is now duplicated back-to-back.
		const result = ydoc.getText(node.id).toJSON();
		const half = result.length / 2;
		expect(result.slice(0, half)).toBe(nodeText);
		expect(result.slice(half)).toBe(nodeText);
		expect(result).not.toBe(nodeText);
	});

	test("FIX: textNodeSafe() declines to seed while isLocallyPersisted is false, so the later persisted history applies cleanly", () => {
		const nodeText = "content that already existed in a prior session";
		const node = makeNode("node-2", nodeText);

		const priorSession = new Y.Doc();
		priorSession.getText(node.id).insert(0, nodeText);
		const persistedUpdate = Y.encodeStateAsUpdate(priorSession);

		const ydoc = new Y.Doc();
		const canvas = makeCanvas(ydoc, /* isLocallyPersisted */ false);

		// Same call, through the sync-safe accessor: no seed happens because
		// isLocallyPersisted is false.
		const ytext = canvas.textNodeSafe(node);
		expect(ytext.toJSON()).toBe("");

		// The real persisted history lands.
		Y.applyUpdate(ydoc, persistedUpdate);

		// No double: the only content present is the real persisted history.
		expect(ydoc.getText(node.id).toJSON()).toBe(nodeText);
	});

	test("FIX: textNodeSafe() seeds normally once isLocallyPersisted is true (matches nodeText())", () => {
		const nodeText = "brand new node, never synced before";
		const node = makeNode("node-3", nodeText);

		const ydoc = new Y.Doc();
		const canvas = makeCanvas(ydoc, /* isLocallyPersisted */ true);

		const ytext = canvas.textNodeSafe(node);

		expect(ytext.toJSON()).toBe(nodeText);
		expect(ydoc.getText(node.id).toJSON()).toBe(nodeText);
	});

	test("FIX: a node textNodeSafe() declined to seed is NOT stranded empty -- a later nodeText() call (post-sync) still seeds it", () => {
		// Guards against the specific trap flagged during triage: a guard
		// that silently skips seeding must not permanently strand the node's
		// text empty. textNodeSafe() avoids this by not touching any
		// "already seeded" bookkeeping -- unlike CanvasDocument.mergeCanvasData(), which
		// marks a node "known" in the same pass it seeds it. Simulates the
		// mergeCanvasData() call shape (a later, real nodeText() call once synced)
		// without importing mergeCanvasData()'s own crdtNodes plumbing.
		const nodeText = "brand new node, never synced before";
		const node = makeNode("node-4", nodeText);

		const ydoc = new Y.Doc();
		const canvasUnsynced = makeCanvas(ydoc, /* isLocallyPersisted */ false);

		// First touch, while unsynced: declines to seed.
		expect(canvasUnsynced.textNodeSafe(node).toJSON()).toBe("");

		// Sync completes with nothing to replay (genuinely new node) --
		// mirrors awaitFirstSync() resolving.
		const canvasSynced = makeCanvas(ydoc, /* isLocallyPersisted */ true);

		// A later real nodeText() call (what mergeCanvasData() does once
		// CanvasViewBinding.attach() has gated CanvasViewPatch construction on
		// awaitFirstSync()) still seeds it correctly.
		expect(canvasSynced.nodeText(node).toJSON()).toBe(nodeText);
	});
});
