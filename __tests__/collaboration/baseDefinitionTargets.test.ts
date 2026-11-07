import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { parseBaseDefinitionCatalog, parseBaseDefinitionPage, type BaseDefinitionCatalog } from "../../src/collaboration/BaseDefinitionProtocol";
import { parseAnchor, protocolJson, bodyFromText, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { DiscussionTransport, DiscussionFailure } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "definitions" };
const scope = baseDiscussionScope(id(3), id(4));
const definition = (n = 10, revision = 2) => ({ id: id(n), kind: "formula" as const, revision, fingerprint: "a".repeat(64), property: { source: "formula" as const, name: "Total " + n } });
const catalog = (revision = 2): BaseDefinitionCatalog => ({ protocol_version: 1, entry_id: id(3), view_id: id(4), definition_id: id(5), generation: id(6),
	registry_revision: revision, computed_values: false, targets: [definition(10, revision), { ...definition(11, revision), kind: "summary", summary: "Average" }] });
const selection = { type: "formula" as const, definitionId: id(10), definitionRevision: 2 };
function anchor(): BaseAnchor { return { version: 1, type: "base", definition_id: id(5), view_id: id(4), generation: id(6), registry_revision: 2,
	target: { type: "formula", definition_id: id(10), definition_revision: 2, property: definition().property } }; }
function remote() {
	return { identity, capabilities: jest.fn().mockResolvedValue({ discussions: true, baseTargets: ["view", "formula", "summary", "formula_cell"], baseRecordTypes: ["markdown"] }),
		permissions: jest.fn().mockResolvedValue({ read: true, comment: true, edit: false, moderate: false }),
		participants: jest.fn().mockResolvedValue({ participants: [], hasMore: false }),
		baseTargetContext: jest.fn().mockResolvedValue({ protocol_version: 1, entry_id: id(3), view_id: id(4), definition_id: id(5), generation: id(6), registry_revision: 2 }),
		baseDefinitions: jest.fn().mockResolvedValue(catalog()), changes: jest.fn().mockResolvedValue({ events: [], cursor: "current", has_more: false }), send: jest.fn() };
}
async function open(factory: IDBFactory, transport = remote()) {
	const store = await DiscussionStore.open(identity, factory), session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	await session.start(); session.watch(scope, () => {}, "base"); await session.refresh(); session.setForeground(false); await session.outbox.settled();
	return { store, session, transport };
}
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1)); expect(check()).toBe(true); }
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("definition codecs retain typed lineage and reject evaluated data, malformed enums and future revisions", () => {
	expect(parseAnchor(anchor())).toEqual(anchor());
	const summary = { ...anchor(), target: { ...anchor().target, type: "summary", summary: "Average" } };
	expect(parseAnchor(summary)).toEqual(summary);
	const cell = { ...anchor(), target: { ...anchor().target, type: "formula_cell", record_id: id(20), record_generation: id(21) } };
	expect(parseAnchor(cell)).toEqual(cell);
	for (const patch of [{ record_id: undefined }, { record_generation: "path.md" }, { dependency_ids: [] }, { property: { source: "note", name: "Total" } }]) {
		expect(() => parseAnchor({ ...cell, target: { ...cell.target, ...patch } })).toThrow();
	}
	for (const target of [
		{ ...anchor().target, definition_revision: 3 }, { ...anchor().target, computed_value: "private" },
		{ ...anchor().target, property: { source: ["formula"], name: "Total" } },
		{ ...anchor().target, property: { source: "note", name: "Total" } },
		{ ...summary.target, summary: "bad\ud800" },
	]) expect(() => parseAnchor({ ...anchor(), target })).toThrow();
	for (const patch of [{ kind: ["formula"] }, { revision: 3 }, { id: "path.base" }, { property: { source: ["formula"], name: "Total" } }]) {
		expect(() => parseBaseDefinitionCatalog({ ...catalog(), targets: [{ ...definition(), ...patch }] }, id(3), id(4))).toThrow();
	}
	expect(() => parseBaseDefinitionCatalog({ ...catalog(), computed_values: true }, id(3), id(4))).toThrow();
	expect(() => parseBaseDefinitionCatalog({ ...catalog(), targets: [definition(), definition()] }, id(3), id(4))).toThrow();
	expect(() => parseBaseDefinitionCatalog(catalog(), id(3), id(7))).toThrow();
	expect(() => parseBaseDefinitionPage({ ...catalog(), has_more: true, next_after: id(100) }, id(3), id(4))).toThrow();
});

