/**
 * Coverage for `FileDiffView`'s two reads of a per-side *file identity* — the
 * tab title (`getDisplayText()`) and the per-side header baked into the
 * generated patch (`recomputeDiff()` -> `structuredPatch(path1, path2, ...)`).
 *
 * Why this file exists (, follow-up to the W9 duck-typing scan
 *): `DiffViewState.leftFile`/`rightFile` used to be typed as
 * Obsidian's `TFile`, while both real call sites -- `ViewBindings.openDiffView()`
 * and `y-codemirror.next/LiveEditPlugin` -- pass a live CRDT `Document` as
 * `leftFile`. That compiled with zero casts only because `Document` happened to
 * declare every `TFile` field (`name`/`path`/`extension`/...), so the two
 * reads above resolved by accident rather than by contract. `modify()` and
 * `readContent()` in the same class already narrowed with `instanceof
 * Document` / `instanceof UnsavedFile` before touching anything; these two did
 * not. There was no test on this class at all
 * (`find . -iname '*fileDiffView*' -path '*__tests__*'` -> nothing), so the
 * accident was load-bearing and invisible.
 *
 * `Document` no longer mirrors `TFile` (its fields are `docLabel`/`entryPath`/
 * `docSuffix`/`docStem`/`fileMetrics`/`obsidianVault`/`parentFolder`), so
 * these reads only work now because the view narrows first. The fake below
 * asserts it carries NEITHER `name` NOR `path`, so a future change that
 * re-adds a TFile-shaped field to `Document` cannot make these tests pass by
 * accident all over again — which is exactly how the hazard stayed invisible
 * the first time.
 *
 * Construction convention: `Object.create(Document.prototype)` rather than
 * `new Document(...)`, matching documentCanvasLiveOnpremServerId.test.ts and
 * syncDocumentWebsocketOrdering.test.ts — a real construction drags in the
 * whole VaultShare/IndexedDB/provider stack, none of which these reads touch.
 */

import { describe, test, expect, jest } from "@jest/globals";
import { TFile, Vault } from "obsidian";
import { Document } from "../src/Document";
import { UnsavedFile } from "../src/UnsavedFile";
import { FileDiffView, type DiffViewState } from "../src/fileDiff/fileDiffView";

/**
 * A `Document` far enough along to answer the two identity reads and one
 * content read the diff view makes of it. `content` is a prototype getter on
 * the real class, so it has to be shadowed with `defineProperty` rather than
 * assigned.
 */
function fakeDocument(vaultPath: string, contents: string): Document {
	const doc = Object.create(Document.prototype) as Document;
	doc.entryPath = vaultPath;
	doc.docLabel = "[CRDT] " + (vaultPath.split("/").pop() ?? "");
	Object.defineProperty(doc, "content", { value: contents });

	// The whole point: this object is NOT TFile-shaped. If either field comes
	// back, the assertions below stop proving that the view narrowed.
	expect((doc as unknown as { name?: unknown }).name).toBeUndefined();
	expect((doc as unknown as { path?: unknown }).path).toBeUndefined();
	return doc;
}

/** A `FileDiffView` with its state installed directly — no leaf, no DOM. */
function viewWithState(state?: DiffViewState): FileDiffView {
	const view = Object.create(FileDiffView.prototype) as FileDiffView;
	(view as unknown as { viewState?: DiffViewState }).viewState = state;
	return view;
}

function diffState(
	leftFile: DiffViewState["leftFile"],
	rightFile: DiffViewState["rightFile"],
): DiffViewState {
	return { leftFile, rightFile, allowMergeActions: true };
}

test("closing an unresolved merge never confirms it or discards its buffer", () => {
	const state = { ...diffState(fakeDocument("Note.md", "remote"), new UnsavedFile(new Vault(), "local disk", "local")), onMergeResolved: jest.fn(async () => {}) };
	viewWithState(state).onunload(); expect(state.onMergeResolved).not.toHaveBeenCalled();
	expect((state.rightFile as UnsavedFile).unsavedText).toBe("local");
});

test("merge-buffer edits await their persistence and report save failures", async () => {
	const save = jest.fn(async (_contents: string) => { throw new Error("disk full"); });
	const file = new UnsavedFile(new Vault(), "local disk", "retained", save);
	await expect(viewWithState().writeFile(file, "replacement")).rejects.toThrow("disk full"); expect(save).toHaveBeenCalledWith("replacement");
});

describe("FileDiffView tab title resolves each side's label by kind, not by field accident", () => {
	test("Document vs UnsavedFile — the real merge-conflict pairing", () => {
		const view = viewWithState(
			diffState(
				fakeDocument("notes/meeting.md", "crdt side"),
				new UnsavedFile(new Vault(), "local disk", "disk side"),
			),
		);

		expect(view.getDisplayText()).toBe("File Diff: [CRDT] meeting.md and local disk");
	});

	test("two plain vault TFiles still read their own names", () => {
		const view = viewWithState(
			diffState(new TFile("notes/a.md"), new TFile("notes/b.md")),
		);

		expect(view.getDisplayText()).toBe("File Diff: a.md and b.md");
	});

	test("no state yet — the generic title, not a crash", () => {
		expect(viewWithState(undefined).getDisplayText()).toBe("File diff");
	});
});

describe("FileDiffView patch headers carry each side's path", () => {
	test("Document's entry path and UnsavedFile's path reach the generated patch", async () => {
		const view = viewWithState(
			diffState(
				fakeDocument("notes/meeting.md", "line one\nline two\n"),
				new UnsavedFile(new Vault(), "local disk", "line one\nline TWO\n"),
			),
		);

		await (view as unknown as { recomputeDiff(): Promise<void> }).recomputeDiff();

		const result = (
			view as unknown as {
				diffResult?: { leftFileName?: string; rightFileName?: string; hunks: unknown[] };
			}
		).diffResult;

		// The two sides genuinely differ, so recomputeDiff() runs to completion
		// instead of taking the byte-identical early exit (which would close the
		// view and touch app/leaf this fake does not have).
		expect(result?.hunks.length).toBeGreaterThan(0);
		expect(result?.leftFileName).toBe("notes/meeting.md");
		expect(result?.rightFileName).toBe("local disk");
	});

	test("two plain vault TFiles still head the patch with their own paths", async () => {
		const view = viewWithState(
			diffState(new TFile("notes/a.md"), new TFile("notes/b.md")),
		);
		// A plain TFile is read through the vault, which this fake has no
		// access to — stub the one call recomputeDiff() makes of it.
		(view as unknown as { app: unknown }).app = {
			vault: {
				read: (f: TFile) => Promise.resolve(f.path === "notes/a.md" ? "one\n" : "two\n"),
			},
		};

		await (view as unknown as { recomputeDiff(): Promise<void> }).recomputeDiff();

		const result = (
			view as unknown as { diffResult?: { leftFileName?: string; rightFileName?: string } }
		).diffResult;

		expect(result?.leftFileName).toBe("notes/a.md");
		expect(result?.rightFileName).toBe("notes/b.md");
	});
});
