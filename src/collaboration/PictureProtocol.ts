import { isId, isRecord } from "./DiscussionProtocol";

export const PICTURE_MAX_BYTES = 10 * 1024 * 1024;
export const PICTURE_MAX_PIXELS = 20_000_000;
export const PICTURE_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const PICTURE_SOURCE_QUOTA = 100 * 1024 * 1024;
export const PICTURE_CACHE_QUOTA = 50 * 1024 * 1024;
export class PictureOfflineError extends Error {}
export type PictureVariant = "content" | "thumbnail";
export type CachedPicture = { scopeId: string; id: string; variant: PictureVariant; rendition: PictureRendition; bytes: ArrayBuffer; usedAt: number };
export type PictureBlock = { type: "picture"; picture_id: string; alt?: string };
export type PictureRendition = { sha256: string; size: number; mime: "image/png" | "image/jpeg"; width: number; height: number };
export type PictureMetadata = { picture_id: string; state: "staged" | "verified" | "attached";
	source_sha256: string; source_size: number; source_mime: string | null; expires_at: string | null;
	renditions: { content?: PictureRendition; thumbnail?: PictureRendition } };
export type PictureUpload = { type: "picture.upload"; picture_id: string; sha256: string; size: number };
export type LocalPicture = { id: string; scopeId: string; sha256: string; size: number; bytes: ArrayBuffer };

export const isPictureHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const size = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;

export function parsePictureUpload(value: unknown): PictureUpload {
	if (!isRecord(value) || value.type !== "picture.upload" || !isId(value.picture_id) ||
		!isPictureHash(value.sha256) || !size(value.size, PICTURE_MAX_BYTES)) throw new Error("Invalid picture upload");
	return { type: "picture.upload", picture_id: value.picture_id, sha256: value.sha256, size: value.size };
}

export function parsePictureRendition(value: unknown, thumbnail: boolean): PictureRendition {
	if (!isRecord(value) || !isPictureHash(value.sha256) || !size(value.size, thumbnail ? PICTURE_THUMBNAIL_BYTES : PICTURE_MAX_BYTES) ||
		!["image/png", "image/jpeg"].includes(String(value.mime)) || !size(value.width, PICTURE_MAX_PIXELS) ||
		!size(value.height, PICTURE_MAX_PIXELS) || value.width * value.height > PICTURE_MAX_PIXELS ||
		thumbnail && (value.width > 512 || value.height > 512)) throw new Error("Invalid picture rendition");
	return { sha256: value.sha256, size: value.size, mime: value.mime as PictureRendition["mime"], width: value.width, height: value.height };
}

export function parsePictureMetadata(value: unknown, id: string): PictureMetadata {
	if (!isRecord(value) || !isId(id) || value.picture_id !== id || !["staged", "verified", "attached"].includes(String(value.state)) ||
		!isPictureHash(value.source_sha256) || !size(value.source_size, PICTURE_MAX_BYTES) || !isRecord(value.renditions) ||
		(value.state === "attached" ? value.expires_at !== null : typeof value.expires_at !== "string" ||
			value.expires_at.length > 64 || !Number.isFinite(Date.parse(value.expires_at)))) throw new Error("Invalid picture metadata");
	const result: PictureMetadata = { picture_id: id, state: value.state as PictureMetadata["state"], source_sha256: value.source_sha256,
		source_size: value.source_size, source_mime: null, expires_at: value.expires_at as string | null, renditions: {} };
	if (value.state === "staged") {
		if (value.source_mime !== null || Object.keys(value.renditions).length) throw new Error("Unverified picture has content");
	} else {
		if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(value.source_mime))) throw new Error("Invalid source format");
		result.source_mime = value.source_mime as string;
		result.renditions = { content: parsePictureRendition(value.renditions.content, false), thumbnail: parsePictureRendition(value.renditions.thumbnail, true) };
	}
	return result;
}

export async function pictureHash(bytes: ArrayBuffer): Promise<string> {
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Clone before hashing; callers cannot change bytes while an IDB save awaits. */
export async function prepareLocalPicture(id: string, scopeId: string, bytes: ArrayBuffer): Promise<LocalPicture> {
	if (!isId(id) || !isId(scopeId) || Object.prototype.toString.call(bytes) !== "[object ArrayBuffer]" ||
		!size(bytes.byteLength, PICTURE_MAX_BYTES)) throw new Error("Pictures must be between 1 byte and 10 MiB");
	const copy = bytes.slice(0);
	return { id, scopeId, sha256: await pictureHash(copy), size: copy.byteLength, bytes: copy };
}

export function pictureIds(value: unknown, draft = false): string[] {
	if (!isRecord(value)) return [];
	const blocks = draft ? value.pictures : value.blocks;
	if (blocks === undefined) return [];
	if (!Array.isArray(blocks)) throw new Error("Invalid picture references");
	const pictures = blocks.filter(block => isRecord(block) && block.type === "picture");
	if (pictures.length > 10 || draft && pictures.length !== blocks.length || pictures.some(block =>
		!isId(block.picture_id) || block.alt !== undefined && (typeof block.alt !== "string" || [...block.alt].length > 1024))) throw new Error("Invalid picture references");
	return [...new Set(pictures.map(block => block.picture_id as string))];
}
