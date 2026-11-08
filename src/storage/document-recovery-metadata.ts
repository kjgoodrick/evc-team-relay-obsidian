import { toBase64 } from "lib0/buffer";
import type { DocumentRecoverySnapshot } from "./document-recovery-snapshot";

type Encoded = { type: string; value?: unknown };

/** Tagged values avoid JSON's silent conversion of dates, bytes and undefined. */
function encode(value: unknown, ancestors: Set<object>, depth: number): Encoded {
	if (depth > 32) throw new Error("Document recovery metadata is nested too deeply");
	if (value === null) return { type: "null" };
	if (value === undefined) return { type: "undefined" };
	if (typeof value === "string" || typeof value === "boolean") return { type: typeof value, value };
	if (typeof value === "number") return { type: "number", value: Object.is(value, -0) ? "-0" : Number.isFinite(value) ? value : String(value) };
	if (typeof value === "bigint") return { type: "bigint", value: String(value) };
	if (typeof value !== "object") throw new Error("Unsupported document recovery metadata value");
	if (ancestors.has(value)) throw new Error("Document recovery metadata contains a cycle");
	const tag = Object.prototype.toString.call(value);
	if (tag === "[object Date]") {
		const time = Date.prototype.getTime.call(value);
		return { type: "date", value: Number.isFinite(time) ? time : null };
	}
	if (tag === "[object ArrayBuffer]") return { type: "ArrayBuffer", value: toBase64(new Uint8Array(value as ArrayBuffer)) };
	if (ArrayBuffer.isView(value)) return { type: tag.slice(8, -1), value: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return { type: "array", value: Array.from(value, item => encode(item, ancestors, depth + 1)) };
		if (tag === "[object Object]") return { type: "object", value: Object.entries(value).map(([key, item]) => [key, encode(item, ancestors, depth + 1)]) };
		throw new Error("Unsupported document recovery metadata value");
	} finally { ancestors.delete(value); }
}

export function encodeDocumentRecoveryMetadata(cacheName: string, snapshot: DocumentRecoverySnapshot): string {
	return JSON.stringify({ format: "team-relay-document-cache-metadata", version: 1, cacheName,
		exists: snapshot.exists, cacheVersion: snapshot.version ?? null, updateCount: snapshot.updateCount,
		custom: snapshot.custom.map(item => ({ key: encode(item.key, new Set(), 0), value: encode(item.value, new Set(), 0) })),
	}, null, 2);
}
