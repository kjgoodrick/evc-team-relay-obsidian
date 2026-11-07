import { imagePoint, imageRegion, type ImageBasis, type ImageBox, type ImageGeometry } from "../anchors/imageGeometry";
import { intersectBox, renderedImageFit, type ImageFit } from "../anchors/renderedImages";

/** A verified occurrence, not a URL/filename lookup. The owner invalidates it
 * when the renderer, source mapping, account or image version changes. */
export type ImagePlacementSurface = { image: HTMLImageElement; root: HTMLElement; current: () => boolean };
type Options = {
	surface: ImagePlacementSurface; current: () => boolean; external: boolean;
	save: (basis: ImageBasis, geometry: ImageGeometry) => Promise<void>;
	preview: (geometry: ImageGeometry, basis: ImageBasis) => void; closed: () => void;
};
type Point = { x: number; y: number };
type Corner = "nw" | "ne" | "sw" | "se";
type Drag = { id: number; start: Point; before: ImageGeometry; action: "draw" | "move" | Corner; fit: string };
const corners: Corner[] = ["nw", "ne", "sw", "se"];
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const boxStyle = (element: HTMLElement, box: ImageBox) => {
	element.style.left = `${box.left}px`; element.style.top = `${box.top}px`;
	element.style.width = `${box.width}px`; element.style.height = `${box.height}px`;
};

/** An explicit annotation mode over the original rendered image. It freezes
 * at most 2048² pixels, does not fetch assets or write Markdown, and only hands
 * the confirmed geometry to the existing durable selection-draft path. */
