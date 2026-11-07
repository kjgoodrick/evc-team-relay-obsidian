import { parseImagePeers, parseImageState } from "../../src/collaboration/presence/LocationProtocol";

test.each([
	{ pointer: { x: -0.1, y: 0 }, viewport: null },
	{ pointer: { x: 1.1, y: 0 }, viewport: null },
	{ pointer: { x: true, y: 0 }, viewport: null },
	{ pointer: { x: "0.5", y: 0 }, viewport: null },
	{ pointer: { x: NaN, y: 0 }, viewport: null },
	{ pointer: { x: 0, y: Infinity }, viewport: null },
	{ pointer: { x: 0, y: 0, user_id: "spoof" }, viewport: null },
	{ pointer: null, viewport: { x: 0.8, y: 0, width: 0.3, height: 1 } },
	{ pointer: null, viewport: { x: 0, y: 0, width: 0, height: 1 } },
	{ pointer: null },
])("rejects malformed image geometry: %j", state => expect(() => parseImageState(state)).toThrow());

test("image snapshots copy and freeze valid points and reject duplicate or oversized lists", () => {
	const target = { user_id: "00000000-0000-4000-8000-000000000001", instance_id: "00000000-0000-4000-8000-000000000002", session_id: "a".repeat(32) };
	const state = { pointer: { x: 0.2, y: 0.4 }, viewport: { x: 0, y: 0.2, width: 1, height: 0.5 } };
	const peers = parseImagePeers([{ target, state }]); state.pointer.x = 1;
	expect(peers[0].state.pointer?.x).toBe(0.2); expect(Object.isFrozen(peers[0].state.pointer)).toBe(true);
	expect(() => parseImagePeers([{ target, state }, { target, state }])).toThrow();
	expect(() => parseImagePeers(Array(128).fill({ target, state }))).toThrow();
});
