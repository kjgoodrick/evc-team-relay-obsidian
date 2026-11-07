import { imagePoint, type ImageBox } from "../anchors/imageGeometry";
import { intersectBox } from "../anchors/renderedImages";
import type { ImagePoint } from "./LocationProtocol";

/** Screen-space rectangles are valid for native table/card/list cells and the
 * axis-aligned SVG handles supplied by the timeline bridge. Reject unsupported
 * transforms rather than projecting onto an unrelated bounding rectangle. */
export function baseTargetGeometry(element: Element, root: HTMLElement): { box: ImageBox; clip: ImageBox } | undefined {
	const win = root.ownerDocument.defaultView;
	if (!win || !element.isConnected || !root.contains(element)) return;
	const box = element.getBoundingClientRect();
	if (![box.left, box.top, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return;
	let clip = intersectBox(box, root.getBoundingClientRect());
	clip = clip && intersectBox(clip, { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight });
	for (let node: Element | null = element; node && clip; node = node.parentElement) {
		const style = win.getComputedStyle(node);
		if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.perspective && style.perspective !== "none" || style.rotate && style.rotate !== "none" && style.rotate !== "0deg") return;
		if (style.scale && style.scale !== "none" && style.scale.split(/\s+/).some(value => !Number.isFinite(parseFloat(value)) || parseFloat(value) <= 0)) return;
		if (style.transform && style.transform !== "none") {
			const values = /^matrix\(([^)]+)\)$/.exec(style.transform)?.[1].split(",").map(Number);
			if (!values || values.length !== 6 || !values.every(Number.isFinite) || values[1] !== 0 || values[2] !== 0 || values[0] <= 0 || values[3] <= 0) return;
		}
		if (node !== element && [style.overflowX, style.overflowY].some(value => /^(hidden|clip|scroll|auto)$/.test(value))) {
			const bounds = node.getBoundingClientRect();
			clip = intersectBox(clip, { left: /^(visible|)$/.test(style.overflowX) ? clip.left : bounds.left, top: /^(visible|)$/.test(style.overflowY) ? clip.top : bounds.top,
				width: /^(visible|)$/.test(style.overflowX) ? clip.width : bounds.width, height: /^(visible|)$/.test(style.overflowY) ? clip.height : bounds.height });
		}
	}
	return clip ? { box, clip } : undefined;
}
export function baseScreenPoint(box: ImageBox, point: ImagePoint): ImagePoint { return { x: box.left + box.width * point.x, y: box.top + box.height * point.y }; }
export function revealBasePoint(element: Element, root: HTMLElement, point: ImagePoint, current: () => boolean): boolean {
	const win = root.ownerDocument.defaultView; if (!win || !current()) return false;
	for (let node = element.parentElement; node && root.contains(node); node = node.parentElement) {
		if (!current()) return false;
		const rect = element.getBoundingClientRect(), bounds = node.getBoundingClientRect(), style = win.getComputedStyle(node), screen = baseScreenPoint(rect, point);
		const sx = node.offsetWidth ? bounds.width / node.offsetWidth : 1, sy = node.offsetHeight ? bounds.height / node.offsetHeight : 1;
		if (![sx, sy].every(value => Number.isFinite(value) && value > 0)) return false;
		const left = /^(auto|scroll)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth ? (screen.x - bounds.left - bounds.width / 2) / sx : 0;
		const top = /^(auto|scroll)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight ? (screen.y - bounds.top - bounds.height / 2) / sy : 0;
		if (left || top) node.scrollBy({ left, top, behavior: "instant" });
	}
	const geometry = current() && baseTargetGeometry(element, root); if (!geometry) return false;
	const screen = baseScreenPoint(geometry.box, point); return !!imagePoint(geometry.clip, screen.x, screen.y);
}
