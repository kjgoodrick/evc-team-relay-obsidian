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
