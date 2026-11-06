import type { EditorView } from "@codemirror/view";
import type * as Y from "yjs";

/** Published only by the existing live editor binding. Comment surfaces never
 * create a Y.Doc or load/mint a document just to obtain a selection target. */
export type EditorTextBinding = { documentId: string; text: Y.Text };
const bindings = new WeakMap<EditorView, () => EditorTextBinding | undefined>();
export function bindCommentEditor(editor: EditorView, resolve: () => EditorTextBinding | undefined): () => void {
	bindings.set(editor, resolve);
	return () => { if (bindings.get(editor) === resolve) bindings.delete(editor); };
}
export function commentEditorBinding(editor: EditorView): EditorTextBinding | undefined { return bindings.get(editor)?.(); }
