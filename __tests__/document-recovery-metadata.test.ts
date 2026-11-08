import { encodeDocumentRecoveryMetadata } from "../src/storage/document-recovery-metadata";
import type { DocumentRecoverySnapshot } from "../src/storage/document-recovery-snapshot";

const snapshot = (value: unknown): DocumentRecoverySnapshot => ({ exists: true, version: 1, updateCount: 2, update: new Uint8Array([0, 0]), custom: [{ key: "test", value }] });
const encoded = (value: unknown) => JSON.parse(encodeDocumentRecoveryMetadata("fixture-cache", snapshot(value)));

test("portable metadata records cache identity, review and comparison text without ordinary JSON coercion", () => {
	const state = snapshot("unused"); state.custom = [
		{ key: "restoreReviewRequired", value: 1 }, { key: "syncBase", value: "Ü/笔记.md\nold shared text" },
		{ key: "origin", value: "local" }, { key: "missing", value: undefined },
	];
	expect(JSON.parse(encodeDocumentRecoveryMetadata("fixture-cache", state))).toEqual({
		format: "team-relay-document-cache-metadata", version: 1, cacheName: "fixture-cache", exists: true, cacheVersion: 1, updateCount: 2,
		custom: [
			{ key: { type: "string", value: "restoreReviewRequired" }, value: { type: "number", value: 1 } },
			{ key: { type: "string", value: "syncBase" }, value: { type: "string", value: "Ü/笔记.md\nold shared text" } },
			{ key: { type: "string", value: "origin" }, value: { type: "string", value: "local" } },
			{ key: { type: "string", value: "missing" }, value: { type: "undefined" } },
		],
	});
});

test("dates, binary views, exceptional numbers and nested values keep their explicit types", () => {
	const view = new Uint8Array([99, 0, 255, 128, 99]).subarray(1, 4);
	const value = [new Date("2026-11-08T00:00:00Z"), view, new Uint8Array([0, 255, 128]).buffer, -0, NaN, Infinity, BigInt(123), { flag: true, empty: null }];
	expect(encoded(value).custom[0].value).toEqual({ type: "array", value: [
		{ type: "date", value: Date.parse("2026-11-08T00:00:00Z") },
		{ type: "Uint8Array", value: Buffer.from([0, 255, 128]).toString("base64") },
		{ type: "ArrayBuffer", value: Buffer.from([0, 255, 128]).toString("base64") },
		{ type: "number", value: "-0" }, { type: "number", value: "NaN" }, { type: "number", value: "Infinity" }, { type: "bigint", value: "123" },
		{ type: "object", value: [["flag", { type: "boolean", value: true }], ["empty", { type: "null" }]] },
	] });
});

test("prototype-looking keys remain data entries", () => {
	const value = JSON.parse('{"__proto__":{"scope":"local"},"constructor":"kept"}');
	expect(encoded(value).custom[0].value).toEqual({ type: "object", value: [
		["__proto__", { type: "object", value: [["scope", { type: "string", value: "local" }]] }], ["constructor", { type: "string", value: "kept" }],
	] });
});

test("missing caches are represented explicitly without inventing metadata", () => {
	expect(JSON.parse(encodeDocumentRecoveryMetadata("missing", { exists: false, updateCount: 0, update: new Uint8Array([0, 0]), custom: [] }))).toMatchObject({ exists: false, cacheVersion: null, updateCount: 0, custom: [] });
});

test("unsupported or cyclic metadata fails rather than silently dropping fields", () => {
	const cycle: { next?: unknown } = {}; cycle.next = cycle;
	for (const value of [cycle, new Map([["value", "kept"]]), () => "unsupported"]) expect(() => encoded(value)).toThrow();
	let deep: unknown = "value"; for (let i = 0; i < 40; i++) deep = [deep];
	expect(() => encoded(deep)).toThrow("nested too deeply");
});
