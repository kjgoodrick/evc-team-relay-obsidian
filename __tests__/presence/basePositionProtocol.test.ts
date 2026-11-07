import { baseStateForVersion, parseBaseState, parseBasePeers, parseBaseRecordContext } from "../../src/collaboration/presence/BasePositionProtocol";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const position = () => ({ target: { type: "cell", record_id: id(1), record_generation: id(2), property: { source: "note", name: "status" } }, offset: { x: 0.25, y: 0.5 } });
const state = () => ({ version: 1, pointer: position(), viewport: position() });
const person = { user_id: id(3), session_id: "a".repeat(32), instance_id: id(4) };
const context = () => ({ protocol_version: 1, share_id: id(5), entry_id: id(1), generation: id(2), type: "markdown" });

test("positions copy and freeze nested semantic targets and offsets", () => {
	const source = state(), result = parseBaseState(source);
	expect(result).toEqual(source); source.pointer.target.property.name = "changed"; source.pointer.offset.x = 1;
	expect(result.pointer?.target).toMatchObject({ property: { name: "status" } }); expect(result.pointer?.offset.x).toBe(0.25);
	for (const item of [result, result.pointer, result.pointer?.target, result.pointer?.offset, result.pointer?.target.type === "cell" && result.pointer.target.property]) expect(Object.isFrozen(item)).toBe(true);
});

test("supports record, property header and formula-cell identities without values", () => {
	for (const target of [
		{ type: "item", record_id: id(1), record_generation: id(2) },
		{ type: "property", property: { source: "file", name: "name" } },
		{ ...position().target, property: { source: "formula", name: "Score" } },
	]) expect(parseBaseState({ version: 1, pointer: { ...position(), target }, viewport: null }).pointer?.target).toEqual(target);
	expect(parseBaseState({ version: 1, pointer: null, viewport: null }).pointer).toBeNull();
});

test.each([
	{ version: true }, { version: 3 }, { path: "private" }, { pointer: {} }, { viewport: undefined },
	...[{ x: -1, y: 0 }, { x: 1.1, y: 0 }, { x: true, y: 0 }, { x: "0", y: 0 }, { x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 0, y: 0, extra: 1 }].map(offset => ({ pointer: { ...position(), offset } })),
	...["", "x".repeat(129), "😀".repeat(65), "bad\nname", "\ud800"].map(name => ({ pointer: { ...position(), target: { ...position().target, property: { source: "note", name } } } })),
	...[{ record_id: "bad" }, { record_generation: "bad" }, { value: "private" }, { type: "range" }, { property: { source: "unknown", name: "name" } }].map(patch => ({ pointer: { ...position(), target: { ...position().target, ...patch } } })),
])("rejects unsafe or malformed position %j", patch => expect(() => parseBaseState({ ...state(), ...patch })).toThrow());

test("accepts bounded Unicode and bounds the complete roster frame", () => {
	const value = state(); value.pointer.target.property.name = "😀".repeat(64); value.viewport.target.property.name = "😀".repeat(64);
	const peers = Array.from({ length: 127 }, (_, n) => ({ target: { ...person, instance_id: id(100 + n) }, state: value }));
	expect(parseBasePeers(peers)).toHaveLength(127);
	expect(new TextEncoder().encode(JSON.stringify({ type: "base_states", subscription_id: id(10), status: "available", peers })).length).toBeLessThan(192 * 1024);
	expect(() => parseBasePeers([...peers, peers[0]])).toThrow(); expect(() => parseBasePeers([peers[0], peers[0]])).toThrow();
	expect(() => parseBasePeers([{ ...peers[0], name: "spoof" }])).toThrow();
});

test("record context contains only the requested current lineage", () => {
	const result = parseBaseRecordContext(context(), id(5), id(1)); expect(result).toEqual(context()); expect(Object.isFrozen(result)).toBe(true);
	for (const patch of [{ share_id: id(8) }, { entry_id: id(8) }, { generation: null }, { protocol_version: 2 }, { type: "folder" }, { path: "private" }]) {
		expect(() => parseBaseRecordContext({ ...context(), ...patch }, id(5), id(1))).toThrow();
	}
});

