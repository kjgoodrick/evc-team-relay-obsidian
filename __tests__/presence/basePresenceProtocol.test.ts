import { basePresenceLocation, parseBasePresenceContext } from "../../src/collaboration/presence/BasePresenceProtocol";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = () => ({ protocol_version: 1, share_id: id(1), entry_id: id(2), generation: id(3), definition_id: id(4), registry_revision: 1,
	content_sha256: "a".repeat(64), views: [{ id: id(5), slot: 0, name: "Work", type: "table" }, { id: id(6), slot: 2, name: "Dates", type: "sabidurian-timeline" }] });

test("copies and freezes active identities, preserves sparse slots and constructs exact saved-view locations", () => {
	const input = context(), value = parseBasePresenceContext(input, id(1), id(2));
	expect(value).toEqual(input); input.views[0].name = "Changed"; expect(value.views[0].name).toBe("Work");
	for (const item of [value, value.views, ...value.views]) expect(Object.isFrozen(item)).toBe(true);
	expect(basePresenceLocation(value, id(6))).toEqual({ kind: "base", share_id: id(1), entry_id: id(2), generation: id(3), definition_id: id(4), view_id: id(6), registry_revision: 1 });
	expect(basePresenceLocation(value, id(8))).toBeUndefined();
	expect(parseBasePresenceContext({ ...input, views: [] }, id(1), id(2)).views).toEqual([]);
});

test.each([
	{ protocol_version: 2 }, { share_id: id(9) }, { entry_id: id(9) }, { generation: "bad" }, { definition_id: "bad" },
	{ registry_revision: 0 }, { registry_revision: 1.1 }, { registry_revision: Number.MAX_SAFE_INTEGER + 1 },
	{ content_sha256: "bad" }, { path: "private" }, { views: Array(65).fill(context().views[0]) },
	...[{ slot: -1 }, { slot: 64 }, { slot: 0.5 }, { id: "bad" }, { name: "" }, { name: "bad\nname" }, { name: "\ud800" }, { type: "x".repeat(257) }, { filters: "private" }].map(patch => ({ views: [{ ...context().views[0], ...patch }] })),
	{ views: context().views.reverse() },
	{ views: [context().views[0], { ...context().views[1], slot: 0 }] },
	{ views: [context().views[0], { ...context().views[1], id: id(5) }] },
	{ views: [context().views[0], { ...context().views[1], name: "Work" }] },
])("rejects malformed/ambiguous context %j", patch => {
	expect(() => parseBasePresenceContext({ ...context(), ...patch }, id(1), id(2))).toThrow();
});

test("accepts bounded Unicode view names at the complete 64-view limit", () => {
	const input = context(), views = Array.from({ length: 64 }, (_, slot) => ({ id: id(100 + slot), slot, name: "😀".repeat(254) + String(slot).padStart(2, "0"), type: "😀".repeat(256) }));
	expect(parseBasePresenceContext({ ...input, views }, id(1), id(2)).views).toHaveLength(64);
});