test("record batches deduplicate in-flight reads, distinguish offline proof, and retain only the last page", async () => {
	const factory = new IDBFactory(), s = await open(factory); let next: Awaited<ReturnType<typeof open>> | undefined;
	const { targets: _targets, computed_values: _computed, ...context } = catalog();
	const value = { ...context, records: [{ record_id: id(20), record_generation: id(21) }] };
	const read = jest.fn().mockResolvedValue(value); Object.assign(s.transport, { baseRecordContexts: read });
	try {
		s.session.setForeground(true); await s.session.refresh(); s.session.outbox.stop(); await s.session.outbox.settled();
		const [a, b] = await Promise.all([s.session.readBaseRecordContexts(scope, [id(20)]), s.session.readBaseRecordContexts(scope, [id(20)])]);
		expect(a).toBe(b); expect(read).toHaveBeenCalledTimes(1); expect(s.session.verifiedTargetCatalog(a)).toBe(true);
		read.mockRejectedValueOnce(new DiscussionFailure("retry", "network_unavailable"));
		const cached = await s.session.readBaseRecordContexts(scope, [id(20)]); expect(cached).toEqual(value); expect(s.session.verifiedTargetCatalog(cached)).toBe(false);
		await s.session.close();
		const offline = remote(); for (const call of [offline.capabilities, offline.permissions, offline.baseTargetContext, offline.changes]) call.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		next = await open(factory, offline); Object.assign(next.transport, { baseRecordContexts: jest.fn() });
		expect(await next.session.readBaseRecordContexts(scope, [id(20)])).toEqual(value);
		await expect(next.session.readBaseRecordContexts(scope, [id(99)])).rejects.toThrow();
		expect((next.transport as unknown as { baseRecordContexts: jest.Mock }).baseRecordContexts).not.toHaveBeenCalled();
	} finally { await s.session.close(); await next?.session.close(); }
});

test.each(["success", "denial"] as const)("a competing record batch fences a late %s without overwriting the newer page", async outcome => {
	const factory = new IDBFactory(), a = await open(factory), b = await open(factory); let finish!: (value: unknown) => void, fail!: (error: unknown) => void;
	const { targets: _targets, computed_values: _computed, ...context } = catalog();
	const old = { ...context, records: [{ record_id: id(20), record_generation: id(21) }] };
	const newer = { ...context, records: [{ record_id: id(22), record_generation: id(23) }] };
	const slow = jest.fn(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
	Object.assign(a.transport, { baseRecordContexts: slow }); Object.assign(b.transport, { baseRecordContexts: jest.fn().mockResolvedValue(newer) });
	try {
		const reading = a.session.readBaseRecordContexts(scope, [id(20)]), rejected = expect(reading).rejects.toThrow();
		await until(() => !!finish); await b.session.readBaseRecordContexts(scope, [id(22)]);
		if (outcome === "success") finish(old); else fail(new DiscussionFailure("reject", "target_unavailable", 404));
		await rejected;
		expect(await a.store.preference("baseRecords:" + scope)).toEqual(newer);
	} finally { finish?.(old); await a.session.close(); await b.session.close(); }
});

test("formula cells require both record permission and definition proof across offline restart", async () => {
	const factory = new IDBFactory(), first = await open(factory);
	const choice = { ...selection, type: "formula_cell" as const, recordId: id(20) };
	let next: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const context = { ...catalog(), record_id: id(20), record_generation: id(21) };
		first.transport.baseTargetContext.mockResolvedValue(context);
		const captured = await first.session.captureBaseTarget(scope, choice);
		expect(captured.target).toMatchObject({ type: "formula_cell", record_id: id(20), record_generation: id(21), definition_id: id(10) });
		expect(first.transport.permissions).toHaveBeenCalledWith(id(20));
		await first.store.saveDraft({ id: "cell", scopeId: scope, revision: 1, body: "Cell review", target: protocolJson(captured) });
		await first.session.close();
		const remoteOffline = remote(); for (const call of [remoteOffline.capabilities, remoteOffline.permissions, remoteOffline.baseDefinitions, remoteOffline.baseTargetContext, remoteOffline.changes]) call.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		next = await open(factory, remoteOffline);
		expect(await next.session.captureBaseTarget(scope, choice)).toEqual(captured);
		expect((await next.store.getDraft("cell"))?.target).toEqual(captured);
		await expect(next.session.captureBaseTarget(scope, { ...choice, recordId: id(99) })).rejects.toThrow("verify this saved view and record");
		await next.store.setPreference("baseRecordComment:" + scope + ":" + id(20), false);
		await expect(next.session.captureBaseTarget(scope, choice)).rejects.toThrow("verify this saved view and record");
	} finally { await (next?.session ?? first.session).close(); }
});

