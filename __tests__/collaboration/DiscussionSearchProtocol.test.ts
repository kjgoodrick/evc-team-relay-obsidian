import { parseSearchPage, searchEnvelope, searchItemScope, searchRequest, type DiscussionSearchRequest } from "../../src/collaboration/DiscussionSearchProtocol";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const request: DiscussionSearchRequest = { query: "Private words", state: "all", mine: false, mentions: false, cursor: null, limit: 30 };
const item = { thread: { id: id(4), author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1, removed: false, created_sequence: 1, activity_sequence: 3, created_at: "2026-11-07T00:00:00Z" },
	entry_id: id(3), kind: "note", path: "Notes/One.md", view_id: null, message_id: id(5), message_revision: 1, message_sequence: 3, excerpt: "Matching private words" };
const page = () => ({ protocol_version: 1, items: [item], next_cursor: null });

test("search preserves saved-view scope and permits empty bounded-scan continuation pages", () => {
	const scope = baseDiscussionScope(id(3), id(6)), selected = { ...request, scopeId: scope };
	expect(JSON.parse(searchEnvelope(selected))).toMatchObject({ entry_id: id(3), view_id: id(6), query: request.query });
	const result = parseSearchPage({ ...page(), items: [{ ...item, kind: "base", view_id: id(6) }] }, selected);
	expect(searchItemScope(result.items[0])).toBe(scope); expect(Object.isFrozen(result.items[0])).toBe(true);
	expect(parseSearchPage({ protocol_version: 1, items: [], next_cursor: "opaque_cursor" }, request)).toEqual({ items: [], next_cursor: "opaque_cursor" });
});

test.each([
	{ query: "x".repeat(257) }, { query: "\ud800" }, { query: "private\u0000word" }, { state: "deleted" }, { mine: "true" },
	{ mentions: 1 }, { cursor: "not a cursor" }, { scopeId: "file.md" }, { limit: 51 }, { limit: true }, { target: id(3) },
])("search rejects malformed requests %p", change => {
	expect(() => searchRequest({ ...request, ...change } as unknown as DiscussionSearchRequest)).toThrow("Invalid discussion search");
});

test.each([
	{ thread: { ...item.thread, removed: true } }, { kind: "base" }, { view_id: id(6) }, { message_sequence: 4 },
	{ message_revision: 0 }, { path: "Hidden\npath" }, { excerpt: "x".repeat(481) }, { entry_id: "unknown" },
])("search rejects inconsistent server results %p", change => {
	expect(() => parseSearchPage({ ...page(), items: [{ ...item, ...change }] }, request)).toThrow();
});

test("search rejects duplicate/out-of-order results and another requested scope or state", () => {
	expect(() => parseSearchPage({ ...page(), items: [item, item] }, request)).toThrow();
	expect(() => parseSearchPage(page(), { ...request, scopeId: id(90) })).toThrow();
	expect(() => parseSearchPage(page(), { ...request, state: "resolved" })).toThrow();
});

test("transport puts terms in a sensitive POST and captures immutable filters before credential refresh", async () => {
	let release!: (value: { accountId: string; accessToken: string }) => void;
	const credential = new Promise<{ accountId: string; accessToken: string }>(resolve => { release = resolve; });
	const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify(page()), { status: 200 }));
	const transport = new DiscussionTransport({ serverId: "https://relay.test", shareId: id(2), accountId: id(1) }, () => credential, fetcher);
	const mutable = { ...request }, search = transport.search(mutable); mutable.query = "Changed";
	release({ accountId: id(1), accessToken: "synthetic" }); await search;
	const [url, config] = fetcher.mock.calls[0];
	expect(url).toBe(`https://relay.test/v1/collaboration/shares/${id(2)}/search`);
	expect(config).toMatchObject({ method: "POST", sensitive: true }); expect(JSON.parse(config.body).query).toBe("Private words");
});

test("search capabilities require a boolean and an enabled discussion service", async () => {
	for (const value of [true, false, "true"]) {
		const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify({ protocol_version: 1, features: { discussion_commands: true, discussion_search: value } }), { status: 200 }));
		const transport = new DiscussionTransport({ serverId: "https://relay.test", shareId: id(2), accountId: id(1) }, async () => ({ accountId: id(1), accessToken: "synthetic" }), fetcher);
		if (typeof value === "boolean") expect((await transport.capabilities()).search).toBe(value);
		else await expect(transport.capabilities()).rejects.toMatchObject({ action: "pause" });
	}
});
