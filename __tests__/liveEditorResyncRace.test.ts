import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { LiveCMPluginValue } from "../src/y-codemirror.next/LiveEditPlugin";

jest.mock("../src/ViewBindings", () => ({ isBoundMarkdown: (v: any) => v?.kind === "markdown" }));
jest.mock("../src/initContentClaim", () => ({
	claimInitIfUnclaimed: jest.fn(), markInitDone: jest.fn(), wonInitClaim: () => true,
	awaitClaimSettled: () => settle(),
}));
let settle = async () => {};
function deferred() {
	let resolve!: () => void;
	return { promise: new Promise<void>(r => { resolve = r; }), finish: () => resolve() };
}
function fixture(bound: boolean) {
	const ydoc = new Y.Doc();
	const editor = { state: EditorState.create({ doc: "first" }), dispatch: jest.fn(), dom: {} };
	const document = { crdtDoc: ydoc, get content() { return ydoc.getText("contents").toString(); },
		awaitFirstSync: async () => {}, _liveProvider: { awareness: {}, synced: true, ws: null } };
	const plugin = Object.create(LiveCMPluginValue.prototype) as LiveCMPluginValue;
	Object.assign(plugin, { editor, document, embed: !bound, unsubscribes: [], warn: jest.fn(),
		view: bound ? { kind: "markdown", boundDocument: document, isTracking: false } : undefined });
	return { plugin, editor, document, ydoc };
}
afterEach(() => { settle = async () => {}; });

test.each([true, false])("destroying the editor during sync cannot resume against a closed view: bound=%s", async bound => {
	const f = fixture(bound), pending = deferred();
	f.document.awaitFirstSync = () => pending.promise;
	const task = f.plugin.resync();
	f.plugin.destroy(); pending.finish();
	await expect(task).resolves.toBeUndefined();
	expect(f.editor.dispatch).not.toHaveBeenCalled();
	expect(f.ydoc.getText("contents").toString()).toBe("");
	f.ydoc.destroy();
});

test.each([true, false])("first sync seeds the latest editor buffer after the claim settles: bound=%s", async bound => {
	const f = fixture(bound), pending = deferred(), started = deferred();
	settle = () => { started.finish(); return pending.promise; };
	const task = f.plugin.resync(); await started.promise;
	f.editor.state = f.editor.state.update({ changes: { from: 5, insert: " + still typing" } }).state;
	pending.finish(); await task;
	expect(f.ydoc.getText("contents").toString()).toBe("first + still typing");
	f.ydoc.destroy();
});

test("a stale keyframe cannot overwrite a keystroke entered while resync awaited", async () => {
	const f = fixture(true), started = deferred(), pending = deferred();
	f.ydoc.getText("contents").insert(0, "remote");
	f.plugin.getKeyFrame = async () => { started.finish(); await pending.promise; return [{ from: 0, to: 5, insert: "remote" }]; };
	const task = f.plugin.resync(); await started.promise;
	f.editor.state = f.editor.state.update({ changes: { from: 5, insert: "123" } }).state;
	pending.finish(); await task;
	expect(f.editor.dispatch).not.toHaveBeenCalled();
	expect(f.editor.state.doc.toString()).toBe("first123");
	f.ydoc.destroy();
});

function updateFixture(initial: string) {
 const f = fixture(true), text = f.ydoc.getText("contents"); text.insert(0, initial);
 Object.assign(f.document, { crdtText: text, setUnsavedFile: jest.fn(async () => ({})) });
 Object.assign(f.plugin, { _ytext: text, getDocument: () => f.document, mergeBanner: jest.fn() });
 const send = (before: string, from: number, to: number, insert: string) => {
  const state = EditorState.create({ doc: before }), tr = state.update({ changes: { from, to, insert } });
  f.plugin.update({ docChanged: true, transactions: [tr], changes: tr.changes, startState: state, state: tr.state } as any);
 };
 return { ...f, text, send };
}

test("repeated file-load transactions cannot append copies of an already synced Welcome note", () => {
 const content = "This is your new vault.\nMake a note of something.\n";
 const f = updateFixture(content);
 for (let i = 0; i < 10; i++) f.send("", 0, 0, content);
 expect(f.text.toString()).toBe(content);
 expect((f.document as any).setUnsavedFile).not.toHaveBeenCalled();
 f.send(content, content.length, content.length, "Actual edit");
 expect(f.text.toString()).toBe(content + "Actual edit"); f.ydoc.destroy();
});

test("edits with a divergent base are preserved for review rather than replayed at invalid offsets", async () => {
 const f = updateFixture("remote text"); f.send("local text", 10, 10, " changed");
 await Promise.resolve();
 expect(f.text.toString()).toBe("remote text");
 expect((f.document as any).setUnsavedFile).toHaveBeenCalledWith("local text changed");
 expect(f.plugin.mergeBanner).toHaveBeenCalled(); f.ydoc.destroy();
});

test("a stale plugin cannot forward the next note's load transaction", () => {
 const f = updateFixture("old note"), next = new Y.Doc(); next.getText("contents").insert(0, "new note");
 f.plugin.getDocument = () => ({ crdtText: next.getText("contents") }) as any;
 f.send("", 0, 0, "new note");
 expect(f.text.toString()).toBe("old note"); expect(next.getText("contents").toString()).toBe("new note");
 f.ydoc.destroy(); next.destroy();
});