test("a formula-cell capture rejects a changed definition after record verification without rewriting its draft", async () => {
	const s = await open(new IDBFactory());
	try {
		s.transport.baseTargetContext.mockResolvedValue({ ...catalog(), record_id: id(20), record_generation: id(21) });
		const choice = { ...selection, type: "formula_cell" as const, recordId: id(20) };
		const captured = await s.session.captureBaseTarget(scope, choice);
		await s.store.saveDraft({ id: "kept-cell", scopeId: scope, revision: 1, body: "Keep", target: protocolJson(captured) });
		s.transport.baseDefinitions.mockResolvedValue(catalog(3));
		await expect(s.session.captureBaseTarget(scope, choice)).rejects.toThrow("definition changed");
		expect(await s.session.baseDefinitionStatus(scope, captured)).toContain("has changed");
		expect((await s.store.getDraft("kept-cell"))?.target).toEqual(captured);
		s.transport.permissions.mockResolvedValue({ read: true, comment: false, edit: false, moderate: false });
		await expect(s.session.captureBaseTarget(scope, { ...choice, definitionRevision: 3 })).rejects.toMatchObject({ code: "comment_forbidden" });
	} finally { await s.session.close(); }
});

test("catalogue transport completes bounded pages and refuses mixed revisions, duplicate progress and missing capability", async () => {
	const pages = [{ ...catalog(), targets: Array.from({ length: 100 }, (_, n) => definition(n + 20)), has_more: true, next_after: id(119) },
		{ ...catalog(), targets: [definition(120)], has_more: false, next_after: id(120) }];
	const fetcher = jest.fn().mockImplementationOnce(async () => reply(pages[0])).mockImplementationOnce(async () => reply(pages[1]));
	const transport = new DiscussionTransport(identity, async () => ({ accountId: id(1), accessToken: "synthetic" }), fetcher);
	expect((await transport.baseDefinitions(scope, id(4))).targets).toHaveLength(101);
	expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ view_id: id(4), expected_revision: 2, after: id(119) });
	for (const second of [{ ...pages[1], registry_revision: 3 }, { ...pages[1], targets: [definition(119)], next_after: id(119) }, { ...pages[1], generation: id(9) }]) {
		fetcher.mockReset().mockImplementationOnce(async () => reply(pages[0])).mockImplementationOnce(async () => reply(second));
		await expect(transport.baseDefinitions(scope, id(4))).rejects.toMatchObject({ code: "invalid_read_response" });
	}
	fetcher.mockReset().mockResolvedValue(reply({ protocol_version: 1, features: { discussion_commands: true, discussion_bases: true }, discussion_base_targets: ["view", "formula", "summary"] }));
	expect((await transport.capabilities()).baseTargets).toEqual(["view"]);
});

test("verified definition drafts and queued targets survive offline restart without another network request", async () => {
	const factory = new IDBFactory(), first = await open(factory);
	let next: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const captured = await first.session.captureBaseTarget(scope, selection);
		expect(captured).toEqual(anchor());
		await first.store.saveDraft({ id: "definition-draft", scopeId: scope, revision: 1, body: "Keep this", target: protocolJson(captured) });
		await first.session.queue({ operationId: id(30), scopeId: scope, type: "thread.create", dependsOn: [], payload: {
			type: "thread.create", thread_id: id(31), message_id: id(32), anchor: protocolJson(captured), body: protocolJson(bodyFromText("Queued review")) } });
		await first.session.close();
		const transport = remote(); for (const call of [transport.capabilities, transport.permissions, transport.baseDefinitions, transport.baseTargetContext, transport.changes, transport.send]) call.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		next = await open(factory, transport); transport.baseDefinitions.mockClear();
		expect(await next.session.captureBaseTarget(scope, selection)).toEqual(captured);
		expect(await next.session.baseDefinitionStatus(scope, captured)).toContain("last verified");
		expect(transport.baseDefinitions).not.toHaveBeenCalled();
		expect((await next.store.getDraft("definition-draft"))?.target).toEqual(captured);
		expect(await next.store.pending(scope)).toHaveLength(1);
	} finally { await (next?.session ?? first.session).close(); }
});

