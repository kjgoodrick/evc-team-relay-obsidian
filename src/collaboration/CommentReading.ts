import { Component, MarkdownRenderChild, Menu, Notice, type MarkdownPostProcessorContext, type MarkdownView, type Plugin } from "obsidian";
import * as Y from "yjs";
import type { DiscussionHost } from "./DiscussionHost";
import type { CapturedCommentSelection } from "./CommentEditor";
import type { AnchoredThread, DiscussionSession } from "./DiscussionSession";
import { localTextAnchor, wireTextAnchor, type DiscussionAnchor } from "./DiscussionProtocol";
import { captureBlockAnchor, BlockSelectionError } from "./anchors/blocks";
import { captureTextAnchor, resolveTextAnchor } from "./anchors/text";
import { ReadingSectionMap, ReadingSource, mapReadingSection } from "./anchors/reading";
import { onReadingBindingChange, readingCommentBinding } from "./ReadingTextBinding";

type Scope = { view: MarkdownView; session: DiscussionSession; entryId: string; stop: () => void; dirty: boolean;
	threads: AnchoredThread[]; sections: Set<ReadingCommentSection>; source?: ReadingSource; text?: Y.Text; unobserve?: () => void; epoch: number };
type SectionSnapshot = { scope: Scope; source: ReadingSource; text: Y.Text; generation: string; from: number; to: number };
type HighlightHost = { Highlight?: new (...ranges: Range[]) => unknown; CSS?: { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } } };
export class ReadingSelectionError extends Error {}
const controlsSelector = ".relay-reading-comment-controls,.relay-reading-comment-overlay";

/** One controller shares thread reads, a source parse, and lifecycle work across
 * all sections of each Reading leaf. Rendered content is never rewritten. */
