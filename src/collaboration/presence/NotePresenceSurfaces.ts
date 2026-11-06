import { Component, MarkdownRenderChild, MarkdownView, editorInfoField, type MarkdownPostProcessorContext, type Plugin } from "obsidian";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import * as Y from "yjs";
import { commentEditorBinding } from "../EditorTextBinding";
import { readingCommentBinding } from "../ReadingTextBinding";
import { ReadingSource, ReadingSectionMap, mapReadingSection } from "../anchors/reading";
import type { PresenceLocation } from "./PresencePeers";

/** Read-only semantic capture/navigation shared by Jump and Follow. It never
 * changes the user's selection, note data, mode or saved view preferences. */
export class NotePresenceSurfaces extends Component {
	private editors = new Set<EditorView>();
	private sections = new Set<PresenceSection>();
	private sectionOwners = new WeakMap<HTMLElement, PresenceSection>();
	private active?: { view: MarkdownView; text: Y.Text; id: string; mode: string };
	private stop?: () => void;
	private source?: ReadingSource;
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
		this.stop?.(); this.stop = undefined; this.source = undefined; this.editorContent = undefined; this.active = undefined;
		if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined;
		if (!view || !text || !id || this.closed) return;
		this.active = { view, text, id, mode: mode! };
		const doc = view.containerEl.ownerDocument, win = doc.defaultView;
		const schedule = () => this.schedule(), textChanged = () => { this.source = undefined; this.revision++; this.schedule(); };
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
	add(section: PresenceSection): () => void {
		const previous = this.sectionOwners.get(section.containerEl); if (previous && previous !== section) previous.unload();
		this.sectionOwners.set(section.containerEl, section); this.sections.add(section); this.schedule();
		return () => { this.sections.delete(section); if (this.sectionOwners.get(section.containerEl) === section) this.sectionOwners.delete(section.containerEl); this.schedule(); };
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
	private snapshots(): { section: PresenceSection; from: number; to: number; source: ReadingSource }[] {
		const active = this.active; if (!active || active.mode !== "preview") return [];
		const binding = readingCommentBinding(active.view);
		if (binding?.text !== active.text || binding.documentId !== active.id) return [];
		this.source ??= new ReadingSource(active.text.toString());
		if (active.view.getViewData() !== this.source.source) return [];
		const results: { section: PresenceSection; from: number; to: number; source: ReadingSource }[] = [];
		for (const section of this.sections) {
			if (!section.containerEl.isConnected || section.context.sourcePath !== active.view.file?.path || !active.view.contentEl.contains(section.containerEl)) continue;
			const info = section.context.getSectionInfo(section.containerEl);
			if (info?.text !== this.source.source) continue;
			const range = this.source.section(info.lineStart, info.lineEnd);
			if (range) results.push({ section, ...range, source: this.source });
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
			if (span) location.selection = { anchor: relative(span.from), head: relative(span.to) };
		}
		return location;
	}
	async reveal(from: number, to: number, current = () => true): Promise<boolean> {
		const active = this.active;
		if (!active || !current() || from < 0 || to < from || to > active.text.length) return false;
		if (active.mode !== "preview") {
			const editor = this.editor();
			if (!editor || !this.editorMatches(editor)) return false;
			editor.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) }); return true;
		}
		const revision = this.revision;
		for (let attempt = 0; attempt < 12; attempt++) {
			if (this.active !== active || this.closed || this.revision !== revision || !current()) return false;
			const snapshots = this.snapshots(), target = snapshots.find(snapshot => from >= snapshot.from && from < snapshot.to);
			if (target && target.section.containerEl.getBoundingClientRect().height > 0) {
				target.section.containerEl.scrollIntoView({ block: "center", behavior: "auto" }); return true;
			}
			const binding = readingCommentBinding(active.view);
			if (binding?.text !== active.text || binding.documentId !== active.id || !this.source || active.view.getViewData() !== this.source.source) return false;
			// Public applyScroll uses fractional source lines. Derive the line from
			// the receiver's current Y.Text, never from a peer's pixels or offsets.
			const line = this.source.source.slice(0, from).split("\n").length - 1;
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