test("changed definitions require a fresh choice and preserve the old target and body", async () => {
	const s = await open(new IDBFactory());
	try {
		const captured = await s.session.captureBaseTarget(scope, selection);
		await s.store.saveDraft({ id: "old", scopeId: scope, revision: 1, body: "Original", target: protocolJson(captured) });
		s.transport.baseDefinitions.mockResolvedValue(catalog(3));
		await expect(s.session.captureBaseTarget(scope, selection)).rejects.toThrow("definition changed");
		expect(await s.session.baseDefinitionStatus(scope, captured)).toContain("has changed");
		expect((await s.store.getDraft("old"))?.target).toEqual(captured);
		expect((await s.session.captureBaseTarget(scope, { ...selection, definitionRevision: 3 })).target).toMatchObject({ definition_revision: 3 });
		expect(s.session.baseRegistryRevision(scope)).toBe(3);
		s.transport.baseDefinitions.mockResolvedValue({ ...catalog(4), targets: [] });
		expect(await s.session.baseDefinitionStatus(scope, captured)).toContain("no longer available");
	} finally { await s.session.close(); }
});

test("a newer window's proof survives stale success, denial and reset races", async () => {
	const factory = new IDBFactory(), a = await open(factory), b = await open(factory);
	try {
		for (const denied of [false, true]) {
			let resolve!: (value: BaseDefinitionCatalog) => void, reject!: (error: unknown) => void;
			a.transport.baseDefinitions.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
			const old = a.session.readBaseDefinitions(scope); const expected = expect(old).rejects.toThrow(); await until(() => !!resolve);
			b.transport.baseDefinitions.mockResolvedValue(catalog(4)); await b.session.readBaseDefinitions(scope);
			if (denied) reject(new DiscussionFailure("reject", "target_unavailable", 404)); else resolve(catalog(2));
			await expected;
			expect(await a.store.preference("baseDefinitions:" + scope)).toEqual(catalog(4));
		}
		let finish!: (value: BaseDefinitionCatalog) => void;
		a.transport.baseDefinitions.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const stale = a.session.readBaseDefinitions(scope); const expected = expect(stale).rejects.toThrow(); await until(() => !!finish);
		await b.store.clearRemoteScope(scope); finish(catalog(5)); await expected;
	} finally { await a.session.close(); await b.session.close(); }
});

test("readers can inspect definitions without gaining capture authority and stale offline catalogues fail closed", async () => {
	const factory = new IDBFactory(), transport = remote();
	transport.permissions.mockResolvedValue({ read: true, comment: false, edit: false, moderate: false });
	const s = await open(factory, transport);
	try {
		await s.session.readBaseDefinitions(scope);
		expect((await s.session.readBaseDefinitions(scope)).targets).toHaveLength(2);
		await expect(s.session.captureBaseTarget(scope, selection)).rejects.toThrow("comment permission");
		await s.store.setPreference("baseContext:" + scope, { protocol_version: 1, entry_id: id(3), view_id: id(4), definition_id: id(5), generation: id(6), registry_revision: 5 });
		await expect(s.session.readBaseDefinitions(scope)).rejects.toThrow("verification is stale");
		s.transport.baseDefinitions.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		await expect(s.session.readBaseDefinitions(scope)).rejects.toThrow("Connect to verify");
	} finally { await s.session.close(); }
});

function groupRemote() {
	const transport = remote();
	transport.capabilities.mockResolvedValue({ discussions: true, baseTargets: ["view", "group"], baseRecordTypes: ["markdown"] });
	transport.baseDefinitions.mockResolvedValue({ ...catalog(), targets: [{ id: id(10), kind: "group", revision: 2,
		fingerprint: "a".repeat(64), property: { source: "note", name: "status" } }] });
	transport.baseTargetContext.mockImplementation(async (_scope, _view, record?: string) => ({ ...catalog(),
		...(record ? { record_id: record, record_generation: id(21) } : {}) }));
	transport.permissions.mockImplementation(async key => ({ read: true, comment: key !== id(20), edit: false, moderate: false }));
	return transport;
}
const groupSelection = () => ({ group_definition_id: id(10), group_definition_revision: 2, record_id: id(20), record_generation: id(21),
	dependency: "AA==", time_zone: "UTC", value: { type: "text" as const, value: "Done" } });
