/** @jest-environment jsdom */
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { InlineBaseAnchors } from "../../src/bases/InlineBaseAnchors";
import { inlineBaseHost, inlineBaseInEditor, inlineBaseHostInfo, inlineBaseInSection, inlineBaseRenderers } from "../../src/bases/InlineBasesHost";
import { NativeBasesSurface } from "../../src/bases/NativeBasesSurface";
import { nativePresenceBase } from "../mocks/nativePresenceBase";
jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), FileView: class {}, parseYaml: JSON.parse }));
function fixture() {
	const base = nativePresenceBase(), doc = new Y.Doc(), text = doc.getText("contents");
	text.insert(0, '```base\n'+base.source+'\n```');
	const anchors = new InlineBaseAnchors(text);
	const note = Object.assign(Object.create(TFile.prototype), { path: "Team/Note.md", extension: "md", stat: { mtime: 1, size: text.length } }) as TFile;
	Object.assign(base.query, { file: undefined }); Object.assign(base.controller, { currentFile: note, _loaded: true });
	const owner = { _loaded: true, containerEl: base.content, _children: [base.controller] };
	const view = { file: note, contentEl: base.root, _children: [owner] };
	return { base, doc, text, anchors, note, owner, view, close() { anchors.close(); doc.destroy(); base.close(); } };
}
test("native inline ownership creates a verified surface without masquerading as a saved file", () => {
	const f = fixture(); let allowed = true;
	try {
		const found = inlineBaseRenderers(f.view, "1.13.7"); expect(found).toHaveLength(1);
		const host = inlineBaseHost(found[0], f.anchors, f.anchors.definitions[0], () => allowed)!;
		const surface = NativeBasesSurface.inspect(host, "1.13.7");
		expect(surface?.current()).toBe(true); expect(surface?.file).toBe(f.note); expect(surface?.source).toBe(f.base.source);
		expect(NativeBasesSurface.inspect({ ...host }, "1.13.7")).toBeUndefined();
		f.text.insert(0, '# Before\n'); expect(surface?.current()).toBe(true);
		allowed = false; expect(inlineBaseHostInfo(host)?.current()).toBe(false); expect(surface?.current()).toBe(false);
	} finally { f.close(); }
});
test("source sections distinguish identical definitions and refuse ambiguous sections", () => {
	const f = fixture();
	try {
		const source = f.text.toString(); f.text.insert(f.text.length, '\n\n'+source);
		expect(inlineBaseInSection(f.anchors, 0, f.text.length)).toBeUndefined();
		expect(inlineBaseInSection(f.anchors, source.length+2, f.text.length)?.from).toBe(source.length+2);
		const host = inlineBaseHost(inlineBaseRenderers(f.view, "1.13.7")[0], f.anchors, f.anchors.definitions[1], () => true)!;
		const at = f.text.toString().lastIndexOf('Work'); f.text.insert(at, 'Changed');
		expect(host.dirty).toBe(true);
	} finally { f.close(); }
});
test("foreign, saved-file and detached controllers are not inline candidates", () => {
	const f = fixture();
	try {
		expect(inlineBaseRenderers(f.view, "1.13.8")).toEqual([]);
		Object.assign(f.base.controller, { currentFile: f.base.file }); expect(inlineBaseRenderers(f.view, "1.13.7")).toEqual([]);
		Object.assign(f.base.controller, { currentFile: f.note }); Object.assign(f.base.query, { file: f.base.file });
		expect(inlineBaseRenderers(f.view, "1.13.7")).toEqual([]);
		Object.assign(f.base.query, { file: undefined }); f.base.root.remove(); expect(inlineBaseRenderers(f.view, "1.13.7")).toEqual([]);
	} finally { f.close(); }
});


test("Live Preview maps duplicate inline widgets by editor position and rejects stale text", () => {
	const f = fixture();
	try {
		const source = f.text.toString(); f.text.insert(f.text.length, "\n\n" + source);
		let position = source.length + 2, text = f.text.toString();
		f.base.root.classList.add("cm-editor");
		const find = jest.spyOn(EditorView, "findFromDOM").mockReturnValue({ contentDOM: f.base.root,
			state: { doc: { toString: () => text } }, posAtDOM: () => position } as unknown as EditorView);
		try {
			expect(inlineBaseInEditor(f.anchors, f.base.content)?.from).toBe(source.length + 2);
			expect(find).toHaveBeenLastCalledWith(f.base.root);
			position = 0; expect(inlineBaseInEditor(f.anchors, f.base.content)?.from).toBe(0);
			text += "changed"; expect(inlineBaseInEditor(f.anchors, f.base.content)).toBeUndefined();
		} finally { find.mockRestore(); }
	} finally { f.close(); }
});