export class ReadingComments extends Component {
	private sections = new Set<ReadingCommentSection>();
	private scopes = new Map<MarkdownView, Scope>();
	private documents = new Map<Document, { count: number; stop: () => void }>();
	private selections = new WeakMap<MarkdownView, Range>();
	private timer?: number;
	private closed = false;
	private refreshing = false;
	constructor(private host: DiscussionHost, private plugin: Plugin) { super(); }
	onload(): void {
		this.plugin.registerMarkdownPostProcessor((root, context) => {
			if (!context.sourcePath.endsWith(".md") || root.closest(".internal-embed,.markdown-embed,.canvas-node")) return;
			context.addChild(new ReadingCommentSection(this, root, context));
		}, 1000);
		this.register(this.host.onChange(() => this.invalidate()));
		this.register(onReadingBindingChange(() => this.invalidate()));
		this.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.invalidate()));
		this.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.invalidate()));
		this.plugin.addCommand({ id: "comment-reading-selection", name: "Comment on selected text in reading view", checkCallback: checking => {
			const view = this.host.activeReadingView();
			if (!view) return false;
			if (!checking) this.submit(() => this.capture(view));
			return true;
		} });
	}
	add(section: ReadingCommentSection): () => void {
		this.sections.add(section);
		const doc = section.containerEl.ownerDocument, known = this.documents.get(doc);
		if (known) known.count++;
		else {
			const selectionChanged = () => {
				const selection = doc.getSelection();
				for (const view of this.scopes.keys()) if (view.contentEl.ownerDocument === doc && selection?.rangeCount) {
					const range = selection.getRangeAt(0);
					if (view.contentEl.contains(range.commonAncestorContainer)) {
						if (range.collapsed) this.selections.delete(view); else this.selections.set(view, range.cloneRange());
						for (const section of this.scopes.get(view)!.sections) section.containerEl.classList.toggle("relay-reading-comment-active", !range.collapsed && range.intersectsNode(section.containerEl));
					}
				}
			};
			const visibility = () => this.invalidate(), layout = () => this.schedule();
			doc.addEventListener("selectionchange", selectionChanged); doc.addEventListener("visibilitychange", visibility);
			doc.addEventListener("scroll", layout, true); doc.defaultView?.addEventListener("resize", layout);
			this.documents.set(doc, { count: 1, stop: () => {
				doc.removeEventListener("selectionchange", selectionChanged); doc.removeEventListener("visibilitychange", visibility);
				doc.removeEventListener("scroll", layout, true); doc.defaultView?.removeEventListener("resize", layout);
			} });
		}
		this.schedule();
		return () => {
			this.sections.delete(section); section.clear();
			const current = this.documents.get(doc);
			if (current && --current.count === 0) { current.stop(); this.clearHighlights(doc); this.documents.delete(doc); }
			this.schedule();
		};
	}
	invalidate(): void {
		// Ordinary cache/status notifications keep controls and keyboard focus.
		// Account/read revocation still clears synchronously before storage reads.
		for (const section of this.sections) {
			const current = this.snapshot(section);
			if (!current || !current.scope.session.permission(current.scope.entryId)?.comment) {
				section.clear(); this.clearHighlights(section.containerEl.ownerDocument);
			}
		}
		for (const scope of this.scopes.values()) { scope.dirty = true; scope.epoch++; }
		this.schedule();
	}
	schedule(): void {
		if (!this.closed && this.timer === undefined) this.timer = window.setTimeout(() => {
			this.timer = undefined; void this.refresh().catch(() => { for (const section of this.sections) section.clear(); for (const doc of this.documents.keys()) this.clearHighlights(doc); });
		}, 60);
	}
	private async refresh(): Promise<void> {
		if (this.closed) return;
		if (this.refreshing) { this.schedule(); return; }
		this.refreshing = true;
		try {
			const grouped = new Map<MarkdownView, Set<ReadingCommentSection>>();
			for (const section of this.sections) {
				const view = this.host.readingViewFor(section.containerEl, section.context.sourcePath);
				if (!view || view.contentEl.ownerDocument.hidden || !view.contentEl.getClientRects().length) { section.clear(); continue; }
				const set = grouped.get(view) ?? new Set(); set.add(section); grouped.set(view, set);
			}
			for (const [view, scope] of this.scopes) {
				const target = this.host.targetFor(view.file ?? undefined);
				if (!grouped.has(view) || target.session !== scope.session || target.entryId !== scope.entryId) {
					scope.epoch++; scope.stop(); scope.unobserve?.(); this.scopes.delete(view); this.selections.delete(view);
				}
			}
			for (const [view, sections] of grouped) {
				const target = this.host.targetFor(view.file ?? undefined);
				if (!target.session?.canAnchorText || !target.entryId) { for (const section of sections) section.clear(); continue; }
				let scope = this.scopes.get(view);
				if (!scope) {
					scope = { view, session: target.session, entryId: target.entryId, stop: () => {}, dirty: true, threads: [], sections, epoch: 0 };
					this.scopes.set(view, scope);
					scope.stop = scope.session.watch(scope.entryId, () => this.invalidate());
				}
				scope.sections = sections;
				const binding = readingCommentBinding(view);
				if (scope.text !== binding?.text) {
					scope.unobserve?.(); scope.text = binding?.text; scope.source = undefined;
					if (scope.text) {
						const text = scope.text, currentScope = scope, changed = () => {
							currentScope.source = undefined;
							for (const section of currentScope.sections) section.clear();
							this.clearHighlights(view.contentEl.ownerDocument); this.schedule();
						};
						text.observe(changed); scope.unobserve = () => text.unobserve(changed);
					}
				}
				if (scope.dirty) {
					scope.dirty = false; const epoch = scope.epoch;
					const threads = scope.session.permission(scope.entryId)?.read ? await scope.session.anchorThreads(scope.entryId) : [];
					if (this.closed || scope.epoch !== epoch || this.scopes.get(view) !== scope) continue;
					scope.threads = threads;
				}
			}
			this.draw();
		} finally { this.refreshing = false; }
	}
	snapshot(section: ReadingCommentSection): SectionSnapshot | undefined {
		const view = this.host.readingViewFor(section.containerEl, section.context.sourcePath), scope = view ? this.scopes.get(view) : undefined;
		if (!view || !scope || !scope.session.canAnchorText || !scope.session.permission(scope.entryId)?.read) return undefined;
		const target = this.host.targetFor(view.file ?? undefined), binding = readingCommentBinding(view), generation = scope.session.documentGeneration(scope.entryId);
		if (target.session !== scope.session || target.entryId !== scope.entryId || !binding || binding.text !== scope.text || binding.documentId !== scope.entryId || !generation) return undefined;
		// The scope observes this exact Y.Text and discards the parse synchronously
		// on changes. Avoid serializing/parsing the entire note for every section.
		scope.source ??= new ReadingSource(binding.text.toString());
		const info = section.context.getSectionInfo(section.containerEl);
		if (!info || info.text !== scope.source.source || view.getViewData() !== scope.source.source) return undefined;
		const span = scope.source.section(info.lineStart, info.lineEnd);
		return span ? { scope, text: binding.text, source: scope.source, generation, ...span } : undefined;
	}
	capture(view: MarkdownView, block?: ReadingCommentSection, within?: ReadingCommentSection): CapturedCommentSelection {
		const scope = this.scopes.get(view);
		if (!scope || !view.file || !scope.session.permission(scope.entryId)?.comment) throw new ReadingSelectionError("Comment access is required for this shared note.");
		let snapshot: SectionSnapshot | undefined, span: { from: number; to: number } | undefined;
		if (block) snapshot = this.snapshot(block);
		else {
			const selection = view.contentEl.ownerDocument.getSelection();
			const current = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
			const range = current && !current.collapsed && view.contentEl.contains(current.commonAncestorContainer) ? current : this.selections.get(view);
			if (!range || range.collapsed || !view.contentEl.contains(range.commonAncestorContainer)) throw new ReadingSelectionError("Select text in reading view before adding a comment.");
			if (within && !range.intersectsNode(within.containerEl)) throw new ReadingSelectionError("Select text in this block before adding a selection comment.");
			const maps: ReadingSectionMap[] = [];
			for (const section of scope.sections) if (range.intersectsNode(section.containerEl)) {
				const next = this.snapshot(section), map = next ? section.map(next) : undefined;
				if (!next || !map) throw new ReadingSelectionError("This rendering cannot be selected precisely. Use Comment on source block, or open Source mode to select text.");
				snapshot ??= next; maps.push(map);
			}
			span = ReadingSectionMap.combine(view.contentEl, maps)?.sourceRange(range);
		}
		if (!snapshot || (!block && !span)) throw new ReadingSelectionError("This selection is unavailable or still synchronizing. Select it again after the note updates.");
		if (block && !scope.session.canAnchorBlocks) throw new ReadingSelectionError("Block comments are not enabled on this server.");
		const anchor = block ? captureBlockAnchor(snapshot.text, scope.entryId, snapshot.generation, snapshot.from, snapshot.to) :
			captureTextAnchor(snapshot.text, scope.entryId, snapshot.generation, span!.from, span!.to);
		return { file: view.file, session: scope.session, entryId: scope.entryId, anchor: wireTextAnchor(anchor) };
	}
	submit(capture: () => CapturedCommentSelection): void {
		try { const selected = capture(); void this.host.saveCommentSelection(selected); }
		catch (error) { new Notice(error instanceof ReadingSelectionError || error instanceof BlockSelectionError ? error.message : "This selection could not be captured. Wait for the shared note to synchronize and try again."); }
	}
	openThread(scope: Scope, threadId: string): void {
		if (scope.view.file) void this.host.openThread(scope.view.file, scope.session, scope.entryId, threadId);
	}
	activate(section: ReadingCommentSection): void {
		for (const candidate of this.sections) candidate.containerEl.classList.toggle("relay-reading-comment-active", candidate === section);
	}
	private clearHighlights(doc: Document): void {
		const registry = (doc.defaultView as unknown as HighlightHost | null)?.CSS?.highlights;
		registry?.delete("relay-comments-open"); registry?.delete("relay-comments-resolved");
	}
	private draw(): void {
		const ranges = new Map<Document, { open: Range[]; resolved: Range[] }>();
		for (const doc of this.documents.keys()) { this.clearHighlights(doc); ranges.set(doc, { open: [], resolved: [] }); }
		for (const scope of this.scopes.values()) {
			const binding = readingCommentBinding(scope.view), generation = scope.session.documentGeneration(scope.entryId);
			if (!binding || binding.documentId !== scope.entryId || !generation || !scope.session.permission(scope.entryId)?.read) { for (const section of scope.sections) section.clear(); continue; }
			const snapshot = Y.snapshot(binding.text.doc!), positions = scope.threads.flatMap(thread => {
				if (thread.anchor?.type !== "text") return [];
				const position = resolveTextAnchor(binding.text, scope.entryId, generation, localTextAnchor(thread.anchor), snapshot);
				return position.status === "attached" ? [{ thread, ...position }] : [];
			});
			for (const section of scope.sections) {
				const current = this.snapshot(section);
				if (!current) { section.clear(); continue; }
				const matches = positions.filter(position => position.from < current.to && position.to > current.from);
				section.controls(scope, matches.map(position => position.thread));
				if (!section.visible) { section.overlay([]); continue; }
				const map = matches.length ? section.map(current) : undefined, all: Range[] = [];
				for (const position of matches) {
					const visible = map?.domRanges(position.from, position.to) ?? [];
					all.push(...visible); ranges.get(section.containerEl.ownerDocument)?.[position.thread.state === "resolved" ? "resolved" : "open"].push(...visible);
				}
				const browser = section.containerEl.ownerDocument.defaultView as unknown as HighlightHost | null;
				section.overlay(browser?.Highlight && browser.CSS?.highlights ? [] : all);
			}
		}
		for (const [doc, values] of ranges) {
			const browser = doc.defaultView as unknown as HighlightHost | null;
			if (browser?.Highlight && browser.CSS?.highlights) {
				browser.CSS.highlights.set("relay-comments-open", new browser.Highlight(...values.open));
				browser.CSS.highlights.set("relay-comments-resolved", new browser.Highlight(...values.resolved));
			}
		}
	}
	reveal(view: MarkdownView, session: DiscussionSession, entryId: string, anchor: DiscussionAnchor): boolean {
		const scope = this.scopes.get(view), binding = readingCommentBinding(view), generation = session.documentGeneration(entryId);
		if (!scope || scope.session !== session || scope.entryId !== entryId || !binding || binding.documentId !== entryId || !generation || anchor.type !== "text" || !session.permission(entryId)?.read) return false;
		const position = resolveTextAnchor(binding.text, entryId, generation, localTextAnchor(anchor));
		if (position.status !== "attached") return false;
		for (const section of scope.sections) {
			const current = this.snapshot(section), ranges = current ? section.map(current)?.domRanges(position.from, position.to) : undefined;
			if (!current || position.from < current.from || position.from >= current.to) continue;
			if (anchor.structure && !ranges?.length) { section.containerEl.scrollIntoView({ block: "center", behavior: "auto" }); return true; }
			if (!ranges?.length) continue;
			const selection = view.contentEl.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(ranges[0]);
			section.containerEl.scrollIntoView({ block: "center", behavior: "auto" }); return true;
		}
		return false;
	}
	onunload(): void {
		this.closed = true; if (this.timer !== undefined) window.clearTimeout(this.timer);
		for (const section of this.sections) section.clear();
		for (const scope of this.scopes.values()) { scope.epoch++; scope.stop(); scope.unobserve?.(); }
		for (const [doc, value] of this.documents) { value.stop(); this.clearHighlights(doc); }
		this.scopes.clear(); this.sections.clear(); this.documents.clear();
	}
}

