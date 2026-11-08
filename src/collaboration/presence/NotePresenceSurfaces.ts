import { Component, MarkdownRenderChild, MarkdownView, editorInfoField, type MarkdownPostProcessorContext, type Plugin } from "obsidian";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import * as Y from "yjs";
import { commentEditorBinding } from "../EditorTextBinding";
import { readingCommentBinding } from "../ReadingTextBinding";
import { ReadingSource, ReadingSectionMap, mapReadingSection } from "../anchors/reading";
import type { PresenceLocation } from "./PresencePeers";
import { ReadingPresenceLayer, type ReadingPresenceScope } from "./ReadingPresenceLayer";
import type { ImageOccurrence } from "../anchors/images";
import { editorImageTargets, readingImageTargets, type RenderedImageTarget } from "../anchors/renderedImages";

/** Scroll exact rendered text without replacing native selection. */
export function revealReadingRange(root: HTMLElement, range: Range): boolean {
	if (!root.contains(range.startContainer) || typeof range.getClientRects !== "function") return false;
	let rect = Array.from(range.getClientRects()).find(rect => rect.height > 0 && [rect.top, rect.bottom, rect.left, rect.right].every(Number.isFinite));
	if (!rect) return false;
	const win = root.ownerDocument.defaultView; if (!win) return false;
	let revealed = false;
	for (let element = range.startContainer.parentElement; element && root.contains(element); element = element.parentElement) {
		const style = win.getComputedStyle(element), vertical = /^(auto|scroll)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
		const horizontal = /^(auto|scroll)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
		if (!vertical && !horizontal) continue;
		const box = element.getBoundingClientRect();
		const sy = element.offsetHeight > 0 ? box.height / element.offsetHeight : 1, sx = element.offsetWidth > 0 ? box.width / element.offsetWidth : 1;
		if (![sx, sy].every(value => Number.isFinite(value) && value > 0)) continue;
		const top = vertical ? ((rect.top + rect.bottom) / 2 - (box.top + box.bottom) / 2) / sy : 0;
		const left = horizontal ? (rect.left < box.left ? rect.left - box.left : rect.right > box.right ? rect.right - box.right : 0) / sx : 0;
		element.scrollBy({ top, left, behavior: "auto" }); revealed = true;
		// A nested code/table scroller can move horizontally while an outer pane
		// still needs vertical navigation. Re-measure after each actual scroll.
		const moved = Array.from(range.getClientRects()).find(rect => rect.height > 0 && [rect.top, rect.bottom, rect.left, rect.right].every(Number.isFinite));
		if (moved) rect = moved;
	}
	return revealed;
}

/** Read-only semantic capture/navigation shared by Jump and Follow. It never
 * changes the user's selection, note data, mode or saved view preferences. */
