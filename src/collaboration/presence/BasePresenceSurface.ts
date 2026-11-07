import type { FileView } from "obsidian";
import type { NativeBasesSurface, NativeBasePresenceBinding } from "../../bases/NativeBasesSurface";
import { basePresenceLocation, type BasePresenceContext } from "./BasePresenceProtocol";
import type { BaseLocation } from "./LocationProtocol";

type Options = {
	current(): boolean; connected(): boolean; supported(): boolean; hash(): string | undefined;
	inspect(): NativeBasesSurface | undefined; read(): Promise<BasePresenceContext>; readSource(): Promise<string>;
	changed(): void; interacted(): void;
};
const owned = ".relay-presence-action,.relay-presence-follow,.relay-bases-comments,.relay-bases-comment-tools";

/** One foreground native Base, verified independently of discussions. Metadata
 * and source reads are reused across result repainting and saved-view changes. */
export class BasePresenceSurface {
	private surface?: NativeBasesSurface;
	private binding?: NativeBasePresenceBinding;
	private context?: Promise<BasePresenceContext>;
	private source?: Promise<string>;
	private key = "";
	private attempted?: { scope: string; source: string };
	private selection?: string;
	private refreshedFor?: string;
	private version = 0;
	private pending = false;
	private closed = false;
	private timer?: number;
	private stops: (() => void)[] = [];
	state: "waiting" | "ready" | "unavailable" = "waiting";
	constructor(readonly view: FileView, private shareId: string, private entryId: string, private options: Options) {
		const root = view.contentEl;
		const observer = new MutationObserver(records => {
			if (!records.some(record => {
				const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
				if (target?.closest(owned)) return false;
				const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
				return !nodes.length || nodes.some(node => node.nodeType !== 1 || !(node as Element).matches(owned));
			})) return;
			if (this.timer === undefined) this.timer = window.setTimeout(() => { this.timer = undefined; this.refresh(); }, 50);
		});
		observer.observe(root, { subtree: true, childList: true }); this.stops.push(() => observer.disconnect());
		const interacted = (event: Event) => {
			if (!(event.target as Element | null)?.closest?.(".relay-presence-action,.relay-presence-follow")) this.options.interacted();
		};
		for (const event of ["pointerdown", "wheel", "keydown"]) { root.addEventListener(event, interacted, { passive: true }); this.stops.push(() => root.removeEventListener(event, interacted)); }
	}
	get location(): BaseLocation | undefined {
		return !this.closed && this.options.current() && this.options.supported() && this.binding?.current() && this.binding.context.content_sha256 === this.options.hash() ?
			basePresenceLocation(this.binding.context, this.binding.viewId) : undefined;
	}
	private clear(state: BasePresenceSurface["state"]): void {
		const changed = !!this.binding || this.state !== state; this.binding = undefined; this.state = state;
		if (changed && !this.closed) this.options.changed();
	}
	private attemptKey(surface: NativeBasesSurface): string { return JSON.stringify([this.key, surface.slot, surface.name, surface.type]); }
	refresh(): void {
		if (this.closed) return;
		const file = this.view.file, hash = this.options.hash();
		if (!file || !this.options.current() || !this.options.supported() || !hash || file.stat.size > 262_144) {
			this.version++; this.key = ""; this.surface = undefined; this.attempted = undefined; this.selection = undefined; this.context = undefined; this.source = undefined;
			this.clear(this.options.connected() && (!this.options.supported() || !!file && file.stat.size > 262_144) ? "unavailable" : "waiting"); return;
		}
		const { mtime, size } = file.stat, path = file.path;
		const key = JSON.stringify([path, mtime, size, hash]);
		if (key !== this.key) { this.version++; this.key = key; this.context = undefined; this.source = undefined; this.attempted = undefined; this.selection = undefined; this.refreshedFor = undefined; this.clear("waiting"); }
		const surface = this.surface?.current() ? this.surface : this.options.inspect();
		if (surface !== this.surface) {
			if (surface?.slot !== this.surface?.slot || surface?.name !== this.surface?.name || surface?.type !== this.surface?.type) this.selection = undefined;
			this.version++; this.surface = surface; this.clear("waiting");
		}
		if (!surface) { this.clear("unavailable"); return; }
		if (this.location) return;
		if (this.binding) this.clear("waiting");
		const attempt = this.attemptKey(surface);
		if (this.pending || this.attempted?.scope === attempt && this.attempted.source === surface.source) return;
		const version = this.version;
		const current = () => !this.closed && this.version === version && this.options.current() && this.options.supported() && this.view.file === file && file.path === path && file.stat.mtime === mtime && file.stat.size === size && this.options.hash() === hash && this.surface === surface;
		this.pending = true;
		void Promise.resolve().then(async () => {
			if (!current()) return;
			this.context ??= Promise.resolve().then(() => this.options.read());
			this.source ??= Promise.resolve().then(() => this.options.readSource());
			const [context, source] = await Promise.all([this.context, this.source]);
			if (!current()) return;
			if (context.content_sha256 !== hash) throw new Error("Base version changed");
			const binding = await surface.bindPresence(context, this.shareId, this.entryId, async () => source, current);
			if (!current()) return;
			if (!binding?.current()) throw new Error("Base view unavailable");
			this.binding = binding; this.attempted = undefined; this.state = "ready"; this.options.changed();
		}).catch(() => { if (current()) { this.attempted = { scope: attempt, source: surface.source }; this.clear("unavailable"); } }).finally(() => {
			this.pending = false;
			if (!this.closed && this.version !== version) this.refresh();
		});
	}
	deny(): void {
		this.version++; this.attempted = this.surface ? { scope: this.attemptKey(this.surface), source: this.surface.source } : undefined;
		this.context = undefined; this.source = undefined; this.selection = undefined; this.clear("unavailable");
	}
	retry(): void { this.version++; this.attempted = undefined; this.context = undefined; this.source = undefined; this.selection = undefined; this.refreshedFor = undefined; this.clear("waiting"); this.refresh(); }
	cancelNavigation(): void { this.selection = undefined; }
	/** Select only a verified saved view. Never reopen the file or save settings. */
	activate(location: BaseLocation, current: () => boolean): "ready" | "waiting" | "unavailable" {
		if (!current() || this.closed) return "unavailable";
		const binding = this.binding, here = this.location;
		if (!here || !binding || !this.surface) return this.state === "unavailable" ? "unavailable" : "waiting";
		if (!this.surface.canNavigate()) return "unavailable";
		if (here.share_id !== location.share_id || here.entry_id !== location.entry_id) return "unavailable";
		if (here.generation !== location.generation || here.definition_id !== location.definition_id || here.registry_revision !== location.registry_revision) {
			const desired = JSON.stringify([location.generation, location.definition_id, location.registry_revision]);
			if (desired === this.refreshedFor) return "unavailable";
			this.refreshedFor = desired; this.version++; this.context = undefined; this.attempted = undefined; this.selection = undefined;
			this.clear("waiting"); this.refresh(); return "waiting";
		}
		if (here.view_id === location.view_id) return "ready";
		if (this.selection === location.view_id) return "waiting";
		if (!this.surface.activatePresenceView(location.view_id, binding)) return "unavailable";
		this.selection = location.view_id; this.refresh(); return "waiting";
	}
	reveal(current: () => boolean): boolean {
		if (!current() || !this.location || !this.surface?.canNavigate()) return false;
		const viewport = this.surface?.viewport(); if (!viewport) return false;
		viewport.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); return current() && !!this.location;
	}
	close(): void {
		if (this.closed) return; this.closed = true; this.version++;
		if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined;
		this.stops.splice(0).forEach(stop => stop()); this.surface = undefined; this.binding = undefined; this.context = undefined; this.source = undefined;
	}
}
