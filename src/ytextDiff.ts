import * as Y from "yjs";
import { namedLogger } from "./logging";
import { diff_match_patch, type Diff } from "diff-match-patch";
import { currentToggles } from "./featureToggleState";
import { hasPreservableContent, sameTextContent } from "./textEquivalence";

type DeltaLog = (...args: unknown[]) => void;

/** No-op unless the `enableDeltaLogging` featureKey is on — this path runs on every
 * disk-write reconciliation, so logging is opt-in to avoid flooding debug output. */
function deltaLogger(): DeltaLog {
	if (!currentToggles().enableDeltaLogging) {
		return () => {};
	}
	return namedLogger("[applyDiffToYText]", "debug");
}

/**
 * One handler per diff-match-patch operation code (see `Diff` from the
 * `diff-match-patch` package: 1 insert / 0 equal / -1 delete). Dispatching
 * through this table rather than a switch keeps `applyDiffToYText` itself to a
 * plain loop, and makes each op's cursor arithmetic independently testable
 * in isolation from the transaction plumbing around it.
 */
const DIFF_OP_HANDLERS: Record<
	number,
	(ytext: Y.Text, cursor: number, text: string, log: DeltaLog) => number
> = {
	1: (ytext, cursor, text, log) => {
		log(`Inserting "${text}" at position ${cursor}`);
		ytext.insert(cursor, text);
		return cursor + text.length;
	},
	0: (_ytext, cursor, text, log) => {
		log(`Keeping "${text}" (length: ${text.length})`);
		return cursor + text.length;
	},
	[-1]: (ytext, cursor, text, log) => {
		log(`Deleting "${text}" at position ${cursor}`);
		ytext.delete(cursor, text.length);
		return cursor;
	},
};

export function applyDiffToYText(
	ydoc: Y.Doc,
	diskBuffer: string,
	origin?: unknown,
): void {
	const ytext = ydoc.getText("contents");
	const currentContent = ytext.toJSON();
	const log = deltaLogger();
	log("Updating YDoc:");
	log("Current content length:", currentContent.length);
	log("Disk buffer length:", diskBuffer.length);

	const dmp = new diff_match_patch();
	const diffs: Diff[] = dmp.diff_main(currentContent, diskBuffer);
	dmp.diff_cleanupSemantic(diffs);
	if (diffs.length === 0) {
		return;
	}

	ydoc.transact(() => {
		let cursor = 0;
		for (const [operation, text] of diffs) {
			const applyOp = DIFF_OP_HANDLERS[operation];
			cursor = applyOp ? applyOp(ytext, cursor, text, log) : cursor;
			log("intermediate", ytext.toJSON());
		}
	}, origin);

	log("result", ytext.toJSON());
	log("Update complete. New content length:", ytext.toJSON().length);
}

/**
 * Persists `content` somewhere the user can find it and returns the path it
 * was written to. Injected by the caller so this module stays independent of
 * the vault/file API (and directly unit-testable without mocking it).
 */
export type ConflictCopyWriter = (content: string) => Promise<string>;

export interface ReconcileResult {
	/** True if the Y.Doc was rewritten to match `vaultContent`. */
	reconciled: boolean;
	/** Path the pre-reconciliation content was preserved at, if it diverged. */
	conflictPath?: string;
}

/**
 * Reconcile a Y.Doc's "contents" text to match `vaultContent`, WITHOUT
 * silently discarding whatever the Y.Doc currently holds.
 *
 * `applyDiffToYText` computes a plain-text diff against whatever is CURRENTLY
 * in the Y.Doc and applies it as real delete/insert CRDT ops — indistinguishable
 * from any other edit once broadcast, and unrecoverable after GC. If the Y.Doc's
 * content differs from `vaultContent` at all, the losing (pre-reconciliation)
 * content is preserved via `writeConflictCopy` FIRST. If that write fails, the
 * reconciliation is skipped entirely (fail closed) rather than risk a silent loss.
 */
export async function reconcileWithConflictCopy(
	ydoc: Y.Doc,
	vaultContent: string,
	writeConflictCopy: ConflictCopyWriter,
	origin?: unknown,
	log: (...args: unknown[]) => void = () => {},
	canApply: () => boolean = () => true,
): Promise<ReconcileResult> {
	const ytext = ydoc.getText("contents");
	const currentContent = ytext.toJSON();

	if (!canApply() || sameTextContent(currentContent, vaultContent)) {
		return { reconciled: false };
	}

	if (!hasPreservableContent(currentContent)) {
		// Nothing to lose: an empty Y.Text would only produce a 0-byte copy.
		applyDiffToYText(ydoc, vaultContent, origin);
		return { reconciled: true };
	}

	let conflictPath: string;
	try {
		conflictPath = await writeConflictCopy(currentContent);
	} catch (e) {
		log(
			"Failed to write conflict copy — skipping reconciliation to avoid silent data loss:",
			e,
		);
		return { reconciled: false };
	}

	// A backup write yields to live edits. That backup covers only the old
	// snapshot; it does not authorize replacing text that arrived meanwhile.
	if (!canApply() || ytext.toString() !== currentContent) {
		log("Content changed or an editor opened during backup; deferring reconciliation.");
		return { reconciled: false, conflictPath };
	}
	applyDiffToYText(ydoc, vaultContent, origin);
	return { reconciled: true, conflictPath };
}
