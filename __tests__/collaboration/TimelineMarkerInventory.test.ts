import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { parseTimelineMarkerInventoryPage } from "../../src/collaboration/TimelineMarkerManagementProtocol";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = baseDiscussionScope(id(1), id(3));
const marker = (n: number) => ({ id: id(n), revision: 1, active: true, content: { kind: "point", label: "Launch", color: "#abcdef",
	range: { version: 1, kind: "ordinal", start: "999999999999999.000000001", end: "999999999999999.000000001", start_inclusive: true, end_inclusive: true, unit: "property-value" } } });
const page = (markers = [marker(20)], more = false) => ({ protocol_version: 1, entry_id: id(1), definition_id: id(2), generation: id(4), registry_revision: 2,
	catalog_revision: 300, markers, has_more: more, next_after: markers.at(-1)?.id ?? null });
const response = (value: unknown) => new Response(JSON.stringify(value));
const transport = (fetcher: jest.Mock) => new DiscussionTransport({ serverId: "https://relay.test", shareId: id(10), accountId: id(11) }, async () => ({ accountId: id(11), accessToken: "synthetic" }), fetcher);

test("base inventory retains precise summaries and archived markers without manufacturing view placements", () => {
	const wire = page([marker(20), { ...marker(21), active: false }]);
	expect(parseTimelineMarkerInventoryPage(wire, id(1))).toEqual(wire);
	const parsed = parseTimelineMarkerInventoryPage(wire, id(1)); wire.markers[0].content.label = "Changed";
	expect(parsed.markers[0].content.label).toBe("Launch"); expect(parsed.markers[0]).not.toHaveProperty("placements");
});

test("inventory rejects duplicate/out-of-order IDs, extra placements, broken cursors and oversized pages", () => {
	const wire = page();
	for (const invalid of [{ ...wire, entry_id: id(99) }, { ...wire, view_id: id(3) }, { ...wire, markers: [marker(20), marker(20)] },
		{ ...wire, markers: [marker(21), marker(20)] }, { ...wire, markers: [{ ...marker(20), placements: [] }] }, { ...wire, next_after: id(99) },
		{ ...wire, markers: [], has_more: true, next_after: null }, page(Array.from({ length: 51 }, (_, index) => marker(index + 20))),
		{ ...wire, catalog_revision: 0 }, { ...wire, markers: [{ ...marker(20), revision: 0 }] }]) expect(() => parseTimelineMarkerInventoryPage(invalid, id(1))).toThrow();
	expect(() => parseTimelineMarkerInventoryPage(wire, id(1), id(20))).toThrow();
	expect(parseTimelineMarkerInventoryPage({ ...page([]), next_after: id(20) }, id(1), id(20)).markers).toEqual([]);
});

test("transport reads all base markers with revision-pinned bounded pages and no view filter", async () => {
	const fetcher = jest.fn().mockResolvedValueOnce(response(page([marker(20)], true))).mockResolvedValueOnce(response(page([marker(21)])));
	const result = await transport(fetcher).timelineMarkerInventory(scope);
	expect(result.markers.map(item => item.id)).toEqual([id(20), id(21)]); expect(result).not.toHaveProperty("has_more");
	expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ include_archived: true });
	expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ include_archived: true, expected_revision: 300, after: id(20) });
	expect(fetcher.mock.calls[0][0]).toContain(`/entries/${id(1)}/bases/timeline-markers/catalog`);
});

test.each(["definition_id", "generation", "registry_revision", "catalog_revision"])("inventory never returns partial data across a changed %s", async key => {
	const fetcher = jest.fn().mockResolvedValueOnce(response(page([marker(20)], true))).mockResolvedValueOnce(response({ ...page([marker(21)]), [key]: key.endsWith("revision") ? 999 : id(99) }));
	await expect(transport(fetcher).timelineMarkerInventory(scope)).rejects.toMatchObject({ code: "invalid_read_response" });
});

test.each(["count", "pages"])("inventory bounds total %s without exposing a partial list", async limit => {
	const fetcher = jest.fn().mockImplementation(async () => {
		const index = fetcher.mock.calls.length - 1;
		return response(page(Array.from({ length: limit === "count" ? 50 : 1 }, (_, i) => marker(100 + index * 50 + i)), true));
	});
	await expect(transport(fetcher).timelineMarkerInventory(scope)).rejects.toMatchObject({ code: "invalid_read_response" });
	expect(fetcher).toHaveBeenCalledTimes(6);
});

test("inventory supports the maximum 256 summaries without fetching per-marker placements", async () => {
	const fetcher = jest.fn().mockImplementation(async () => {
		const index = fetcher.mock.calls.length - 1;
		return response(page(Array.from({ length: index === 5 ? 6 : 50 }, (_, i) => marker(100 + index * 50 + i)), index < 5));
	});
	expect((await transport(fetcher).timelineMarkerInventory(scope)).markers).toHaveLength(256); expect(fetcher).toHaveBeenCalledTimes(6);
});
