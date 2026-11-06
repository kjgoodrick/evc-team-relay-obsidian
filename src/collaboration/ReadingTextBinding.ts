import type { MarkdownView } from "obsidian";
import type { EditorTextBinding } from "./EditorTextBinding";

const bindings = new WeakMap<MarkdownView, () => EditorTextBinding | undefined>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) { try { listener(); } catch { /* Isolate surfaces. */ } } };
/** Published by the existing view/CRDT bridge; comments never load or mint a
 * document to obtain an anchor. A replaced bridge cannot unbind its successor. */
export function bindReadingComments(view: MarkdownView, resolve: () => EditorTextBinding | undefined): () => void {
	bindings.set(view, resolve); changed();
	return () => { if (bindings.get(view) === resolve) { bindings.delete(view); changed(); } };
}
export function readingCommentBinding(view: MarkdownView): EditorTextBinding | undefined { return bindings.get(view)?.(); }
export function onReadingBindingChange(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
