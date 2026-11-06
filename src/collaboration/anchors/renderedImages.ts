import type { ImageOccurrence } from "./images";
import type { ImageBasis, ImageBox } from "./imageGeometry";

export type RenderedImageTarget = { image: HTMLImageElement; occurrence: ImageOccurrence };
const excluded = ".markdown-embed,.canvas-node,.cm-tooltip,.relay-rendered-images";
export function renderedImages(root: HTMLElement): HTMLImageElement[] {
	return [...(root.matches("img") ? [root as HTMLImageElement] : []), ...Array.from(root.querySelectorAll<HTMLImageElement>("img"))]
		.filter(image => !!image.getAttribute("src") && !image.matches(".cm-widgetBuffer") && !image.closest(excluded));
}

/** Source order is meaningful only within a verified renderer section. A count
 * mismatch or an HTML image makes the mapping ambiguous; never match by URL. */
export function readingImageTargets(root: HTMLElement, source: string, from: number, to: number, occurrences: ImageOccurrence[]): RenderedImageTarget[] {
	if (/<\/?(?:img|picture|svg)\b/i.test(source.slice(from, to))) return [];
	const expected = occurrences.filter(image => image.from >= from && image.to <= to), images = renderedImages(root);
	return expected.length === images.length ? images.map((image, index) => ({ image, occurrence: expected[index] })) : [];
}

/** CodeMirror maps rendered widgets back to source, including repeated embeds.
 * Ambiguous boundaries or a renderer that cannot map its node have no overlay. */
export function editorImageTargets(root: HTMLElement, occurrences: ImageOccurrence[], position: (node: Node) => number): RenderedImageTarget[] {
	return renderedImages(root).flatMap(image => {
		try {
			const at = position(image), matches = occurrences.filter(item => item.from <= at && at <= item.to);
			return matches.length === 1 ? [{ image, occurrence: matches[0] }] : [];
		} catch { return []; }
	});
}

export type ImageFit = { frame: ImageBox; content: ImageBox };
function offset(value: string, available: number, horizontal: boolean): number | undefined {
	if (value === "center") return available / 2;
	if (value === (horizontal ? "left" : "top")) return 0;
	if (value === (horizontal ? "right" : "bottom")) return available;
	if (/^-?(?:\d*\.)?\d+%$/.test(value)) return available * parseFloat(value) / 100;
	if (/^-?(?:\d*\.)?\d+px$/.test(value) || value === "0") return parseFloat(value);
}

/** CSS object-fit geometry in the image's content box, before clipping. */
export function fitImage(frame: ImageBox, basis: ImageBasis, fit: string, position: string, scaleX = 1, scaleY = 1): ImageFit | undefined {
	if (![frame.left, frame.top, frame.width, frame.height, basis.width, basis.height, scaleX, scaleY].every(Number.isFinite) ||
		Math.min(frame.width, frame.height, basis.width, basis.height, scaleX, scaleY) <= 0) return;
	const width = frame.width / scaleX, height = frame.height / scaleY;
	let renderedWidth = width, renderedHeight = height;
	if (fit !== "fill") {
		let scale: number;
		if (fit === "contain") scale = Math.min(width / basis.width, height / basis.height);
		else if (fit === "cover") scale = Math.max(width / basis.width, height / basis.height);
		else if (fit === "none") scale = 1;
		else if (fit === "scale-down") scale = Math.min(1, width / basis.width, height / basis.height);
		else return;
		renderedWidth = basis.width * scale; renderedHeight = basis.height * scale;
	}
	const parts = position.trim().split(/\s+/); if (parts.length !== 2) return;
	const x = offset(parts[0], width - renderedWidth, true), y = offset(parts[1], height - renderedHeight, false);
	if (x === undefined || y === undefined) return;
	return { frame, content: { left: frame.left + x * scaleX, top: frame.top + y * scaleY, width: renderedWidth * scaleX, height: renderedHeight * scaleY } };
}

export function intersectBox(a: ImageBox, b: ImageBox): ImageBox | undefined {
	const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top), right = Math.min(a.left + a.width, b.left + b.width), bottom = Math.min(a.top + a.height, b.top + b.height);
	return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : undefined;
}

/** Axis-aligned scales/zoom and normal object-fit crops are supported. Rotated,
 * reflected or perspective ancestors need a quad adapter; fail closed meanwhile. */
export function renderedImageFit(image: HTMLImageElement, root: HTMLElement): ImageFit | undefined {
	const win = image.ownerDocument.defaultView; if (!win || !image.complete || !image.naturalWidth || !image.naturalHeight) return;
	for (let node: HTMLElement | null = image; node; node = node.parentElement) {
		const style = win.getComputedStyle(node);
		if (style.perspective && style.perspective !== "none" || style.rotate && style.rotate !== "none" && style.rotate !== "0deg") return;
		if (style.scale && style.scale !== "none" && style.scale.split(/\s+/).some(value => !Number.isFinite(parseFloat(value)) || parseFloat(value) <= 0)) return;
		if (style.transform && style.transform !== "none") {
			const values = /^matrix\(([^)]+)\)$/.exec(style.transform)?.[1].split(",").map(Number);
			if (!values || values.length !== 6 || values[1] !== 0 || values[2] !== 0 || values[0] <= 0 || values[3] <= 0) return;
		}
	}
	const style = win.getComputedStyle(image), rect = image.getBoundingClientRect();
	const number = (value: string) => parseFloat(value) || 0;
	const borderX = number(style.borderLeftWidth), borderY = number(style.borderTopWidth), paddingX = number(style.paddingLeft), paddingY = number(style.paddingTop);
	const scaleX = rect.width / image.offsetWidth, scaleY = rect.height / image.offsetHeight;
	const frame = { left: rect.left + (borderX + paddingX) * scaleX, top: rect.top + (borderY + paddingY) * scaleY,
		width: (image.clientWidth - paddingX - number(style.paddingRight)) * scaleX, height: (image.clientHeight - paddingY - number(style.paddingBottom)) * scaleY };
	const fit = fitImage(frame, { width: image.naturalWidth, height: image.naturalHeight, orientation: "display" }, style.objectFit || "fill", style.objectPosition || "50% 50%", scaleX, scaleY);
	if (!fit) return;
	let clipped = intersectBox(frame, root.getBoundingClientRect());
	for (let node = image.parentElement; node && clipped; node = node.parentElement) {
		const current = win.getComputedStyle(node);
		if ([current.overflowX, current.overflowY].some(value => /^(hidden|clip|scroll|auto)$/.test(value))) {
			const box = node.getBoundingClientRect();
			clipped = intersectBox(clipped, { left: /^(visible|)$/.test(current.overflowX) ? clipped.left : box.left,
				top: /^(visible|)$/.test(current.overflowY) ? clipped.top : box.top,
				width: /^(visible|)$/.test(current.overflowX) ? clipped.width : box.width,
				height: /^(visible|)$/.test(current.overflowY) ? clipped.height : box.height });
		}
	}
	return clipped ? { frame: clipped, content: fit.content } : undefined;
}