function laneRangeRemote() {
	const transport = groupRemote();
	transport.capabilities.mockResolvedValue({ discussions: true, baseTargets: ["view", "group", "timeline_range"], baseRecordTypes: ["markdown"] });
	const axis = { protocol_version: 1, entry_id: id(3), view_id: id(4), definition_id: id(5), generation: id(6), registry_revision: 2,
		axis: { id: id(60), kind: "axis", revision: 2, fingerprint: "a".repeat(64), axis: { version: 1, renderer: "sabidurian-sequence",
			start_property: { source: "note", name: "order" }, end_property: null, time_zone: null } } };
	return Object.assign(transport, { timelineAxis: jest.fn().mockResolvedValue(axis) });
}
const laneRange = { version: 1 as const, kind: "ordinal" as const, start: "999999999999998.000000001", end: "999999999999998.000000002",
	start_inclusive: true, end_inclusive: false, unit: "property-value" as const };

test("a new lane range can be captured and queued offline after reopening verified view and source caches", async () => {
	const factory = new IDBFactory(); let s = await open(factory, laneRangeRemote());
	try {
		await s.session.readBaseContext(scope, id(20)); await s.session.readBaseDefinitions(scope); const axis = await s.session.readTimelineAxis(scope);
		await s.session.close();
		const offline = laneRangeRemote();
		for (const method of [offline.capabilities, offline.permissions, offline.baseTargetContext, offline.baseDefinitions, offline.timelineAxis, offline.changes]) method.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		s = await open(factory, offline);
		const lane = await s.session.captureBaseGroupSelection(scope, groupSelection()), captured = await s.session.captureTimelineRange(scope, axis, laneRange, lane);
		expect(captured.capture).toEqual(lane.capture); expect(captured.range).toMatchObject({ axis_definition_id: id(60), axis_definition_revision: 2, range: laneRange });
		await s.store.saveDraft({ id: "lane-range", scopeId: scope, revision: 0, body: "Keep both targets", target: protocolJson(captured) });
		const command = { operationId: id(30), scopeId: scope, type: "base.group.create" as const, dependsOn: [], payload: protocolJson({
			type: "base.group.create", thread_id: id(31), message_id: id(32), body: bodyFromText("Offline lane range"), anchor: captured }) };
		await s.session.queue(command, { id: "lane-range", revision: 0 });
		expect((await s.store.pending(scope))[0].payload).toEqual(command.payload); expect(await s.store.getDraft("lane-range")).toBeUndefined();
		await s.session.close(); s = await open(factory, offline);
		expect((await s.store.pending(scope))[0].payload).toEqual(command.payload);
		await expect(s.session.captureTimelineRange(scope, axis, laneRange, { ...lane, capture: { ...lane.capture, view_id: id(99) } })).rejects.toThrow("current supported lane");
	} finally { await s.session.close(); }
});

test("a changed range axis refuses a queued lane draft while retaining its original evidence", async () => {
	const transport = laneRangeRemote(), s = await open(new IDBFactory(), transport);
	try {
		const axis = await s.session.readTimelineAxis(scope), lane = await s.session.captureBaseGroupSelection(scope, groupSelection());
		const captured = await s.session.captureTimelineRange(scope, axis, laneRange, lane);
		await s.store.saveDraft({ id: "lane-range", scopeId: scope, revision: 0, body: "Keep both targets", target: protocolJson(captured) });
		transport.timelineAxis.mockResolvedValue({ ...axis, registry_revision: 3, axis: { ...axis.axis, revision: 3 } });
		await expect(s.session.queue({ operationId: id(30), scopeId: scope, type: "base.group.create", dependsOn: [], payload: protocolJson({
			type: "base.group.create", thread_id: id(31), message_id: id(32), body: bodyFromText("Keep"), anchor: captured }) }, { id: "lane-range", revision: 0 })).rejects.toThrow("draft and lane evidence are retained");
		expect((await s.store.getDraft("lane-range"))!.target).toEqual(captured); expect(await s.store.pending(scope)).toHaveLength(0);
	} finally { await s.session.close(); }
});

