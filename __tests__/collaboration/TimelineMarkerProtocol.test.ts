import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { bodyFromText, parseAnchor, parseChanges, protocolJson, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { parseTimelineMarkerContent } from "../../src/collaboration/TimelineMarkerContent";
import { parseTimelineMarkerCatalog, parseTimelineMarkerPage } from "../../src/collaboration/TimelineMarkerProtocol";
import { DiscussionTransport, queuedEnvelope } from "../../src/collaboration/DiscussionTransport";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const axis = { version: 1 as const, renderer: "sabidurian-sequence" as const, start_property: { source: "note" as const, name: "order" }, end_property: null, time_zone: null };
const range = { version: 1 as const, kind: "ordinal" as const, start: "999999999999999.000000001", end: "999999999999999.000000001", start_inclusive: true, end_inclusive: true, unit: "property-value" as const };
const content = { kind: "point" as const, label: "Milestone", color: "#ab12ef", range };
const target = { type: "timeline_marker" as const, marker_id: id(20), marker_revision: 2, axis_definition_id: id(6), axis_definition_revision: 5, axis, content };
const marker = { id: id(20), revision: 2, active: true, content,
	placement: { view_id: id(3), active: true, axis_definition_id: id(6), axis_definition_revision: 5, axis }, target };
const wire = { protocol_version: 1, entry_id: id(1), definition_id: id(2), generation: id(4), registry_revision: 5,
	catalog_revision: 3, markers: [marker], has_more: false, next_after: id(20) };
const anchor: BaseAnchor = { version: 1, type: "base", definition_id: id(2), view_id: id(3), generation: id(4), registry_revision: 5, target };
const scope = baseDiscussionScope(id(1), id(3));

test("change pages carry only strictly scoped marker revision hints and preserve legacy responses", () => {
	const version = { protocol_version: 1, entry_id: id(1), view_id: id(3), definition_id: id(2), generation: id(4), registry_revision: 5, catalog_revision: 3 };
	const page = { events: [], cursor: "checkpoint", has_more: false, view_id: id(3), filtered: true };
	expect(parseChanges(page, id(3))).toEqual(page);
	expect(parseChanges({ ...page, timeline_markers: version }, id(3), id(1)).timeline_markers).toEqual(version);
	for (const patch of [{ entry_id: id(99) }, { view_id: id(99) }, { catalog_revision: -1 }, { registry_revision: 0 }, { label: "Untrusted content" }]) {
		expect(() => parseChanges({ ...page, timeline_markers: { ...version, ...patch } }, id(3), id(1))).toThrow();
	}
	expect(() => parseChanges({ events: [], cursor: "checkpoint", has_more: false, timeline_markers: version })).toThrow();
});

test("marker anchors preserve exact point coordinates, captured content and immutable revision", () => {
	expect(parseAnchor(anchor)).toEqual(anchor);
	const parsed = parseAnchor(anchor) as BaseAnchor;
	expect(parsed.target).not.toBe(anchor.target);
	for (const patch of [{ marker_id: "bad" }, { marker_revision: 0 }, { axis_definition_revision: 6 },
		{ range }, { lane: { type: "view" } }, { content: { ...content, color: "red" } },
		{ axis: { ...axis, renderer: "sabidurian-timeline" } }]) {
		expect(() => parseAnchor({ ...anchor, target: { ...target, ...patch } })).toThrow();
	}
});

test("point content requires one normalized closed coordinate and plain bounded labels", () => {
	expect(parseTimelineMarkerContent({ ...content, color: "#AB12EF" })).toEqual(content);
	for (const label of ["", " ", "bad\nlabel", "x".repeat(257), "\ud800"]) expect(() => parseTimelineMarkerContent({ ...content, label })).toThrow();
	expect(parseTimelineMarkerContent({ ...content, label: "🎉".repeat(256) }).label).toHaveLength(512);
	for (const bounds of [{ end: "999999999999999.000000002" }, { end_inclusive: false }]) {
		expect(() => parseTimelineMarkerContent({ ...content, range: { ...range, ...bounds } })).toThrow();
	}
	const historical = { version: 1, kind: "historical", start: { precision: "year", year: -500 }, end: { precision: "year", year: -500 },
		start_inclusive: true, end_inclusive: true, calendar: "proleptic-gregorian", year_numbering: "astronomical" };
	expect(parseTimelineMarkerContent({ ...content, range: historical }).range).toEqual(historical);
	expect(() => parseTimelineMarkerContent({ ...content, range: { ...historical, end: { precision: "month", year: -500, month: 1 } } })).toThrow();
});

test("catalog decoding validates every identity, duplicate, revision, placement and redundant target", () => {
	expect(parseTimelineMarkerPage(wire, id(1), id(3))).toMatchObject({ view_id: id(3), markers: [marker] });
	for (const value of [{ ...wire, entry_id: id(99) }, { ...wire, view_id: id(99) }, { ...wire, catalog_revision: 1 },
		{ ...wire, markers: [marker, marker] }, { ...wire, record_id: id(9) }, { ...wire, registry_revision: 4 }]) {
		expect(() => parseTimelineMarkerCatalog(value, id(1), id(3))).toThrow();
	}
	for (const change of [{ placement: { ...marker.placement, view_id: id(99) } }, { active: "yes" },
		{ target: { ...target, marker_id: id(99) } }, { target: { ...target, content: { ...content, label: "Forged" } } },
		{ target: { ...target, axis: { ...axis, start_property: { source: "note", name: "different" } } } },
		{ placement: { ...marker.placement, pixels: 5 } }]) {
		expect(() => parseTimelineMarkerCatalog({ ...wire, markers: [{ ...marker, ...change }] }, id(1), id(3))).toThrow();
	}
	for (const change of [{ next_after: id(99) }, { markers: [], has_more: true, next_after: null }]) {
		expect(() => parseTimelineMarkerPage({ ...wire, ...change }, id(1), id(3))).toThrow();
	}
	expect(() => parseTimelineMarkerPage(wire, id(1), id(3), id(20))).toThrow();
	expect(parseTimelineMarkerPage({ ...wire, markers: [], next_after: id(20) }, id(1), id(3), id(20)).markers).toEqual([]);
});

test("inactive placements retain metadata when current content no longer fits their old axis", () => {
	const oldAxis = { ...axis, renderer: "sabidurian-timeline", time_zone: "UTC" };
	const archived = { ...marker, placement: { ...marker.placement, active: false, axis: oldAxis }, target: { ...target, axis: oldAxis } };
	expect(parseTimelineMarkerCatalog({ ...wire, markers: [archived] }, id(1), id(3)).markers[0].placement.active).toBe(false);
	expect(() => parseAnchor({ ...anchor, target: archived.target })).toThrow();
	expect(() => parseTimelineMarkerCatalog({ ...wire, markers: [{ ...archived, placement: { ...archived.placement, active: true } }] }, id(1), id(3))).toThrow();
});

const transportFor = (fetcher: jest.Mock) => new DiscussionTransport({ serverId: "https://relay.test", shareId: id(10), accountId: id(11) }, async () => ({ accountId: id(11), accessToken: "synthetic" }), fetcher);
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
test("transport pins catalog revision across pages and keeps archived marker context", async () => {
	const second = { ...marker, id: id(21), target: { ...target, marker_id: id(21) }, active: false };
	const fetcher = jest.fn().mockResolvedValueOnce(response({ ...wire, has_more: true })).mockResolvedValueOnce(response({ ...wire, markers: [second], next_after: id(21) }));
	const transport = transportFor(fetcher), result = await transport.timelineMarkers(scope, id(3));
	expect(result.markers).toEqual([marker, second]);
	expect(fetcher.mock.calls[0][0]).toContain("/entries/" + id(1) + "/bases/timeline-markers/catalog");
	expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ view_id: id(3), include_archived: true, expected_revision: 3, after: id(20) });
	await expect(transport.timelineMarkers(scope, id(99))).rejects.toMatchObject({ code: "invalid_local_target" });
	expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each(["catalog_revision", "registry_revision", "generation", "definition_id"])("transport refuses a torn %s between catalog pages", async key => {
	const fetcher = jest.fn().mockResolvedValueOnce(response({ ...wire, has_more: true })).mockResolvedValueOnce(response({ ...wire, markers: [],
		[key]: key.endsWith("revision") ? 6 : id(99) }));
	await expect(transportFor(fetcher).timelineMarkers(scope, id(3))).rejects.toMatchObject({ code: "invalid_read_response" });
});

test("marker creation requires both target and feature advertisement; old servers stay readable", async () => {
	const caps = (enabled?: unknown) => ({ protocol_version: 1, features: { discussion_commands: true, discussion_bases: true,
		...(enabled === undefined ? {} : { discussion_timeline_markers: enabled }) }, discussion_base_targets: ["view", "timeline_marker"] });
	for (const enabled of [undefined, false, true]) {
		const result = await transportFor(jest.fn().mockResolvedValue(response(caps(enabled)))).capabilities();
		expect(result.baseTargets.includes("timeline_marker")).toBe(enabled === true);
	}
	await expect(transportFor(jest.fn().mockResolvedValue(response(caps("yes")))).capabilities()).rejects.toMatchObject({ code: "invalid_read_response" });
});

test("marker drafts and queued commands survive restart and fence version 18 workers", async () => {
	const factory = new IDBFactory(), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "marker-cache" };
	let store = await DiscussionStore.open(identity, factory);
	const operation = { operationId: id(10), scopeId: scope, type: "thread.create" as const, dependsOn: [], payload: protocolJson({ type: "thread.create",
		thread_id: id(11), message_id: id(12), anchor, body: bodyFromText("Review milestone") }) };
	await store.saveDraft({ id: "marker-draft", scopeId: scope, revision: 1, body: "Discussion", target: protocolJson(anchor) });
	await store.enqueue(operation); store.close(); store = await DiscussionStore.open(identity, factory);
	try {
		expect(parseAnchor((await store.getDraft("marker-draft"))?.target)).toEqual(anchor);
		expect(JSON.parse(queuedEnvelope(id(2), (await store.pending(scope))[0])).command.anchor).toEqual(anchor);
		await expect(new Promise((resolve, reject) => {
			const old = factory.open("team-relay-discussions:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]), 18);
			old.onerror = () => reject(old.error); old.onsuccess = () => { old.result.close(); resolve(undefined); };
		})).rejects.toMatchObject({ name: "VersionError" });
		await store.setPreference("timelineMarkers:" + scope, protocolJson(parseTimelineMarkerCatalog(wire, id(1), id(3))));
		await store.clearRemoteScope(scope);
		expect(await store.preference("timelineMarkers:" + scope)).toBeUndefined();
		expect((await store.getDraft("marker-draft"))?.target).toEqual(anchor);
		expect(await store.pending(scope)).toHaveLength(1);
	} finally { store.close(); }
});
