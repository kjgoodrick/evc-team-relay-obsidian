import { BaseTarget, baseTargetKey } from "../../src/collaboration/anchors/bases";

const view = { baseId: "base-a", viewId: "planning-board" };
const cell: BaseTarget = { ...view, type: "base-cell", recordId: "task-a", property: { source: "note", id: "status" } };

test("cell identity needs view, record and property; layout and current value are not identity", () => {
	expect(baseTargetKey(cell)).not.toBe(baseTargetKey({ ...cell, recordId: "task-b" }));
	expect(baseTargetKey(cell)).not.toBe(baseTargetKey({ ...cell, viewId: "inventory" }));
	expect(baseTargetKey(cell)).not.toBe(baseTargetKey({ ...cell, property: { source: "formula", id: "status" } }));
	expect(baseTargetKey({ ...cell, currentValue: "done", row: 50 } as BaseTarget)).toBe(baseTargetKey(cell));
});

test("an item keeps its discussion when the same saved view switches to timeline", () => {
	expect(baseTargetKey({ ...view, type: "base-item", recordId: "task" }))
		.toBe(baseTargetKey({ ...view, type: "timeline-item", recordId: "task" }));
});

test("empty, text, numeric and boolean groups cannot collide", () => {
	const groups = [{ type: "empty" }, { type: "text", value: "" }, { type: "text", value: "1" },
		{ type: "number", value: 1 }, { type: "boolean", value: true }] as const;
	expect(new Set(groups.map(value => baseTargetKey({ ...view, type: "base-group",
		group: { property: { source: "note", id: "status" }, value } })))).toHaveProperty("size", 5);
});

test("formula revision is evidence, not a new discussion identity", () => {
	const formula: BaseTarget = { ...view, type: "base-formula", definitionId: "cost", definitionRevision: "v1" };
	expect(baseTargetKey(formula)).toBe(baseTargetKey({ ...formula, definitionRevision: "v2" }));
});

const range: BaseTarget = { ...view, type: "timeline-range", start: { type: "date", value: "2026-11-01" },
	end: { type: "date", value: "2026-11-08" }, startInclusive: true, endInclusive: false, timeZone: "America/Denver" };

test("timeline interval differs from item, lane and milestone; calendar range survives DST", () => {
	expect(baseTargetKey(range)).toContain("2026-11-01");
	expect(baseTargetKey(range)).not.toBe(baseTargetKey({ ...range, endInclusive: true }));
	expect(baseTargetKey(range)).not.toBe(baseTargetKey({ ...range, lane: { property: { source: "note", id: "owner" }, value: { type: "text", value: "Alice" } } }));
	expect(baseTargetKey({ ...view, type: "timeline-milestone", milestoneId: "release" })).not.toBe(baseTargetKey(range));
});

test("equivalent instants canonicalize; timezone-less, impossible and reversed dates fail", () => {
	const instant = { ...range, start: { type: "instant", value: "2026-11-01T01:00:00-06:00" }, end: { type: "instant", value: "2026-11-01T02:00:00-07:00" } } as BaseTarget;
	expect(baseTargetKey(instant)).toBe(baseTargetKey({ ...range, start: { type: "instant", value: "2026-11-01T07:00:00Z" }, end: { type: "instant", value: "2026-11-01T09:00:00Z" } }));
	for (const start of [{ type: "date", value: "2026-02-30" }, { type: "date", value: "2026-12-01" },
		{ type: "instant", value: "2026-11-01T01:00:00" }]) {
		expect(() => baseTargetKey({ ...range, start } as BaseTarget)).toThrow();
	}
	expect(() => baseTargetKey({ ...range, timeZone: "not/a-zone" })).toThrow();
});
