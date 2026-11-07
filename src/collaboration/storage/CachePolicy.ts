import { PICTURE_CACHE_QUOTA } from "../PictureProtocol";

export const MAX_PICTURE_CACHE_BYTES = 500 * 1024 * 1024;
export function validPictureCacheLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PICTURE_CACHE_BYTES && value % (1024 * 1024) === 0;
}
export function pictureCacheLimit(value: unknown): number { return validPictureCacheLimit(value) ? value : PICTURE_CACHE_QUOTA; }
export interface DiscussionStorageUsage {
	drafts: number;
	queued: number;
	sending: number;
	rejected: number;
	review: number;
	cachedRecords: number;
	cachedPictures: number;
	cachedPictureBytes: number;
	pictureCacheLimit: number;
	savedPictures: number;
	savedPictureBytes: number;
}
