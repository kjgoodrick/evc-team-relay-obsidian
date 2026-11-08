import type * as Y from "yjs";

export interface RestoreLocalText { label: string; text: string }
export interface ManagedRestoreText {
	entryId: string;
	serverPath: string;
	serverText: string;
	local: RestoreLocalText[];
	capturedAt: string;
	check(): void;
}

/** A display/read path must remain a literal descendant of this share. */
export function requireRestoreRelativePath(path: string): void {
	if (typeof path !== "string" || !path || /^[a-z]:/i.test(path) || path.includes("\\")
		|| [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
		|| path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("The retained source has an unsafe path");
}
/** A missing insertion/deletion dependency can leave visible text plausible
 * while omitting saved work. Keep its raw bytes exportable; do not present that
 * partially applied history as a complete source version. */
export function assertCompleteComparisonSource(doc: Y.Doc, label: string): void {
	if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) throw new Error(`${label} contains incomplete changes and cannot be compared as full text. Retain a recovery copy before continuing.`);
}
