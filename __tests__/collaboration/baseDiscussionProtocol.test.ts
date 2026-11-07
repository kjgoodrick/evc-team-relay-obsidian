import { BASE_TARGET_KINDS, BASE_RECORD_TYPES, parseAnchor, parseBaseTargetContext, parseChanges, parseThreadList, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { DiscussionTransport, queuedEnvelope } from "../../src/collaboration/DiscussionTransport";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2) };
const credential = async () => ({ accountId: id(1), accessToken: "synthetic" });
const anchor = (): BaseAnchor => ({ version: 1, type: "base", definition_id: id(3), view_id: id(4), generation: id(5), registry_revision: 7,
	target: { type: "cell", record_id: id(6), record_generation: id(7), property: { source: "note", name: "status" } } });
const context = () => ({ protocol_version: 1, entry_id: id(8), definition_id: id(3), view_id: id(4), generation: id(5), registry_revision: 7,
	record_id: id(6), record_generation: id(7) });
const thread = () => ({ id: id(9), author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1,
	removed: false, created_sequence: 3, activity_sequence: 3, created_at: "2026-11-06T00:00:00Z" });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("saved-view anchors preserve explicit lineage and target kinds without accepting unverified dependency schemes", () => {
	for (const target of [
		{ type: "view" }, { type: "item", record_id: id(6), record_generation: id(7) }, anchor().target,
		{ type: "property", property: { source: "file", name: "name" } },
	]) expect(parseAnchor({ ...anchor(), target, entry_id: id(8) })).toEqual({ ...anchor(), target });
	for (const target of [
		{ type: "view", record_id: id(6) }, { type: "item", record_id: id(6) },
		{ ...anchor().target, dependencies: [] }, { type: "timeline", lane: "unverified" },
		...[{ source: "formula", name: "cost" }, { source: "note", name: "a\nb" }, { source: "note", name: "\ud800" },
			{ source: "note", name: "😀".repeat(257) }].map(property => ({ type: "property", property })),
	]) expect(() => parseAnchor({ ...anchor(), target })).toThrow();
	for (const patch of [{ registry_revision: 0 }, { registry_revision: Number.MAX_SAFE_INTEGER + 1 }, { definition_id: "path.base" }]) {
		expect(() => parseAnchor({ ...anchor(), ...patch })).toThrow();
	}
});

test("context is bound to the requested definition entry, view and optional record", () => {
	expect(parseBaseTargetContext(context(), id(8), id(4), id(6))).toEqual(context());
	for (const args of [[id(9), id(4), id(6)], [id(8), id(9), id(6)], [id(8), id(4), id(9)], [id(8), id(4)]]) {
		expect(() => parseBaseTargetContext(context(), args[0], args[1], args[2])).toThrow();
	}
});

test("only explicitly requested saved-view pages can advance over hidden threads", () => {
	const empty = { threads: [], next_after: 5, scanned_through: 5, has_more: true, view_id: id(4) };
	expect(parseThreadList(empty, 0, id(4))).toEqual(empty);
	for (const [value, view] of [[empty, undefined], [empty, id(9)], [{ ...empty, scanned_through: 4 }, id(4)],
		[{ ...empty, next_after: 0, scanned_through: 0 }, id(4)], [{ ...empty, threads: [thread()], next_after: 2, scanned_through: 2 }, id(4)]] as const) {
		expect(() => parseThreadList(value, 0, view)).toThrow();
	}
	expect(parseThreadList({ ...empty, threads: [thread()] }, 0, id(4)).threads).toHaveLength(1);
	expect(() => parseThreadList({ ...empty, threads: [thread(), thread()] }, 0, id(4))).toThrow();
	expect(() => parseThreadList({ threads: [], next_after: 1, has_more: true }, 0)).toThrow();
});

test("filtered changes require matching view evidence and preserve empty advancing pages", () => {
	const page = { events: [], cursor: "opaque", has_more: true, view_id: id(4), filtered: true };
	expect(parseChanges(page, id(4))).toEqual(page);
	expect(() => parseChanges(page)).toThrow();
	expect(() => parseChanges(page, id(9))).toThrow();
	expect(() => parseChanges({ ...page, filtered: false }, id(4))).toThrow();
	const event = { kind: "thread.state", sequence: 2, data: { operation_id: id(10), scope_id: id(11), thread_id: id(9),
		actor_id: id(1), sequence: 2, state: "resolved", state_revision: 2, removed: false, changed: true, view_id: id(4) } };
	expect(parseChanges({ ...page, events: [event] }, id(4)).events[0].data.view_id).toBe(id(4));
	expect(() => parseChanges({ ...page, events: [{ ...event, data: { ...event.data, view_id: id(9) } }] }, id(4))).toThrow();
});

