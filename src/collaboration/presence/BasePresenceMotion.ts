import type { TFile } from "obsidian";
import type { NativeBaseHandle, NativeBaseTarget, NativeBasesSurface } from "../../bases/NativeBasesSurface";
import { presenceColorForUser } from "../../presenceColor";
import { imagePoint } from "../anchors/imageGeometry";
import { intersectBox } from "../anchors/renderedImages";
import { baseScreenPoint, baseTargetGeometry, revealBasePoint } from "./BasePresenceGeometry";
import { BasePresenceRecords, type BaseLocalRecord } from "./BasePresenceRecords";
import { parseBaseState, type BasePosition, type BasePresenceState, type BasePresenceTarget, type BaseRecordContext } from "./BasePositionProtocol";
import type { BaseLocation } from "./LocationProtocol";
import type { SurfacePresencePeer } from "./PresencePeers";

export type BasePointerPeer = Pick<SurfacePresencePeer, "key" | "name" | "userId" | "baseState">;
export type BaseMotionOptions = {
	current(): boolean; publishing(): boolean; surface(): NativeBasesSurface | undefined; location(): BaseLocation | undefined;
	local(file: TFile): BaseLocalRecord | undefined; file(id: string): TFile | undefined; read(id: string): Promise<BaseRecordContext>;
	publish(state: BasePresenceState | null): void;
};
const owned = ".relay-base-presence,.relay-presence-action,.relay-presence-follow,.relay-bases-comments,.relay-bases-comment-tools";
const sameTarget = (a: NativeBaseTarget, b: NativeBaseTarget) => a.type === b.type && (!("file" in a) || "file" in b && a.file === b.file) &&
	(!("property" in a) || "property" in b && a.property.source === b.property.source && a.property.name === b.property.name);
const rounded = (value: number) => Math.round(value * 10000) / 10000;
export const baseFollowPosition = (state: BasePresenceState | undefined, follow: boolean): BasePosition | undefined =>
	(follow ? state?.viewport ?? state?.pointer : state?.pointer ?? state?.viewport) ?? undefined;

/** Foreground semantic capture and bounded overlays. Uses the verified native
 * models; visible labels and row indexes never identify a remote record. */
