import { Component, FileView, MarkdownView, type Plugin, type TFile } from "obsidian";
import type { DiscussionHost, ImageFileCommentContext } from "./DiscussionHost";
import type { AnchoredThread, DiscussionSession } from "./DiscussionSession";
import type { ImageAssets, RenderedImageEvidence } from "./ImageAssets";
import type { ImageFileAnchor } from "./DiscussionProtocol";
import { imageAssetChanged } from "./anchors/images";
import { renderedImageFit } from "./anchors/renderedImages";
import type { ImageBox } from "./anchors/imageGeometry";

type Marker = { button: HTMLButtonElement; anchor: ImageFileAnchor };
const owned = ".relay-rendered-images";

/** Direct-file views have no Markdown occurrence mapping. Only the exact native
 * resource of the authorized managed file may receive its discussion overlay. */
export class ImageFileOverlays extends Component {
	private views = new Map<FileView, ImageFileOverlay>();
	constructor(private host: DiscussionHost, private plugin: Plugin, private assets: ImageAssets, private open: (file: TFile) => void) { super(); }
	onload(): void {
		this.register(this.host.onChange(() => this.reconcile()));
		this.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.reconcile()));
		this.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.reconcile()));
		this.registerEvent(this.plugin.app.workspace.on("file-open", () => this.reconcile()));
		this.registerEvent(this.plugin.app.vault.on("modify", () => this.reconcile()));
		this.reconcile();
	}
	private reconcile(): void {
		const live = new Set<FileView>();
		this.plugin.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof FileView && !(leaf.view instanceof MarkdownView) && leaf.view.file && this.host.targetFor(leaf.view.file).kind === "image") live.add(leaf.view);
		});
		for (const [view, overlay] of this.views) if (!live.has(view)) { overlay.close(); this.views.delete(view); }
		for (const view of live) {
			let overlay = this.views.get(view);
			if (!overlay) { overlay = new ImageFileOverlay(this.host, view, this.assets, this.open); this.views.set(view, overlay); }
			overlay.invalidate();
		}
	}
	onunload(): void { for (const overlay of this.views.values()) overlay.close(); this.views.clear(); }
}