export class RenderedImagePlacement {
	private layer?: HTMLDivElement;
	private scene?: HTMLDivElement;
	private canvas?: HTMLCanvasElement;
	private mark?: HTMLButtonElement;
	private handles = new Map<Corner, HTMLButtonElement>();
	private toolbar?: HTMLDivElement;
	private status?: HTMLElement;
	private modes = new Map<ImageGeometry["type"], HTMLButtonElement>();
	private basis?: ImageBasis;
	private geometry: ImageGeometry = { type: "whole" };
	private drag?: Drag;
	private cleanup: (() => void)[] = [];
	private frame?: number;
	private finished = false;
	private saving = false;
	private previousFocus?: HTMLElement;
	private win: Window;
	constructor(private options: Options) { this.win = options.surface.root.ownerDocument.defaultView ?? window; }
	open(): void {
		const { image, root } = this.options.surface, doc = root.ownerDocument;
		if (!this.valid() || !renderedImageFit(image, root) || Math.max(image.naturalWidth, image.naturalHeight) > 100000) throw new Error("Image placement unavailable");
		this.basis = { width: image.naturalWidth, height: image.naturalHeight, orientation: "display" };
		const canvas = doc.createElement("canvas"), scale = Math.min(1, 2048 / Math.max(this.basis.width, this.basis.height));
		canvas.width = Math.max(1, Math.round(this.basis.width * scale)); canvas.height = Math.max(1, Math.round(this.basis.height * scale));
		const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Image preview unavailable");
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height); // A tainted external canvas is displayed only; never exported/read.
		this.canvas = canvas; canvas.setAttribute("aria-hidden", "true");
		this.previousFocus = doc.activeElement as HTMLElement;
		const layer = this.layer = doc.createElement("div"); layer.className = "relay-rendered-images relay-image-placement";
		const scene = this.scene = layer.createDiv({ cls: "relay-image-placement-scene", attr: { "aria-label": "Image annotation placement" } }); scene.append(canvas);
		this.mark = scene.createEl("button", { cls: "relay-image-placement-mark", attr: { type: "button", "aria-label": "Move annotation with arrow keys; hold shift for larger steps" } });
		this.mark.dataset.handle = "move";
		for (const corner of corners) {
			const label = { nw: "top left", ne: "top right", sw: "bottom left", se: "bottom right" }[corner];
			const handle = scene.createEl("button", { cls: "relay-image-placement-handle", attr: { type: "button", "aria-label": `Resize ${label} corner with arrow keys` } });
			handle.dataset.handle = corner; this.handles.set(corner, handle);
		}
		const toolbar = this.toolbar = layer.createDiv({ cls: "relay-image-placement-toolbar", attr: { role: "group", "aria-label": "Image annotation" } });
		for (const [mode, label] of [["whole", "Whole image"], ["pin", "Pin"], ["region", "Region"]] as const) {
			const button = toolbar.createEl("button", { text: label, attr: { type: "button" } });
			this.modes.set(mode, button);
			button.onclick = () => {
				if (!this.valid() || this.saving) return; this.cancelDrag();
				this.geometry = mode === "whole" ? { type: mode } : this.initial(mode); this.draw(); this.announce();
			};
		}
		toolbar.createEl("button", { text: "Larger preview / coordinates", attr: { type: "button" } }).onclick = () => {
			if (!this.valid() || this.saving || !this.basis) return;
			this.cancelDrag(); this.options.preview({ ...this.geometry }, { ...this.basis });
		};
		toolbar.createEl("button", { text: "Add comment", cls: "mod-cta", attr: { type: "button" } }).onclick = () => { void this.save(); };
		toolbar.createEl("button", { text: "Cancel", attr: { type: "button" } }).onclick = () => { if (!this.saving) this.close(); };
		this.status = toolbar.createDiv({ cls: "relay-image-placement-status", attr: { role: "status", "aria-live": "polite" } });
		const listen = (target: EventTarget, event: string, callback: EventListener, capture = false) => {
			target.addEventListener(event, callback, capture); this.cleanup.push(() => target.removeEventListener(event, callback, capture));
		};
		listen(scene, "pointerdown", event => this.down(event as PointerEvent));
		listen(scene, "pointermove", event => this.move(event as PointerEvent));
		listen(scene, "pointerup", event => {
			const pointer = event as PointerEvent; if (pointer.pointerId !== this.drag?.id) return;
			this.move(pointer); this.releaseDrag(); this.announce();
		});
		listen(scene, "pointercancel", event => { if ((event as PointerEvent).pointerId === this.drag?.id) this.cancelDrag(); });
		listen(scene, "lostpointercapture", event => { if ((event as PointerEvent).pointerId === this.drag?.id) this.cancelDrag(); });
		listen(scene, "click", event => { event.preventDefault(); event.stopPropagation(); });
		listen(layer, "keydown", event => this.key(event as KeyboardEvent));
		const layout = () => this.schedule();
		listen(doc, "scroll", layout, true); listen(this.win, "resize", layout);
		listen(doc, "visibilitychange", () => this.validate());
		const observer = new MutationObserver(records => {
			if (records.some(record => !(record.target.nodeType === 1 ? record.target as Element : record.target.parentElement)?.closest(".relay-rendered-images"))) this.validate();
		});
		observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset", "style", "class", "width", "height"] });
		this.cleanup.push(() => observer.disconnect());
		if (typeof ResizeObserver !== "undefined") {
			const observer = new ResizeObserver(layout); observer.observe(root); observer.observe(image); this.cleanup.push(() => observer.disconnect());
		}
		root.append(layer); this.layout(); this.announce(); this.modes.get("whole")?.focus();
	}
	private valid(): boolean {
		const { image, root, current } = this.options.surface;
		return !this.finished && !root.ownerDocument.hidden && root.isConnected && root.contains(image) && this.options.current() && current() &&
			image.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && (!this.basis || image.naturalWidth === this.basis.width && image.naturalHeight === this.basis.height);
	}
	validate(): void { if (!this.valid()) this.close(); else this.schedule(); }
	private schedule(): void {
		if (this.finished || this.frame !== undefined) return;
		this.frame = this.win.requestAnimationFrame(() => { this.frame = undefined; this.layout(); });
	}
	private fit(): ImageFit | undefined { return this.valid() ? renderedImageFit(this.options.surface.image, this.options.surface.root) : undefined; }
	private layout(): void {
		const fit = this.fit(), layer = this.layer;
		if (!fit || !layer || !this.scene || !this.canvas) { this.close(); return; }
		if (this.drag && this.drag.fit !== JSON.stringify(fit)) this.cancelDrag();
		const box = layer.getBoundingClientRect(), sx = box.width / layer.clientWidth, sy = box.height / layer.clientHeight;
		if (![sx, sy].every(value => Number.isFinite(value) && value > 0)) { this.close(); return; }
		boxStyle(this.scene, { left: (fit.frame.left - box.left) / sx, top: (fit.frame.top - box.top) / sy, width: fit.frame.width / sx, height: fit.frame.height / sy });
		boxStyle(this.canvas, { left: (fit.content.left - fit.frame.left) / sx, top: (fit.content.top - fit.frame.top) / sy, width: fit.content.width / sx, height: fit.content.height / sy });
		if (this.toolbar) {
			const height = this.toolbar.getBoundingClientRect().height, bottom = fit.frame.top + fit.frame.height;
			const top = fit.frame.top - box.top >= height + 8 ? fit.frame.top - height - 4 : box.top + box.height - bottom >= height + 8 ? bottom + 4 : box.top + box.height - height;
			this.toolbar.style.top = `${Math.max(0, (top - box.top) / sy)}px`;
		}
		this.draw(fit, sx, sy);
	}
	private initial(type: "pin" | "region"): ImageGeometry {
		const fit = this.fit(), visible = fit && intersectBox(fit.frame, fit.content);
		if (!fit || !visible) return { type: "pin", x: 0.5, y: 0.5 };
		const x = (visible.left - fit.content.left) / fit.content.width, y = (visible.top - fit.content.top) / fit.content.height;
		const width = visible.width / fit.content.width, height = visible.height / fit.content.height;
		return type === "pin" ? { type, x: x + width / 2, y: y + height / 2 } : { type, x: x + width / 4, y: y + height / 4, width: width / 2, height: height / 2 };
	}
	private point(event: PointerEvent, fit: ImageFit, bounded = false): Point | undefined {
		const visible = intersectBox(fit.content, fit.frame); if (!visible) return;
		if (!bounded && !imagePoint(visible, event.clientX, event.clientY)) return;
		return imagePoint(fit.content, clamp(event.clientX, visible.left, visible.left + visible.width), clamp(event.clientY, visible.top, visible.top + visible.height));
	}
	private down(event: PointerEvent): void {
		if (this.saving || this.drag || this.geometry.type === "whole" || event.button !== 0 || event.isPrimary === false) return;
		const fit = this.fit(), point = fit && this.point(event, fit); if (!fit || !point) return;
		event.preventDefault(); event.stopPropagation();
		const handle = (event.target as Element).closest<HTMLElement>("[data-handle]")?.dataset.handle;
		this.drag = { id: event.pointerId, start: point, before: { ...this.geometry }, action: handle === "move" || corners.includes(handle as Corner) ? handle as "move" | Corner : "draw", fit: JSON.stringify(fit) };
		try { this.scene!.setPointerCapture(event.pointerId); } catch { this.drag = undefined; return; }
		if (this.geometry.type === "pin") this.geometry = { type: "pin", ...point };
		this.mark?.focus({ preventScroll: true }); this.draw();
	}
	private move(event: PointerEvent): void {
		const drag = this.drag; if (!drag || drag.id !== event.pointerId || this.saving) return;
		const fit = this.fit(); if (!fit) { this.close(); return; }
		if (JSON.stringify(fit) !== drag.fit) { this.cancelDrag(); return; }
		const point = this.point(event, fit, true); if (!point) return;
		event.preventDefault(); event.stopPropagation();
		if (drag.before.type === "pin") this.geometry = { type: "pin", ...point };
		else if (drag.action === "draw") this.geometry = imageRegion(drag.start, point) ?? drag.before;
		else if (drag.action === "move") this.geometry = this.translated(drag.before, point.x - drag.start.x, point.y - drag.start.y);
		else this.geometry = this.resized(drag.before, drag.action, point) ?? this.geometry;
		this.draw();
	}
	private translated(geometry: ImageGeometry, dx: number, dy: number): ImageGeometry {
		if (geometry.type === "whole") return geometry;
		return { ...geometry, x: clamp(geometry.x + dx, 0, geometry.type === "region" ? 1 - geometry.width : 1), y: clamp(geometry.y + dy, 0, geometry.type === "region" ? 1 - geometry.height : 1) };
	}
	private resized(geometry: ImageGeometry, corner: Corner, point: Point): ImageGeometry | undefined {
		if (geometry.type !== "region") return;
		const opposite = { x: corner.endsWith("w") ? geometry.x + geometry.width : geometry.x, y: corner.startsWith("n") ? geometry.y + geometry.height : geometry.y };
		return imageRegion(opposite, point);
	}
	private key(event: KeyboardEvent): void {
		if (event.key === "Escape" && !this.saving) { event.preventDefault(); event.stopPropagation(); if (this.drag) this.cancelDrag(); else this.close(); return; }
		if (this.saving || !this.valid() || this.geometry.type === "whole" || event.ctrlKey || event.metaKey || event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
		const handle = (event.target as HTMLElement).dataset.handle; if (!handle) return;
		event.preventDefault(); event.stopPropagation(); this.cancelDrag();
		const step = event.shiftKey ? 0.1 : 0.01, dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
		const geometry = this.geometry;
		if (handle === "move") this.geometry = this.translated(geometry, dx, dy);
		else if (geometry.type === "region") this.geometry = this.resized(geometry, handle as Corner, {
			x: clamp(geometry.x + (handle.endsWith("e") ? geometry.width : 0) + dx), y: clamp(geometry.y + (handle.startsWith("s") ? geometry.height : 0) + dy),
		}) ?? geometry;
		this.draw(); this.announce();
	}
	private releaseDrag(): void {
		const drag = this.drag; this.drag = undefined;
		if (drag) { try { this.scene?.releasePointerCapture(drag.id); } catch { /* Capture can already be lost on detach. */ } }
	}
	private cancelDrag(): void { if (this.drag) { this.geometry = this.drag.before; this.releaseDrag(); this.draw(); this.announce(); } }
	private draw(fit = this.fit(), sx?: number, sy?: number): void {
		if (!fit || !this.layer || !this.mark || !this.scene) return;
		const box = this.layer.getBoundingClientRect(); sx ??= box.width / this.layer.clientWidth; sy ??= box.height / this.layer.clientHeight;
		const geometry = this.geometry;
		for (const [mode, button] of this.modes) button.setAttribute("aria-pressed", String(mode === geometry.type));
		this.scene.style.touchAction = geometry.type === "whole" ? "auto" : "none";
		this.mark.hidden = geometry.type === "whole";
		for (const button of this.handles.values()) button.hidden = geometry.type !== "region";
		if (geometry.type === "whole") return;
		const left = (fit.content.left + geometry.x * fit.content.width - fit.frame.left) / sx, top = (fit.content.top + geometry.y * fit.content.height - fit.frame.top) / sy;
		const width = geometry.type === "region" ? geometry.width * fit.content.width / sx : 24, height = geometry.type === "region" ? geometry.height * fit.content.height / sy : 24;
		this.mark.classList.toggle("pin", geometry.type === "pin"); boxStyle(this.mark, { left, top, width, height });
		for (const [corner, button] of this.handles) { button.style.left = `${left + (corner.endsWith("e") ? width : 0)}px`; button.style.top = `${top + (corner.startsWith("s") ? height : 0)}px`; }
	}
	private announce(): void {
		if (!this.status) return; const geometry = this.geometry, percent = (value: number) => `${Number((value * 100).toFixed(2))}%`;
		this.status.textContent = `${this.options.external ? "External image · version unknown. " : ""}Frozen preview. ` +
			(geometry.type === "whole" ? "Choose Pin or Region to place an annotation." : `${geometry.type === "pin" ? "Pin" : "Region"} at ${percent(geometry.x)}, ${percent(geometry.y)}${geometry.type === "region" ? `; size ${percent(geometry.width)} × ${percent(geometry.height)}` : ""}. Drag to adjust, or use arrow keys on the annotation and corner handles.`);
	}
	private async save(): Promise<void> {
		if (this.saving || !this.valid() || !this.fit() || !this.basis) return;
		this.cancelDrag(); this.saving = true;
		for (const button of Array.from(this.layer!.querySelectorAll("button"))) button.disabled = true;
		try { await this.options.save({ ...this.basis }, { ...this.geometry }); this.close(false); }
		catch { if (!this.finished) { this.status!.textContent = "The image target could not be saved. Check access and synchronization, then try again."; } }
		finally {
			this.saving = false;
			if (!this.finished) { for (const button of Array.from(this.layer!.querySelectorAll("button"))) button.disabled = false; this.validate(); }
		}
	}
	close(restoreFocus = true): void {
		if (this.finished) return; this.finished = true; this.releaseDrag();
		const focused = this.layer?.contains(this.layer.ownerDocument.activeElement);
		this.cleanup.forEach(stop => stop()); this.cleanup = [];
		if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame); this.frame = undefined;
		if (this.canvas) this.canvas.width = this.canvas.height = 0;
		this.layer?.remove();
		if (restoreFocus && focused && this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
		this.options.closed();
	}
}