test("transport negotiates supported targets, requests context and refuses cross-view or cross-entry reads", async () => {
	const fetcher = jest.fn().mockImplementation(async () => reply({ protocol_version: 1, features: { discussion_commands: true, discussion_bases: true, discussion_base_definition_catalog: true, discussion_base_groups: true, discussion_timeline_markers: true },
		discussion_base_targets: [...BASE_TARGET_KINDS, "future_target"] }));
	const transport = new DiscussionTransport(identity, credential, fetcher);
	expect((await transport.capabilities()).baseTargets).toEqual(BASE_TARGET_KINDS);
	fetcher.mockImplementation(async () => reply(context()));
	expect(await transport.baseTargetContext(id(8), id(4), id(6))).toEqual(context());
	expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ view_id: id(4), record_id: id(6) });
	await expect(transport.baseTargetContext(id(8), id(4), "bad")).rejects.toMatchObject({ code: "invalid_local_target" });
	const page = { thread: thread(), anchor: { ...anchor(), entry_id: id(8) }, messages: [], has_more: false, next_after: 0 };
	fetcher.mockImplementation(async () => reply(page));
	expect((await transport.thread(id(8), id(9), 0, id(4))).anchor).toEqual(anchor());
	await expect(transport.thread(id(8), id(9), 0, id(10))).rejects.toMatchObject({ code: "invalid_read_response" });
	await expect(transport.thread(id(10), id(9))).rejects.toMatchObject({ code: "invalid_read_response" });
	fetcher.mockImplementation(async () => reply({ threads: [], has_more: true, next_after: 5, scanned_through: 5, view_id: id(4) }));
	expect((await transport.threads(id(8), 0, id(4))).next_after).toBe(5);
	expect(fetcher.mock.calls.at(-1)![0]).toContain("&view_id=" + id(4));
});

test("record capabilities are explicit, bounded and conservative with older servers", async () => {
	const base = { protocol_version: 1, features: { discussion_commands: true, discussion_bases: true }, discussion_base_targets: BASE_TARGET_KINDS };
	const fetcher = jest.fn().mockImplementation(async () => reply(base));
	const transport = new DiscussionTransport(identity, credential, fetcher);
	expect((await transport.capabilities()).baseRecordTypes).toEqual(["markdown"]);
	for (const kinds of [[...BASE_RECORD_TYPES, "future"], [], ["folder", "image"]]) {
		fetcher.mockImplementation(async () => reply({ ...base, discussion_base_record_types: kinds }));
		expect((await transport.capabilities()).baseRecordTypes).toEqual(BASE_RECORD_TYPES.filter(kind => kinds.includes(kind)));
	}
	for (const kinds of [null, "image", [1], ["image", "image"], ["x".repeat(65)], Array.from({ length: 33 }, (_, n) => String(n))]) {
		fetcher.mockImplementation(async () => reply({ ...base, discussion_base_record_types: kinds }));
		await expect(transport.capabilities()).rejects.toMatchObject({ code: "invalid_read_response" });
	}
	fetcher.mockImplementation(async () => reply({ ...base, features: { ...base.features, discussion_bases: false }, discussion_base_record_types: BASE_RECORD_TYPES }));
	expect((await transport.capabilities()).baseRecordTypes).toEqual([]);
});

test.each([["base_discussions_disabled", "pause"], ["base_group_summaries_disabled", "pause"], ["base_definition_not_synced", "retry"], ["base_view_unavailable", "reject"]])(
	"Bases error %s retains its delivery classification", async (code, action) => {
		const operation = { operationId: id(12), scopeId: id(8), type: "thread.create" as const, dependsOn: [],
			payload: { type: "thread.create", thread_id: id(9), message_id: id(10), anchor: anchor() } };
		expect(JSON.parse(queuedEnvelope(id(2), operation)).command.anchor).toEqual(anchor());
		const transport = new DiscussionTransport(identity, credential, async () => reply({ detail: { code } }, 409));
		await expect(transport.send(operation)).rejects.toMatchObject({ code, action });
	});

test("group-summary creation requires an explicit target plus definition and group support", async () => {
	for (const catalog of [false, true]) for (const groups of [false, true]) for (const advertised of [false, true]) {
		const transport = new DiscussionTransport(identity, credential, async () => reply({ protocol_version: 1,
			features: { discussion_commands: true, discussion_bases: true, discussion_base_definition_catalog: catalog, discussion_base_groups: groups },
			discussion_base_targets: advertised ? ["group_summary"] : ["summary", "group"] }));
		expect((await transport.capabilities()).baseTargets.includes("group_summary")).toBe(catalog && groups && advertised);
	}
});
