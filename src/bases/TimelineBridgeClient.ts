import { TFile, type EventRef, type Workspace } from "obsidian";
import { nativeBaseProperty, type NativeBaseHandle, type NativeBaseGroupLocation, type NativeBaseReveal, type NativeBaseTarget, type NativeBasesExtension, type NativeBasesIntegrations } from "./NativeBasesSurface";
import { timelineRangeBridge, type RemoteTimelineRanges } from "./TimelineRangeBridge";
import { timelineLocalMarkers, type RemoteLocalMarkers } from "./TimelineLocalMarkerBridge";

declare module "obsidian" {
	interface Workspace {
		on(name: "time-and-line:collaboration-ready", callback: (bridge: unknown) => void, ctx?: unknown): EventRef;
	}
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const node = (value: unknown): value is HTMLElement => object(value) && value.nodeType === 1 && typeof value.contains === "function" && typeof value.getBoundingClientRect === "function";
const methods = (value: ObjectValue, names: string[]) => names.every(name => typeof value[name] === "function");
const TYPES = ["sabidurian-timeline", "sabidurian-sequence"];
interface RemoteBridge {
	protocolVersion: number; available: boolean; viewTypes: string[];
	getSurfaces(): unknown; onChange(callback: () => void): unknown; canNavigate(document: Document): unknown;
}
interface RemoteSurface extends RemoteTimelineRanges, RemoteLocalMarkers {
	protocolVersion: number; owner: ObjectValue; root: HTMLElement; capabilities: string[];
	current(): unknown; viewport(): unknown; handles(): unknown; hit(node: Node, point?: { clientX: number; clientY: number }): unknown;
	reveal(target: unknown): unknown; beginAnnotation(select: (handle: unknown) => void, stopped: () => void): unknown;
	groups?(): unknown; revealGroup?(group: unknown): unknown;
}
interface Adapter extends NativeBasesExtension { source: RemoteSurface }

/** Optional local plugin boundary. Registry/source/managed-identity verification
 * remains in NativeBasesSurface and DiscussionHost; discovery grants no access. */
export class TimelineBridgeClient implements NativeBasesIntegrations {
	private bridge?: RemoteBridge;
	private stop?: () => void;
	private event?: EventRef;
	private closed = false;
	private adapters = new Map<unknown, Adapter>();
	private annotations = new Map<unknown, () => void>();
	constructor(private workspace: Workspace, private changed: (binding: boolean) => void) {}
	start(): void {
		if (this.closed || this.event) return;
		this.event = this.workspace.on("time-and-line:collaboration-ready", value => this.receive(value));
		this.workspace.trigger("time-and-line:collaboration-request", (value: unknown) => this.receive(value));
	}
	private active(): boolean { try { return !this.closed && this.bridge?.available === true; } catch { return false; } }
	supports(type: string): boolean { return this.active() && TYPES.includes(type) && this.bridge!.viewTypes.includes(type); }
	canNavigate(document: Document): boolean {
		if (!this.active()) return true;
		try { return this.bridge!.canNavigate(document) === true; } catch { return false; }
	}
	find(owner: unknown): NativeBasesExtension | undefined { const adapter = this.adapters.get(owner); return adapter?.current() ? adapter : undefined; }
	private receive(value: unknown): void {
		try {
			if (this.closed || !object(value) || value.protocolVersion !== 1 || value.available !== true || !Array.isArray(value.viewTypes) ||
				value.viewTypes.length > 8 || !value.viewTypes.every(type => typeof type === "string") || !methods(value, ["getSurfaces", "onChange", "canNavigate"])) return;
			if (value === (this.bridge as unknown)) { this.refresh(false); return; }
			this.stop?.(); this.stopAnnotations(); this.adapters.clear(); this.bridge = value as unknown as RemoteBridge;
			const bridge = this.bridge, stop = bridge.onChange(() => { if (this.bridge === bridge) this.refresh(false); });
			if (typeof stop !== "function") { this.bridge = undefined; this.changed(true); return; }
			this.stop = stop as () => void; this.refresh(true);
		} catch { this.stopAnnotations(); this.adapters.clear(); this.bridge = undefined; this.changed(true); }
	}
	private refresh(binding: boolean): void {
		if (this.closed) return;
		try {
			if (!this.active()) { this.stop?.(); this.stop = undefined; this.bridge = undefined; this.stopAnnotations(); this.adapters.clear(); this.changed(true); return; }
			const values = this.bridge!.getSurfaces();
			if (!Array.isArray(values) || values.length > 256) throw new Error("Unsupported timeline surfaces");
			const next = new Map<unknown, Adapter>(), duplicate = new Set<unknown>();
			for (const value of values) {
				const capabilities = object(value) ? value.capabilities : undefined;
				if (!object(value) || value.protocolVersion !== 1 || !object(value.owner) || !this.supports(String(value.owner.type)) || !node(value.root) ||
					!Array.isArray(capabilities) || capabilities.length > 32 || !["item", "cell", "geometry", "reveal", "annotation"].every(capability => capabilities.includes(capability)) ||
					!methods(value, ["current", "viewport", "handles", "hit", "reveal", "beginAnnotation"])) continue;
				if (next.has(value.owner)) { duplicate.add(value.owner); continue; }
				const prior = this.adapters.get(value.owner);
				next.set(value.owner, prior?.source === (value as unknown) ? prior! : this.adapter(value as unknown as RemoteSurface));
			}
			for (const owner of duplicate) next.delete(owner);
			for (const [owner, stop] of this.annotations) if (next.get(owner) !== this.adapters.get(owner)) stop();
			this.adapters = next; this.changed(binding);
		} catch { this.stopAnnotations(); this.adapters.clear(); this.changed(true); }
	}
	private adapter(source: RemoteSurface): Adapter {
		const owner = source.owner, root = source.root;
		const current = () => {
			try { return this.active() && this.adapters.get(owner)?.source === source && source.owner === owner && source.root === root && source.current() === true && root.isConnected; }
			catch { return false; }
		};
		const handle = (value: unknown): NativeBaseHandle | undefined => {
			if (!current() || !object(value) || !object(value.target) || !node(value.element) || !root.contains(value.element) || typeof value.current !== "function") return;
			const captured = value.target, file = captured.file, element = value.element, kind = captured.type, propertyId = captured.property;
			if (!(file instanceof TFile) || !["item", "cell"].includes(String(kind))) return;
			const property = kind === "cell" ? nativeBaseProperty(propertyId) : undefined; if (kind === "cell" && !property) return;
			const target: NativeBaseTarget = property ? { type: "cell", file, property } : { type: "item", file };
			return { element, target, current: () => {
				try { return current() && value.target === captured && captured.file === file && captured.type === kind && captured.property === propertyId &&
					value.element === element && element.isConnected && root.contains(element) && (value.current as () => unknown).call(value) === true; }
				catch { return false; }
			} };
		};
		const group = (value: unknown): NativeBaseGroupLocation | undefined => {
			if (!current() || !source.capabilities.includes("groups") || typeof source.revealGroup !== "function" ||
				!object(value) || !object(value.target) || value.target.type !== "group" || !object(value.target.group) ||
				!Array.isArray(value.target.group.entries) || value.target.group.entries.length > 20_000 || !node(value.element) ||
				!root.contains(value.element) || typeof value.current !== "function") return;
			const captured = value.target, identity = captured.group, element = value.element;
			const live = () => {
				try { return current() && source.capabilities.includes("groups") && typeof source.groups === "function" && typeof source.revealGroup === "function" &&
					value.target === captured && captured.type === "group" && captured.group === identity && value.element === element &&
					element.isConnected && root.contains(element) && (value.current as () => unknown).call(value) === true; }
				catch { return false; }
			};
			return { group: identity, element, current: live, reveal: () => {
				try {
					if (!live()) return "unavailable";
					if (!this.canNavigate(root.ownerDocument)) return "busy";
					const result = source.revealGroup!(identity);
					return ["revealed", "hidden", "unavailable", "busy", "ambiguous"].includes(String(result)) ? result as NativeBaseReveal : "unavailable";
				} catch { return "unavailable"; }
			} };
		};
		return { source, owner, root, current,
			localMarkers: () => timelineLocalMarkers(source, current),
			...timelineRangeBridge(source, String(owner.type), current, () => this.canNavigate(root.ownerDocument), {
				cancel: () => this.annotations.get(owner)?.(),
				register: stop => { this.annotations.set(owner, stop); },
				retire: stop => { if (this.annotations.get(owner) === stop) this.annotations.delete(owner); },
			}),
			groups: () => {
				try { const values = current() && source.capabilities.includes("groups") && source.groups?.();
					return Array.isArray(values) && values.length <= 256 ? values.map(group).filter((value): value is NativeBaseGroupLocation => !!value && value.current()) : []; }
				catch { return []; }
			},
			viewport: () => { try { const view = current() && source.viewport(); return node(view) && view.isConnected && root.contains(view) ? view : undefined; } catch { return; } },
			handles: () => { try { const values = current() && source.handles(); return Array.isArray(values) && values.length <= 2048 ? values.map(handle).filter((value): value is NativeBaseHandle => !!value && value.current()) : []; } catch { return []; } },
			hit: (node, point) => { try { return current() ? handle(source.hit(node, point)) : undefined; } catch { return; } },
			reveal: target => {
				try {
					if (!current()) return "unavailable";
					if (!this.canNavigate(root.ownerDocument)) return "busy";
					if (target.type === "view") return "revealed";
					if (target.type === "property" || target.type === "summary") return "property-hidden";
					const value = source.reveal(target.type === "item" ? target : { type: "cell", file: target.file, property: target.property.source + "." + target.property.name });
					return ["revealed", "hidden", "property-hidden", "unavailable", "busy", "ambiguous"].includes(String(value)) ? value as NativeBaseReveal : "unavailable";
				} catch { return "unavailable"; }
			},
			beginAnnotation: (select, stopped, selectGroup) => {
				try {
					if (!current() || !this.canNavigate(root.ownerDocument)) return;
					this.annotations.get(owner)?.();
					let ended = false, cancelled = false, delivered = false, remote = () => {};
					const done = () => { if (ended) return; ended = true; if (this.annotations.get(owner) === stop) this.annotations.delete(owner); stopped(); };
					const stop = () => { if (cancelled) return; cancelled = true; try { remote(); } finally { done(); } };
					const result = source.beginAnnotation(value => {
						if (cancelled || delivered) return;
						if (object(value) && object(value.target) && value.target.type === "group") {
							const selected = group(value); if (selected?.current() && selectGroup) { delivered = true; selectGroup(selected); } return;
						}
						const selected = handle(value); if (selected?.current()) { delivered = true; select(selected); }
					}, done);
					if (typeof result !== "function") { done(); return; }
					remote = result as () => void;
					if (ended) { remote(); return; }
					this.annotations.set(owner, stop); return stop;
				} catch { return; }
			},
		};
	}
	private stopAnnotations(): void { for (const stop of [...this.annotations.values()]) { try { stop(); } catch { /* Dispose every optional consumer. */ } } this.annotations.clear(); }
	close(): void { this.closed = true; this.stopAnnotations(); this.stop?.(); this.stop = undefined; if (this.event) this.workspace.offref(this.event); this.event = undefined; this.bridge = undefined; this.adapters.clear(); }
}
