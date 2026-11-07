import type * as Y from "yjs";
import type { MarkdownView, TFile } from "obsidian";
import { sha256Hex } from "../../contentDigest";
import { ImageAssets, type RenderedImageEvidence } from "../ImageAssets";
import type { ImageOccurrence } from "../anchors/images";
import type { RenderedImageTarget } from "../anchors/renderedImages";
import { EmbeddedImageAnchors } from "./EmbeddedImageAnchors";
import type { EmbeddedAsset, EmbeddedImage, EmbeddedPeer } from "./EmbeddedImageProtocol";
import { ImagePresenceMotion, type ImagePointerPeer } from "./ImagePresenceMotion";
import type { ImageLocation } from "./LocationProtocol";
import type { PresencePeer } from "./PresencePeers";

type Options = {
	current: () => boolean; publishing: () => boolean;
	targets: (occurrences: ImageOccurrence[]) => RenderedImageTarget[];
	read: (entryId: string) => Promise<ImageLocation>;
	publish: (embed: EmbeddedImage | null) => void; changed: () => void;
};
type Remote = { peer: PresencePeer; embed: EmbeddedImage };
type Position = Remote & { occurrence: ImageOccurrence };
type Mounted = { key: string; occurrence: ImageOccurrence; evidence?: RenderedImageEvidence; embed?: EmbeddedImage; motion?: ImagePresenceMotion };
const participant = (peer: Pick<PresencePeer, "userId" | "sessionId" | "instanceId">) => JSON.stringify([peer.userId, peer.sessionId, peer.instanceId]);
const semantic = ({ state: _state, ...embed }: EmbeddedImage) => JSON.stringify(embed);
const sameOccurrence = (a: ImageOccurrence, b: ImageOccurrence) => a.from === b.from && a.to === b.to && a.destination === b.destination;
const owned = ".relay-image-presence,.relay-reading-presence,.relay-reading-comment-controls,.relay-reading-comment-overlay,.relay-rendered-images,.relay-presence-follow,.relay-presence-action";
const blank = { pointer: null, viewport: null };

/** Only the hovered/touched image and images with remote participants acquire
 * overlays. Existing decoded pixels and verified source mappings are reused;
 * this does not open a discussion session or parse another note document. */
