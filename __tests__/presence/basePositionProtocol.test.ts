import { parseBaseState, parseBasePeers, parseBaseRecordContext } from "../../src/collaboration/presence/BasePositionProtocol";

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
	{ version: true }, { version: 2 }, { path: "private" }, { pointer: {} }, { viewport: undefined },
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
