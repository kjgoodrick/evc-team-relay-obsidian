import type { MarkdownView } from "obsidian";
import type * as Y from "yjs";
import type { YSweetProvider } from "../../client/provider";
import { presenceColorForUser } from "../../presenceColor";
import type { ReadingSectionMap } from "../anchors/reading";
import { presencePeers, resolvePresenceRange } from "./PresencePeers";

export type ReadingPresenceScope = { view: MarkdownView; text: Y.Text; id: string; provider: YSweetProvider; current: () => boolean };
export type ReadingPresenceSection = { root: HTMLElement; from: number; to: number; map: () => ReadingSectionMap | undefined };
type HighlightHost = { Highlight?: new (...ranges: Range[]) => unknown; CSS?: { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } } };
type MappedPeer = { signature: string; ranges: Range[]; caret?: Range };
let nextLayer = 0;
const owned = ".relay-image-presence,.relay-reading-presence,.relay-reading-comment-controls,.relay-reading-comment-overlay,.relay-rendered-images";

/** Display-only observer of an already bound/authorized document. It never
 * publishes awareness, loads a note or changes native selection/Markdown. */
export class ReadingPresenceLayer {
	private layer: HTMLDivElement;
	private style: HTMLStyleElement;
	private win: Window;
	private cleanup: (() => void)[] = [];
	private frame?: number;
	private timer?: number;
	private closed = false;
	private names = new Set<string>();
	private mapped = new Map<string, MappedPeer>();
	private prefix = `relay-reading-presence-${++nextLayer}-`;
	private addedClass: boolean;
	constructor(private scope: ReadingPresenceScope, private sections: () => ReadingPresenceSection[], private sourceChanged: () => void) {
		const root = scope.view.contentEl, doc = root.ownerDocument; this.win = doc.defaultView ?? window;
		this.addedClass = !root.classList.contains("relay-reading-presence-root"); root.classList.add("relay-reading-presence-root");
		this.layer = doc.createElement("div"); this.layer.className = "relay-reading-presence"; this.layer.setAttribute("aria-hidden", "true"); root.append(this.layer);
		this.style = doc.createElement("style"); doc.head.append(this.style);
		const listen = (target: EventTarget, name: string, callback: EventListener, capture = false) => {
			target.addEventListener(name, callback, capture); this.cleanup.push(() => target.removeEventListener(name, callback, capture));
		};
		listen(doc, "scroll", () => this.schedule(), true); listen(this.win, "resize", () => this.schedule());
		listen(doc, "visibilitychange", () => this.validate());
		listen(this.win, "blur", () => this.clear()); listen(this.win, "pagehide", () => this.clear());
		const changed = (event: { added: number[]; updated: number[]; removed: number[] }) => {
			if (!event.added.concat(event.updated, event.removed).some(id => id !== scope.provider.awareness.clientID)) return;
			if (event.removed.length) { this.clear(); this.schedule(); }
			else if (this.timer === undefined) this.timer = this.win.setTimeout(() => { this.timer = undefined; this.schedule(); }, 100);
		};
		scope.provider.awareness.on("change", changed); this.cleanup.push(() => scope.provider.awareness.off("change", changed));
		const connection = () => this.validate();
		for (const name of ["status", "sync", "presence-status"] as const) {
			scope.provider.on(name, connection); this.cleanup.push(() => scope.provider.off(name, connection));
		}
		const textChanged = () => { this.sourceChanged(); this.invalidate(); };
		scope.text.observe(textChanged); this.cleanup.push(() => scope.text.unobserve(textChanged));
		const observer = new MutationObserver(records => {
			if (records.some(record => !(record.target.nodeType === 1 ? record.target as Element : record.target.parentElement)?.closest(owned) &&
				!(record.type === "childList" && [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].every(node => node.nodeType === 1 && (node as Element).matches(owned))))) this.invalidate();
		});
		observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden"] }); this.cleanup.push(() => observer.disconnect());
		if (typeof ResizeObserver !== "undefined") { const observer = new ResizeObserver(() => this.schedule()); observer.observe(root); this.cleanup.push(() => observer.disconnect()); }
		this.schedule();
	}
	matches(scope: ReadingPresenceScope): boolean { return this.scope.view === scope.view && this.scope.text === scope.text && this.scope.id === scope.id && this.scope.provider === scope.provider; }
	get text(): Y.Text { return this.scope.text; }
	update(scope: ReadingPresenceScope): void { this.scope = scope; this.validate(); }
	private valid(): boolean {
		const root = this.scope.view.contentEl;
		return !this.closed && !root.ownerDocument.hidden && root.isConnected && !!root.getClientRects().length && this.scope.current();
	}
	validate(): void { if (!this.valid()) this.clear(); else this.schedule(); }
	invalidate(): void { this.mapped.clear(); this.clear(); this.schedule(); }
	private clearHighlights(): void {
		const host = this.win as unknown as HighlightHost;
		for (const name of this.names) host.CSS?.highlights?.delete(name); this.names.clear(); this.style.replaceChildren();
	}
	private clear(): void { this.clearHighlights(); this.layer.replaceChildren(); }
	schedule(): void {
		if (this.closed || this.frame !== undefined) return;
		this.frame = this.win.requestAnimationFrame(() => { this.frame = undefined; this.draw(); });
	}
	private draw(): void {
		if (!this.valid()) { this.clear(); return; }
		const root = this.scope.view.contentEl, box = this.layer.getBoundingClientRect(), sx = box.width / this.layer.clientWidth, sy = box.height / this.layer.clientHeight;
		if (![box.width, box.height, sx, sy].every(value => Number.isFinite(value) && value > 0)) { this.clear(); return; }
		const host = this.win as unknown as HighlightHost, highlights = !!host.Highlight && !!host.CSS?.highlights;
		const visible = this.sections().filter(section => {
			const rect = section.root.getBoundingClientRect(); return rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
		});
		const maps = new Map<ReadingPresenceSection, ReadingSectionMap | undefined>();
		const mapFor = (section: ReadingPresenceSection) => { if (!maps.has(section)) maps.set(section, section.map()); return maps.get(section); };
		const leaves = new Map<Element, boolean>(), viewportKeys = new Map<ReadingSectionMap, string>();
		const include = (element: Element) => {
			if (!leaves.has(element)) { const rect = element.getBoundingClientRect(); leaves.set(element, rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom); }
			return leaves.get(element)!;
		};
		const viewportKey = (section: ReadingPresenceSection) => {
			const map = mapFor(section); if (!map) return "";
			if (!viewportKeys.has(map)) viewportKeys.set(map, map.visibleContent(include)); return viewportKeys.get(map);
		};
		const peers = presencePeers(this.scope.provider.awareness), live = new Set<string>(), names = new Set<string>(), rules: string[] = [], fragment = root.ownerDocument.createDocumentFragment();
		const quota = Math.min(64, Math.max(1, Math.floor(512 / Math.max(1, peers.length))));
		let rectangles = 0, measured = 0;
		const clipped = (rect: DOMRect) => {
			if (![rect.left, rect.top, rect.right, rect.bottom, rect.height].every(Number.isFinite) || rect.height <= 0 || rect.bottom <= box.top || rect.top >= box.bottom || rect.right < box.left || rect.left > box.right) return;
			const left = Math.max(box.left, rect.left), top = Math.max(box.top, rect.top);
			return { left: (left - box.left) / sx, top: (top - box.top) / sy, width: Math.max(2, (Math.min(box.right, rect.right) - left) / sx), height: (Math.min(box.bottom, rect.bottom) - top) / sy };
		};
		const geometry = (element: HTMLElement, rect: { left: number; top: number; width: number; height: number }) => {
			element.style.left = `${rect.left}px`; element.style.top = `${rect.top}px`; element.style.width = `${rect.width}px`; element.style.height = `${rect.height}px`;
		};
		for (const peer of peers) {
			const selection = peer.surface === "reading" ? peer.selection : peer.cursor, position = selection && resolvePresenceRange(selection, this.scope.text);
			if (!position || peer.surface === "reading" && position.anchor === position.head) continue;
			const from = Math.min(position.anchor, position.head), to = Math.max(position.anchor, position.head);
			const candidates = visible.filter(section => from === to ? from >= section.from && from <= section.to : from < section.to && to > section.from);
			if (!candidates.length) continue; live.add(peer.key);
			const signature = JSON.stringify([position, selection!.head.assoc, quota, candidates.map(section => [section.from, section.to, viewportKey(section)])]);
			let mapped = this.mapped.get(peer.key);
			if (!mapped || mapped.signature !== signature || candidates.some(section => !mapFor(section)?.isCurrent())) {
				const ranges: Range[] = []; let caret: Range | undefined;
				for (const section of candidates) {
					const map = mapFor(section); if (!map) continue;
					if (from !== to && ranges.length < quota) ranges.push(...map.domRanges(from, to, { include, limit: quota - ranges.length, exact: true }));
					if (position.head >= section.from && position.head <= section.to) caret ??= map.domCaret(position.head, selection!.head.assoc);
				}
				mapped = { signature, ranges, caret }; this.mapped.set(peer.key, mapped);
			}
			const color = presenceColorForUser({ id: peer.userId }), name = this.prefix + peer.clientId;
			if (highlights && mapped.ranges.length) {
				host.CSS!.highlights!.set(name, new host.Highlight!(...mapped.ranges)); names.add(name);
				rules.push(`::highlight(${name}) { background-color: ${color.light}; }`);
			}
			let label: ReturnType<typeof clipped>, caret = false;
			if (mapped.caret) for (const rect of Array.from(mapped.caret.getClientRects())) { label = clipped(rect); if (label) { caret = true; break; } }
			if (!highlights || !label) for (const range of mapped.ranges) {
				if (measured >= 4096) break;
				for (const rect of Array.from(range.getClientRects())) {
					if (++measured > 4096) break;
					const visible = clipped(rect); if (!visible) continue; label ??= visible;
					if (!highlights && rectangles < 256) {
						const mark = root.ownerDocument.createElement("div"); mark.className = "relay-reading-presence-selection"; mark.style.backgroundColor = color.light; geometry(mark, visible); fragment.append(mark); rectangles++;
					}
					if (highlights) break;
				}
				if (highlights && label) break;
			}
			if (!label) continue;
			if (caret && peer.surface === "editor") {
				const mark = root.ownerDocument.createElement("div"); mark.className = "relay-reading-presence-caret"; mark.style.backgroundColor = color.color; geometry(mark, { ...label, width: 2 }); fragment.append(mark);
			}
			const flag = root.ownerDocument.createElement("div"); flag.className = "relay-reading-presence-name"; flag.textContent = peer.name; flag.dataset.peer = peer.key;
			flag.style.setProperty("--relay-presence-color", color.color);
			flag.style.left = `${Math.min(label.left, Math.max(0, box.width / sx - 160))}px`; flag.style.top = `${Math.max(0, label.top - 20)}px`; fragment.append(flag);
		}
		for (const name of this.names) if (!names.has(name)) host.CSS?.highlights?.delete(name); this.names = names; this.style.textContent = rules.join("\n");
		for (const key of this.mapped.keys()) if (!live.has(key)) this.mapped.delete(key);
		this.layer.replaceChildren(fragment);
	}
	close(): void {
		if (this.closed) return; this.closed = true; this.cleanup.forEach(stop => stop()); this.cleanup = [];
		if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
		if (this.timer !== undefined) this.win.clearTimeout(this.timer);
		this.clear(); this.mapped.clear(); this.layer.remove(); this.style.remove();
		if (this.addedClass) this.scope.view.contentEl.classList.remove("relay-reading-presence-root");
	}
}