test("inventory group capabilities and queued selections survive offline reopen, then downgrade preserves pending work", async () => {
	function fileRemote() {
		const transport = groupRemote();
		transport.capabilities.mockResolvedValue({ discussions: true, baseTargets: ["view", "group"], baseRecordTypes: ["markdown", "image"], baseFileGroupProperties: ["ext", "path"] });
		transport.baseDefinitions.mockResolvedValue({ ...catalog(), targets: [{ id: id(10), kind: "group", revision: 2,
			fingerprint: "a".repeat(64), property: { source: "file", name: "ext" } }] });
		return transport;
	}
	const factory = new IDBFactory(); let s = await open(factory, fileRemote());
	const { dependency: _dependency, time_zone: _zone, ...common } = groupSelection();
	const input = { ...common, source_kind: "file" as const, source_path_sha256: "a".repeat(64), value: { type: "text" as const, value: "png" } };
	try {
		expect(s.session.canAnchorBaseGroup({ source: "file", name: "EXT" })).toBe(true);
		expect(s.session.canAnchorBaseGroup({ source: "file", name: "size" })).toBe(false);
		await s.session.captureBaseGroupSelection(scope, input);
		await expect(s.session.captureBaseGroupSelection(scope, groupSelection())).rejects.toThrow("source changed");
		await s.session.close(); const offline = fileRemote();
		for (const method of [offline.capabilities, offline.permissions, offline.baseTargetContext, offline.baseDefinitions, offline.changes]) method.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		s = await open(factory, offline);
		expect(s.session.canAnchorBaseGroup({ source: "file", name: "ext" })).toBe(true);
		const captured = await s.session.captureBaseGroupSelection(scope, input);
		await s.store.saveDraft({ id: "file-group", scopeId: scope, revision: 0, body: "Offline file discussion", target: protocolJson(captured) });
		await s.session.queue({ operationId: id(30), scopeId: scope, type: "base.group.create", dependsOn: [], payload: protocolJson({
			type: "base.group.create", thread_id: id(31), message_id: id(32), body: bodyFromText("Offline file discussion"), anchor: captured }) }, { id: "file-group", revision: 0 });
		expect(await s.store.pending(scope)).toHaveLength(1); await s.session.close();
		const downgraded = fileRemote(); downgraded.capabilities.mockResolvedValue({ discussions: true, baseTargets: ["view", "group"], baseRecordTypes: ["markdown"] });
		s = await open(factory, downgraded);
		expect(s.session.canAnchorBaseGroup({ source: "file", name: "ext" })).toBe(false);
		await expect(s.session.captureBaseGroupSelection(scope, input)).rejects.toThrow("source changed");
		expect((await s.store.pending(scope))[0].payload).toMatchObject({ anchor: captured });
	} finally { await s.session.close(); }
});

test("new offline group capture uses cached source read lineage and never requires source comment permission", async () => {
	const factory = new IDBFactory(); let s = await open(factory, groupRemote());
	try {
		await s.session.readBaseContext(scope, id(20)); await s.session.readBaseDefinitions(scope); await s.session.close();
		const offline = groupRemote();
		for (const method of [offline.capabilities, offline.permissions, offline.baseTargetContext, offline.baseDefinitions, offline.changes]) {
			method.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		}
		s = await open(factory, offline);
		const captured = await s.session.captureBaseGroupSelection(scope, groupSelection());
		expect(captured).toMatchObject({ type: "base_group_pending", capture: groupSelection() });
		await s.store.saveDraft({ id: "offline-group", scopeId: scope, revision: 0, body: "Keep me", target: protocolJson(captured) });
		const pending = { operationId: id(30), scopeId: scope, type: "base.group.create" as const, dependsOn: [], payload: protocolJson({
			type: "base.group.create", thread_id: id(31), message_id: id(32), body: bodyFromText("Offline group comment"), anchor: captured }) };
		await s.session.queue(pending, { id: "offline-group", revision: 0 });
		expect(await s.store.getDraft("offline-group")).toBeUndefined(); expect((await s.store.pending(scope))[0].payload).toEqual(pending.payload);
		await expect(s.session.captureBaseGroupSelection(scope, { ...groupSelection(), record_id: id(99) })).rejects.toThrow("Connect to verify");
		expect(offline.permissions.mock.calls.map(call => call[0])).not.toContain(id(20));
	} finally { await s.session.close(); }
});

test("capture freezes local value before asynchronous verification and rejects changed source lineage", async () => {
	const s = await open(new IDBFactory(), groupRemote());
	try {
		const selection = groupSelection(), flight = s.session.captureBaseGroupSelection(scope, selection);
		selection.value.value = "Changed"; selection.dependency = "AQ==";
		const captured = await flight;
		expect(captured.capture.value).toEqual({ type: "text", value: "Done" }); expect(captured.capture.dependency).toBe("AA==");
		await expect(s.session.captureBaseGroupSelection(scope, { ...groupSelection(), record_generation: id(99) })).rejects.toThrow("source changed");
		await s.store.saveDraft({ id: "group", scopeId: scope, revision: 0, body: "Keep me", target: protocolJson(captured) });
		s.transport.baseDefinitions.mockResolvedValue({ ...catalog(3), targets: [{ id: id(10), kind: "group", revision: 3,
			fingerprint: "b".repeat(64), property: { source: "note", name: "status" } }] });
		await expect(s.session.queue({ operationId: id(30), scopeId: scope, type: "base.group.create", dependsOn: [], payload: protocolJson({
			type: "base.group.create", thread_id: id(31), message_id: id(32), body: bodyFromText("Keep me"), anchor: captured }) }, { id: "group", revision: 0 }))
			.rejects.toThrow("draft is retained");
		expect((await s.store.getDraft("group"))?.target).toEqual(captured); expect(await s.store.pending(scope)).toHaveLength(0);
	} finally { await s.session.close(); }
});


