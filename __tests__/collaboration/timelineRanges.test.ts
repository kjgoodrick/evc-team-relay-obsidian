import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTimelineRange, timelineRangeKey, validateTimelineTimeZone } from "../../src/collaboration/TimelineRange";
import { baseTargetKey, type BaseTarget } from "../../src/collaboration/anchors/bases";

const fixtures: { valid: { name: string; input: unknown; normalized: unknown; key: unknown[] }[];
	invalid: { name: string; input: unknown }[] } = JSON.parse(readFileSync(join(__dirname, "../fixtures/timeline-ranges-v1.json"), "utf8"));

describe("shared timeline coordinate contract", () => {
	test.each(fixtures.valid)("$name", ({ input, normalized, key }) => {
		const range = parseTimelineRange(input);
		expect(range).toEqual(normalized);
		expect(timelineRangeKey(range)).toBe(JSON.stringify(key));
		expect(parseTimelineRange(JSON.parse(JSON.stringify(range)))).toEqual(range);
	});
	test.each(fixtures.invalid)("rejects $name", ({ input }) => {
		expect(() => parseTimelineRange(input)).toThrow();
	});
});

test("capture/projection requires local timezone support but persisted decoding does not", () => {
	expect(validateTimelineTimeZone("America/Denver")).toBe("America/Denver");
	expect(validateTimelineTimeZone("UTC")).toBe("UTC");
	expect(() => validateTimelineTimeZone("Future/Example")).toThrow("Unsupported timeline time zone");
	expect(() => validateTimelineTimeZone("../UTC")).toThrow();
});

test("semantic range identity includes view, axis revision and optional lane, never layout", () => {
	const range = parseTimelineRange(fixtures.valid.find(item => item.name === "adjacent exact large ordinal values")!.input);
	const target: BaseTarget = { type: "timeline-range", baseId: "base", viewId: "view", axisDefinitionId: "axis", axisDefinitionRevision: 1, range };
	const key = baseTargetKey(target);
	for (const change of [{ baseId: "other" }, { viewId: "other" }, { axisDefinitionId: "other" }, { axisDefinitionRevision: 2 },
		{ lane: { property: { source: "note" as const, id: "status" }, value: { type: "text" as const, value: "Done" } } }]) {
		expect(baseTargetKey({ ...target, ...change })).not.toBe(key);
	}
	expect(baseTargetKey({ ...target, zoom: 4, pixelStart: 123, row: 2 } as BaseTarget)).toBe(key);
	for (const axisDefinitionRevision of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
		expect(() => baseTargetKey({ ...target, axisDefinitionRevision })).toThrow();
	}
});

test("explicit offsets identify the same instant without losing capture offsets", () => {
	const range = parseTimelineRange(fixtures.valid.find(item => item.name === "DST repeated wall time")!.input);
	expect(range.kind).toBe("instant");
	expect(timelineRangeKey(range)).toBe(timelineRangeKey(parseTimelineRange({ ...range,
		start: "2026-11-01T07:30:00Z", end: "2026-11-01T08:30:00Z" })));
	expect(range.start).toBe("2026-11-01T01:30:00.000-06:00");
});

test("non-JSON numeric edge cases are refused without rewriting the input", () => {
	const range = fixtures.valid[0].input as Record<string, unknown>;
	const snapshot = JSON.stringify(range);
	parseTimelineRange(range);
	expect(JSON.stringify(range)).toBe(snapshot);
	for (const version of [NaN, Infinity, -Infinity, undefined, BigInt(1)]) {
		expect(() => parseTimelineRange({ ...range, version })).toThrow();
	}
});
