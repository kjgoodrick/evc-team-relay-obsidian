import { PICTURE_MAX_BYTES, PICTURE_MAX_PIXELS } from "./PictureProtocol";

export class PictureInputError extends Error {}
export type PictureHeader = { mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; width: number; height: number };
const invalid = () => new PictureInputError("Choose a valid static PNG, JPEG, WebP, or GIF picture.");
const animated = () => new PictureInputError("Animated pictures are not supported in comments. Choose a still image.");

/** Inspect dimensions and animation before asking the host to decode a local
 * preview. This is a bounded client preflight, not a substitute for the server's
 * full decode, metadata removal and format verification.
 */
export function inspectPicture(bytes: ArrayBuffer): PictureHeader {
	if (!bytes.byteLength || bytes.byteLength > PICTURE_MAX_BYTES) throw new PictureInputError("Each picture must be at most 10 MiB.");
	const data = new Uint8Array(bytes), view = new DataView(bytes);
	const has = (at: number, size: number) => at >= 0 && size >= 0 && at + size <= data.length;
	const text = (at: number, length: number) => has(at, length) ? String.fromCharCode(...data.subarray(at, at + length)) : "";
	const result = (mime: PictureHeader["mime"], width: number, height: number): PictureHeader => {
		if (!width || !height) throw invalid();
		if (width * height > PICTURE_MAX_PIXELS) throw new PictureInputError("Each picture must be at most 20 megapixels.");
		return { mime, width, height };
	};
	if (text(0, 8) === "\x89PNG\r\n\x1a\n") {
		if (!has(8, 25) || text(12, 4) !== "IHDR" || view.getUint32(8) !== 13) throw invalid();
		const info = result("image/png", view.getUint32(16), view.getUint32(20));
		let ended = false;
		for (let at = 8; has(at, 12);) {
			const size = view.getUint32(at), type = text(at + 4, 4);
			if (!has(at, size + 12)) throw invalid();
			if (type === "acTL") throw animated();
			if (type === "IHDR" && at !== 8) throw invalid();
			at += size + 12;
			if (type === "IEND") { ended = size === 0 && at === data.length; break; }
		}
		if (!ended) throw invalid();
		return info;
	}
	if (data[0] === 0xff && data[1] === 0xd8) {
		let info: PictureHeader | undefined;
		for (let at = 2; at < data.length;) {
			if (data[at++] !== 0xff) throw invalid();
			while (data[at] === 0xff) at++;
			const marker = data[at++];
			if (marker === 0xda || marker === 0xd9) break;
			if (!has(at, 2)) throw invalid();
			const length = view.getUint16(at);
			if (length < 2 || !has(at, length)) throw invalid();
			if (marker === 0xe2 && text(at + 2, 4) === "MPF\0") throw animated();
			if ([0xc0, 0xc1, 0xc2].includes(marker)) {
				if (length < 8 || info) throw invalid();
				info = result("image/jpeg", view.getUint16(at + 5), view.getUint16(at + 3));
			}
			at += length;
		}
		if (!info) throw invalid();
		return info;
	}
	if (["GIF87a", "GIF89a"].includes(text(0, 6))) {
		if (!has(0, 13)) throw invalid();
		const info = result("image/gif", view.getUint16(6, true), view.getUint16(8, true));
		let at = 13 + ((data[10] & 0x80) ? 3 * (1 << ((data[10] & 7) + 1)) : 0), frames = 0;
		const blocks = () => {
			while (has(at, 1)) { const size = data[at++]; if (!size) return; if (!has(at, size)) throw invalid(); at += size; }
			throw invalid();
		};
		while (has(at, 1)) {
			const type = data[at++];
			if (type === 0x3b) { if (frames !== 1 || at !== data.length) throw invalid(); return info; }
			if (type === 0x21) { if (!has(at++, 1)) throw invalid(); blocks(); }
			else if (type === 0x2c) {
				if (++frames > 1) throw animated();
				if (!has(at, 9)) throw invalid();
				const width = view.getUint16(at + 4, true), height = view.getUint16(at + 6, true);
				result("image/gif", width, height);
				if (view.getUint16(at, true) + width > info.width || view.getUint16(at + 2, true) + height > info.height) throw invalid();
				at += 9 + ((data[at + 8] & 0x80) ? 3 * (1 << ((data[at + 8] & 7) + 1)) : 0);
				if (!has(at++, 1)) throw invalid(); blocks();
			} else throw invalid();
		}
		throw invalid();
	}
	if (text(0, 4) === "RIFF" && text(8, 4) === "WEBP" && view.getUint32(4, true) + 8 === data.length) {
		let info: PictureHeader | undefined, frame = false;
		for (let at = 12; at < data.length;) {
			if (!has(at, 8)) throw invalid();
			const kind = text(at, 4), size = view.getUint32(at + 4, true), start = at + 8;
			if (!has(start, size + (size & 1))) throw invalid();
			if (kind === "ANIM" || kind === "ANMF" || kind === "VP8X" && (data[start] & 2)) throw animated();
			if (kind === "VP8X") {
				if (size !== 10 || info) throw invalid();
				const u24 = (pos: number) => data[pos] + (data[pos + 1] << 8) + (data[pos + 2] << 16);
				info = result("image/webp", 1 + u24(start + 4), 1 + u24(start + 7));
			} else if (kind === "VP8 " || kind === "VP8L") {
				if (frame) throw invalid(); frame = true;
				let decoded: PictureHeader;
				if (kind === "VP8 ") {
					if (size < 10 || text(start + 3, 3) !== "\x9d\x01\x2a") throw invalid();
					decoded = result("image/webp", view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff);
				} else {
					if (size < 5 || data[start] !== 0x2f) throw invalid();
					const bits = view.getUint32(start + 1, true);
					decoded = result("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
				}
				if (info && (info.width !== decoded.width || info.height !== decoded.height)) throw invalid();
				info = decoded;
			}
			at = start + size + (size & 1);
		}
		if (!info || !frame) throw invalid();
		return info;
	}
	throw invalid();
}

export async function readPictureFile(file: File): Promise<ArrayBuffer> {
	if (!file.size || file.size > PICTURE_MAX_BYTES) throw new PictureInputError("Each picture must be at most 10 MiB.");
	// FileReader also works in host webviews that lack Blob.arrayBuffer.
	if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
	return new Promise((resolve, reject) => {
		const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(new PictureInputError("This picture could not be read. Choose it again.")); reader.readAsArrayBuffer(file);
	});
}
