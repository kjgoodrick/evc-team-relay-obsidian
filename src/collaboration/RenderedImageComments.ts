import { Component, MarkdownView, type Plugin } from "obsidian";
import * as Y from "yjs";
import type { DiscussionHost } from "./DiscussionHost";
import type { ImageCommentContext } from "./CommentEditor";
import type { AnchoredThread, DiscussionSession } from "./DiscussionSession";
import type { ImageAssets, RenderedImageEvidence } from "./ImageAssets";
import { imageAssetChanged, markdownImages, type ImageOccurrence } from "./anchors/images";
import { renderedImageFit, type RenderedImageTarget } from "./anchors/renderedImages";
import { localTextAnchor, type ImageAnchor } from "./DiscussionProtocol";
import type { ImageBox } from "./anchors/imageGeometry";
import { resolveTextAnchor } from "./anchors/text";
import type { ImagePlacementSurface } from "./ui/RenderedImagePlacement";

type OpenImage = (context: ImageCommentContext, image: ImageOccurrence, surface?: ImagePlacementSurface) => void;
type Marker = { thread: AnchoredThread; anchor: ImageAnchor };
type Record = { target: RenderedImageTarget; key: string; attempt: number; element: HTMLDivElement; clip: HTMLDivElement; controls: HTMLDivElement;
	evidence?: RenderedImageEvidence; signature?: string; markers: { button: HTMLButtonElement; value: Marker }[]; current: () => boolean };
const owned = ".relay-rendered-images";

/** One controller per live Markdown pane. It uses source mappings supplied by
 * the existing CM/Reading adapters, never filename searches or DOM ordinals
 * across a whole note. Its DOM is outside the editor/Reading content. */
export class RenderedImageComments extends Component {
	private views = new Map<MarkdownView, RenderedImageView>();
	constructor(private host: DiscussionHost, private plugin: Plugin, private assets: ImageAssets, private open: OpenImage) { super(); }
	onload(): void {
		this.register(this.host.onChange(() => this.reconcile()));
		this.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.reconcile()));
		this.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.reconcile()));
		this.registerEvent(this.plugin.app.workspace.on("file-open", () => this.reconcile()));
		this.reconcile();
	}
	private reconcile(): void {
		const live = new Set(this.plugin.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView));
		for (const [view, surface] of this.views) if (!live.has(view)) { surface.close(); this.views.delete(view); }
		for (const view of live) {
			let surface = this.views.get(view);
			if (!surface) { surface = new RenderedImageView(this.host, view, this.assets, this.open); this.views.set(view, surface); }
			surface.invalidate();
		}
	}
	onunload(): void { for (const surface of this.views.values()) surface.close(); this.views.clear(); }
}