test("fresh HTTP catalog proof never transfers to a retry fallback or an offline session", async () => {
	const s = await open(new IDBFactory());
	try {
		s.session.setForeground(true); await s.session.refresh(); s.session.outbox.stop(); await s.session.outbox.settled();
		const verified = await s.session.readBaseDefinitions(scope); expect(s.session.verifiedTargetCatalog(verified)).toBe(true);
		s.transport.baseDefinitions.mockRejectedValueOnce(new DiscussionFailure("retry", "network_unavailable"));
		const cached = await s.session.readBaseDefinitions(scope); expect(cached).toEqual(verified);
		expect(s.session.verifiedTargetCatalog(cached)).toBe(false);
		s.session.setForeground(false); expect(s.session.verifiedTargetCatalog(verified)).toBe(false);
	} finally { await s.session.close(); }
});

test.each(["definitions", "axis", "markers", "records"] as const)("%s target verification started before authentication loss stays invalid after sign-in recovery", async kind => {
	const s = await open(new IDBFactory()); let finish!: (value: unknown) => void;
	const { targets: _targets, computed_values: _computed, ...context } = catalog();
	const value = kind === "definitions" ? catalog() : kind === "records" ? { ...context, records: [{ record_id: id(20), record_generation: id(21) }] } : kind === "markers" ? { ...context, catalog_revision: 0, markers: [] } :
		{ ...context, axis: { id: id(60), kind: "axis", revision: 2, fingerprint: "a".repeat(64), axis: { version: 1,
			renderer: "sabidurian-sequence", start_property: { source: "note", name: "order" }, end_property: null, time_zone: null } } };
	const remoteRead = jest.fn(() => new Promise(resolve => { finish = resolve; }));
	Object.assign(s.transport, { [kind === "definitions" ? "baseDefinitions" : kind === "axis" ? "timelineAxis" : kind === "records" ? "baseRecordContexts" : "timelineMarkers"]: remoteRead });
	const read = () => kind === "definitions" ? s.session.readBaseDefinitions(scope) : kind === "axis" ? s.session.readTimelineAxis(scope) : kind === "records" ? s.session.readBaseRecordContexts(scope, [id(20)]) : s.session.readTimelineMarkers(scope);
	try {
		const reading = read(), rejected = expect(reading).rejects.toThrow(); await until(() => remoteRead.mock.calls.length === 1);
		s.transport.capabilities.mockRejectedValueOnce(new DiscussionFailure("authenticate", "session_revoked", 401));
		await s.session.start(); expect(s.session.status).toBe("authentication_required");
		await s.session.start(); expect(s.session.status).toBe("ready");
		finish(value); await rejected;
		expect(s.session.verifiedTargetCatalog(value)).toBe(false);
		const key = (kind === "definitions" ? "baseDefinitions:" : kind === "axis" ? "timelineAxis:" : kind === "records" ? "baseRecords:" : "timelineMarkers:") + scope;
		expect(await s.store.preference(key)).toBeUndefined();
		remoteRead.mockImplementation(() => Promise.resolve(value)); await expect(read()).resolves.toEqual(value);
	} finally { finish?.(value); await s.session.close(); }
});

test.each(["definitions", "axis", "markers", "records"] as const)("%s authentication denial locks verification until a successful sign-in check", async kind => {
	const s = await open(new IDBFactory());
	const failure = new DiscussionFailure("authenticate", "session_revoked", 401), remoteRead = jest.fn().mockRejectedValue(failure);
	Object.assign(s.transport, { [kind === "definitions" ? "baseDefinitions" : kind === "axis" ? "timelineAxis" : kind === "records" ? "baseRecordContexts" : "timelineMarkers"]: remoteRead });
	const read = () => kind === "definitions" ? s.session.readBaseDefinitions(scope) : kind === "axis" ? s.session.readTimelineAxis(scope) : kind === "records" ? s.session.readBaseRecordContexts(scope, [id(20)]) : s.session.readTimelineMarkers(scope);
	try {
		await expect(read()).rejects.toBe(failure);
		expect(s.session.status).toBe("authentication_required"); expect(s.session.canQueue).toBe(false);
		await expect(read()).rejects.toThrow("unavailable"); expect(remoteRead).toHaveBeenCalledTimes(1);
		s.transport.capabilities.mockRejectedValueOnce(new DiscussionFailure("retry", "network_unavailable"));
		await s.session.start(); expect(s.session.status).toBe("authentication_required");
		await s.session.start(); expect(s.session.status).toBe("ready");
	} finally { await s.session.close(); }
});

