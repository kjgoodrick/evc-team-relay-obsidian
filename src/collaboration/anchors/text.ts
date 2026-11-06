import * as Y from "yjs";
import { fromBase64, toBase64 } from "lib0/buffer";

/** Wire v1 uses Yjs v1 encodings and UTF-16 offsets, including on the Rust side. */
export interface TextAnchor {
	version: 1;
	type: "text";
	documentId: string;
	generation: string;
	start: string;
	end: string;
	dependency: string;
	selectedLength: number;
	context: { quote: string; prefix: string; suffix: string; truncated: boolean };
}

export type TextAnchorResolution =
	| { status: "attached"; from: number; to: number }
	| { status: "waiting_for_sync" | "generation_mismatch" | "unanchored" | "invalid" };

export function decodeBoundedBase64(value: string, maxBytes: number): Uint8Array {
	if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 ||
		! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		throw new Error("Invalid anchor encoding");
	}
	const bytes = fromBase64(value);
	if (bytes.length > maxBytes || toBase64(bytes) !== value) throw new Error("Invalid anchor encoding");
	return bytes;
}

/** A state vector cannot detect unapplied delete-only updates. Check both parts. */
export function containsSnapshot(current: Y.Snapshot, dependency: Y.Snapshot): boolean {
	for (const [client, clock] of dependency.sv) {
		if ((current.sv.get(client) ?? 0) < clock) return false;
	}
	for (const [client, required] of dependency.ds.clients) {
		const present = current.ds.clients.get(client) ?? [];
		let index = 0;
		for (const range of required) {
			let cursor = range.clock;
			const end = range.clock + range.len;
			while (index < present.length && present[index].clock + present[index].len <= cursor) index++;
			while (cursor < end && index < present.length && present[index].clock <= cursor) {
				cursor = Math.max(cursor, present[index].clock + present[index].len);
				if (cursor < end) index++;
			}
			if (cursor < end) return false;
		}
	}
	return true;
}

export function captureTextAnchor(
	text: Y.Text, documentId: string, generation: string, anchor: number, head: number,
): TextAnchor {
	if (!text.doc || !documentId || !generation || !Number.isSafeInteger(anchor) ||
		!Number.isSafeInteger(head) || Math.min(anchor, head) < 0 || Math.max(anchor, head) > text.length) {
		throw new Error("Cannot anchor an invalid document selection");
	}
	const from = Math.min(anchor, head), to = Math.max(anchor, head);
	const source = text.toString();
	const dependency = Y.encodeSnapshot(Y.snapshot(text.doc));
	if (dependency.byteLength > 64 * 1024) throw new Error("Anchor dependency exceeds protocol limit");
	// Context is only recovery text. Cutting a UTF-16 window through an emoji
	// must not create invalid JSON Unicode or change the actual selection offsets.
	const contextSlice = (start: number, end: number) => {
		let value = source.slice(start, end);
		if (value.length && value.charCodeAt(0) >= 0xdc00 && value.charCodeAt(0) <= 0xdfff) value = value.slice(1);
		if (value.length && value.charCodeAt(value.length - 1) >= 0xd800 && value.charCodeAt(value.length - 1) <= 0xdbff) value = value.slice(0, -1);
		return [...value].map(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff ? "\ufffd" : char).join("");
	};
	const quote = contextSlice(from, Math.min(to, from + 512));
	return {
		version: 1, type: "text", documentId, generation,
		start: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, from, 0))),
		end: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, to, from === to ? 0 : -1))),
		dependency: toBase64(dependency), selectedLength: to - from,
		context: {
			quote, prefix: contextSlice(Math.max(0, from - 64), from),
			suffix: contextSlice(to, to + 64), truncated: quote.length < to - from,
		},
	};
}

/** Pure placement only; never mutate text or silently search for a replacement. */
export function resolveTextAnchor(
	text: Y.Text, documentId: string, generation: string, anchor: TextAnchor,
	currentSnapshot?: Y.Snapshot,
): TextAnchorResolution {
	if (anchor.documentId !== documentId || anchor.generation !== generation) {
		return { status: "generation_mismatch" };
	}
	try {
		if (!text.doc || anchor.version !== 1 || anchor.type !== "text" ||
			!Number.isSafeInteger(anchor.selectedLength) || anchor.selectedLength < 0) return { status: "invalid" };
		const dependency = Y.decodeSnapshot(decodeBoundedBase64(anchor.dependency, 64 * 1024));
		const start = Y.decodeRelativePosition(decodeBoundedBase64(anchor.start, 256));
		const end = Y.decodeRelativePosition(decodeBoundedBase64(anchor.end, 256));
		if (!containsSnapshot(currentSnapshot ?? Y.snapshot(text.doc), dependency)) return { status: "waiting_for_sync" };
		const from = Y.createAbsolutePositionFromRelativePosition(start, text.doc);
		const to = Y.createAbsolutePositionFromRelativePosition(end, text.doc);
		if (!from || !to) return { status: "unanchored" };
		if (from.type !== text || to.type !== text || from.index < 0 || to.index > text.length) return { status: "invalid" };
		if (from.index > to.index || (anchor.selectedLength > 0 && from.index === to.index)) return { status: "unanchored" };
		return { status: "attached", from: from.index, to: to.index };
	} catch {
		return { status: "invalid" };
	}
}
