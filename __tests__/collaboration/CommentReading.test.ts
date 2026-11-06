/** @jest-environment jsdom */
import * as Y from "yjs";
import type { MarkdownPostProcessorContext, MarkdownView, Plugin, TFile } from "obsidian";
import { ReadingComments, ReadingCommentSection } from "../../src/collaboration/CommentReading";
import { bindReadingComments } from "../../src/collaboration/ReadingTextBinding";
import { captureTextAnchor } from "../../src/collaboration/anchors/text";
import { localTextAnchor, wireTextAnchor } from "../../src/collaboration/DiscussionProtocol";
import { resolveTextAnchor } from "../../src/collaboration/anchors/text";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";

jest.mock("obsidian", () => {
	class Component {
		cleanups: (() => void)[] = [];
		register(fn: () => void) { this.cleanups.push(fn); }
		registerEvent() {}
		registerDomEvent(node: EventTarget, type: string, fn: EventListener) { node.addEventListener(type, fn); this.register(() => node.removeEventListener(type, fn)); }
		unload() { (this as unknown as { onunload?: () => void }).onunload?.(); this.cleanups.reverse().forEach(fn => fn()); }
	}
	return { Component, MarkdownRenderChild: class extends Component { constructor(readonly containerEl: HTMLElement) { super(); } },
		Notice: class {}, Menu: class { addItem() { return this; } showAtPosition() {} showAtMouseEvent() {} } };
});
Object.assign(HTMLElement.prototype, { getClientRects: () => [{ width: 500, height: 600 }], scrollIntoView: jest.fn() });
Object.assign(Range.prototype, { getClientRects: () => [] });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function until(check: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
	throw new Error("Reading view did not settle");
}
function fixture() {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "repeat **repeat**\n\nnext");
	const contentEl = document.createElement("div"); contentEl.innerHTML = "<div><p>repeat <strong>repeat</strong></p></div><div><p>next</p></div>"; document.body.append(contentEl);
	const roots = Array.from(contentEl.children) as HTMLElement[], file = { path: "Team/Note.md", extension: "md" } as TFile;
	let source = text.toString(), current = true, read = true;
	const view = { contentEl, file, getViewData: () => source, getMode: () => "preview" } as unknown as MarkdownView;
	const anchor = wireTextAnchor(captureTextAnchor(text, id(1), id(2), 9, 15));
	const listeners = new Set<() => void>(), stop = jest.fn();
	const session = { canAnchorText: true, canAnchorBlocks: true, identity: { accountId: id(3) }, permission: () => ({ read, comment: read, edit: false }),
		documentGeneration: () => id(2), watch: jest.fn((_: string, fn: () => void) => { listeners.add(fn); return stop; }), displayName: () => "Reviewer",
		anchorThreads: jest.fn().mockResolvedValue([{ id: id(4), anchor, author_id: id(3), state: "open", activity_sequence: 1 }]) } as unknown as DiscussionSession;
	const host = { onChange: jest.fn(() => jest.fn()), readingViewFor: (root: HTMLElement) => current && contentEl.contains(root) ? view : undefined, activeReadingView: () => view,
		targetFor: () => ({ session: current ? session : undefined, entryId: id(1) }), saveCommentSelection: jest.fn().mockResolvedValue(undefined), openThread: jest.fn() };
	const plugin = { registerMarkdownPostProcessor: jest.fn(), addCommand: jest.fn(), app: { workspace: { on: jest.fn() } } };
	const comments = new ReadingComments(host as unknown as DiscussionHost, plugin as unknown as Plugin); comments.onload();
	const unbind = bindReadingComments(view, () => ({ documentId: id(1), text }));
	const sections = roots.map((root, index) => new ReadingCommentSection(comments, root, { sourcePath: file.path, docId: "test", frontmatter: null, addChild: jest.fn(),
		getSectionInfo: () => ({ text: source, lineStart: index * 2, lineEnd: index * 2 }) } as MarkdownPostProcessorContext));
	sections.forEach(section => section.onload());
	return { text, view, anchor, comments, sections, host, session, roots, listeners,
		setSource(value: string) { source = value; }, revoke() { read = false; listeners.forEach(fn => fn()); }, logout() { current = false; comments.invalidate(); },
		close() { sections.forEach(section => section.unload()); comments.unload(); unbind(); doc.destroy(); contentEl.remove(); } };
}