export class RenderedImageView {
	private layer: HTMLDivElement;
	private records = new Map<HTMLImageElement, Record>();
	private cleanup: (() => void)[] = [];
	private session?: DiscussionSession;
	private entryId?: string;
	private text?: Y.Text;
	private unobserve?: () => void;
	private unwatch?: () => void;
	private threads: AnchoredThread[] = [];
	private parsed?: { source: string; images: ImageOccurrence[] };
	private parseRevision = 0;
	private placements = new Map<string, Marker[]>();
	private timer?: number;
	private frame?: number;
	private closed = false;
	private busy = false;
	private dirty = true;
	private epoch = 0;
	private win: Window;
	constructor(private host: DiscussionHost, private view: MarkdownView, private assets: ImageAssets, private open: OpenImage) {
		const root = view.contentEl, doc = root.ownerDocument; this.win = doc.defaultView ?? window;
		this.layer = doc.createElement("div"); this.layer.className = "relay-rendered-images";
		root.classList.add("relay-rendered-image-root"); root.append(this.layer);
		const layout = () => { this.layout(); this.invalidate(false); }, changed = () => this.invalidate();
		const listen = (target: EventTarget, event: string, fn: EventListener, capture = false) => {
			target.addEventListener(event, fn, capture); this.cleanup.push(() => target.removeEventListener(event, fn, capture));
		};
		listen(root, "load", changed, true); listen(root, "error", changed, true);
		listen(doc, "scroll", layout, true); listen(this.win, "resize", layout); listen(doc, "visibilitychange", changed);
		const observer = new MutationObserver(records => {
			if (records.every(record => (record.target.nodeType === 1 ? record.target as Element : record.target.parentElement)?.closest(owned) ||
				(record.type === "childList" && [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].every(node => node.nodeType === 1 && (node as Element).matches(owned))) ||
				(record.attributeName === "style" && !(record.target as Element).matches("img") && !(record.target as Element).querySelector("img")))) return;
			this.invalidate(false);
		});
		observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset", "width", "height", "style"] });
		this.cleanup.push(() => observer.disconnect());
		if (typeof ResizeObserver !== "undefined") {
			const resize = new ResizeObserver(layout); resize.observe(root); this.cleanup.push(() => resize.disconnect());
		}
		this.invalidate();
	}
	private context(): ImageCommentContext | undefined {
		if (this.closed || this.view.contentEl.ownerDocument.hidden || !this.view.contentEl.isConnected || !this.view.contentEl.getClientRects().length) return;
		try { return this.host.imageContext(this.view, false); } catch { return; }
	}
	invalidate(data = true): void {
		if (this.closed) return;
		if (data) { this.dirty = true; this.epoch++; }
		const context = this.context();
		if (!context || context.session !== this.session || context.entryId !== this.entryId || context.text !== this.text) this.clear();
		for (const record of this.records.values()) if (!record.current() || record.evidence && !record.evidence.valid()) record.element.hidden = true;
		if (this.timer === undefined) this.timer = this.win.setTimeout(() => { this.timer = undefined; void this.refresh(); }, 60);
	}
	private clear(): void { for (const record of this.records.values()) record.element.remove(); this.records.clear(); }
	private async refresh(): Promise<void> {
		if (this.closed) return;
		if (this.busy) { this.invalidate(false); return; }
		this.busy = true;
		try {
			const context = this.context();
			if (!context) { this.clear(); this.detach(); return; }
			if (context.session !== this.session || context.entryId !== this.entryId || context.text !== this.text) {
				this.detach(); this.session = context.session; this.entryId = context.entryId; this.text = context.text;
				this.unwatch = context.session.watch(context.entryId, () => this.invalidate());
				const changed = () => { this.parsed = undefined; this.clear(); this.epoch++; this.invalidate(false); };
				context.text.observe(changed); this.unobserve = () => context.text.unobserve(changed); this.dirty = true;
			}
			const epoch = this.epoch;
			if (this.dirty) {
				this.dirty = false; const threads = await context.session.anchorThreads(context.entryId);
				if (this.closed || epoch !== this.epoch || !context.current()) { this.dirty = true; return; }
				this.threads = threads.filter(thread => thread.anchor?.type === "image");
			}
			const source = context.text.toString();
			if (source !== this.parsed?.source) { this.parsed = { source, images: markdownImages(source) }; this.parseRevision++; }
			this.placements.clear();
			const occurrences = new Set(this.parsed.images.map(image => `${image.from}:${image.to}`));
			const snapshot = Y.snapshot(context.text.doc!);
			for (const thread of this.threads) {
				if (thread.anchor?.type !== "image") continue;
				const position = resolveTextAnchor(context.text, context.entryId, context.generation, localTextAnchor(thread.anchor.occurrence), snapshot);
				if (position.status !== "attached") continue;
				const key = `${position.from}:${position.to}`;
				if (occurrences.has(key)) this.placements.set(key, [...this.placements.get(key) ?? [], { thread, anchor: thread.anchor }]);
			}
			const targets = this.host.renderedImages(this.view, this.parsed.images), live = new Set<HTMLImageElement>();
			for (const target of targets) {
				if (!renderedImageFit(target.image, this.view.contentEl)) continue;
				let assetKey: string;
				try { assetKey = JSON.stringify(this.assets.describe(context.file, target.occurrence.destination)); } catch { continue; }
				live.add(target.image);
				const key = [context.generation, this.parseRevision, target.occurrence.from, target.occurrence.to, target.image.currentSrc || target.image.src, assetKey].join("\n");
				let record = this.records.get(target.image);
				if (!record || record.key !== key || !record.evidence && record.attempt !== this.epoch) {
					record?.element.remove();
					const current = () => !this.closed && this.parsed?.source === source && context.session === this.session && context.entryId === this.entryId && context.text === this.text &&
						context.session.documentGeneration(context.entryId) === context.generation && !!context.session.permission(context.entryId)?.read && target.image.isConnected && this.records.get(target.image) === record;
					record = this.create(target, key, current); this.records.set(target.image, record);
					const captured = record;
					void this.assets.verifyRendered(context.file, target.occurrence.destination, target.image, current).then(evidence => {
						if (this.records.get(target.image) !== captured || !current() || !evidence.valid()) return;
						captured.evidence = evidence; this.populate(captured, context); this.layout();
					}).catch(() => { /* Unverified renders retain the command/dialog fallback. */ });
				} else if (record.evidence?.valid()) this.populate(record, context);
			}
			for (const [image, record] of this.records) if (!live.has(image)) { record.element.remove(); this.records.delete(image); }
			this.layout();
		} catch { this.clear(); }
		finally { this.busy = false; }
	}
	private create(target: RenderedImageTarget, key: string, current: () => boolean): Record {
		const element = this.layer.ownerDocument.createElement("div"); element.className = "relay-rendered-image"; element.hidden = true;
		const clip = element.createDiv({ cls: "relay-rendered-image-clip" }), controls = element.createDiv({ cls: "relay-rendered-image-controls" });
		this.layer.append(element); return { target, key, attempt: this.epoch, element, clip, controls, markers: [], current };
	}
	private populate(record: Record, context: ImageCommentContext): void {
		if (!record.evidence?.valid() || !record.current()) return;
		const image = record.target.image, matches = this.placements.get(`${record.target.occurrence.from}:${record.target.occurrence.to}`) ?? [];
		const comment = context.session.canAnchorImages && !!context.session.permission(context.entryId)?.comment;
		const signature = [comment, image.naturalWidth, image.naturalHeight, ...matches.map(({ thread }) => `${thread.id}:${thread.activity_sequence}`)].join("|");
		if (record.signature === signature) return; record.signature = signature;
		record.controls.empty(); record.clip.empty(); record.markers = [];
		const guarded = (action: () => void) => () => { if (this.context()?.session === context.session && record.current() && record.evidence?.valid()) action(); };
		if (comment) record.controls.createEl("button", { text: "Comment on image", attr: { type: "button", "aria-label": "Comment on this image occurrence" } }).onclick = guarded(() => {
			try { const writable = this.host.imageContext(this.view); this.open(writable, record.target.occurrence, {
				image, root: this.view.contentEl, current: () => record.current() && !!record.evidence?.valid(),
			}); } catch { this.invalidate(); }
		});
		for (const value of matches) {
			const { thread, anchor } = value;
			const changed = imageAssetChanged(anchor.asset, record.evidence.asset) || anchor.basis.width !== image.naturalWidth || anchor.basis.height !== image.naturalHeight;
			const label = `${context.session.displayName(context.entryId, thread.author_id)} · ${thread.state === "resolved" ? "Resolved" : "Open"} image ${anchor.geometry.type === "whole" ? "discussion" : anchor.geometry.type}`;
			const button = (changed || anchor.geometry.type === "whole" ? record.controls : record.clip).createEl("button", {
				text: changed ? "Image changed · discussion" : anchor.geometry.type === "whole" ? "Image discussion" : "", attr: { type: "button", "aria-label": label + (changed ? " · image changed" : ""), title: label },
				cls: changed || anchor.geometry.type === "whole" ? undefined : ["relay-rendered-image-mark", anchor.geometry.type, thread.state === "resolved" ? "is-resolved" : "is-open"],
			});
			button.onclick = guarded(() => { void this.host.openThread(context.file, context.session, context.entryId, thread.id); });
			if (!changed && anchor.geometry.type !== "whole") record.markers.push({ button, value });
		}
		if (record.evidence.asset.kind === "external") record.controls.createEl("span", { text: "Version unknown", cls: "relay-rendered-image-evidence" });
	}
	private layout(): void {
		if (this.closed || this.frame !== undefined) return;
		this.frame = this.win.requestAnimationFrame(() => {
			this.frame = undefined; const root = this.view.contentEl, box = this.layer.getBoundingClientRect(), current = this.context();
			const sx = box.width / this.layer.clientWidth, sy = box.height / this.layer.clientHeight;
			for (const record of this.records.values()) {
				const fit = current && record.current() && record.evidence?.valid() ? renderedImageFit(record.target.image, root) : undefined;
				if (!fit || !Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) { record.element.hidden = true; continue; }
				record.element.hidden = false;
				this.box(record.element, { left: (fit.frame.left - box.left) / sx, top: (fit.frame.top - box.top) / sy, width: fit.frame.width / sx, height: fit.frame.height / sy });
				for (const { button, value } of record.markers) {
					const geometry = value.anchor.geometry; if (geometry.type === "whole") continue;
					const left = (fit.content.left + geometry.x * fit.content.width - fit.frame.left) / sx, top = (fit.content.top + geometry.y * fit.content.height - fit.frame.top) / sy;
					const width = geometry.type === "region" ? geometry.width * fit.content.width / sx : 20, height = geometry.type === "region" ? geometry.height * fit.content.height / sy : 20;
					button.hidden = geometry.type === "pin" ? left < 0 || top < 0 || left > fit.frame.width / sx || top > fit.frame.height / sy :
						left + width <= 0 || top + height <= 0 || left >= fit.frame.width / sx || top >= fit.frame.height / sy;
					this.box(button, { left, top, width, height });
				}
			}
		});
	}
	private box(element: HTMLElement, box: ImageBox): void { element.style.left = `${box.left}px`; element.style.top = `${box.top}px`; element.style.width = `${box.width}px`; element.style.height = `${box.height}px`; }
	private detach(): void { this.unwatch?.(); this.unobserve?.(); this.unwatch = this.unobserve = undefined; this.session = undefined; this.entryId = undefined; this.text = undefined; this.parsed = undefined; this.threads = []; }
	close(): void {
		this.closed = true; this.epoch++; this.detach(); this.clear(); this.cleanup.forEach(stop => stop());
		if (this.timer !== undefined) this.win.clearTimeout(this.timer);
		if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
		this.layer.remove(); this.view.contentEl.classList.remove("relay-rendered-image-root");
	}
}
