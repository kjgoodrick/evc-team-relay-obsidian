export type ImageAsset = { kind: "managed"; entry_id: string; sha256: string } | { kind: "external"; url: string; version_evidence: "unknown" };
/** Coordinates use the browser's orientation-corrected intrinsic image, never
 * the surrounding element's padding, crop or CSS pixel dimensions. */
export type ImageBasis = { width: number; height: number; orientation: "display" };
export type ImageGeometry = { type: "whole" } | { type: "pin"; x: number; y: number } |
	{ type: "region"; x: number; y: number; width: number; height: number };
export type ImageBox = { left: number; top: number; width: number; height: number };

export function imagePoint(box: ImageBox, clientX: number, clientY: number, clamp = false): { x: number; y: number } | undefined {
	if (![box.left, box.top, box.width, box.height, clientX, clientY].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return;
	const x = (clientX - box.left) / box.width, y = (clientY - box.top) / box.height;
	if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return;
	return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

export function imageRegion(a: { x: number; y: number }, b: { x: number; y: number }): ImageGeometry | undefined {
	const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), width = Math.max(a.x, b.x) - x, height = Math.max(a.y, b.y) - y;
	if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return;
	return { type: "region", x, y, width, height };
}