test("Reading capture uses the actual shared text, survives prefix edits and freezes before opening the composer", async () => {
	const f = fixture();
	try {
		await until(() => !!f.roots[0].querySelector("button"));
		expect(f.session.watch).toHaveBeenCalledTimes(1); // Shared subscription, not one per section.
		const control = f.roots[0].querySelector("button")!; control.focus(); f.listeners.forEach(fn => fn());
		await new Promise(resolve => setTimeout(resolve, 100));
		expect(f.roots[0].querySelector("button")).toBe(control); expect(document.activeElement).toBe(control);
		const range = document.createRange(); range.selectNodeContents(f.roots[0].querySelector("strong")!);
		const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
		const captured = f.comments.capture(f.view);
		expect(captured.anchor.context.quote).toBe("repeat"); expect(captured.anchor.selected_length).toBe(6);
		f.comments.submit(() => captured);
		expect(f.host.saveCommentSelection).toHaveBeenCalledWith(captured);
		f.text.insert(0, "prefix ");
		expect(() => f.comments.capture(f.view)).toThrow("rendering"); // Render snapshot is stale.
		expect(resolveTextAnchor(f.text, id(1), id(2), localTextAnchor(captured.anchor))).toEqual({ status: "attached", from: 16, to: 22 });
		f.roots[0].querySelector("p")!.firstChild!.textContent = "prefix repeat "; f.setSource(f.text.toString());
		await until(() => !!f.roots[0].querySelector("button"));
		expect(f.comments.reveal(f.view, f.session, id(1), captured.anchor)).toBe(true);
		expect(selection.toString()).toBe("repeat");
	} finally { f.close(); }
});

test("reprocessing an existing Reading root transfers ownership without duplicate controls or stale teardown", async () => {
	const f = fixture(); let replacement: ReadingCommentSection | undefined;
	try {
		await until(() => !!f.roots[0].querySelector("button"));
		replacement = new ReadingCommentSection(f.comments, f.roots[0], f.sections[0].context); replacement.onload();
		await until(() => f.roots[0].querySelectorAll(".relay-reading-comment-controls").length === 1);
		f.sections[0].unload(); f.comments.invalidate();
		await until(() => f.roots[0].classList.contains("relay-reading-comment-section"));
		expect(f.roots[0].querySelectorAll(".relay-reading-comment-controls")).toHaveLength(1);
		expect(f.comments.snapshot(f.sections[0])).toBeUndefined(); expect(f.comments.snapshot(replacement)).toBeDefined();
	} finally { replacement?.unload(); f.close(); }
});

test("Reading allows cross-section selection and explicit block fallback, then clears immediately on revoke", async () => {
	const f = fixture();
	try {
		await until(() => !!f.roots[1].querySelector("button"));
		const range = document.createRange(); range.setStart(f.roots[0].querySelector("strong")!.firstChild!, 0); range.setEnd(f.roots[1].querySelector("p")!.firstChild!, 4);
		const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
		expect(f.comments.capture(f.view).anchor.context.quote).toBe("repeat**\n\nnext");
		expect(f.comments.capture(f.view, f.sections[0]).anchor.structure).toEqual({ kind: "blocks", blocks: [{ kind: "paragraph" }] });
		f.revoke(); expect(f.roots[0].querySelector("button")).toBeNull();
		expect(f.roots[0].classList.contains("relay-reading-comment-section")).toBe(false);
		expect(() => f.comments.capture(f.view)).toThrow("access");
		expect(f.comments.reveal(f.view, f.session, id(1), f.anchor)).toBe(false);
	} finally { f.close(); }
});

test("an account change clears existing controls and ignores late thread reads", async () => {
	const f = fixture();
	try {
		await until(() => !!f.roots[0].querySelector("button"));
		let release!: (value: unknown[]) => void;
		(f.session.anchorThreads as jest.Mock).mockImplementation(() => new Promise(resolve => { release = resolve; }));
		f.listeners.forEach(fn => fn()); await until(() => !!release);
		f.logout(); expect(f.roots[0].querySelector("button")).toBeNull(); release([]);
		await new Promise(resolve => setTimeout(resolve, 100));
		expect(f.roots[0].querySelector("button")).toBeNull();
	} finally { f.close(); }
});

test("an unsupported callout render keeps an explicit whole-block target and can reveal it in Reading view", async () => {
	const f = fixture();
	try {
		await until(() => !!f.roots[0].querySelector("button"));
		const source = "> [!note] Title\n> Body";
		f.text.delete(0, f.text.length); f.text.insert(0, source); f.setSource(source);
		f.roots[0].innerHTML = '<div class="callout"><div class="callout-title">Title</div><div class="callout-content"><p>Body</p></div></div>';
		f.roots[1].remove(); f.sections[0].context.getSectionInfo = () => ({ text: source, lineStart: 0, lineEnd: 1 });
		await until(() => !!f.roots[0].querySelector("button"));
		const range = document.createRange(); range.selectNodeContents(f.roots[0].querySelector("p")!);
		const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
		expect(() => f.comments.capture(f.view)).toThrow("rendering");
		const captured = f.comments.capture(f.view, f.sections[0]);
		expect(captured.anchor.structure).toEqual({ kind: "blocks", blocks: [{ kind: "callout" }] });
		expect(captured.anchor.context.quote).toBe(source);
		(f.session.anchorThreads as jest.Mock).mockResolvedValue([{ id: id(9), anchor: captured.anchor, state: "open", activity_sequence: 2 }]);
		f.listeners.forEach(fn => fn()); await until(() => f.roots[0].classList.contains("relay-reading-block-comment"));
		expect(f.comments.reveal(f.view, f.session, id(1), captured.anchor)).toBe(true);
	} finally { f.close(); }
});
