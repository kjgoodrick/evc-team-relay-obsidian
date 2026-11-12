import type { LocalDiscussionAnchor } from "./LocalDiscussionAnchor";
import { StateEffect, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, Menu, type Editor, type TFile } from "obsidian";
import * as Y from "yjs";
import { commentEditorBinding } from "./EditorTextBinding";
import { captureTextAnchor, resolveTextAnchor } from "./anchors/text";
import { captureBlockAnchor } from "./anchors/blocks";
import { localTextAnchor, wireTextAnchor, sourceAnchor, type DiscussionAnchor, type WireTextAnchor } from "./DiscussionProtocol";
import type { DiscussionHost } from "./DiscussionHost";
import type { AnchoredThread, DiscussionSession } from "./DiscussionSession";
import { editorImageTargets, type RenderedImageTarget } from "./anchors/renderedImages";
import type { ImageOccurrence } from "./anchors/images";

const refreshComments = StateEffect.define<null>();
export type CapturedCommentSelection<A extends LocalDiscussionAnchor = WireTextAnchor> = { file: TFile; session: DiscussionSession; entryId: string; anchor: A };
export type ImageCommentContext = { file: TFile; session: DiscussionSession; entryId: string; text: Y.Text; generation: string; position?: number; current: () => boolean };
export interface CommentEditorSurface {
	imageContext?(writable?: boolean): ImageCommentContext;
	renderedImages?(occurrences: ImageOccurrence[]): RenderedImageTarget[];
	readonly editor: Editor | undefined;
	readonly file: TFile | undefined;
	capture(blocks?: boolean): CapturedCommentSelection;
	reveal(session: DiscussionSession, entryId: string, anchor: DiscussionAnchor): boolean;
}

class ThreadMarker extends WidgetType {
	constructor(private threads: AnchoredThread[], private session: DiscussionSession, private open: (id: string) => void, private entryId: string) { super(); }
	eq(other: ThreadMarker): boolean { return this.session === other.session && this.entryId === other.entryId &&
		this.threads.map(t => t.id + ":" + t.state + ":" + t.author_id).join() === other.threads.map(t => t.id + ":" + t.state + ":" + t.author_id).join(); }
	toDOM(view: EditorView): HTMLElement {
		const button = view.dom.ownerDocument.createElement("button"); button.type = "button";
		button.className = "relay-comment-marker"; button.textContent = "💬" + (this.threads.length > 1 ? " " + this.threads.length : "");
		button.setAttribute("aria-label", this.threads.length === 1 ? "Open comment" : `Open ${this.threads.length} comments at this position`);
		button.onclick = () => {
			if (this.threads.length === 1) { this.open(this.threads[0].id); return; }
			const menu = new Menu();
			for (const thread of this.threads) menu.addItem(item => item.setTitle(this.session.displayName(this.entryId, thread.author_id) +
				" · " + (thread.state === "resolved" ? "Resolved discussion" : "Open discussion")).onClick(() => this.open(thread.id)));
			const rect = button.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom });
		};
		return button;
	}
	ignoreEvent(): boolean { return true; }
}

