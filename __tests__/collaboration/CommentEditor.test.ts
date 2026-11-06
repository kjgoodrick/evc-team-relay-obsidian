/** @jest-environment jsdom */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type Editor, type TFile } from "obsidian";
import * as Y from "yjs";
import { commentEditorExtension, type CommentEditorSurface } from "../../src/collaboration/CommentEditor";
import { bindCommentEditor } from "../../src/collaboration/EditorTextBinding";
import { captureTextAnchor } from "../../src/collaboration/anchors/text";
import { wireTextAnchor } from "../../src/collaboration/DiscussionProtocol";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";

jest.mock("obsidian", () => ({ editorInfoField: require("@codemirror/state").StateField.define({ create: () => ({}), update: (value: unknown) => value }), Menu: class {} }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 20 }) });
async function until(check: () => boolean) {
	for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
	throw new Error("Editor condition did not settle");
}

test("real CodeMirror captures its bound Y.Text, clips highlights, navigates and clears on account change", async () => {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "alpha 🙂 beta gamma");
	const anchor = wireTextAnchor(captureTextAnchor(text, id(1), id(2), 9, 13));
	const thread = { id: id(4), anchor, author_id: id(5), state: "open", state_revision: 1, anchor_revision: 1,
		removed: false, created_sequence: 1, activity_sequence: 1, created_at: "2026-11-05T00:00:00Z" };
	const session = { canAnchorText: true, canAnchorBlocks: true, permission: () => ({ read: true, comment: true }), documentGeneration: () => id(2),
		anchorThreads: jest.fn().mockResolvedValue([thread]), watch: jest.fn(() => jest.fn()), displayName: () => "Reviewer" } as unknown as DiscussionSession;
	const file = { path: "Team/Note.md", extension: "md" } as TFile, editor = {} as Editor;
	let surface!: CommentEditorSurface, current: DiscussionSession | undefined = session;
	const notifications = new Set<() => void>();
	const host = { registerEditor: (value: CommentEditorSurface) => { surface = value; return jest.fn(); },
		onChange: (fn: () => void) => { notifications.add(fn); return () => notifications.delete(fn); },
		targetFor: () => ({ path: file.path, entryId: id(1), session: current }), openThread: jest.fn() };
	const parent = document.createElement("div"); document.body.append(parent);
	const view = new EditorView({ parent, state: EditorState.create({ doc: text.toString(), selection: { anchor: 9, head: 13 },
		extensions: [editorInfoField.init(() => ({ file, editor } as never)), commentEditorExtension(host as unknown as DiscussionHost)] }) });
	let boundDocumentId = id(1);
	const unbind = bindCommentEditor(view, () => ({ text, documentId: boundDocumentId }));
	try {
		expect(surface.capture().anchor.context.quote).toBe("beta");
		const block = surface.capture(true).anchor;
		expect(block.context.quote).toBe("alpha 🙂 beta gamma");
		expect(block.structure).toEqual({ kind: "blocks", blocks: [{ kind: "paragraph" }] });
		Object.assign(session, { canAnchorBlocks: false });
		expect(() => surface.capture(true)).toThrow("not enabled");
		expect(surface.capture().anchor.context.quote).toBe("beta");
		Object.assign(session, { canAnchorBlocks: true });
		await until(() => !!parent.querySelector(".relay-comment-marker"));
		expect(parent.querySelector(".relay-comment-highlight")?.textContent).toBe("beta");
		parent.querySelector<HTMLButtonElement>(".relay-comment-marker")!.click();
		expect(host.openThread).toHaveBeenCalledWith(file, session, id(1), id(4));
		text.insert(0, "prefix ");
		expect(() => surface.capture()).toThrow("synchronizing"); // Y.Text updated before CM: no guessed offsets.
		view.dispatch({ changes: { from: 0, insert: "prefix " } });
		await until(() => parent.querySelector(".relay-comment-highlight")?.textContent === "beta");
		expect(surface.reveal(session, id(1), anchor)).toBe(true);
		expect(view.state.selection.main.from).toBe(16); expect(view.state.selection.main.to).toBe(20);
		expect(text.toString()).toBe("prefix alpha 🙂 beta gamma");
		boundDocumentId = id(99);
		expect(surface.reveal(session, id(1), anchor)).toBe(false);
		expect(() => surface.capture()).toThrow("synchronizing");
		boundDocumentId = id(1);
		current = undefined; notifications.forEach(fn => fn());
		expect(view.dom.classList.contains("relay-comment-highlights-hidden")).toBe(true);
		expect(() => surface.capture()).toThrow();
		await until(() => !parent.querySelector(".relay-comment-marker"));
	} finally { unbind(); view.destroy(); doc.destroy(); parent.remove(); }
});