export class NotePresenceSurfaces extends Component {
	private editors = new Set<EditorView>();
	private sections = new Set<PresenceSection>();
	private sectionOwners = new WeakMap<HTMLElement, PresenceSection>();
	private active?: { view: MarkdownView; text: Y.Text; id: string; mode: string };
	private stop?: () => void;
	private sources = new WeakMap<Y.Text, ReadingSource>();
	private readers = new Map<MarkdownView, ReadingPresenceLayer>();
	private timer?: number;
	private closed = false;
	private revision = 0;
	private waits = new Map<number, () => void>();
	private editorContent?: { doc: EditorView["state"]["doc"]; revision: number; matches: boolean };
	constructor(private plugin: Plugin, private changed: (location: PresenceLocation) => void, private interrupted: () => void) { super(); }
	onload(): void {
		const schedule = () => this.schedule(), attach = (view: EditorView) => {
			this.editors.add(view); this.schedule();
			return () => { this.editors.delete(view); this.schedule(); };
		};
		this.plugin.registerEditorExtension(ViewPlugin.fromClass(class {
			private stop: () => void;
			constructor(view: EditorView) { this.stop = attach(view); }
			update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) schedule(); }
			destroy() { this.stop(); }
		}));
		this.plugin.registerMarkdownPostProcessor((root, context) => {
			if (context.sourcePath.endsWith(".md") && !root.closest(".internal-embed,.markdown-embed,.canvas-node")) context.addChild(new PresenceSection(this, root, context));
		}, 1001);
	}
	setActive(view?: MarkdownView, text?: Y.Text, id?: string): void {
		const mode = view?.getMode();
		if (this.active?.view === view && this.active?.text === text && this.active?.mode === mode && this.active?.id === id) return;
		if (this.active) this.sources.delete(this.active.text);
		this.stop?.(); this.stop = undefined; this.editorContent = undefined; this.active = undefined;
		if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined;
		if (!view || !text || !id || this.closed) return;
		this.active = { view, text, id, mode: mode! };
		this.sources.delete(text);
		const doc = view.containerEl.ownerDocument, win = doc.defaultView;
		const schedule = () => this.schedule(), textChanged = () => { this.sources.delete(text); this.revision++; this.schedule(); };
		const interrupt = (event: Event) => {
			if (view.contentEl.contains(event.target as Node) && !(event.target as Element)?.closest?.(".relay-presence-follow")) this.interrupted();
		};
		const events = ["wheel", "touchstart", "pointerdown", "keydown", "beforeinput"];
		for (const name of events) doc.addEventListener(name, interrupt, { capture: true, passive: true });
		doc.addEventListener("scroll", schedule, true); doc.addEventListener("selectionchange", schedule); win?.addEventListener("resize", schedule);
		text.observe(textChanged);
		this.stop = () => {
			for (const name of events) doc.removeEventListener(name, interrupt, true);
			doc.removeEventListener("scroll", schedule, true); doc.removeEventListener("selectionchange", schedule); win?.removeEventListener("resize", schedule);
			text.unobserve(textChanged);
		};
		this.schedule();
	}
	setReaders(scopes: ReadingPresenceScope[]): void {
		const wanted = new Set(scopes.map(scope => scope.view));
		for (const [view, layer] of this.readers) if (!wanted.has(view)) { this.sources.delete(layer.text); layer.close(); this.readers.delete(view); }
		if (this.closed) return;
		for (const scope of scopes) {
			let layer = this.readers.get(scope.view);
			if (layer && !layer.matches(scope)) { this.sources.delete(layer.text); layer.close(); this.readers.delete(scope.view); layer = undefined; }
			if (!layer) {
				this.sources.delete(scope.text);
				layer = new ReadingPresenceLayer(scope, () => this.snapshotsFor(scope.view, scope.text, scope.id).map(snapshot => ({
					root: snapshot.section.containerEl, from: snapshot.from, to: snapshot.to, map: () => snapshot.section.map(snapshot.source, snapshot.from, snapshot.to),
				})), () => this.sources.delete(scope.text));
				this.readers.set(scope.view, layer);
			} else layer.update(scope);
		}
	}
	add(section: PresenceSection): () => void {
		if (this.closed) return () => {};
		const previous = this.sectionOwners.get(section.containerEl); if (previous && previous !== section) previous.unload();
		const changed = () => { this.schedule(); for (const layer of this.readers.values()) layer.invalidate(); };
		this.sectionOwners.set(section.containerEl, section); this.sections.add(section); changed();
		return () => { this.sections.delete(section); if (this.sectionOwners.get(section.containerEl) === section) this.sectionOwners.delete(section.containerEl); changed(); };
	}
	schedule(): void {
		if (this.closed || !this.active || this.timer !== undefined) return;
		this.timer = window.setTimeout(() => { this.timer = undefined; this.changed(this.capture()); }, 100);
	}
	private editor(): EditorView | undefined {
		const active = this.active;
		return active && [...this.editors].find(editor => {
			const info = editor.state.field(editorInfoField, false), binding = commentEditorBinding(editor);
			return info?.editor === active.view.editor && info.file === active.view.file && binding?.documentId === active.id && binding.text === active.text;
		});
	}
	private editorMatches(editor: EditorView): boolean {
		if (!this.active) return false;
		if (this.editorContent?.doc !== editor.state.doc || this.editorContent.revision !== this.revision) {
			this.editorContent = { doc: editor.state.doc, revision: this.revision, matches: editor.state.doc.toString() === this.active.text.toString() };
		}
		return this.editorContent.matches;
	}
	hasCurrentBinding(): boolean {
		const active = this.active; if (!active || this.closed || active.view.getMode() !== active.mode) return false;
		if (active.mode !== "preview") { const editor = this.editor(); return !!editor && this.editorMatches(editor); }
		const binding = readingCommentBinding(active.view);
		return binding?.documentId === active.id && binding.text === active.text && active.view.getViewData() === this.sourceFor(active.text).source;
	}
	/** Reuse the actual source-bound editor/Reading renderer; URL order alone
	 * cannot identify repeated embeds or images inside transcluded notes. */
	imageTargets(occurrences: ImageOccurrence[]): RenderedImageTarget[] {
		const active = this.active; if (!active || this.closed) return [];
		return this.imageTargetsFor(active.view, active.text, active.id, occurrences);
	}
	/** Display-only split panes resolve against their own renderer binding. The
	 * active publisher and its selection/viewport are not changed. */
	imageTargetsFor(view: MarkdownView, text: Y.Text, id: string, occurrences: ImageOccurrence[]): RenderedImageTarget[] {
		if (this.closed) return [];
		let targets: RenderedImageTarget[];
		if (view.getMode() === "preview") targets = this.snapshotsFor(view, text, id).flatMap(({ section, source, from, to }) =>
			readingImageTargets(section.containerEl, source.source, from, to, occurrences));
		else {
			const editor = [...this.editors].find(editor => {
				const info = editor.state.field(editorInfoField, false), binding = commentEditorBinding(editor);
				return info?.editor === view.editor && info.file === view.file && binding?.documentId === id && binding.text === text;
			});
			if (!editor || (this.active?.view === view && this.active.text === text && this.active.id === id ?
				!this.editorMatches(editor) : editor.state.doc.toString() !== text.toString())) return [];
			targets = editorImageTargets(editor.dom, occurrences, node => editor.posAtDOM(node));
		}
		// Overlapping renderer sections must not give an image two identities.
		return targets.filter((target, i) => targets.findIndex(other => other.image === target.image) === i &&
			!targets.some(other => other.image === target.image && (other.occurrence.from !== target.occurrence.from || other.occurrence.to !== target.occurrence.to)));
	}
	private snapshots(): { section: PresenceSection; from: number; to: number; source: ReadingSource }[] {
		const active = this.active; if (!active || active.mode !== "preview") return [];
		return this.snapshotsFor(active.view, active.text, active.id);
	}
	private sourceFor(text: Y.Text): ReadingSource {
		let source = this.sources.get(text); if (!source) { source = new ReadingSource(text.toString()); this.sources.set(text, source); } return source;
	}
	private snapshotsFor(view: MarkdownView, text: Y.Text, id: string): { section: PresenceSection; from: number; to: number; source: ReadingSource }[] {
		const binding = readingCommentBinding(view);
		if (view.getMode() !== "preview" || binding?.text !== text || binding.documentId !== id) return [];
		const source = this.sourceFor(text);
		if (view.getViewData() !== source.source) return [];
		const results: { section: PresenceSection; from: number; to: number; source: ReadingSource }[] = [];
		for (const section of this.sections) {
			if (!section.containerEl.isConnected || section.context.sourcePath !== view.file?.path || !view.contentEl.contains(section.containerEl)) continue;
			const info = section.context.getSectionInfo(section.containerEl);
			if (info?.text !== source.source) continue;
			const range = source.section(info.lineStart, info.lineEnd);
			if (range) results.push({ section, ...range, source });
		}
		return results.sort((a, b) => a.from - b.from);
	}
	capture(): PresenceLocation {
		const active = this.active; if (!active) return { viewport: null, selection: null };
		const relative = (offset: number) => Y.createRelativePositionFromTypeIndex(active.text, offset);
		if (active.mode !== "preview") {
			const editor = this.editor();
			if (!editor || !this.editorMatches(editor)) return { viewport: null, selection: null };
			return { viewport: relative(editor.lineBlockAtHeight(editor.scrollDOM.scrollTop).from), selection: null };
		}
		const snapshots = this.snapshots(), bounds = active.view.contentEl.getBoundingClientRect();
		const visible = snapshots.find(({ section }) => { const rect = section.containerEl.getBoundingClientRect(); return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom; });
		const location: PresenceLocation = { viewport: visible ? relative(visible.from) : null, selection: null };
		const selection = active.view.contentEl.ownerDocument.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
		if (range && !range.collapsed && active.view.contentEl.contains(range.commonAncestorContainer)) {
			const maps: ReadingSectionMap[] = [];
			for (const snapshot of snapshots) if (range.intersectsNode(snapshot.section.containerEl)) {
				const map = snapshot.section.map(snapshot.source, snapshot.from, snapshot.to);
				if (!map) return location;
				maps.push(map);
			}
			const span = ReadingSectionMap.combine(active.view.contentEl, maps)?.sourceRange(range);
			if (span) {
				const backwards = selection?.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset;
				location.selection = { anchor: relative(backwards ? span.to : span.from), head: relative(backwards ? span.from : span.to) };
			}
		}
		return location;
	}
	async reveal(from: number, to: number, current = () => true): Promise<boolean> {
		const active = this.active;
		if (!active || !current() || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > active.text.length) return false;
		if (active.mode !== "preview") {
			const editor = this.editor();
			if (!editor || !this.editorMatches(editor)) return false;
			editor.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) }); return true;
		}
		const revision = this.revision;
		for (let attempt = 0; attempt < 12; attempt++) {
			if (this.active !== active || this.closed || this.revision !== revision || !current()) return false;
			const snapshots = this.snapshots(), target = snapshots.find(snapshot => from >= snapshot.from && (from < snapshot.to || from === snapshot.to && from === active.text.length));
			if (target && target.section.containerEl.getBoundingClientRect().height > 0) {
				const map = target.section.map(target.source, target.from, target.to), range = from === to ? map?.domCaret(from) : map?.domRanges(from, to)[0];
				if (range && revealReadingRange(active.view.contentEl, range)) return true;
				target.section.containerEl.scrollIntoView({ block: "center", behavior: "auto" }); return true;
			}
			const binding = readingCommentBinding(active.view), source = this.sourceFor(active.text);
			if (binding?.text !== active.text || binding.documentId !== active.id || active.view.getViewData() !== source.source) return false;
			// Public applyScroll uses fractional source lines. Derive the line from
			// the receiver's current Y.Text, never from a peer's pixels or offsets.
			const line = source.source.slice(0, from).split("\n").length - 1;
			active.view.previewMode.applyScroll(line);
			await new Promise<void>(resolve => {
				const timer = window.setTimeout(() => { this.waits.delete(timer); resolve(); }, 50);
				this.waits.set(timer, resolve);
			});
		}
		return false;
	}
	onunload(): void {
		this.closed = true; this.setActive(); this.stop?.(); this.editors.clear(); this.sections.clear();
		for (const layer of this.readers.values()) layer.close(); this.readers.clear();
		this.sources = new WeakMap();
		for (const [timer, resolve] of this.waits) { window.clearTimeout(timer); resolve(); } this.waits.clear();
	}
}

export class PresenceSection extends MarkdownRenderChild {
	private mapped?: { source: ReadingSource; from: number; to: number; value?: ReadingSectionMap };
	constructor(private owner: NotePresenceSurfaces, root: HTMLElement, readonly context: MarkdownPostProcessorContext) { super(root); }
	onload(): void { this.register(this.owner.add(this)); }
	map(source: ReadingSource, from: number, to: number): ReadingSectionMap | undefined {
		if (this.mapped?.source !== source || this.mapped.from !== from || this.mapped.to !== to || !this.mapped.value?.isCurrent()) {
			this.mapped = { source, from, to, value: mapReadingSection(this.containerEl, source.source, from, to, source) };
		}
		return this.mapped.value;
	}
}
