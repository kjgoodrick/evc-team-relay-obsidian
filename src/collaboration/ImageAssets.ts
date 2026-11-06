import type { App, TFile } from "obsidian";
import type { ShareRegistry } from "../VaultShare";
import { sha256Hex } from "../contentDigest";
import { isId, safeImageUrl } from "./DiscussionProtocol";
import type { ImageAsset } from "./anchors/imageGeometry";

export type ImagePreview = { asset: ImageAsset; url: string; valid: () => boolean; release: () => void };
export class ImageUnavailable extends Error {}

/** Resolves only the existing authorized inventory. Previewing a comment never
 * creates an attachment, mints an upload grant or asks the server to fetch a URL. */
export class ImageAssets {
	constructor(private app: App, private shares: ShareRegistry) {}
	private managed(note: TFile, destination: string) {
		let path: string;
		try { path = decodeURIComponent(destination.split("#")[0]); } catch { throw new ImageUnavailable("The image link could not be read."); }
		const file = this.app.metadataCache.getFirstLinkpathDest(path, note.path), folder = this.shares.shareFor(note.path);
		if (!file || !folder || this.shares.shareFor(file.path) !== folder) throw new ImageUnavailable("This image must be in the same shared folder as the note.");
		const inspect = () => {
			if (this.app.vault.getFileByPath(file.path) !== file || !folder.wantsConnection || folder.isRecoveringStructure) return;
			const path = folder.toVirtualPath(file.path), record = folder.folderIndex.recordFor(path), index = folder._liveProvider.managedIndex;
			const base = folder.crdtDoc.getMap<{ owner: boolean; permissions: Record<string, string> }>("managed_base_v1").get("snapshot");
			if (!record || record.type !== "image" || !isId(record.id) || !record.hash || !/^[0-9a-f]{64}$/.test(record.hash) ||
				!index?.registered(path, record.id) || index.isBlocked(path, record.id) || !base || !base.owner && !["read", "write"].includes(base.permissions[path])) return;
			return { asset: { kind: "managed" as const, entry_id: record.id, sha256: record.hash }, mime: record.mimetype ?? "application/octet-stream" };
		};
		const value = inspect();
		if (!value) throw new ImageUnavailable("This shared image is unavailable or still synchronizing.");
		return { file, inspect, ...value };
	}
	describe(note: TFile, destination: string): ImageAsset {
		if (safeImageUrl(destination)) return { kind: "external", url: destination, version_evidence: "unknown" };
		if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(destination)) throw new ImageUnavailable("This image URL is not supported.");
		return this.managed(note, destination).asset;
	}
	async load(note: TFile, destination: string, current: () => boolean): Promise<ImagePreview> {
		if (!current()) throw new ImageUnavailable("This image's shared context is no longer available.");
		const asset = this.describe(note, destination);
		if (asset.kind === "external") return { asset, url: asset.url, valid: current, release: () => {} };
		const managed = this.managed(note, destination), file = managed.file, { mtime, size } = file.stat;
		if (size > 64 * 1024 * 1024) throw new ImageUnavailable("This image is too large for the comment placement preview (64 MiB limit).");
		const valid = () => current() && file.stat.mtime === mtime && file.stat.size === size &&
			managed.inspect()?.asset.entry_id === asset.entry_id && managed.inspect()?.asset.sha256 === asset.sha256;
		const bytes = await this.app.vault.readBinary(file);
		if (bytes.byteLength > 64 * 1024 * 1024 || !valid()) throw new ImageUnavailable("The image changed while it was opening. Open it again.");
		if (await sha256Hex(bytes) !== asset.sha256 || !valid()) throw new ImageUnavailable("Wait for the image contents to finish synchronizing, then try again.");
		const url = URL.createObjectURL(new Blob([bytes], { type: managed.mime }));
		return { asset, url, valid, release: () => URL.revokeObjectURL(url) };
	}
}