export function commentEditorExtension(host: DiscussionHost) {
	return ViewPlugin.fromClass(class implements CommentEditorSurface {
		decorations: DecorationSet = Decoration.none;
		private session?: DiscussionSession;
		private entryId?: string;
		private threads: AnchoredThread[] = [];
		private stopWatch?: () => void;
		private stopHost: () => void;
		private stopSurface: () => void;
		private timer?: number;
		private visual?: number;
		private promptTimer?: number;
		private closed = false;
		private epoch = 0;
		constructor(private view: EditorView) {
			this.stopSurface = host.registerEditor(this);
			this.stopHost = host.onChange(() => { this.checkContext(); this.schedule(); this.schedulePrompt(); });
			this.checkContext(); this.schedule();
		}
		get editor(): Editor | undefined { return this.view.state.field(editorInfoField, false)?.editor; }
		get file(): TFile | undefined { return this.view.state.field(editorInfoField, false)?.file ?? undefined; }
		private get win(): Window { return this.view.dom.ownerDocument.defaultView ?? window; }
		private checkContext(): void {
			if (this.closed) return;
			const file = this.file, target = file ? host.targetFor(file) : undefined;
			const session = target?.session?.canAnchorText ? target.session : undefined, id = session ? target?.entryId : undefined;
			if (session !== this.session || id !== this.entryId) {
				this.epoch++; const stop = this.stopWatch; this.stopWatch = undefined;
				this.session = session; this.entryId = id; this.threads = [];
				stop?.();
				this.view.dom.classList.add("relay-comment-highlights-hidden");
				if (session && id) this.stopWatch = session.watch(id, () => { this.checkContext(); this.schedule(); });
			}
			if (!session || !id || !session.permission(id)?.read) this.view.dom.classList.add("relay-comment-highlights-hidden");
		}
		private schedule(): void {
			if (this.closed || this.timer !== undefined) return;
			this.timer = this.win.setTimeout(() => { this.timer = undefined; void this.load().catch(() => { this.threads = []; this.redraw(); }); }, 60);
		}
		private async load(): Promise<void> {
			if (this.closed) return;
			const session = this.session, id = this.entryId, epoch = ++this.epoch;
			const threads = session && id && session.permission(id)?.read ? await session.anchorThreads(id) : [];
			if (this.closed || epoch !== this.epoch || session !== this.session) return;
			this.threads = threads.filter(thread => sourceAnchor(thread.anchor)); this.redraw();
		}
		private redraw(): void {
			if (this.closed || this.visual !== undefined) return;
			this.visual = this.win.setTimeout(() => { this.visual = undefined; if (!this.closed) this.view.dispatch({ effects: refreshComments.of(null) }); }, 0);
		}
		private schedulePrompt(): void {
			if (this.closed || this.promptTimer !== undefined) return;
			this.promptTimer = this.win.setTimeout(() => {
				this.promptTimer = undefined;
				if (this.closed) return;
				const selection = this.view.state.selection.main;
				if (!host.choosingReattachment || host.choosingCommandRecovery || selection.empty) { host.offerReattachment?.(this); return; }
				if (!this.view.hasFocus) return;
				try {
					const captured = this.capture(), coords = this.view.coordsAtPos(selection.to);
					if (coords) host.offerReattachment?.(this, captured, new DOMRect(coords.left, coords.top, coords.right - coords.left, coords.bottom - coords.top));
					else host.offerReattachment?.(this);
				} catch { host.offerReattachment?.(this); }
			}, 0);
		}
		update(update: ViewUpdate): void {
			this.checkContext();
			if (update.selectionSet || update.docChanged || update.focusChanged || update.viewportChanged) this.schedulePrompt();
			if (update.docChanged) { this.decorations = this.decorations.map(update.changes); this.redraw(); }
			if (update.viewportChanged || update.transactions.some(tr => tr.effects.some(effect => effect.is(refreshComments)))) this.build();
		}
		private build(): void {
			const bound = commentEditorBinding(this.view), session = this.session, id = this.entryId;
			const generation = id ? session?.documentGeneration(id) : undefined;
			if (!bound || !session || !id || !generation || !session.permission(id)?.read || bound.documentId !== id) {
				this.decorations = Decoration.none; return;
			}
			// Editor updates and Y.Text notifications may land in adjacent turns.
			// Keep the already-mapped decorations during that gap, not an empty frame.
			if (bound.text.toString() !== this.view.state.doc.toString()) return;
			this.view.dom.classList.remove("relay-comment-highlights-hidden");
			const snapshot = Y.snapshot(bound.text.doc!), decorations: Range<Decoration>[] = [], groups = new Map<number, AnchoredThread[]>();
			for (const thread of this.threads) {
				const anchor = sourceAnchor(thread.anchor); if (!anchor) continue;
				const position = resolveTextAnchor(bound.text, id, generation, localTextAnchor(anchor), snapshot);
				if (position.status !== "attached") continue;
				let marker: number | undefined;
				for (const visible of this.view.visibleRanges) {
					if (position.to < visible.from || position.from > visible.to) continue;
					const from = Math.max(position.from, visible.from), to = Math.min(position.to, visible.to);
					marker ??= from;
					if (from < to) decorations.push(Decoration.mark({ class: "relay-comment-highlight" + (thread.state === "resolved" ? " is-resolved" : ""),
						attributes: { "data-comment-thread": thread.id } }).range(from, to));
				}
				if (marker !== undefined) groups.set(marker, [...groups.get(marker) ?? [], thread]);
			}
			const file = this.file;
			if (file) for (const [position, threads] of groups) decorations.push(Decoration.widget({ side: 1,
				widget: new ThreadMarker(threads, session, threadId => { void host.openThread(file, session, id, threadId); }, id) }).range(position));
			this.decorations = Decoration.set(decorations, true);
		}
		imageContext(writable = true): ImageCommentContext {
			this.checkContext();
			const file = this.file, session = this.session, id = this.entryId, bound = commentEditorBinding(this.view), generation = id ? session?.documentGeneration(id) : undefined;
			const current = () => !this.closed && !!session && (writable ? session.canAnchorImages : session.canAnchorText) && !!id && !!session.permission(id)?.read && (!writable || !!session.permission(id)?.comment) && this.file === file && this.session === session &&
				this.entryId === id && session.documentGeneration(id) === generation && commentEditorBinding(this.view)?.text === bound?.text &&
				!!bound && !this.view.composing && bound.text.toString() === this.view.state.doc.toString();
			if (!file || !session || !id || !bound || bound.documentId !== id || !generation || !current()) throw new Error("Wait for this shared image and note to synchronize.");
			return { file, session, entryId: id, text: bound.text, generation, position: this.view.state.selection.main.head, current };
		}
		renderedImages(occurrences: ImageOccurrence[]): RenderedImageTarget[] {
			return editorImageTargets(this.view.contentDOM, occurrences, node => this.view.posAtDOM(node));
		}
		capture(blocks = false): CapturedCommentSelection {
			this.checkContext();
			const file = this.file, session = this.session, id = this.entryId, bound = commentEditorBinding(this.view);
			const generation = id ? session?.documentGeneration(id) : undefined;
			if (!file || !session || !id || !generation || !session.permission(id)?.comment || !bound || bound.documentId !== id ||
				this.view.composing || bound.text.toString() !== this.view.state.doc.toString()) throw new Error("Wait for this shared editor to finish synchronizing, then select the text again.");
			const { anchor, head } = this.view.state.selection.main;
			if (blocks && !session.canAnchorBlocks) throw new Error("Block comments are not enabled on this server.");
			return { file, session, entryId: id, anchor: wireTextAnchor((blocks ? captureBlockAnchor : captureTextAnchor)(bound.text, id, generation, anchor, head)) };
		}
		reveal(session: DiscussionSession, entryId: string, anchor: DiscussionAnchor): boolean {
			const bound = commentEditorBinding(this.view), generation = session.documentGeneration(entryId), source = sourceAnchor(anchor);
			if (this.closed || session !== this.session || entryId !== this.entryId || !source || !bound || bound.documentId !== entryId || !generation ||
				!session.permission(entryId)?.read || bound.text.toString() !== this.view.state.doc.toString()) return false;
			const position = resolveTextAnchor(bound.text, entryId, generation, localTextAnchor(source));
			if (position.status !== "attached") return false;
			this.view.dispatch({ selection: { anchor: position.from, head: position.to }, effects: EditorView.scrollIntoView(position.from, { y: "center" }) });
			this.view.focus(); return true;
		}
		destroy(): void {
			this.closed = true; host.offerReattachment?.(this); this.epoch++; this.stopWatch?.(); this.stopHost(); this.stopSurface();
			if (this.timer !== undefined) this.win.clearTimeout(this.timer);
			if (this.visual !== undefined) this.win.clearTimeout(this.visual);
			if (this.promptTimer !== undefined) this.win.clearTimeout(this.promptTimer);
			this.view.dom.classList.remove("relay-comment-highlights-hidden");
		}
	}, { decorations: value => value.decorations });
}