const group = () => ({ type: "group", record_id: id(1), record_generation: id(2), property: { source: "note", name: "status" }, value_sha256: "a".repeat(64), references: [{ record_id: id(6), record_generation: id(7) }] });
const range = () => ({ type: "timeline_range", axis: { version: 1, renderer: "sabidurian-timeline", start_property: { source: "note", name: "start" }, end_property: null, time_zone: "America/Denver" },
	range: { version: 1, kind: "calendar", start: "2026-11-01", end: "2026-11-07", start_inclusive: true, end_inclusive: true, time_zone: "America/Denver" }, lane: group() });
const extended = (target: unknown = group()) => ({ version: 2, pointer: { target, offset: { x: 0.25, y: 0.5 } }, viewport: position() });

test("extended targets copy all nested inputs and downgrade without guessing positions", () => {
	const input = range(), parsed = parseBaseState(extended(input));
	expect(parsed.pointer?.target).toEqual(input);
	input.range.start = "2020-01-01"; input.lane.references[0].record_generation = id(12);
	const result = parsed.pointer!.target;
	expect(result.type).toBe("timeline_range"); if (result.type !== "timeline_range") throw new Error("missing range");
	expect(result.range.start).toBe("2026-11-01"); expect(result.lane?.references[0].record_generation).toBe(id(7));
	for (const item of [result, result.axis, result.axis.start_property, result.range, result.lane, result.lane?.references, result.lane?.references[0]]) expect(Object.isFrozen(item)).toBe(true);
	expect(baseStateForVersion(parsed, 1)).toEqual({ version: 1, pointer: null, viewport: position() });
	expect(baseStateForVersion(parsed, 2)).toBe(parsed);
	expect(() => parseBaseState({ ...extended(), version: 1 })).toThrow();
});

test.each([
	{ value: "private" }, { value_sha256: "bad" }, { property: { source: "formula", name: "private" } },
	{ property: { source: "file", name: "size" } }, { references: [{ record_id: id(1), record_generation: id(2) }] },
	{ references: Array.from({ length: 9 }, (_, n) => ({ record_id: id(20 + n), record_generation: id(50 + n) })) },
])("rejects malformed/unsupported group %j", patch => expect(() => parseBaseState(extended({ ...group(), ...patch }))).toThrow());

test.each([
	{ axis: { ...range().axis, version: true } }, { axis: { ...range().axis, time_zone: "UTC" } },
	{ axis: { ...range().axis, renderer: "sabidurian-sequence", time_zone: null } },
	{ range: { ...range().range, start: "2026-02-30" } }, { lane: undefined }, { pixel: 2 },
])("rejects mismatched range %j", patch => expect(() => parseBaseState(extended({ ...range(), ...patch }))).toThrow());

test("bounds expanded states below ingress and negotiated snapshot budgets", () => {
	const target = { ...group(), property: { source: "note", name: "😀".repeat(64) }, references: Array.from({ length: 8 }, (_, n) => ({ record_id: id(30 + n), record_generation: id(50 + n) })) };
	const value = parseBaseState({ ...extended(target), viewport: { target, offset: { x: 0.5, y: 0.5 } } });
	const peers = Array.from({ length: 127 }, (_, n) => ({ target: { ...person, instance_id: id(100 + n) }, state: value }));
	expect(parseBasePeers(peers)).toHaveLength(127);
	const bytes = new TextEncoder().encode(JSON.stringify({ type: "base_states", subscription_id: id(10), status: "available", peers })).length;
	expect(bytes).toBeGreaterThan(192 * 1024); expect(bytes).toBeLessThan(512 * 1024);
	const heavy = { ...range(), lane: target, axis: { ...range().axis, start_property: target.property, end_property: target.property } };
	expect(() => parseBaseState({ version: 2, pointer: { target: heavy, offset: { x: 0, y: 0 } }, viewport: { target: heavy, offset: { x: 0, y: 0 } } })).toThrow();
});