export class ImageFileOverlay {
	private layer: HTMLDivElement;
	private element: HTMLDivElement;
	private controls: HTMLDivElement;
	private clip: HTMLDivElement;
	private markers: Marker[] = [];
	private image?: HTMLImageElement;
	private evidence?: RenderedImageEvidence;
	private current?: () => boolean;
	private key = "";
	private signature = "";
	private attempt = -1;
	private threads: AnchoredThread[] = [];
	private session?: DiscussionSession;
	private entryId?: string;
	private file?: TFile;
	private unwatch?: () => void;
	private cleanup: (() => void)[] = [];
	private timer?: number;
	private frame?: number;
	private epoch = 0;
	private dirty = true;
	private busy = false;
	private closed = false;
	private win: Window;
	constructor(private host: DiscussionHost, private view: FileView, private assets: ImageAssets, private open: (file: TFile) => void) {
		const root = view.contentEl, doc = root.ownerDocument; this.win = doc.defaultView ?? window;
		this.layer = doc.createElement("div"); this.layer.className = "relay-rendered-images";
		this.element = this.layer.createDiv({ cls: "relay-rendered-image" }); this.element.hidden = true;
		this.clip = this.element.createDiv({ cls: "relay-rendered-image-clip" }); this.controls = this.element.createDiv({ cls: "relay-rendered-image-controls" });
		root.classList.add("relay-rendered-image-root"); root.append(this.layer);
		const changed = () => this.invalidate(), layout = () => { this.layout(); this.invalidate(false); };
		const listen = (target: EventTarget, event: string, fn: EventListener, capture = false) => {
			target.addEventListener(event, fn, capture); this.cleanup.push(() => target.removeEventListener(event, fn, capture));
		};
		listen(root, "load", changed, true); listen(root, "error", changed, true);
		listen(doc, "scroll", layout, true); listen(this.win, "resize", layout); listen(doc, "visibilitychange", changed);
		const observer = new MutationObserver(records => {
			if (records.every(record => (record.target.nodeType === 1 ? record.target as Element : record.target.parentElement)?.closest(owned))) return;
			this.invalidate(false);
		});
		observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset", "width", "height", "style"] });
		this.cleanup.push(() => observer.disconnect());
		if (typeof ResizeObserver !== "undefined") { const observer = new ResizeObserver(layout); observer.observe(root); this.cleanup.push(() => observer.disconnect()); }
		this.invalidate();
	}
	private context(): ImageFileCommentContext | undefined {
		if (this.closed || this.view.contentEl.ownerDocument.hidden || !this.view.contentEl.isConnected || !this.view.contentEl.getClientRects().length || !this.view.file) return;
		try { return this.host.imageFileContext(this.view.file, false); } catch { return; }
	}
	invalidate(data = true): void {
		if (this.closed) return;
		if (data) { this.dirty = true; this.epoch++; }
		if (!this.current?.() || !this.evidence?.valid()) this.element.hidden = true;
		if (this.timer === undefined) this.timer = this.win.setTimeout(() => { this.timer = undefined; void this.refresh(); }, 60);
	}
	private detach(): void { this.unwatch?.(); this.unwatch = undefined; this.session = undefined; this.entryId = undefined; this.file = undefined; this.threads = []; this.clear(); }
	private clear(): void { this.element.hidden = true; this.image = undefined; this.evidence = undefined; this.current = undefined; this.key = ""; this.signature = ""; this.markers = []; this.controls.empty(); this.clip.empty(); }
	private async refresh(): Promise<void> {
		if (this.closed) return;
		if (this.busy) { this.invalidate(false); return; }
		this.busy = true;
		try {
			const file = this.view.file, target = file ? this.host.targetFor(file) : undefined;
			if (!file || target?.kind !== "image" || !target.session || !target.entryId || !this.view.contentEl.getClientRects().length || this.view.contentEl.ownerDocument.hidden) { this.detach(); return; }
			if (file !== this.file || target.session !== this.session || target.entryId !== this.entryId) {
				this.detach(); this.file = file; this.session = target.session; this.entryId = target.entryId; this.dirty = true;
				this.unwatch = this.session.watch(this.entryId, () => this.invalidate(), "image");
			}
			const context = this.context(); if (!context) { this.clear(); return; }
			const epoch = this.epoch;
			if (this.dirty) {
				this.dirty = false; const threads = await context.session.anchorThreads(context.entryId);
				if (this.closed || epoch !== this.epoch || !context.current()) { this.dirty = true; this.invalidate(false); return; }
				this.threads = threads.filter(thread => thread.anchor?.type === "image_file" && thread.anchor.asset.entry_id === context.entryId);
			}
			const asset = this.assets.describeFile(file), resource = this.view.app.vault.getResourcePath(file);
			const images = Array.from(this.view.contentEl.querySelectorAll<HTMLImageElement>("img")).filter(image => {
				if (image.closest(owned)) return false;
				try { return new URL(image.currentSrc || image.src).href === new URL(resource).href; } catch { return false; }
			});
			if (asset.entry_id !== context.entryId || images.length !== 1 || !renderedImageFit(images[0], this.view.contentEl)) { this.clear(); return; }
			const image = images[0], key = JSON.stringify([context.generation, asset, image.currentSrc || image.src]);
			if (image !== this.image || key !== this.key || !this.evidence && this.attempt !== epoch) {
				this.clear(); this.image = image; this.key = key; this.attempt = epoch;
				const current = () => !this.closed && this.image === image && this.key === key && this.view.file === file && image.isConnected &&
					this.view.contentEl.contains(image) && this.context()?.session === context.session && context.current();
				this.current = current;
				void this.assets.verifyRenderedFile(file, image, current).then(evidence => {
					if (!current() || !evidence.valid()) return;
					this.evidence = evidence; this.populate(context); this.layout();
				}).catch(() => { /* Unverified or unsupported render: command/sidebar remains available. */ });
			} else if (this.evidence?.valid()) this.populate(context);
			this.layout();
		} catch { this.clear(); }
		finally { this.busy = false; }
	}
	private populate(context: ImageFileCommentContext): void {
		const image = this.image, evidence = this.evidence;
		if (!image || !evidence?.valid() || !this.current?.()) return;
		const canComment = context.session.canAnchorImageFiles && !!context.session.permission(context.entryId)?.comment;
		const signature = JSON.stringify([canComment, image.naturalWidth, image.naturalHeight, this.threads.map(thread => [thread.id, thread.activity_sequence])]);
		if (signature === this.signature) return; this.signature = signature;
		this.controls.empty(); this.clip.empty(); this.markers = [];
		const guarded = (action: () => void) => () => { if (this.current?.() && this.evidence?.valid() && context.current()) action(); };
		if (canComment) this.controls.createEl("button", { text: "Comment on image", attr: { type: "button" } }).onclick = guarded(() => this.open(context.file));
		for (const thread of this.threads) {
			if (thread.anchor?.type !== "image_file") continue;
			const anchor = thread.anchor, changed = context.generation !== anchor.generation || imageAssetChanged(anchor.asset, evidence.asset) ||
				anchor.basis.width !== image.naturalWidth || anchor.basis.height !== image.naturalHeight;
			const label = `${context.session.displayName(context.entryId, thread.author_id)} · ${thread.state === "resolved" ? "Resolved" : "Open"} image ${anchor.geometry.type === "whole" ? "discussion" : anchor.geometry.type}`;
			const button = (changed || anchor.geometry.type === "whole" ? this.controls : this.clip).createEl("button", {
				text: changed ? "Image changed · discussion" : anchor.geometry.type === "whole" ? "Image discussion" : "",
				attr: { type: "button", "aria-label": label + (changed ? " · image changed" : ""), title: label },
				cls: changed || anchor.geometry.type === "whole" ? undefined : ["relay-rendered-image-mark", anchor.geometry.type, thread.state === "resolved" ? "is-resolved" : "is-open"],
			});
			button.onclick = guarded(() => { void this.host.openThread(context.file, context.session, context.entryId, thread.id); });
			if (!changed && anchor.geometry.type !== "whole") this.markers.push({ button, anchor });
		}
	}
	private layout(): void {
		if (this.closed || this.frame !== undefined) return;
		this.frame = this.win.requestAnimationFrame(() => {
			this.frame = undefined;
			const fit = this.image && this.current?.() && this.evidence?.valid() ? renderedImageFit(this.image, this.view.contentEl) : undefined;
			const box = this.layer.getBoundingClientRect(), sx = box.width / this.layer.clientWidth, sy = box.height / this.layer.clientHeight;
			if (!fit || !Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) { this.element.hidden = true; return; }
			this.element.hidden = false; this.box(this.element, { left: (fit.frame.left - box.left) / sx, top: (fit.frame.top - box.top) / sy, width: fit.frame.width / sx, height: fit.frame.height / sy });
			for (const { button, anchor } of this.markers) {
				const geometry = anchor.geometry; if (geometry.type === "whole") continue;
				const left = (fit.content.left + geometry.x * fit.content.width - fit.frame.left) / sx, top = (fit.content.top + geometry.y * fit.content.height - fit.frame.top) / sy;
				const width = geometry.type === "region" ? geometry.width * fit.content.width / sx : 20, height = geometry.type === "region" ? geometry.height * fit.content.height / sy : 20;
				button.hidden = geometry.type === "pin" ? left < 0 || top < 0 || left > fit.frame.width / sx || top > fit.frame.height / sy : left + width <= 0 || top + height <= 0 || left >= fit.frame.width / sx || top >= fit.frame.height / sy;
				this.box(button, { left, top, width, height });
			}
		});
	}
	private box(element: HTMLElement, box: ImageBox): void { element.style.left = `${box.left}px`; element.style.top = `${box.top}px`; element.style.width = `${box.width}px`; element.style.height = `${box.height}px`; }
	close(): void {
		this.closed = true; this.epoch++; this.detach(); this.cleanup.forEach(stop => stop());
		if (this.timer !== undefined) this.win.clearTimeout(this.timer);
		if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
		this.layer.remove(); this.view.contentEl.classList.remove("relay-rendered-image-root");
	}
}
