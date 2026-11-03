import { dirname, join } from "path-browserify";

/**
 * Compute a doc-relative conflict-copy path for `docPath`, inserting `label`
 * into the filename before the extension and keeping it in the same
 * directory as the original (e.g. "notes/todo.md" + "relay conflict 2026-07-21"
 * -> "notes/todo (relay conflict 2026-07-21).md"). Pure and file-I/O free so
 * it's directly unit-testable — see VaultShare.writeConflictCopy for the
 * write side.
 */
const CONFLICT_COPY_SUFFIX = /\((?:relay conflict|relay deleted)[^()]*\)(?:\.[^./]+)?$/;
export const RECOVERY_FOLDER = "Relay Recovery (local only)";

/**
 * True when `path` is one of the plugin's own recovery copies
 * ("x (relay conflict <ts>).md", "x (relay deleted <ts>).md"). Such copies
 * are local artefacts: syncing them multiplies them on every participant and
 * nests them on the next conflict.
 */
export function isConflictCopyPath(path: string): boolean {
	return path.split("/").includes(RECOVERY_FOLDER) || CONFLICT_COPY_SUFFIX.test(path);
}

export function buildConflictCopyPath(docPath: string, label: string): string {
	const dir = dirname(docPath);
	const base = docPath.split("/").pop() || docPath;
	const dotIdx = base.lastIndexOf(".");
	const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
	const ext = dotIdx > 0 ? base.slice(dotIdx) : "";
	const conflictName = `${stem} (${label})${ext}`;
	return dir === "." ? conflictName : join(dir, conflictName);
}
