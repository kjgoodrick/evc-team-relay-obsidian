import * as Y from "yjs";
import { sha256Hex } from "../../contentDigest";
import { markdownImages, type ImageOccurrence } from "../anchors/images";
import { parseEmbeddedImage, type EmbeddedImage, type EmbeddedAsset } from "./EmbeddedImageProtocol";
import { resolvePresenceRange } from "./PresencePeers";
import type { ImagePresenceState } from "./LocationProtocol";

/** Relative source intervals distinguish repeated images. A hash of the exact
 * image syntax prevents a replaced/deleted occurrence from inheriting motion.
 * Source parsing and small syntax hashes are reused across pointer updates. */
export class EmbeddedImageAnchors {
	private snapshot?: { source: string; images: ImageOccurrence[] };
	private hashes = new Map<string, Promise<string>>();
	private revision = 0;
	private closed = false;
	private changed = () => { this.revision++; this.snapshot = undefined; };
	constructor(readonly text: Y.Text, private digest = sha256Hex) { text.observe(this.changed); }
	get images(): ImageOccurrence[] { return this.current().images; }
	private current(): { source: string; images: ImageOccurrence[] } {
		if (this.closed) return { source: "", images: [] };
		if (!this.snapshot) { const source = this.text.toString(); this.snapshot = { source, images: markdownImages(source) }; }
		return this.snapshot;
	}
	private hash(source: string): Promise<string> {
		let result = this.hashes.get(source);
		if (!result) {
			result = this.digest(new TextEncoder().encode(source).buffer);
			if (this.hashes.size >= 128) this.hashes.delete(this.hashes.keys().next().value!);
			this.hashes.set(source, result);
			void result.catch(() => { if (this.hashes.get(source) === result) this.hashes.delete(source); });
		}
		return result;
	}
	async capture(occurrence: ImageOccurrence, asset: EmbeddedAsset, basis: EmbeddedImage["basis"], state: ImagePresenceState): Promise<EmbeddedImage | undefined> {
		const current = this.current(), revision = this.revision;
		if (this.closed || !this.text.doc || !current.images.some(image => image.from === occurrence.from && image.to === occurrence.to && image.destination === occurrence.destination && image.syntax === occurrence.syntax)) return;
		const source_sha256 = await this.hash(current.source.slice(occurrence.from, occurrence.to));
		if (this.closed || this.revision !== revision) return;
		return parseEmbeddedImage({ version: 1, source_sha256, asset, basis, state, occurrence: {
			anchor: Y.createRelativePositionFromTypeIndex(this.text, occurrence.from, 0),
			head: Y.createRelativePositionFromTypeIndex(this.text, occurrence.to, -1),
		} });
	}
	async resolve(embed: EmbeddedImage): Promise<ImageOccurrence | undefined> {
		if (this.closed) return;
		const position = resolvePresenceRange(embed.occurrence, this.text), current = this.current(), revision = this.revision;
		// Image intervals are forward and nonempty. Never widen a collapsed or
		// ambiguous interval or locate a different copy by matching its URL.
		if (!position || position.anchor >= position.head) return;
		const occurrence = current.images.find(image => image.from === position.anchor && image.to === position.head);
		if (!occurrence || await this.hash(current.source.slice(occurrence.from, occurrence.to)) !== embed.source_sha256 || this.closed || revision !== this.revision) return;
		return occurrence;
	}
	close(): void { if (this.closed) return; this.closed = true; this.text.unobserve(this.changed); this.snapshot = undefined; this.hashes.clear(); }
}
