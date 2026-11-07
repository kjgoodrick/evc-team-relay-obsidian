import type { DiscussionSession } from "./DiscussionSession";
import { DiscussionFailure } from "./DiscussionTransport";
import { inspectPicture } from "./PictureInput";
import { parsePictureRendition, pictureHash, PictureOfflineError, type CachedPicture, type PictureVariant } from "./PictureProtocol";

export type PictureContent = { bytes: ArrayBuffer; mime: string; width: number; height: number; offline: boolean; local: boolean };

/** One account-owned loader. No credential or private URL is assigned to an img.
 * Visible thumbnails share in-flight work; at most two reads run concurrently.
 */
export class DiscussionPictures {
	private flights = new Map<string, Promise<PictureContent>>();
	private active = 0;
	private waiting: (() => void)[] = [];
	constructor(private session: DiscussionSession) {}
	load(entryId: string, pictureId: string, variant: PictureVariant = "thumbnail", local: boolean | "only" = false): Promise<PictureContent> {
		const key = JSON.stringify([entryId, pictureId, variant, local]);
		const previous = this.flights.get(key); if (previous) return previous;
		if (this.flights.size >= 32) return Promise.reject(new Error("Other pictures are loading. Retry in a moment."));
		const flight = this.session.trackLocal(this.limited(() => this.read(entryId, pictureId, variant, local)));
		this.flights.set(key, flight);
		void flight.finally(() => this.flights.delete(key)).catch(() => {});
		return flight;
	}
	private async limited<T>(work: () => Promise<T>): Promise<T> {
		if (this.active >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
		else this.active++;
		try { return await work(); } finally {
			const next = this.waiting.shift(); if (next) next(); else this.active--;
		}
	}
	private allowed(entryId: string): boolean {
		return !["closed", "authentication_required", "unavailable", "error"].includes(this.session.status) && !!this.session.permission(entryId)?.read;
	}
	private closed(): boolean { return this.session.status === "closed"; }
	private async cached(row: CachedPicture | undefined): Promise<PictureContent | undefined> {
		if (!row) return undefined;
		try {
			const rendition = parsePictureRendition(row.rendition, row.variant === "thumbnail");
			if (row.bytes.byteLength !== rendition.size || await pictureHash(row.bytes) !== rendition.sha256) return undefined;
			return { bytes: row.bytes, ...rendition, offline: true, local: false };
		} catch { return undefined; }
	}
	private async read(entryId: string, pictureId: string, variant: PictureVariant, local: boolean | "only"): Promise<PictureContent> {
		const { session } = this;
		if (this.closed()) throw new Error("This discussion account is closed.");
		if (local) {
			const source = await session.store.pictureSource(pictureId, entryId);
			if (source) {
				if (await pictureHash(source.bytes) !== source.sha256) throw new Error("The saved picture could not be verified.");
				const info = inspectPicture(source.bytes);
				if (this.closed()) throw new Error("This discussion account is closed.");
				return { bytes: source.bytes, ...info, offline: !session.online, local: true };
			}
		}
		if (local === "only") throw new PictureOfflineError("The original picture is not retained on this device.");
		if (!this.allowed(entryId)) throw new Error("Reconnect and check access to view this picture.");
		const checkpoint = await session.store.checkpoint(entryId);
		const cachePolicy = await session.store.pictureCachePolicy();
		const cached = await session.store.cachedPicture(entryId, pictureId, variant);
		const current = async () => this.allowed(entryId) && (await session.store.checkpoint(entryId)).generation === checkpoint.generation;
		try {
			if (!session.online) throw new DiscussionFailure("retry", "network_unavailable");
			// Always reauthorize online, even when immutable bytes are already cached.
			const metadata = await session.transport.picture(entryId, pictureId), rendition = metadata.renditions[variant];
			if (!rendition || !await current()) throw new Error("This picture is unavailable.");
			const saved = cached?.rendition.sha256 === rendition.sha256 ? await this.cached(cached) : undefined;
			if (saved && await current()) return { ...saved, offline: false };
			const bytes = await session.transport.pictureContent(entryId, pictureId, variant, rendition);
			if (!await current()) throw new Error("Access to this picture changed.");
			try { if (rendition.size <= cachePolicy.limit) await session.store.cachePicture(entryId, pictureId, variant, rendition, bytes, checkpoint.generation, cachePolicy.epoch); }
			catch { /* A disposable cache failure must not discard a downloaded image. */ }
			if (!await current()) throw new Error("Access to this picture changed.");
			return { bytes, ...rendition, offline: false, local: false };
		} catch (error) {
			if (error instanceof DiscussionFailure && error.action === "retry" && await current()) {
				const saved = await this.cached(cached); if (saved && await current()) return saved;
				throw new PictureOfflineError("This picture is not saved on this device. Reconnect to load it.");
			}
			if (error instanceof DiscussionFailure && error.action !== "retry") await session.store.forgetPicture(entryId, pictureId);
			throw error;
		}
	}
}
