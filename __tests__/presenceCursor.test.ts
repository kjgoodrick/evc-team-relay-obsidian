/** @jest-environment jsdom */
import { EditorState, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { editorInfoField } from "obsidian";
import { DocumentViewBinding, ViewBindingStateField } from "../src/ViewBindings";
import { yRemoteSelections, yRemoteSelectionsTheme } from "../src/y-codemirror.next/RemoteSelections";
import { presenceColorForUser } from "../src/presenceColor";

// Substitute only the host's document lookup. Rendering, Yjs positions and the
// CodeMirror extension are production code, mounted in real EditorViews.
jest.mock("../src/ViewBindings", () => ({
	ViewBindingStateField: require("@codemirror/state").StateField.define({ create: () => null, update: (v: unknown) => v }),
	DocumentViewBinding: class {},
}));
jest.mock("obsidian", () => ({
	editorInfoField: require("@codemirror/state").StateField.define({ create: () => ({ file: null }), update: (v: unknown) => v }),
}));

test("cursor names, borders and selections keep the same identity color across notes and profile changes", () => {
	const fixtures = ["#ff0000", "#0000ff"].map(color => {
		const doc = new Y.Doc(), text = doc.getText("content"), awareness = new Awareness(doc);
		text.insert(0, "A shared note");
		const peer = doc.clientID + 1;
		awareness.states.set(peer, { user: { id: "alice", name: "Alice", color }, cursor: {
			anchor: Y.createRelativePositionFromTypeIndex(text, 0), head: Y.createRelativePositionFromTypeIndex(text, 4),
		} });
		const binding = Object.assign(new (DocumentViewBinding as unknown as new () => object)(), { boundDocument: { crdtText: text, _liveProvider: { awareness } } });
		const registry = { locateMarkdownView: () => binding };
		const parent = document.body.appendChild(document.createElement("div"));
		parent.className = "relay-live-editor";
		const editor = new EditorView({ parent, state: EditorState.create({ doc: text.toString(), extensions: [
			(ViewBindingStateField as StateField<unknown>).init(() => registry), editorInfoField,
			yRemoteSelections, yRemoteSelectionsTheme,
		] }) });
		editor.dispatch({});
		return { doc, awareness, peer, parent, editor };
	});
	try {
		const expected = document.createElement("span");
		const color = presenceColorForUser({ id: "alice" });
		expected.style.borderColor = color.color;
		expected.style.backgroundColor = color.light;
		for (const f of fixtures) {
			expect(f.parent.querySelector<HTMLElement>(".cm-ySelectionCaret")?.style.borderColor).toBe(expected.style.borderColor);
			expect(f.parent.querySelector<HTMLElement>(".cm-ySelection")?.style.backgroundColor).toBe(expected.style.backgroundColor);
		}
		const f = fixtures[1];
		Object.assign(f.awareness.states.get(f.peer)!.user, { name: "Renamed Alice", color: "#ffffff" });
		f.awareness.emit("change", [{ added: [], updated: [f.peer], removed: [] }, "test"]);
		expect(f.parent.querySelector(".cm-ySelectionInfo")?.textContent).toBe("Renamed Alice");
		expect(f.parent.querySelector<HTMLElement>(".cm-ySelectionCaret")?.style.borderColor).toBe(expected.style.borderColor);
	} finally {
		for (const f of fixtures) { f.editor.destroy(); f.awareness.destroy(); f.doc.destroy(); f.parent.remove(); }
	}
});
