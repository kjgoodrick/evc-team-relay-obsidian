import type { FileView } from "obsidian";
import { ImageAssets, type RenderedImageEvidence } from "../ImageAssets";
import type { ImageLocation, ImagePresenceState } from "./LocationProtocol";
import type { SurfacePresencePeer } from "./PresencePeers";
import { ImagePresenceMotion } from "./ImagePresenceMotion";

type Options = {
	current: () => boolean; connected: () => boolean; supported: () => boolean;
	read: () => Promise<ImageLocation>; changed: () => void; interacted: () => void;
	motion?: { publishing: () => boolean; publish: (state: ImagePresenceState | null) => void };
};

/** A directly opened image uses its actual native resource and synchronized
 * bytes. No comment session, duplicate image decode, document or asset upload. */
export class ImagePresenceSurface {
	private image?: HTMLImageElement;
	private key = "";
	private attempted?: string;
	private proof?: ImageLocation;
	private evidence?: RenderedImageEvidence;
	private pending = false;
	private closed = false;
	private version = 0;
	private stops: (() => void)[] = [];
	private motion?: ImagePresenceMotion;
	private peers: readonly SurfacePresencePeer[] = [];
	state: "waiting" | "ready" | "unavailable" = "waiting";
	constructor(readonly view: FileView, private assets: ImageAssets, private options: Options) {
		const root = view.contentEl;
		const changed = () => this.refresh();
		for (const event of ["load", "error"]) { root.addEventListener(event, changed, true); this.stops.push(() => root.removeEventListener(event, changed, true)); }
		const observer = new MutationObserver(changed);
		observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset"] });
		this.stops.push(() => observer.disconnect());
		const interacted = (event: Event) => {
			const element = event.target as Element | null;
			if (!element?.closest?.(".relay-presence-follow,.relay-presence-action")) this.options.interacted();
		};
		for (const event of ["pointerdown", "wheel", "keydown"]) { root.addEventListener(event, interacted, { passive: true }); this.stops.push(() => root.removeEventListener(event, interacted)); }
	}
	get location(): ImageLocation | undefined { return !this.closed && this.options.current() && this.options.supported() && this.evidence?.valid() ? this.proof : undefined; }
	private selection(): { image: HTMLImageElement; key: string } | undefined {
		const file = this.view.file;
		if (!file || this.closed || !this.options.current()) return;
		try {
			const asset = this.assets.describeFile(file), resource = new URL(this.view.app.vault.getResourcePath(file)).href;
			const images = Array.from(this.view.contentEl.querySelectorAll<HTMLImageElement>("img")).filter(image => {
				try { return !image.closest(".relay-rendered-images") && new URL(image.currentSrc || image.src).href === resource; } catch { return false; }
			});
			if (images.length !== 1 || !images[0].complete || !images[0].naturalWidth || !images[0].naturalHeight) return;
			const image = images[0];
			return { image, key: JSON.stringify([file.path, asset, file.stat.mtime, file.stat.size, image.currentSrc || image.src, image.naturalWidth, image.naturalHeight]) };
		} catch { return; }
	}
	private clear(state: ImagePresenceSurface["state"]): void {
		const changed = !!this.proof || this.state !== state;
		this.proof = undefined; this.evidence = undefined; this.state = state;
		this.motion?.close(); this.motion = undefined;
		if (changed && !this.closed) this.options.changed();
	}
	refresh(): void {
		if (this.closed) return;
		const selected = this.selection();
		if (!selected || !this.options.supported()) {
			if (this.key || this.image) { this.version++; this.key = ""; this.image = undefined; this.attempted = undefined; }
			this.clear(this.options.connected() && !this.options.supported() ? "unavailable" : "waiting"); return;
		}
		if (selected.key !== this.key || selected.image !== this.image) {
			this.version++; this.key = selected.key; this.image = selected.image; this.attempted = undefined; this.clear("waiting");
		}
		if (this.location) return;
		if (this.proof) this.clear("waiting");
		if (this.pending || this.attempted === this.key) return;
		const version = this.version, image = selected.image, file = this.view.file!, key = this.key;
		this.attempted = key; this.pending = true;
		const current = () => {
			if (this.closed || this.version !== version || this.view.file !== file || !this.options.current() || !this.options.supported()) return false;
			const selected = this.selection(); return selected?.image === image && selected.key === key;
		};
		void Promise.resolve().then(async () => {
			if (!current()) return;
			const [proof, evidence] = await Promise.all([this.options.read(), this.assets.verifyRenderedFile(file, image, current)]);
			if (!current()) return;
			if (!evidence.valid() || evidence.asset.kind !== "managed" || evidence.asset.entry_id !== proof.entry_id || evidence.asset.sha256 !== proof.content_sha256) throw new Error("Image version changed");
			this.proof = proof; this.evidence = evidence; this.state = "ready";
			this.options.changed();
			if (current() && this.options.motion) { this.motion = new ImagePresenceMotion(this.view.contentEl, image, { ...this.options.motion, current: () => !!this.location }); this.motion.setPeers(this.peers); }
		}).catch(() => { if (current()) this.clear("unavailable"); }).finally(() => {
			this.pending = false;
			if (!this.closed && this.version !== version) this.refresh();
		});
	}
	deny(): void { this.version++; this.attempted = this.key; this.clear("unavailable"); }
	retry(): void { this.version++; this.attempted = undefined; this.clear("waiting"); this.refresh(); }
	setPeers(peers: readonly SurfacePresencePeer[]): void { this.peers = peers; this.motion?.setPeers(peers); }
	refreshMovement(): void { this.motion?.refresh(); }
	reveal(current: () => boolean, state?: ImagePresenceState, follow = false): boolean {
		if (!current() || !this.location || !this.image) return false;
		if (this.motion && (state?.pointer || state?.viewport)) return this.motion.reveal(state, follow, current);
		this.image.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		return current() && !!this.location;
	}
	close(): void { this.closed = true; this.version++; this.stops.splice(0).forEach(stop => stop()); this.motion?.close(); this.motion = undefined; this.peers = []; this.proof = undefined; this.evidence = undefined; this.image = undefined; }
}