function groupSummaryRemote() {
	const source = groupRemote();
	source.capabilities.mockResolvedValue({ discussions: true, baseTargets: ["view", "group", "summary", "group_summary"], baseRecordTypes: ["markdown"] });
	source.baseDefinitions.mockResolvedValue({ ...catalog(), targets: [{ id: id(10), kind: "group", revision: 2,
		fingerprint: "a".repeat(64), property: { source: "note", name: "status" } }, catalog().targets[1]] });
	return source;
}

test("group-summary selections and offline sends preserve both definitions without requiring source comment access", async () => {
	const factory = new IDBFactory(); let s = await open(factory, groupSummaryRemote());
	try {
		const group = await s.session.captureBaseGroupSelection(scope, groupSelection());
		const selected = await s.session.captureBaseGroupSummary(scope, group, id(11), 2);
		expect(selected).toMatchObject({ ...group, summary: { type: "summary", definition_id: id(11), definition_revision: 2, summary: "Average" } });
		await s.store.saveDraft({ id: "group-summary", scopeId: scope, revision: 0, body: "Keep me", target: protocolJson(selected) });
		await s.session.close();
		const offline = groupSummaryRemote();
		for (const read of [offline.capabilities, offline.permissions, offline.baseDefinitions, offline.baseTargetContext, offline.changes]) read.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		s = await open(factory, offline);
		expect(await s.session.captureBaseGroupSummary(scope, group, id(11), 2)).toEqual(selected);
		const command = { operationId: id(30), scopeId: scope, type: "base.group.create" as const, dependsOn: [], payload: protocolJson({
			type: "base.group.create", thread_id: id(31), message_id: id(32), body: bodyFromText("Offline summary"), anchor: selected }) };
		await s.session.queue(command, { id: "group-summary", revision: 0 });
		expect(await s.store.getDraft("group-summary")).toBeUndefined(); expect((await s.store.pending(scope))[0].payload).toEqual(command.payload);
		expect(offline.permissions.mock.calls.map(call => call[0])).not.toContain(id(20));
	} finally { await s.session.close(); }
});

test.each(["summary", "group", "capability", "permission"])("group-summary %s changes preserve the original draft and prevent queueing", async change => {
	const s = await open(new IDBFactory(), groupSummaryRemote());
	try {
		const group = await s.session.captureBaseGroupSelection(scope, groupSelection());
		const selected = await s.session.captureBaseGroupSummary(scope, group, id(11), 2);
		await s.store.saveDraft({ id: "summary", scopeId: scope, revision: 0, body: "Original", target: protocolJson(selected) });
		if (change === "permission") {
			s.transport.permissions.mockResolvedValue({ read: true, comment: false, edit: false, moderate: false }); s.session.setForeground(true); await s.session.refresh(); s.session.outbox.stop(); await s.session.outbox.settled();
		} else if (change === "capability") {
			s.transport.capabilities.mockResolvedValue({ discussions: true, baseTargets: ["view", "group", "summary"], baseRecordTypes: ["markdown"] }); await s.session.start(); s.session.setForeground(false);
		} else {
			const current = await s.session.readBaseDefinitions(scope);
			s.transport.baseDefinitions.mockResolvedValue({ ...current, registry_revision: 3, targets: current.targets.map(item => item.kind === change ? { ...item, revision: 3 } : item) });
		}
		await expect(s.session.captureBaseGroupSummary(scope, group, id(11), 2)).rejects.toThrow();
		await expect(s.session.queue({ operationId: id(30), scopeId: scope, type: "base.group.create", dependsOn: [], payload: protocolJson({
			type: "base.group.create", thread_id: id(31), message_id: id(32), body: bodyFromText("Original"), anchor: selected }) }, { id: "summary", revision: 0 })).rejects.toThrow();
		expect((await s.store.getDraft("summary"))?.target).toEqual(selected); expect(await s.store.pending(scope)).toHaveLength(0);
	} finally { await s.session.close(); }
});
