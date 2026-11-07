import { imagePoint } from "../anchors/imageGeometry";
import { intersectBox, renderedImageFit } from "../anchors/renderedImages";
import { presenceColorForUser } from "../../presenceColor";
import type { ImagePoint, ImagePresenceState } from "./LocationProtocol";
import type { SurfacePresencePeer } from "./PresencePeers";

type Options = { current: () => boolean; publishing: () => boolean; publish: (state: ImagePresenceState | null) => void };
const rounded = (value: number) => Math.round(value * 10000) / 10000;
const center = (state?: ImagePresenceState, follow = false): ImagePoint | undefined => {
	const viewport = state?.viewport, point = state?.pointer;
	return follow && viewport ? { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 } : point ?? (viewport ? { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 } : undefined);
};

/** Screen geometry is read at most once per capture/paint batch. This class
 * never reads image bytes, changes zoom or takes over the user's selection. */
export class ImagePresenceMotion {
	private win: Window;
	private layer: HTMLDivElement;
	private peers: readonly SurfacePresencePeer[] = [];
	private markers = new Map<string, { element: HTMLDivElement; label: HTMLSpanElement }>();
	private pointer?: { x: number; y: number };
	private captureTimer?: number;
	private frame?: number;
	private publishing?: boolean;
	private signature = "";
	private closed = false;
	private stops: (() => void)[] = [];
	constructor(private root: HTMLElement, private image: HTMLImageElement, private options: Options) {
		const doc = root.ownerDocument; this.win = doc.defaultView ?? window;
		this.layer = doc.createElement("div"); this.layer.className = "relay-image-presence"; this.layer.setAttribute("aria-hidden", "true");
		root.classList.add("relay-image-presence-root"); root.append(this.layer);
		const listen = (target: EventTarget, name: string, listener: EventListener, capture = false) => {
			target.addEventListener(name, listener, { capture, passive: true }); this.stops.push(() => target.removeEventListener(name, listener, capture));
		};
		const move = (event: Event) => {
			const pointer = event as PointerEvent;
			this.pointer = event.target === image ? { x: pointer.clientX, y: pointer.clientY } : undefined;
			this.scheduleCapture();
		};
		const leave = () => { this.pointer = undefined; this.capture(); };
		listen(root, "pointermove", move); listen(root, "pointerdown", move); listen(root, "pointerleave", leave);
		listen(root, "pointercancel", leave); listen(root, "pointerup", event => { if ((event as PointerEvent).pointerType === "touch") leave(); });
		const layout = () => { this.pointer = undefined; this.scheduleCapture(); this.paint(); };
		listen(doc, "scroll", layout, true); listen(this.win, "resize", layout);
		if (typeof ResizeObserver !== "undefined") { const observer = new ResizeObserver(layout); observer.observe(root); observer.observe(image); this.stops.push(() => observer.disconnect()); }
		const observer = new MutationObserver(layout);
		// Ancestor themes/zoom can alter mapping without replacing image bytes.
		for (let node: HTMLElement | null = image; node; node = node.parentElement) observer.observe(node, { attributes: true, attributeFilter: ["style", "class", "width", "height"] });
		this.stops.push(() => observer.disconnect()); this.refresh();
	}
	refresh(): void {
		const publishing = !this.closed && this.options.publishing();
		if (publishing !== this.publishing) { this.publishing = publishing; this.pointer = undefined; this.capture(); this.paint(); }
	}
	setPeers(peers: readonly SurfacePresencePeer[]): void {
		const signature = JSON.stringify(peers.map(peer => [peer.key, peer.name, peer.imageState]));
		if (signature === this.signature) return;
		this.signature = signature; this.peers = peers; this.paint();
	}
	private scheduleCapture(): void {
		if (!this.closed && this.captureTimer === undefined) this.captureTimer = this.win.setTimeout(() => { this.captureTimer = undefined; this.capture(); }, 125);
	}
	private capture(): void {
		if (this.closed) return;
		const fit = this.options.current() && this.options.publishing() ? renderedImageFit(this.image, this.root) : undefined;
		const visible = fit && intersectBox(fit.frame, fit.content);
		if (!fit || !visible) { this.options.publish(null); return; }
		const start = imagePoint(fit.content, visible.left, visible.top, true)!, end = imagePoint(fit.content, visible.left + visible.width, visible.top + visible.height, true)!;
		const x = rounded(start.x), y = rounded(start.y), width = Math.min(1 - x, rounded(end.x - start.x)), height = Math.min(1 - y, rounded(end.y - start.y));
		const within = this.pointer && imagePoint(visible, this.pointer.x, this.pointer.y);
		const pointer = within && this.pointer ? imagePoint(fit.content, this.pointer.x, this.pointer.y) : undefined;
		this.options.publish({ pointer: pointer ? { x: rounded(pointer.x), y: rounded(pointer.y) } : null,
			viewport: width > 0 && height > 0 ? { x, y, width, height } : null });
	}
	private paint(): void {
		if (this.closed || this.frame !== undefined) return;
		this.frame = this.win.requestAnimationFrame(() => {
			this.frame = undefined;
			const fit = this.options.current() ? renderedImageFit(this.image, this.root) : undefined, box = this.layer.getBoundingClientRect();
			const sx = box.width / this.layer.clientWidth, sy = box.height / this.layer.clientHeight;
			if (!fit || ![sx, sy].every(value => Number.isFinite(value) && value > 0)) { this.layer.hidden = true; return; }
			this.layer.hidden = false;
			const wanted = new Set<string>();
			for (const peer of this.peers.slice(0, 127)) {
				const pointer = peer.imageState?.pointer; if (!pointer) continue;
				const x = fit.content.left + pointer.x * fit.content.width, y = fit.content.top + pointer.y * fit.content.height;
				if (!imagePoint(fit.frame, x, y)) continue;
				wanted.add(peer.key); let marker = this.markers.get(peer.key);
				if (!marker) {
					const element = this.root.ownerDocument.createElement("div"), label = this.root.ownerDocument.createElement("span");
					element.className = "relay-image-presence-pointer"; element.append(label); this.layer.append(element);
					marker = { element, label }; this.markers.set(peer.key, marker);
				}
				if (marker.label.textContent !== peer.name) marker.label.textContent = peer.name;
				marker.element.style.setProperty("--presence-color", presenceColorForUser({ id: peer.userId }).color);
				marker.element.style.left = `${(x - box.left) / sx}px`; marker.element.style.top = `${(y - box.top) / sy}px`;
				// Keep names within the current image's visible frame.
				marker.label.style.transform = `translate(${x > fit.frame.left + fit.frame.width / 2 ? "calc(-100% - 8px)" : "8px"}, ${y > fit.frame.top + fit.frame.height / 2 ? "-100%" : "0"})`;
			}
			for (const [key, marker] of this.markers) if (!wanted.has(key)) { marker.element.remove(); this.markers.delete(key); }
		});
	}
	reveal(state: ImagePresenceState | undefined, follow: boolean, current: () => boolean): boolean {
		const point = center(state, follow); if (!point || !current() || !this.options.current()) return false;
		if (!renderedImageFit(this.image, this.root)) this.image.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		for (let element = this.image.parentElement; element && this.root.contains(element); element = element.parentElement) {
			if (!current() || !this.options.current()) return false;
			const fit = renderedImageFit(this.image, this.root); if (!fit) return false;
			const style = this.win.getComputedStyle(element), box = element.getBoundingClientRect();
			const sx = element.offsetWidth ? box.width / element.offsetWidth : 1, sy = element.offsetHeight ? box.height / element.offsetHeight : 1;
			if (![sx, sy].every(value => Number.isFinite(value) && value > 0)) return false;
			const left = /^(auto|scroll)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth ? (fit.content.left + point.x * fit.content.width - (box.left + box.width / 2)) / sx : 0;
			const top = /^(auto|scroll)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight ? (fit.content.top + point.y * fit.content.height - (box.top + box.height / 2)) / sy : 0;
			if (left || top) element.scrollBy({ left, top, behavior: "instant" });
		}
		const fit = renderedImageFit(this.image, this.root);
		return current() && this.options.current() && !!fit && !!imagePoint(fit.frame, fit.content.left + point.x * fit.content.width, fit.content.top + point.y * fit.content.height);
	}
	close(): void {
		this.closed = true; this.stops.splice(0).forEach(stop => stop());
		if (this.captureTimer !== undefined) this.win.clearTimeout(this.captureTimer);
		if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
		this.layer.remove(); this.root.classList.remove("relay-image-presence-root"); this.markers.clear(); this.peers = [];
		this.options.publish(null);
	}
}