export class BasePresenceMotion {
	private win: Window;
	private records: BasePresenceRecords;
	private layer: HTMLDivElement;
	private markers = new Map<string, { element: HTMLDivElement; label: HTMLSpanElement }>();
	private peers: readonly BasePointerPeer[] = [];
	private pointer?: { node: Node; x: number; y: number };
	private stops: (() => void)[] = [];
	private captureTimer?: number;
	private frame?: number;
	private scope = "";
	private surface?: NativeBasesSurface;
	private publishing = false;
	private closed = false;
	private navigation = 0;
	private waits = new Set<() => void>();
	constructor(private root: HTMLElement, private options: BaseMotionOptions) {
		const doc = root.ownerDocument; this.win = doc.defaultView ?? window;
		this.records = new BasePresenceRecords({ current: () => !this.closed && options.current(), local: options.local, read: options.read,
			changed: () => { this.scheduleCapture(); this.paint(); } });
		this.layer = doc.createElement("div"); this.layer.className = "relay-base-presence"; this.layer.setAttribute("aria-hidden", "true");
		root.classList.add("relay-base-presence-root"); root.append(this.layer);
		const listen = (target: EventTarget, name: string, listener: EventListener, capture = false) => {
			target.addEventListener(name, listener, { passive: true, capture }); this.stops.push(() => target.removeEventListener(name, listener, capture));
		};
		const move = (event: Event) => {
			const pointer = event as PointerEvent, node = event.target as Node | null;
			this.pointer = node && !(node.nodeType === 1 ? node as Element : node.parentElement)?.closest(owned) ? { node, x: pointer.clientX, y: pointer.clientY } : undefined;
			if (this.pointer) this.scheduleCapture(); else this.capture();
		};
		const leave = () => { this.pointer = undefined; this.capture(); };
		listen(root, "pointermove", move); listen(root, "pointerdown", move); listen(root, "pointerleave", leave); listen(root, "pointercancel", leave);
		listen(root, "pointerup", event => { if ((event as PointerEvent).pointerType === "touch") leave(); });
		const layout = () => this.layout();
		listen(doc, "scroll", layout, true); listen(this.win, "resize", layout);
		if (typeof ResizeObserver !== "undefined") { const observer = new ResizeObserver(layout); observer.observe(root); this.stops.push(() => observer.disconnect()); }
		const observer = new MutationObserver(records => {
			if (records.some(record => !(record.target as Element).closest(owned))) this.layout();
		});
		observer.observe(root, { attributes: true, subtree: true, attributeFilter: ["style", "class", "width", "height"] }); this.stops.push(() => observer.disconnect());
		this.refresh();
	}
	private snapshot(): { surface: NativeBasesSurface; location: BaseLocation } | undefined {
		if (this.closed || !this.options.current()) return;
		const location = this.options.location(), surface = this.options.surface();
		return location && surface?.current() ? { location, surface } : undefined;
	}
	refresh(): void {
		if (this.closed) return;
		const snapshot = this.snapshot(), scope = JSON.stringify(snapshot?.location ?? null), publishing = !!snapshot && this.options.publishing();
		if (scope !== this.scope || snapshot?.surface !== this.surface || publishing !== this.publishing) {
			this.scope = scope; this.surface = snapshot?.surface; this.publishing = publishing; this.pointer = undefined; this.cancelNavigation(); this.capture(); this.paint();
		}
		if (!this.options.current()) this.records.reset();
		else this.scheduleCapture();
	}
	layout(): void { if (!this.closed) { this.pointer = undefined; this.scheduleCapture(); this.paint(); } }
	retry(): void { this.records.reset(); this.scheduleCapture(); this.paint(); }
	recordsChanged(): void { this.records.reconcile(); this.capture(); this.paint(); }
	setPeers(peers: readonly BasePointerPeer[]): void { this.peers = peers.slice(0, 127); this.paint(); }
	private scheduleCapture(): void {
		if (!this.closed && this.captureTimer === undefined) this.captureTimer = this.win.setTimeout(() => { this.captureTimer = undefined; this.capture(); }, 125);
	}
	private wireTarget(target: NativeBaseTarget): BasePresenceTarget | undefined {
		if (target.type === "view") return;
		if (target.type === "property") return { type: "property", property: target.property };
		const record = this.records.get(target.file); if (!record || target.type === "cell" && target.property.source === "note" && record.type !== "markdown") return;
		const identity = { record_id: record.entry_id, record_generation: record.generation };
		return target.type === "item" ? { type: "item", ...identity } : { type: "cell", ...identity, property: target.property };
	}
	private position(handle: NativeBaseHandle | undefined, x: number, y: number, handles: readonly NativeBaseHandle[]): BasePosition | null {
		if (!handle || handle.target.type === "view" || !handle.current() || handles.filter(item => sameTarget(item.target, handle.target)).length !== 1) return null;
		const geometry = baseTargetGeometry(handle.element, this.root);
		if (!geometry || !imagePoint(geometry.clip, x, y)) return null;
		const offset = imagePoint(geometry.box, x, y), target = offset && this.wireTarget(handle.target);
		return offset && target ? { target, offset: { x: rounded(offset.x), y: rounded(offset.y) } } : null;
	}
	private capture(): void {
		if (this.closed) return;
		try { this.captureCurrent(); } catch { this.options.publish(null); }
	}
	private captureCurrent(): void {
		const snapshot = this.snapshot();
		if (!snapshot || !this.options.publishing()) { this.options.publish(null); return; }
		const { surface } = snapshot, handles = surface.handles(); if (handles.length > 2048) { this.options.publish(null); return; }
		const pointer = this.pointer, hit = pointer && surface.hit(pointer.node, { clientX: pointer.x, clientY: pointer.y });
		const rect = surface.viewport()?.getBoundingClientRect(); let viewport: BasePosition | null = null;
		if (rect && rect.width > 0 && rect.height > 0) {
			const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
			const candidates: { handle: NativeBaseHandle; distance: number }[] = [];
			for (const handle of handles) {
				if (handle.target.type !== "item" && handle.target.type !== "cell") continue;
				const clip = intersectBox(handle.element.getBoundingClientRect(), rect); if (!clip) continue;
				const point = { x: Math.min(clip.left + clip.width, Math.max(clip.left, x)), y: Math.min(clip.top + clip.height, Math.max(clip.top, y)) };
				const distance = (x - point.x) ** 2 + (y - point.y) ** 2;
				candidates.push({ handle, distance });
			}
			candidates.sort((a, b) => a.distance - b.distance || Number(b.handle.target.type === "cell") - Number(a.handle.target.type === "cell"));
			// Read ancestor styles only for nearby candidates, not every mounted cell.
			for (const { handle } of candidates.slice(0, 16)) {
				const clip = baseTargetGeometry(handle.element, this.root)?.clip; if (!clip) continue;
				viewport = this.position(handle, Math.min(clip.left + clip.width, Math.max(clip.left, x)), Math.min(clip.top + clip.height, Math.max(clip.top, y)), handles); break;
			}
		}
		try { this.options.publish(parseBaseState({ version: 1, pointer: pointer ? this.position(hit, pointer.x, pointer.y, handles) : null, viewport })); }
		catch { this.options.publish(null); }
	}
	private nativeTarget(target: BasePresenceTarget, files: readonly TFile[]): NativeBaseTarget | undefined {
		if (target.type === "group" || target.type === "timeline_range") return;
		if (target.type === "property") return { type: "property", property: target.property };
		const matches = files.filter(file => this.options.local(file)?.id === target.record_id); if (matches.length !== 1) return;
		const file = matches[0], context = this.records.get(file, target.record_generation);
		if (!context || target.type === "cell" && target.property.source === "note" && context.type !== "markdown") return;
		return target.type === "item" ? { type: "item", file } : { type: "cell", file, property: target.property };
	}
	private paint(): void {
		if (this.closed || this.frame !== undefined) return;
		this.frame = this.win.requestAnimationFrame(() => {
			this.frame = undefined;
			try { this.paintCurrent(); } catch { this.layer.hidden = true; for (const marker of this.markers.values()) marker.element.remove(); this.markers.clear(); }
		});
	}
	private paintCurrent(): void {
		const snapshot = this.snapshot(), wanted = new Set<string>();
		const box = this.layer.getBoundingClientRect(), sx = box.width / this.layer.clientWidth, sy = box.height / this.layer.clientHeight;
		const handles = snapshot?.surface.handles() ?? [], files = [...new Set(handles.flatMap(handle => "file" in handle.target ? [handle.target.file] : []))];
		this.layer.hidden = !snapshot || handles.length > 2048 || ![sx, sy].every(value => Number.isFinite(value) && value > 0);
		if (!this.layer.hidden) for (const peer of this.peers) {
			const pointer = peer.baseState?.pointer; if (!pointer) continue;
			const target = this.nativeTarget(pointer.target, files); if (!target) continue;
			const matches = handles.filter(handle => sameTarget(handle.target, target)); if (matches.length !== 1 || !matches[0].current()) continue;
			const geometry = baseTargetGeometry(matches[0].element, this.root); if (!geometry) continue;
			const point = baseScreenPoint(geometry.box, pointer.offset); if (!imagePoint(geometry.clip, point.x, point.y)) continue;
			wanted.add(peer.key); let marker = this.markers.get(peer.key);
			if (!marker) {
				const element = this.root.ownerDocument.createElement("div"), label = this.root.ownerDocument.createElement("span"); element.className = "relay-base-presence-pointer";
				element.append(label); this.layer.append(element); marker = { element, label }; this.markers.set(peer.key, marker);
			}
			marker.label.textContent = peer.name; marker.element.style.setProperty("--presence-color", presenceColorForUser({ id: peer.userId }).color);
			marker.element.style.left = `${(point.x - box.left) / sx}px`; marker.element.style.top = `${(point.y - box.top) / sy}px`;
			marker.label.style.transform = `translate(${point.x > box.left + box.width / 2 ? "calc(-100% - 8px)" : "8px"}, ${point.y > box.top + box.height / 2 ? "-100%" : "0"})`;
		}
		for (const [key, marker] of this.markers) if (!wanted.has(key)) { marker.element.remove(); this.markers.delete(key); }
	}
	private nextFrame(): Promise<void> {
		return new Promise(resolve => {
			let frame = 0, timer = 0;
			const finish = () => { this.win.cancelAnimationFrame(frame); this.win.clearTimeout(timer); this.waits.delete(finish); resolve(); };
			this.waits.add(finish); frame = this.win.requestAnimationFrame(finish); timer = this.win.setTimeout(finish, 100);
		});
	}
	async reveal(state: BasePresenceState, follow: boolean, authorized: () => boolean): Promise<boolean> {
		const position = baseFollowPosition(state, follow), initial = this.snapshot(), version = ++this.navigation;
		let recordCurrent = () => true;
		const current = () => version === this.navigation && authorized() && recordCurrent() && !!initial && this.snapshot()?.surface === initial.surface && initial.surface.canNavigate();
		if (!position || !initial || !current()) return false;
		if (position.target.type === "group" || position.target.type === "timeline_range") return false;
		let target: NativeBaseTarget;
		if (position.target.type === "property") target = position.target;
		else {
			const file = this.options.file(position.target.record_id); if (!file) return false;
			let cancel!: () => void;
			const cancelled = new Promise<undefined>(resolve => { cancel = () => resolve(undefined); this.waits.add(cancel); });
			const record = await Promise.race([this.records.wait(file, position.target.record_generation), cancelled]); this.waits.delete(cancel);
			if (!record || !current()) return false;
			if (position.target.type === "cell" && position.target.property.source === "note" && record.type !== "markdown") return false;
			recordCurrent = () => this.records.get(file, record.generation) === record;
			target = position.target.type === "item" ? { type: "item", file } : { type: "cell", file, property: position.target.property };
		}
		const { surface } = initial;
		if (surface.handles().filter(handle => sameTarget(handle.target, target)).length > 1) return false;
		if (await surface.reveal(target, current, () => this.nextFrame()) !== "revealed" || !current()) return false;
		const matches = surface.handles().filter(handle => sameTarget(handle.target, target));
		return matches.length === 1 && matches[0].current() && revealBasePoint(matches[0].element, this.root, position.offset, () => current() && matches[0].current());
	}
	cancelNavigation(): void { this.navigation++; for (const finish of this.waits) finish(); }
	close(): void {
		if (this.closed) return; this.closed = true; this.cancelNavigation(); this.records.close();
		this.stops.splice(0).forEach(stop => stop());
		if (this.captureTimer !== undefined) this.win.clearTimeout(this.captureTimer); if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
		this.layer.remove(); this.root.classList.remove("relay-base-presence-root"); this.markers.clear(); this.peers = []; this.options.publish(null);
	}
}
