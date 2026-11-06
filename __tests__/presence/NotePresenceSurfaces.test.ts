/** @jest-environment jsdom */
import * as Y from "yjs";
import type { MarkdownPostProcessorContext, MarkdownView, Plugin } from "obsidian";
import { NotePresenceSurfaces, PresenceSection } from "../../src/collaboration/presence/NotePresenceSurfaces";
import { bindReadingComments } from "../../src/collaboration/ReadingTextBinding";

jest.mock("obsidian", () => {
	class Component {
		stops: (() => void)[] = [];
		register(fn: () => void) { this.stops.push(fn); }
		unload() { (this as unknown as { onunload?: () => void }).onunload?.(); this.stops.splice(0).forEach(stop => stop()); }
	}
	return { Component, MarkdownRenderChild: class extends Component { constructor(readonly containerEl: HTMLElement) { super(); } } };
});

function fixture() {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "repeat **repeat**\n\nnext");
	const root = document.body.appendChild(document.createElement("div"));
	root.innerHTML = "<div><p>repeat <strong>repeat</strong></p></div><div><p>next</p></div>";
	const roots = Array.from(root.children) as HTMLElement[];
	let source = text.toString();
	const view = { contentEl: root, containerEl: root, getViewData: () => source, file: { path: "Shared/Note.md" }, getMode: () => "preview" } as unknown as MarkdownView;
	const changed = jest.fn(), interrupted = jest.fn();
	const surfaces = new NotePresenceSurfaces({ registerEditorExtension: jest.fn(), registerMarkdownPostProcessor: jest.fn() } as unknown as Plugin, changed, interrupted);
	surfaces.onload(); const unbind = bindReadingComments(view, () => ({ documentId: "note", text }));
	surfaces.setActive(view, text, "note");
	root.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
	roots.forEach((section, index) => {
		section.getBoundingClientRect = () => ({ top: index * 100, bottom: index * 100 + 80, height: 80 }) as DOMRect;
		section.scrollIntoView = jest.fn();
	});
	const sections = roots.map((section, index) => new PresenceSection(surfaces, section, {
		sourcePath: view.file!.path, docId: "presence-test", frontmatter: null, addChild: jest.fn(),
		getSectionInfo: () => ({ text: source, lineStart: index * 2, lineEnd: index * 2 }),
	} as MarkdownPostProcessorContext));
	sections.forEach(section => section.onload());
	return { doc, text, root, roots, view, surfaces, changed, interrupted, unbind,
		updateSource: () => { source = text.toString(); },
		close: () => { sections.forEach(section => section.unload()); surfaces.unload(); unbind(); doc.destroy(); root.remove(); document.getSelection()?.removeAllRanges(); } };
}

test("Reading publishes the verified visible block and exact rendered selection, independently of comment permission", async () => {
	const f = fixture();
	try {
		const range = document.createRange(); range.selectNodeContents(f.roots[0].querySelector("strong")!);
		document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
		const location = f.surfaces.capture();
		expect(Y.createAbsolutePositionFromRelativePosition(location.viewport!, f.doc)?.index).toBe(0);
		expect(Y.createAbsolutePositionFromRelativePosition(location.selection!.anchor, f.doc)?.index).toBe(9);
		expect(Y.createAbsolutePositionFromRelativePosition(location.selection!.head, f.doc)?.index).toBe(15);
		const originalSelection = document.getSelection()!.toString();
		expect(await f.surfaces.reveal(19, 20)).toBe(true); expect(f.roots[1].scrollIntoView).toHaveBeenCalled();
		expect(document.getSelection()!.toString()).toBe(originalSelection);
		f.roots[0].getBoundingClientRect = () => ({ top: -100, bottom: -20, height: 80 }) as DOMRect;
		expect(Y.createAbsolutePositionFromRelativePosition(f.surfaces.capture().viewport!, f.doc)?.index).toBe(19);
		document.getSelection()!.removeAllRanges(); expect(f.surfaces.capture().selection).toBeNull();
	} finally { f.close(); }
});

test("stale rendered source and changed binding cannot publish or reveal a guessed location", async () => {
	const f = fixture();
	try {
		f.text.insert(0, "prefix ");
		expect(f.surfaces.capture()).toEqual({ viewport: null, selection: null }); expect(await f.surfaces.reveal(2, 3)).toBe(false);
		f.updateSource(); f.roots[0].querySelector("p")!.firstChild!.textContent = "prefix repeat ";
		expect(f.surfaces.capture().viewport).not.toBeNull();
		f.unbind(); expect(f.surfaces.capture()).toEqual({ viewport: null, selection: null });
	} finally { f.close(); }
});

test("manual navigation interrupts, passive pointer/scroll does not, and deactivation cancels pending publication", () => {
	jest.useFakeTimers(); const f = fixture();
	try {
		f.root.dispatchEvent(new Event("scroll", { bubbles: true })); f.root.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
		expect(f.interrupted).not.toHaveBeenCalled();
		f.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); expect(f.interrupted).toHaveBeenCalledTimes(1);
		f.surfaces.setActive(); jest.advanceTimersByTime(200); expect(f.changed).not.toHaveBeenCalled();
		f.root.dispatchEvent(new Event("beforeinput", { bubbles: true })); expect(f.interrupted).toHaveBeenCalledTimes(1);
	} finally { f.close(); jest.useRealTimers(); }
});

test("distant Reading navigation materializes through the host source-line API and verifies its section", async () => {
	jest.useFakeTimers(); const f = fixture();
	try {
		f.roots[1].remove();
		const applyScroll = jest.fn(() => { f.root.append(f.roots[1]); });
		Object.assign(f.view, { previewMode: { applyScroll } });
		const pending = f.surfaces.reveal(19, 20);
		expect(applyScroll).toHaveBeenCalledWith(2);
		expect(f.roots[1].scrollIntoView).not.toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync(60); expect(await pending).toBe(true);
		expect(f.roots[1].scrollIntoView).toHaveBeenCalledTimes(1);
	} finally { f.close(); jest.useRealTimers(); }
});

test("cancelled or unloaded navigation cannot complete after a delayed Reading render", async () => {
	jest.useFakeTimers(); const f = fixture(); let current = true;
	try {
		f.roots[1].remove(); Object.assign(f.view, { previewMode: { applyScroll: jest.fn() } });
		const pending = f.surfaces.reveal(19, 20, () => current);
		current = false; f.root.append(f.roots[1]); await jest.advanceTimersByTimeAsync(60);
		expect(await pending).toBe(false); expect(f.roots[1].scrollIntoView).not.toHaveBeenCalled();
		f.roots[1].remove(); const unloading = f.surfaces.reveal(19, 20);
		f.surfaces.unload(); expect(await unloading).toBe(false);
	} finally { f.close(); jest.useRealTimers(); }
});