export class ReadingCommentSection extends MarkdownRenderChild {
	visible = true;
	private mapped?: { source: string; from: number; to: number; value?: ReadingSectionMap };
	private bar?: HTMLElement;
	private svg?: SVGSVGElement;
	private signature = "";
	constructor(private owner: ReadingComments, root: HTMLElement, readonly context: MarkdownPostProcessorContext) { super(root); }
	onload(): void {
		this.register(this.owner.add(this));
		const observer = new MutationObserver(records => {
			if (records.every(record => (record.target.nodeType === 1 ? record.target as Element : record.target.parentElement)?.closest(controlsSelector) ||
				(record.type === "childList" && [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].every(node => node.nodeType === 1 && (node as Element).matches(controlsSelector))))) return;
			this.mapped = undefined; this.owner.schedule();
		});
		observer.observe(this.containerEl, { childList: true, characterData: true, subtree: true }); this.register(() => observer.disconnect());
		if (typeof IntersectionObserver !== "undefined") {
			const visible = new IntersectionObserver(entries => { this.visible = entries.some(entry => entry.isIntersecting); if (!this.visible) this.mapped = undefined; this.owner.schedule(); });
			visible.observe(this.containerEl); this.register(() => visible.disconnect());
		}
		this.registerDomEvent(this.containerEl, "pointerup", () => this.owner.activate(this));
		this.registerDomEvent(this.containerEl, "contextmenu", event => {
			// Links, pictures, checkboxes and native controls keep their own menus.
			if ((event.target as Element | null)?.closest("a,img,button,input,textarea,select")) return;
			const menu = this.commentMenu(); if (!menu) return; event.preventDefault(); menu.showAtMouseEvent(event);
		});
	}
	private commentMenu(): Menu | undefined {
		const current = this.owner.snapshot(this); if (!current?.scope.session.permission(current.scope.entryId)?.comment) return;
		let selected: CapturedCommentSelection | undefined, block: CapturedCommentSelection | undefined;
		try { selected = this.owner.capture(current.scope.view, undefined, this); } catch { /* The block fallback remains explicit. */ }
		try { if (current.scope.session.canAnchorBlocks) block = this.owner.capture(current.scope.view, this); } catch { /* Freeze before opening the menu. */ }
		if (!selected && !block) return;
		const menu = new Menu();
		if (selected) menu.addItem(item => item.setTitle("Comment on selected text").setIcon("message-square").onClick(() => this.owner.submit(() => selected!)));
		if (block) menu.addItem(item => item.setTitle("Comment on source block").setIcon("message-square").onClick(() => this.owner.submit(() => block!)));
		return menu;
	}
	map(snapshot: SectionSnapshot): ReadingSectionMap | undefined {
		if (!this.mapped || this.mapped.source !== snapshot.source.source || this.mapped.from !== snapshot.from || this.mapped.to !== snapshot.to || this.mapped.value && !this.mapped.value.isCurrent()) {
			this.mapped = { source: snapshot.source.source, from: snapshot.from, to: snapshot.to,
				value: mapReadingSection(this.containerEl, snapshot.source.source, snapshot.from, snapshot.to, snapshot.source) };
		}
		return this.mapped.value;
	}
	controls(scope: Scope, threads: AnchoredThread[]): void {
		this.containerEl.classList.add("relay-reading-comment-section");
		const comment = !!scope.session.permission(scope.entryId)?.comment;
		const signature = [scope.session.identity.accountId, scope.entryId, comment, scope.session.canAnchorBlocks, ...threads.map(thread => thread.id + ":" + thread.activity_sequence)].join("|");
		if (signature === this.signature && this.bar) return;
		this.signature = signature; this.bar?.remove();
		this.bar = this.containerEl.ownerDocument.createElement("span"); this.bar.className = "relay-reading-comment-controls";
		const button = (label: string, click: () => void) => {
			const element = this.bar!.ownerDocument.createElement("button"); element.type = "button"; element.textContent = label;
			element.addEventListener("pointerdown", event => event.preventDefault()); element.onclick = click; this.bar!.append(element);
		};
		if (comment) button("Add comment", () => {
			const box = this.bar!.getBoundingClientRect(); this.commentMenu()?.showAtPosition({ x: box.left, y: box.bottom });
		});
		if (threads.length) button(`${threads.length} comment${threads.length === 1 ? "" : "s"}`, () => {
			const menu = new Menu();
			for (const thread of threads) menu.addItem(item => item.setTitle(scope.session.displayName(scope.entryId, thread.author_id) + " · " + thread.state)
				.onClick(() => this.owner.openThread(scope, thread.id)));
			const box = this.bar!.getBoundingClientRect(); menu.showAtPosition({ x: box.left, y: box.bottom });
		});
		if (this.bar.childElementCount) this.containerEl.append(this.bar);
		this.containerEl.classList.toggle("relay-reading-has-comments", threads.length > 0);
		this.containerEl.classList.toggle("relay-reading-block-comment", threads.some(thread => thread.anchor?.type === "text" && thread.anchor.structure));
	}
	overlay(ranges: Range[]): void {
		this.svg?.remove(); this.svg = undefined; if (!ranges.length) return;
		const box = this.containerEl.getBoundingClientRect(); if (!box.width || !box.height) return;
		const svg = this.containerEl.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.classList.add("relay-reading-comment-overlay"); svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`); svg.setAttribute("aria-hidden", "true");
		for (const range of ranges) for (const rect of Array.from(range.getClientRects()).slice(0, 200)) {
			const mark = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
			for (const [key, value] of Object.entries({ x: rect.left - box.left, y: rect.top - box.top, width: rect.width, height: rect.height })) mark.setAttribute(key, String(value));
			svg.append(mark);
		}
		this.svg = svg; this.containerEl.append(svg);
	}
	clear(): void { this.bar?.remove(); this.bar = undefined; this.svg?.remove(); this.svg = undefined; this.signature = ""; this.mapped = undefined; this.containerEl.classList.remove("relay-reading-comment-section", "relay-reading-has-comments", "relay-reading-comment-active", "relay-reading-block-comment"); }
	onunload(): void { this.clear(); this.containerEl.classList.remove("relay-reading-comment-section"); }
}
