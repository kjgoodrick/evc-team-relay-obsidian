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

function cursorFixture(source = "A shared note", shared?: { doc: Y.Doc; awareness: Awareness }) {
	const doc = shared?.doc ?? new Y.Doc(), text = doc.getText("contents");
	if (!shared) text.insert(0, source);
	const awareness = shared?.awareness ?? new Awareness(doc);
	const boundDocument = { crdtText: text, _liveProvider: { awareness } };
	const binding = Object.assign(new (DocumentViewBinding as unknown as new () => object)(), { boundDocument });
	const registry = { locateMarkdownView: () => binding };
	const parent = document.body.appendChild(document.createElement("div")); parent.className = "relay-live-editor";
	const editor = new EditorView({ parent, state: EditorState.create({ doc: text.toString(), extensions: [
		(ViewBindingStateField as StateField<unknown>).init(() => registry), editorInfoField, yRemoteSelections,
	] }) });
	const focus = jest.spyOn(editor, "hasFocus", "get").mockReturnValue(false);
	const close = () => { editor.destroy(); focus.mockRestore(); parent.remove(); if (!shared) { awareness.destroy(); doc.destroy(); } };
	return { doc, text, awareness, binding, editor, focus, close };
}

test("only the foreground pane publishes and clears its cursor on blur or destroy", () => {
	const hostFocus = jest.spyOn(document, "hasFocus").mockReturnValue(true);
	const first = cursorFixture(), second = cursorFixture(undefined, first);
	try {
		first.focus.mockReturnValue(true); first.editor.dispatch({ selection: { anchor: 1, head: 4 } });
		const cursor = first.awareness.getLocalState()!.cursor;
		expect(cursor).toBeTruthy();
		second.editor.dispatch({}); // An inactive pane receives an update.
		expect(first.awareness.getLocalState()!.cursor).toBe(cursor);
		first.focus.mockReturnValue(false); first.editor.dispatch({});
		expect(first.awareness.getLocalState()!.cursor).toBeNull();
		second.focus.mockReturnValue(true); second.editor.dispatch({ selection: { anchor: 5 } });
		expect(first.awareness.getLocalState()!.cursor).toBeTruthy();
		window.dispatchEvent(new Event("blur"));
		expect(first.awareness.getLocalState()!.cursor).toBeNull();
		second.editor.dispatch({});
		expect(first.awareness.getLocalState()!.cursor).toBeTruthy();
		second.close();
		expect(first.awareness.getLocalState()!.cursor).toBeNull();
	} finally { first.close(); hostFocus.mockRestore(); }
});

test("switching provider detaches the old listener and clears stale decorations", () => {
	const f = cursorFixture(), nextDoc = new Y.Doc(), nextAwareness = new Awareness(nextDoc);
	const nextText = nextDoc.getText("contents"); nextText.insert(0, "A shared note");
	const oldOff = jest.spyOn(f.awareness, "off"), nextOff = jest.spyOn(nextAwareness, "off");
	try {
		f.editor.dispatch({});
		f.binding.boundDocument = { crdtText: nextText, _liveProvider: { awareness: nextAwareness } };
		f.editor.dispatch({});
		expect(oldOff).toHaveBeenCalledWith("change", expect.any(Function));
		const dispatch = jest.spyOn(f.editor, "dispatch");
		f.awareness.emit("change", [{ added: [f.doc.clientID + 1], updated: [], removed: [] }, "test"]);
		expect(dispatch).not.toHaveBeenCalled();
		nextAwareness.emit("change", [{ added: [nextDoc.clientID + 1], updated: [], removed: [] }, "test"]);
		expect(dispatch).toHaveBeenCalledTimes(1);
		f.editor.destroy();
		expect(nextOff).toHaveBeenCalledWith("change", expect.any(Function));
	} finally { f.close(); nextAwareness.destroy(); nextDoc.destroy(); }
});

test("long remote selections render only the visible range and malformed peers do not crash the view", () => {
	const f = cursorFixture(Array.from({ length: 10000 }, () => "line").join("\n"));
	try {
		Object.defineProperty(f.editor, "visibleRanges", { configurable: true, get: () => [{ from: 0, to: 49 }] });
		f.awareness.states.set(f.doc.clientID + 1, { user: { name: "Remote" }, cursor: {
			anchor: Y.createRelativePositionFromTypeIndex(f.text, 0), head: Y.createRelativePositionFromTypeIndex(f.text, f.text.length),
		} });
		f.awareness.states.set(f.doc.clientID + 2, { cursor: { anchor: { item: "invalid" }, head: {} } });
		f.editor.dispatch({});
		expect(f.editor.plugin(yRemoteSelections)!.decorations.size).toBeLessThan(20);
		expect(f.editor.plugin(yRemoteSelections)!.decorations.size).toBeGreaterThan(0);
	} finally { f.close(); }
});
