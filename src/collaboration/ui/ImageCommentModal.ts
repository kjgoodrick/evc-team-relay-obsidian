import { Modal, type App } from "obsidian";
import { imagePoint, imageRegion, type ImageBasis, type ImageGeometry } from "../anchors/imageGeometry";
import type { ImagePreview } from "../ImageAssets";

type Options = { title: string; load: () => Promise<ImagePreview>; current: () => boolean;
	geometry?: ImageGeometry; basis?: ImageBasis; changed?: boolean;
	save?: (preview: ImagePreview, basis: ImageBasis, geometry: ImageGeometry) => Promise<void>; closed?: () => void };

/** Static, uncropped placement preview. Pointer and numeric controls use the
 * same normalized geometry; normal scrolling outside this surface is untouched. */
export class ImageCommentModal extends Modal {
	private preview?: ImagePreview;
	private image?: HTMLImageElement;
	private basis?: ImageBasis;
	private canvas?: HTMLCanvasElement;
	private overlay?: HTMLElement;
	private statusEl?: HTMLElement;
	private saveButton?: HTMLButtonElement;
	private fields?: HTMLElement;
	private modeButtons: HTMLButtonElement[] = [];
	private geometry: ImageGeometry;
	private closed = false;
	private saving = false;
	private drag?: { id: number; x: number; y: number };
	private timer?: number;
	constructor(app: App, private options: Options) { super(app); this.geometry = options.geometry ?? { type: "whole" }; }
	onOpen(): void {
		this.titleEl.setText(this.options.title); this.contentEl.addClass("relay-image-comment");
		this.statusEl = this.contentEl.createEl("p", { text: "Opening image…", attr: { role: "status", "aria-live": "polite" } });
		if (this.options.save) {
			const modes = this.contentEl.createDiv({ cls: "relay-image-comment-modes" });
			for (const [type, label] of [["whole", "Whole image"], ["pin", "Pin"], ["region", "Region"]] as const) {
				const button = modes.createEl("button", { text: label, attr: { type: "button", "aria-pressed": String(this.geometry.type === type) } });
				button.dataset.mode = type; button.disabled = true; this.modeButtons.push(button);
				button.onclick = () => {
					this.drag = undefined; this.geometry = type === "whole" ? { type } : type === "pin" ? { type, x: 0.5, y: 0.5 } : { type, x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
					this.draw(); this.inputs();
				};
			}
			this.contentEl.createEl("p", { text: "Choose the whole image, place a pin, or drag a region. You can also adjust coordinates below. This preview freezes animation for placement." });
		}
		const stage = this.contentEl.createDiv({ cls: "relay-image-comment-stage" });
		this.canvas = stage.createEl("canvas", { attr: { role: "img", "aria-label": "Image annotation preview" } });
		this.canvas.classList.add("is-unavailable");
		this.overlay = stage.createDiv({ cls: "relay-image-comment-overlay", attr: { "aria-hidden": "true" } });
		this.fields = this.contentEl.createDiv({ cls: "relay-image-comment-fields" });
		stage.onpointerdown = event => {
			if (!this.options.save || !this.basis || !this.preview?.valid() || this.geometry.type === "whole" || event.button !== 0) return;
			const point = imagePoint(this.canvas!.getBoundingClientRect(), event.clientX, event.clientY); if (!point) return;
			event.preventDefault(); stage.setPointerCapture(event.pointerId); this.drag = { id: event.pointerId, ...point };
			if (this.geometry.type === "pin") this.geometry = { type: "pin", ...point }; this.draw();
		};
		const move = (event: PointerEvent) => {
			if (!this.drag || this.drag.id !== event.pointerId || !this.preview?.valid()) return;
			const point = imagePoint(this.canvas!.getBoundingClientRect(), event.clientX, event.clientY, true); if (!point) return;
			this.geometry = this.geometry.type === "pin" ? { type: "pin", ...point } : imageRegion(this.drag, point) ?? this.geometry; this.draw();
		};
		stage.onpointermove = move;
		stage.onpointerup = event => { move(event); if (this.drag?.id === event.pointerId) { this.drag = undefined; stage.releasePointerCapture(event.pointerId); this.inputs(); } };
		stage.onpointercancel = () => { this.drag = undefined; this.inputs(); };
		if (this.options.save) {
			this.saveButton = this.contentEl.createEl("button", { text: "Add comment", cls: "mod-cta", attr: { type: "button" } });
			this.saveButton.disabled = true;
			this.saveButton.onclick = () => { void this.save(); };
		}
		this.contentEl.createEl("button", { text: "Close", attr: { type: "button" } }).onclick = () => this.close();
		void this.load();
	}
	private async load(): Promise<void> {
		try {
			const preview = await this.options.load();
			if (this.closed || !this.options.current()) { preview.release(); return; }
			this.preview = preview;
			const image = this.image = this.contentEl.ownerDocument.createElement("img"); image.referrerPolicy = "no-referrer";
			image.onload = () => {
				if (this.closed || !preview.valid() || !this.canvas) return;
				this.clearDeadline();
				if (!image.naturalWidth || !image.naturalHeight || Math.max(image.naturalWidth, image.naturalHeight) > 100000) { this.failed("This image cannot be previewed."); return; }
				const basis: ImageBasis = { width: image.naturalWidth, height: image.naturalHeight, orientation: "display" };
				const scale = Math.min(1, 2048 / Math.max(basis.width, basis.height));
				this.canvas.width = Math.max(1, Math.round(basis.width * scale)); this.canvas.height = Math.max(1, Math.round(basis.height * scale));
				try {
					const ctx = this.canvas.getContext("2d"); if (!ctx) throw new Error();
					ctx.drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
				} catch { this.failed("This image cannot be previewed."); return; }
				this.basis = basis; this.canvas.classList.remove("is-unavailable");
				const resized = this.options.basis && (this.options.basis.width !== basis.width || this.options.basis.height !== basis.height);
				if (this.options.save && resized) { this.failed("The image dimensions changed. Close and select the image again before placing a comment."); return; }
				if (this.options.changed || resized) {
					this.statusEl!.setText("Image changed. The original annotation is retained with the discussion; its coordinates are not placed on this replacement.");
					this.overlay!.classList.add("is-unavailable");
				} else this.statusEl!.setText(preview.asset.kind === "external" ? "External image · version unknown. Changes to its contents may not be detectable." : "Shared image version verified.");
				this.draw(); this.inputs(); this.validate();
			};
			image.onerror = () => this.failed("The image is unavailable or offline. Its discussion and original target are retained.");
			this.timer = window.setTimeout(() => this.failed("The image did not finish loading. Close and try again when it is available."), 15000);
			image.src = preview.url;
		} catch { this.failed("The image is unavailable, changed, or still synchronizing. Its discussion is retained."); }
	}
	validate(): void {
		if (this.closed) return;
		const current = this.options.current() && (!this.preview || this.preview.valid());
		if (!current) { this.failed("This image or its shared context changed. Close and open it again."); return; }
		const enabled = !!this.basis && !this.saving;
		for (const button of this.modeButtons) button.disabled = !enabled;
		if (this.saveButton) this.saveButton.disabled = !enabled;
	}
	private draw(): void {
		if (!this.overlay) return;
		this.overlay.empty(); const geometry = this.geometry;
		for (const button of this.modeButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === geometry.type));
		if (this.canvas?.parentElement) this.canvas.parentElement.style.touchAction = this.options.save && geometry.type !== "whole" ? "none" : "auto";
		if (geometry.type === "whole") return;
		const mark = this.overlay.createDiv({ cls: ["relay-image-comment-mark", geometry.type] });
		mark.style.left = `${geometry.x * 100}%`; mark.style.top = `${geometry.y * 100}%`;
		if (geometry.type === "region") { mark.style.width = `${geometry.width * 100}%`; mark.style.height = `${geometry.height * 100}%`; }
	}
	private inputs(): void {
		if (!this.fields || !this.options.save) return;
		this.fields.empty(); const geometry = this.geometry; if (geometry.type === "whole") return;
		for (const key of geometry.type === "pin" ? ["x", "y"] as const : ["x", "y", "width", "height"] as const) {
			const row = this.fields.createEl("label", { text: key.toUpperCase() + " (%) " });
			const input = row.createEl("input", { attr: { type: "number", min: "0", max: "100", step: "any" } });
			input.value = String(Number((Number((geometry as unknown as Record<string, number>)[key]) * 100).toFixed(3)));
			input.onchange = () => {
				const value = input.valueAsNumber / 100, next = { ...this.geometry, [key]: value };
				const valid = Number.isFinite(value) && value >= 0 && value <= 1 && (next.type !== "region" || next.width > 0 && next.height > 0 && next.x + next.width <= 1 && next.y + next.height <= 1);
				input.setCustomValidity(valid ? "" : "Keep the annotation inside the image.");
				if (valid) { this.geometry = next; this.draw(); }
			};
		}
	}
	private async save(): Promise<void> {
		if (this.saving || !this.options.save || !this.preview?.valid() || !this.options.current() || !this.basis || this.fields?.querySelector("input:invalid")) return;
		this.saving = true; this.validate();
		try { await this.options.save(this.preview, this.basis, this.geometry); if (!this.closed) this.close(); }
		catch { if (!this.closed) this.statusEl?.setText("The image target could not be saved. Check access and synchronization, then try again."); }
		finally { this.saving = false; this.validate(); }
	}
	private clearDeadline(): void { if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined; }
	private failed(message: string): void {
		if (this.closed) return;
		this.clearDeadline(); this.basis = undefined; this.drag = undefined;
		if (this.image) { this.image.onload = this.image.onerror = null; this.image.removeAttribute("src"); this.image = undefined; }
		if (this.canvas) { this.canvas.width = this.canvas.height = 0; this.canvas.classList.add("is-unavailable"); }
		this.preview?.release(); this.preview = undefined; this.overlay?.empty(); this.statusEl?.setText(message);
		for (const button of this.modeButtons) button.disabled = true;
		if (this.saveButton) this.saveButton.disabled = true;
	}
	onClose(): void {
		this.failed(""); this.closed = true; this.contentEl.empty(); this.options.closed?.();
	}
}