export class EmbeddedImageSurface {
	private anchors: EmbeddedImageAnchors;
	private remote: Remote[] = [];
	private positions = new Map<string, Position>();
	private mounted = new Map<HTMLImageElement, Mounted>();
	private failed = new WeakMap<HTMLImageElement, string>();
	private failures = 0;
	private metadata = new Map<string, Promise<ImageLocation>>();
	private rejected = new WeakSet<Promise<ImageLocation>>();
	private urls = new Map<string, Promise<string>>();
	private local?: { image: HTMLImageElement; point: { x: number; y: number } };
	private timer?: number;
	private waits = new Map<number, () => void>();
	private pending = false;
	private again = false;
	private revision = 0;
	private closed = false;
	private stops: (() => void)[] = [];
	private win: Window;
	private file: TFile;
	constructor(readonly view: MarkdownView, readonly text: Y.Text, private assets: ImageAssets, private options: Options) {
		this.file = view.file!; this.anchors = new EmbeddedImageAnchors(text);
		const root = view.contentEl; this.win = root.ownerDocument.defaultView ?? window;
		const listen = (target: EventTarget, name: string, handler: EventListener, capture = false) => {
			target.addEventListener(name, handler, { capture, passive: true }); this.stops.push(() => target.removeEventListener(name, handler, capture));
		};
		const pointer = (event: Event) => {
			const value = event as PointerEvent, image = event.target as HTMLImageElement;
			if (image?.tagName !== "IMG" || !this.options.publishing()) { this.clearLocal(); return; }
			if (this.local?.image !== image) this.clearLocal();
			this.local = { image, point: { x: value.clientX, y: value.clientY } };
			const mounted = this.mounted.get(image);
			if (mounted?.motion) { mounted.motion.refresh(); mounted.motion.point(this.local.point); }
			else this.refresh();
		};
		listen(root, "pointermove", pointer); listen(root, "pointerdown", pointer);
		for (const event of ["pointerleave", "pointercancel"]) listen(root, event, () => this.clearLocal());
		listen(root, "pointerup", event => { if ((event as PointerEvent).pointerType === "touch") this.clearLocal(); });
		listen(root.ownerDocument, "scroll", () => { this.clearLocal(); this.refresh(); }, true);
		const changed = () => this.invalidate(); text.observe(changed); this.stops.push(() => text.unobserve(changed));
		for (const event of ["load", "error"]) listen(root, event, event => { if (!(event.target as Element)?.closest?.(owned)) this.invalidate(); }, true);
		const observer = new MutationObserver(records => {
			if (records.some(record => !(record.target as Element).closest?.(owned) &&
				(record.type === "attributes" || [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node => node.nodeType !== 1 || !(node as Element).matches(owned))))) this.invalidate();
		});
		observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset"] });
		this.stops.push(() => observer.disconnect());
	}
	get unavailable(): boolean { return this.failures > 0; }
	private current(): boolean { return !this.closed && this.view.file === this.file && this.options.current(); }
	private clearLocal(): void {
		if (!this.local) return;
		const previous = this.mounted.get(this.local.image); this.local = undefined;
		this.options.publish(null); previous?.motion?.refresh(); this.refresh();
	}
	private invalidate(): void {
		this.revision++; this.clearLocal(); this.positions.clear();
		for (const value of this.mounted.values()) value.motion?.close(); this.mounted.clear();
		for (const [key, request] of this.metadata) if (this.rejected.has(request)) this.metadata.delete(key); this.rejected = new WeakSet();
		this.failed = new WeakMap(); this.failures = 0; this.refresh(); this.options.changed();
	}
	retry(): void { this.metadata.clear(); this.invalidate(); }
	setPeers(embeds: readonly EmbeddedPeer[], peers: readonly PresencePeer[]): void {
		const previous = JSON.stringify(this.remote.map(({ peer, embed }) => [peer.key, peer.name, semantic(embed)]));
		const identities = new Map(peers.filter(peer => peer.instanceId).map(peer => [participant(peer), peer]));
		this.remote = embeds.flatMap(({ target, embed }) => {
			const peer = identities.get(JSON.stringify([target.user_id, target.session_id, target.instance_id]));
			return peer ? [{ peer, embed }] : [];
		});
		// Identity/occurrence removal withdraws immediately, before async mapping.
		for (const [key, position] of this.positions) {
			const next = this.remote.find(item => item.peer.key === key && semantic(item.embed) === semantic(position.embed));
			if (!next) this.positions.delete(key); else this.positions.set(key, { ...position, ...next });
		}
		this.paint();
		if (previous !== JSON.stringify(this.remote.map(({ peer, embed }) => [peer.key, peer.name, semantic(embed)]))) this.refresh();
	}
	refresh(): void {
		if (this.closed) return;
		if (!this.current()) { this.clearLocal(); this.positions.clear(); for (const value of this.mounted.values()) value.motion?.close(); this.mounted.clear(); return; }
		if (!this.options.publishing()) this.clearLocal();
		if (this.pending) { this.again = true; return; }
		if (this.timer === undefined) this.timer = this.win.setTimeout(() => { this.timer = undefined; void this.reconcile(); }, 100);
	}
	private async urlHash(url: string): Promise<string> {
		let promise = this.urls.get(url);
		if (!promise) { promise = sha256Hex(new TextEncoder().encode(url).buffer); if (this.urls.size >= 128) this.urls.delete(this.urls.keys().next().value!); this.urls.set(url, promise); }
		return promise;
	}
	private async asset(occurrence: ImageOccurrence, expected?: EmbeddedAsset): Promise<EmbeddedAsset> {
		const asset = this.assets.describe(this.file, occurrence.destination);
		if (expected && (asset.kind !== expected.kind || asset.kind === "managed" && expected.kind === "managed" && (asset.entry_id !== expected.entry_id || asset.sha256 !== expected.sha256))) throw new Error("Image changed");
		if (asset.kind === "external") return { kind: "external", url_sha256: await this.urlHash(asset.url), version_evidence: "unknown" };
		const key = JSON.stringify([asset, expected?.kind === "managed" ? expected.generation : null]); let request = this.metadata.get(key);
		if (!request) {
			request = this.options.read(asset.entry_id);
			const cache = (key: string) => { if (!this.metadata.has(key) && this.metadata.size >= 128) this.metadata.delete(this.metadata.keys().next().value!); this.metadata.set(key, request!); };
			cache(key); if (expected?.kind === "managed") cache(JSON.stringify([asset, null]));
			void request.catch(() => {
				if (this.current() && [...this.metadata.values()].includes(request!)) { this.rejected.add(request!); this.failures++; this.options.changed(); }
			});
		}
		const location = await request;
		if (location.entry_id !== asset.entry_id || location.content_sha256 !== asset.sha256 || JSON.stringify(this.assets.describe(this.file, occurrence.destination)) !== JSON.stringify(asset)) throw new Error("Image changed");
		return { kind: "managed", entry_id: asset.entry_id, generation: location.generation, sha256: asset.sha256 };
	}
	private async reconcile(): Promise<void> {
		if (!this.current() || this.pending) return;
		this.pending = true; const revision = this.revision, current = () => this.current() && revision === this.revision;
		const before = JSON.stringify([...this.positions].map(([key, value]) => [key, value.occurrence]));
		try {
			for (const remote of this.remote) {
				try {
					const occurrence = await this.anchors.resolve(remote.embed); if (!current()) return;
					if (!occurrence || JSON.stringify(await this.asset(occurrence, remote.embed.asset)) !== JSON.stringify(remote.embed.asset)) { this.positions.delete(remote.peer.key); continue; }
					const latest = this.remote.find(item => item.peer.key === remote.peer.key && semantic(item.embed) === semantic(remote.embed));
					if (!current()) return;
					if (latest) this.positions.set(latest.peer.key, { ...latest, occurrence });
				} catch { this.positions.delete(remote.peer.key); }
			}
			if (!current()) return;
			const targets = this.options.targets(this.anchors.images), wanted = targets.filter(target => target.image === this.local?.image || [...this.positions.values()].some(value => sameOccurrence(value.occurrence, target.occurrence)));
			for (const [image, value] of this.mounted) if (!wanted.some(target => target.image === image && sameOccurrence(target.occurrence, value.occurrence)) || value.evidence && !value.evidence.valid()) {
				value.motion?.close(); this.mounted.delete(image);
			}
			// Sequential verification bounds HTTP/digest work; the existing asset
			// verifier also limits simultaneous file reads across all consumers.
			for (const target of wanted.slice(0, 128)) {
				if (!current()) return;
				const { image, occurrence } = target, key = JSON.stringify([occurrence, image.currentSrc || image.src, image.naturalWidth, image.naturalHeight]);
				if (this.mounted.has(image) || this.failed.get(image) === key || !image.complete || !image.naturalWidth || !image.naturalHeight) continue;
				const value: Mounted = { key, occurrence }; this.mounted.set(image, value);
				const valid = () => current() && this.mounted.get(image) === value && image.isConnected &&
					JSON.stringify([occurrence, image.currentSrc || image.src, image.naturalWidth, image.naturalHeight]) === key;
				try {
					const evidence = await this.assets.verifyRendered(this.file, occurrence.destination, image, valid);
					const asset = await this.asset(occurrence), basis = { width: image.naturalWidth, height: image.naturalHeight, orientation: "display" as const };
					const embed = await this.anchors.capture(occurrence, asset, basis, blank);
					if (!valid() || !evidence.valid() || !embed) { if (this.mounted.get(image) === value) this.mounted.delete(image); continue; }
					value.evidence = evidence; value.embed = embed;
					value.motion = new ImagePresenceMotion(this.view.contentEl, image, { externalPointer: true,
						current: () => valid() && evidence.valid(), publishing: () => this.local?.image === image && this.options.publishing(),
						publish: state => { if (this.local?.image === image) this.options.publish(state?.pointer && valid() && evidence.valid() ? { ...embed, state } : null); },
					});
					if (this.local?.image === image) value.motion.point(this.local.point);
				} catch { if (this.mounted.get(image) === value) this.mounted.delete(image); if (current()) { this.failed.set(image, key); this.failures++; this.options.changed(); } }
			}
			this.paint();
			if (before !== JSON.stringify([...this.positions].map(([key, value]) => [key, value.occurrence]))) this.options.changed();
		} catch {
			this.positions.clear(); this.clearLocal(); this.paint();
		} finally {
			this.pending = false;
			if (this.again) { this.again = false; this.refresh(); }
		}
	}
	private paint(): void {
		for (const value of this.mounted.values()) {
			const peers: ImagePointerPeer[] = [...this.positions.values()].filter(position => value.embed && sameOccurrence(value.occurrence, position.occurrence) &&
				JSON.stringify(position.embed.asset) === JSON.stringify(value.embed.asset) && JSON.stringify(position.embed.basis) === JSON.stringify(value.embed.basis))
				.map(({ peer, embed }) => ({ key: peer.key, name: peer.name, userId: peer.userId, imageState: embed.state }));
			value.motion?.setPeers(peers); value.motion?.refresh();
		}
	}
	position(peer: PresencePeer, follow = false): { from: number; to: number; signature: string } | undefined {
		const value = this.current() && this.positions.get(peer.key); if (!value || participant(value.peer) !== participant(peer)) return;
		const state = value.embed.state;
		return { from: value.occurrence.from, to: value.occurrence.to, signature: JSON.stringify([value.embed.occurrence, value.embed.asset, follow ? state.viewport ?? state.pointer : state.pointer ?? state.viewport]) };
	}
	reveal(peer: PresencePeer, follow: boolean, current: () => boolean): boolean {
		const value = this.current() && this.positions.get(peer.key); if (!value || !current()) return false;
		const mounted = [...this.mounted.values()].find(item => sameOccurrence(item.occurrence, value.occurrence) && item.embed &&
			JSON.stringify(item.embed.asset) === JSON.stringify(value.embed.asset) && JSON.stringify(item.embed.basis) === JSON.stringify(value.embed.basis));
		return mounted?.motion?.reveal(value.embed.state, follow, current) === true;
	}
	async revealAfterLayout(peer: PresencePeer, follow: boolean, current: () => boolean): Promise<boolean> {
		this.refresh();
		for (let attempt = 0; attempt < 8; attempt++) {
			if (!this.current() || !current() || !this.position(peer)) return false;
			if (this.reveal(peer, follow, current)) return true;
			await new Promise<void>(resolve => { const timer = this.win.setTimeout(() => { this.waits.delete(timer); resolve(); }, 50); this.waits.set(timer, resolve); });
		}
		return false;
	}
	close(): void {
		if (this.closed) return; this.closed = true; this.revision++;
		this.stops.splice(0).forEach(stop => stop()); this.local = undefined; this.options.publish(null);
		if (this.timer !== undefined) this.win.clearTimeout(this.timer);
		for (const [timer, resolve] of this.waits) { this.win.clearTimeout(timer); resolve(); } this.waits.clear();
		for (const value of this.mounted.values()) value.motion?.close(); this.mounted.clear();
		this.anchors.close(); this.positions.clear(); this.remote = []; this.metadata.clear(); this.rejected = new WeakSet(); this.urls.clear();
	}
}
