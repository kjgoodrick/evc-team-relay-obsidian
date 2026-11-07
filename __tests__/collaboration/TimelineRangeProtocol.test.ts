import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { parseAnchor, parseTimelineAxis, protocolJson, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { DiscussionTransport, queuedEnvelope } from "../../src/collaboration/DiscussionTransport";
import { parseTimelineAxisContext } from "../../src/collaboration/TimelineRangeProtocol";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
Object.assign(globalThis, { IDBKeyRange });
const axis = { version: 1 as const, renderer: "sabidurian-sequence" as const, start_property: { source: "note" as const, name: "order" }, end_property: null, time_zone: null };
const range = { version: 1 as const, kind: "ordinal" as const, start: "999999999999999.000000001", end: "999999999999999.000000002", start_inclusive: true, end_inclusive: false, unit: "property-value" as const };
const context = { protocol_version: 1 as const, entry_id: id(1), definition_id: id(2), view_id: id(3), generation: id(4), registry_revision: 5,
	axis: { id: id(6), kind: "axis" as const, revision: 5, fingerprint: "a".repeat(64), axis } };
const anchor: BaseAnchor = { version: 1, type: "base", definition_id: id(2), view_id: id(3), generation: id(4), registry_revision: 5,
	target: { type: "timeline_range", axis_definition_id: id(6), axis_definition_revision: 5, axis, range } };
const scope = baseDiscussionScope(id(1), id(3));

test("range wire anchors retain exact values and lane witnesses without becoming record targets", () => {
	expect(parseAnchor(anchor)).toEqual(anchor);
	const lane = { type: "group", definition_id: id(7), definition_revision: 3, property: { source: "note", name: "status" }, group_id: id(8), witness_id: id(9), value: { type: "text", value: "Done" } };
	const withLane = { ...anchor, target: { ...anchor.target, lane } };
	expect(parseAnchor(withLane)).toEqual(withLane);
	for (const patch of [{ axis_definition_revision: 6 }, { axis_definition_id: "bad" }, { record_id: id(8) },
		{ lane: { ...lane, witness_id: "bad" } }, { lane: { ...anchor.target } }, { lane: { type: "view" } },
		{ axis: { ...axis, time_zone: "UTC" } }, { range: { ...range, unit: "pixels" } }]) {
		expect(() => parseAnchor({ ...anchor, target: { ...anchor.target, ...patch } })).toThrow();
	}
});

test("axis discovery validates response lineage, revisions and coordinate types", () => {
	expect(parseTimelineAxisContext(context, id(1), id(3))).toEqual(context);
	for (const value of [{ ...context, entry_id: id(99) }, { ...context, view_id: id(99) },
		{ ...context, axis: { ...context.axis, revision: 6 } }, { ...context, axis: { ...context.axis, fingerprint: "bad" } }]) {
		expect(() => parseTimelineAxisContext(value, id(1), id(3))).toThrow();
	}
	expect(() => parseTimelineAxis({ ...axis, end_property: { source: "formula", name: "" } })).toThrow();
});

test("transport uses the scoped axis endpoint and refuses a different saved view", async () => {
	const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify(context), { status: 200 }));
	const transport = new DiscussionTransport({ serverId: "https://relay.test", shareId: id(10), accountId: id(11) }, async () => ({ accountId: id(11), accessToken: "synthetic" }), fetcher);
	expect(await transport.timelineAxis(scope, id(3), 5)).toEqual(context);
	expect(fetcher.mock.calls[0][0]).toContain("/entries/" + id(1) + "/bases/timeline-axis");
	expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ view_id: id(3), expected_revision: 5 });
	await expect(transport.timelineAxis(scope, id(99))).rejects.toMatchObject({ code: "invalid_local_target" });
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test("range drafts and commands survive reopening while older cache writers are fenced", async () => {
	const factory = new IDBFactory(), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "range-cache" };
	let store = await DiscussionStore.open(identity, factory);
	const op = { operationId: id(10), scopeId: scope, type: "thread.create" as const, dependsOn: [], payload: protocolJson({ type: "thread.create", thread_id: id(11), message_id: id(12), anchor, body: { version: 1, blocks: [] } }) };
	await store.saveDraft({ id: "range-draft", scopeId: scope, revision: 1, body: "Discussion", target: protocolJson(anchor) });
	await store.enqueue(op); store.close(); store = await DiscussionStore.open(identity, factory);
	try {
		expect((await store.getDraft("range-draft"))?.target).toEqual(anchor);
		expect(JSON.parse(queuedEnvelope(id(2), (await store.pending(scope))[0])).command.anchor).toEqual(anchor);
		await expect(new Promise((resolve, reject) => {
			const old = factory.open("team-relay-discussions:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]), 17);
			old.onerror = () => reject(old.error); old.onsuccess = () => { old.result.close(); resolve(undefined); };
		})).rejects.toMatchObject({ name: "VersionError" });
	} finally { store.close(); }
});
