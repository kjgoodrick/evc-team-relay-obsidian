import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionFailure, DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionStore, type StoreIdentity } from "../../src/collaboration/storage/DiscussionStore";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { TimelineMarkerManagement } from "../../src/collaboration/TimelineMarkerManagement";
import { parseTimelineMarkerCommandStatus, parseTimelineMarkerCommand, parseTimelineMarkerDetail, parseTimelineMarkerReceipt, type TimelineMarkerCommandStatus, type TimelineMarkerCommand, type TimelineMarkerReceipt } from "../../src/collaboration/TimelineMarkerManagementProtocol";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = baseDiscussionScope(id(1), id(3)), otherView = baseDiscussionScope(id(1), id(30));
const identity = { serverId: "https://relay.test", accountId: id(11), shareId: id(10), vaultId: id(12) };
const axis = { version: 1 as const, renderer: "sabidurian-sequence" as const, start_property: { source: "note" as const, name: "order" }, end_property: null, time_zone: null };
const command = (): TimelineMarkerCommand => ({ operation_id: id(50), definition_id: id(2), generation: id(4), registry_revision: 5,
	expected_catalog_revision: 3, command: { type: "marker.put", marker_id: id(20), expected_marker_revision: 0,
		content: { kind: "point", label: "Launch", color: "#abcdef", range: { version: 1, kind: "ordinal", start: "999999999999999.000000001", end: "999999999999999.000000001", start_inclusive: true, end_inclusive: true, unit: "property-value" } },
		placements: [{ view_id: id(3), axis_definition_id: id(6), axis_definition_revision: 5 }] } });
function receipt(request = command()): TimelineMarkerReceipt {
	if (request.command.type !== "marker.put") throw new Error("Use a put fixture");
	return { protocol_version: 1, entry_id: id(1), definition_id: request.definition_id, generation: request.generation,
		registry_revision: request.registry_revision, catalog_revision: request.expected_catalog_revision + 1, operation_id: request.operation_id,
		marker: { id: request.command.marker_id, revision: request.command.expected_marker_revision + 1, active: true, content: request.command.content,
			placements: request.command.placements.map(placement => ({ ...placement, active: true, axis })) } };
}
const stores: DiscussionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function client(factory = new IDBFactory(), account: StoreIdentity = identity) {
	const store = await DiscussionStore.open(account, factory); stores.push(store);
	const access = { online: true, status: "ready", edit: true, read: true, enabled: true, restoreGeneration: null as string | null, guard: true };
	const send = jest.fn<Promise<TimelineMarkerReceipt>, [string, TimelineMarkerCommand]>().mockImplementation(async (_, request) => receipt(request));
	const changed = jest.fn();
	const inspect = jest.fn<Promise<TimelineMarkerCommandStatus>, [string, TimelineMarkerCommand, (() => boolean)?]>().mockResolvedValue({ status: "unknown" });
	const session = { store, get online() { return access.online; }, get status() { return access.status; },
		get restoreBinding() { return access.restoreGeneration === null ? {} : { restoreGeneration: access.restoreGeneration }; }, get canManageTimelineMarkers() { return access.guard; }, get canCheckTimelineMarkerCommand() { return access.online && access.status === "ready"; },
		permission: () => ({ read: access.read, edit: access.edit }), canAnchorBase: () => access.enabled,
		trackLocal: <T>(promise: Promise<T>) => promise, transport: { manageTimelineMarker: send, timelineMarkerCommandStatus: inspect } } as unknown as DiscussionSession;
	return { store, access, send, inspect, changed, manager: new TimelineMarkerManagement(session, changed) };
}
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

test("management commands copy exact coordinates and reject ambiguous or overflowing intent", () => {
	const input = command(), parsed = parseTimelineMarkerCommand(input);
	if (input.command.type !== "marker.put") throw new Error("Expected put");
	input.command.content.label = "Changed"; input.command.placements[0].view_id = id(99);
	expect(parsed).toEqual(command());
	const valid = command();
	for (const patch of [{ operation_id: "bad" }, { registry_revision: 4 }, { expected_catalog_revision: Number.MAX_SAFE_INTEGER }, { unknown: true }]) {
		expect(() => parseTimelineMarkerCommand({ ...valid, ...patch })).toThrow();
	}
	if (valid.command.type !== "marker.put") throw new Error("Expected put");
	for (const patch of [{ expected_marker_revision: Number.MAX_SAFE_INTEGER }, { placements: [] }, { placements: Array(65).fill(valid.command.placements[0]) },
		{ placements: [{ ...valid.command.placements[0], view_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { ...valid.command.placements[0], view_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }] }]) {
		expect(() => parseTimelineMarkerCommand({ ...valid, command: { ...valid.command, ...patch } })).toThrow();
	}
	expect(() => parseTimelineMarkerCommand({ ...valid, command: { type: "marker.archive", marker_id: id(20), expected_marker_revision: 0 } })).toThrow();
});

test("receipts prove the requested identity, counter advances, content and complete active placement set", () => {
	const request = command(), value = receipt();
	expect(parseTimelineMarkerReceipt(value, id(1), request)).toEqual(value);
	for (const patch of [{ entry_id: id(99) }, { operation_id: id(99) }, { definition_id: id(99) }, { generation: id(99) }, { registry_revision: 6 }, { catalog_revision: 5 }]) {
		expect(() => parseTimelineMarkerReceipt({ ...value, ...patch }, id(1), request)).toThrow();
	}
	for (const patch of [{ revision: 2 }, { active: false }, { content: { ...value.marker.content, label: "Forged" } },
		{ placements: [] }, { placements: [{ ...value.marker.placements[0], active: false }] },
		{ placements: [{ ...value.marker.placements[0], axis_definition_id: id(99) }] },
		{ placements: [...value.marker.placements, { ...value.marker.placements[0], view_id: id(30) }] }]) {
		expect(() => parseTimelineMarkerReceipt({ ...value, marker: { ...value.marker, ...patch } }, id(1), request)).toThrow();
	}
	const inactive = { ...value.marker.placements[0], view_id: id(30), active: false, axis: { ...axis, renderer: "sabidurian-timeline", time_zone: "UTC" } };
	const detached = { ...value, marker: { ...value.marker, placements: [...value.marker.placements, inactive] } };
	expect(parseTimelineMarkerReceipt(detached, id(1), request).marker.placements).toHaveLength(2);
	expect(() => parseTimelineMarkerDetail({ ...detached, marker: { ...detached.marker, placements: [inactive] } }, id(1), id(20))).toThrow();
	const archive = { ...request, expected_catalog_revision: 4, command: { type: "marker.archive" as const, marker_id: id(20), expected_marker_revision: 1 } };
	const archived = { ...value, catalog_revision: 5, marker: { ...value.marker, revision: 2, active: false, placements: [inactive] } };
	expect(parseTimelineMarkerReceipt(archived, id(1), archive).marker.active).toBe(false);
	expect(() => parseTimelineMarkerReceipt({ ...archived, marker: { ...archived.marker, active: true } }, id(1), archive)).toThrow();
});

test("transport routes management by base and rejects success bodies unrelated to the original command", async () => {
	const fetcher = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify(receipt()))).mockResolvedValueOnce(new Response(JSON.stringify(receipt())))
		.mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt(), operation_id: id(99) })));
	const transport = new DiscussionTransport(identity, async () => ({ accountId: identity.accountId, accessToken: "synthetic" }), fetcher);
	expect((await transport.timelineMarker(scope, id(20))).marker.id).toBe(id(20));
	expect(fetcher.mock.calls[0][0]).toContain(`/entries/${id(1)}/bases/timeline-markers/${id(20)}`);
	expect(await transport.manageTimelineMarker(scope, command())).toEqual(receipt());
	expect(fetcher.mock.calls[1][0]).toContain(`/entries/${id(1)}/bases/timeline-markers/commands`);
	expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(command());
	await expect(transport.manageTimelineMarker(scope, command())).rejects.toMatchObject({ code: "invalid_read_response" });
	await expect(transport.manageTimelineMarker(scope, { ...command(), operation_id: "bad" })).rejects.toMatchObject({ code: "invalid_local_command" });
	expect(fetcher).toHaveBeenCalledTimes(3);
});

test.each(["online", "edit", "read", "enabled"] as const)("new commands require %s before persistence or transmission", async gate => {
	const c = await client(); c.access[gate] = false;
	expect(() => c.manager.save(scope, command())).toThrow();
	expect(await c.manager.state(scope)).toBeUndefined(); expect(c.send).not.toHaveBeenCalled();
});

test("lost response retains immutable intent across reopen and retries without a second operation", async () => {
	const db = new IDBFactory(), first = await client(db), input = command();
	first.send.mockImplementationOnce(async (_, request) => {
		expect(await first.manager.state(scope)).toMatchObject({ status: "pending", request: command() });
		expect(request).toEqual(command()); throw new TypeError("Lost response");
	});
	const failed = first.manager.save(scope, input);
	if (input.command.type === "marker.put") input.command.content.label = "Changed after save";
	await expect(failed).rejects.toThrow("Lost response");
	expect(await first.manager.acknowledge(scope, id(50))).toBe(false);
	first.store.close();
	const reopened = await client(db); reopened.access.enabled = false;
	expect(await reopened.manager.state(otherView)).toMatchObject({ status: "pending", request: command(), error: "marker_save_unconfirmed" });
	expect(await reopened.manager.retry(otherView)).toEqual(receipt());
	expect(reopened.send).toHaveBeenCalledWith(otherView, command(), {}, expect.any(Function));
	expect(await reopened.manager.state(scope)).toEqual({ version: 1, scope_id: scope, status: "accepted", request: command(), receipt: receipt() });
	expect(await reopened.manager.retry(scope)).toEqual(receipt()); expect(reopened.send).toHaveBeenCalledTimes(1);
	expect(await reopened.manager.acknowledge(scope, id(99))).toBe(false);
	expect(await reopened.manager.acknowledge(scope, id(50))).toBe(true); expect(await reopened.manager.state(scope)).toBeUndefined();
});

test.each([[401, "auth_required"], [403, "base_editor_required"], [404, "not_found"], [409, "timeline_markers_disabled"], [500, "server_error"]] as const)("uncertain %s/%s keeps the original intent", async (status, code) => {
	const c = await client(); c.send.mockRejectedValueOnce(new DiscussionFailure("reject", code, status));
	await expect(c.manager.save(scope, command())).rejects.toMatchObject({ code });
	expect(await c.manager.state(scope)).toMatchObject({ status: "pending", error: code, request: command() });
	expect(await c.manager.acknowledge(scope, id(50))).toBe(false);
});

test("malformed success stays recoverable rather than clearing intent", async () => {
	const c = await client(); c.send.mockResolvedValueOnce({ ...receipt(), operation_id: id(99) });
	await expect(c.manager.save(scope, command())).rejects.toThrow();
	expect(await c.manager.state(scope)).toMatchObject({ status: "pending", error: "marker_save_unconfirmed" });
});

test.each(["stale_base_revision", "timeline_marker_catalog_changed", "timeline_marker_changed", "base_generation_changed", "operation_id_conflict", "timeline_axis_changed", "timeline_axis_unavailable", "base_view_unavailable"])("monotonic conflict %s requires acknowledgement before another intent", async code => {
	const c = await client(); c.send.mockRejectedValueOnce(new DiscussionFailure("reject", code, 409));
	await expect(c.manager.save(scope, command())).rejects.toMatchObject({ code });
	expect(await c.manager.state(scope)).toMatchObject({ status: "rejected", error: code });
	await expect(c.manager.retry(scope)).rejects.toMatchObject({ code }); expect(c.send).toHaveBeenCalledTimes(1);
	await expect(c.manager.save(otherView, { ...command(), operation_id: id(51) })).rejects.toThrow("previous marker save");
	expect(await c.manager.acknowledge(otherView, id(50))).toBe(true);
	expect((await c.manager.save(otherView, { ...command(), operation_id: id(51) })).operation_id).toBe(id(51));
});

test("same-session retries coalesce and another view cannot replace a pending base operation", async () => {
	const c = await client(), entered = deferred<void>(), result = deferred<TimelineMarkerReceipt>();
	c.send.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
	const saving = c.manager.save(scope, command()); await entered.promise;
	const retry = c.manager.retry(otherView), again = c.manager.retry(scope); expect(again).toBe(retry);
	await expect(c.manager.save(otherView, { ...command(), operation_id: id(51) })).rejects.toThrow("previous marker save");
	result.resolve(receipt()); await expect(saving).resolves.toEqual(receipt()); await retry;
	expect(c.send).toHaveBeenCalledTimes(1);
});

test("a late failure in another window cannot overwrite an accepted receipt or a later operation", async () => {
	const db = new IDBFactory(), first = await client(db), second = await client(db), entered = deferred<void>(), failure = deferred<TimelineMarkerReceipt>();
	first.send.mockImplementationOnce(() => { entered.resolve(); return failure.promise; });
	const saving = first.manager.save(scope, command()); await entered.promise;
	expect(await second.manager.retry(otherView)).toEqual(receipt());
	failure.reject(new TypeError("Late timeout")); await expect(saving).resolves.toEqual(receipt());
	expect(await first.manager.state(scope)).toMatchObject({ status: "accepted" });
	expect(await first.manager.acknowledge(scope, id(50))).toBe(true);
	await second.manager.save(scope, { ...command(), operation_id: id(51) });
	expect(await first.manager.acknowledge(scope, id(50))).toBe(false);
	expect((await first.manager.state(scope))?.request.operation_id).toBe(id(51));
});

test("intent isolation spans account, server, share, vault and base", async () => {
	const db = new IDBFactory(), c = await client(db); await c.manager.save(scope, command());
	expect(await c.manager.state(baseDiscussionScope(id(99), id(3)))).toBeUndefined();
	for (const patch of [{ accountId: id(99) }, { shareId: id(99) }, { vaultId: id(99) }, { serverId: "https://other.test" }]) {
		const other = await client(db, { ...identity, ...patch }); expect(await other.manager.state(scope)).toBeUndefined();
	}
});

test("permission loss during local persistence prevents sending and retains recovery data", async () => {
	const c = await client(), compare = c.store.comparePreference.bind(c.store);
	jest.spyOn(c.store, "comparePreference").mockImplementation(async (...args) => { const saved = await compare(...args); c.access.edit = false; return saved; });
	await expect(c.manager.save(scope, command())).rejects.toThrow("edit permission");
	expect(c.send).not.toHaveBeenCalled(); expect(await c.manager.state(scope)).toMatchObject({ status: "pending" });
	c.access.status = "closed";
	await expect(c.manager.state(scope)).rejects.toThrow("closed"); await expect(c.manager.acknowledge(scope, id(50))).rejects.toThrow("closed");
});

test("invalid local recovery records are preserved and cannot trigger a new send", async () => {
	const c = await client(), invalid = protocolJson({ version: 1, scope_id: scope, request: command(), status: "accepted", receipt: { ...receipt(), operation_id: id(99) } });
	await c.store.setPreference("timelineMarkerCommand:" + id(1), invalid);
	await expect(c.manager.save(scope, command())).rejects.toThrow(); expect(c.send).not.toHaveBeenCalled();
	expect(await c.store.preference("timelineMarkerCommand:" + id(1))).toEqual(invalid);
});

test("marker transport retains the original restore header before credentials resolve", async () => {
	const credential = deferred<{ accountId: string; accessToken: string }>();
	const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify(receipt())));
	const transport = new DiscussionTransport(identity, () => credential.promise, fetcher);
	const binding = { restoreGeneration: id(90) }, input = command();
	const sending = transport.manageTimelineMarker(scope, input, binding);
	binding.restoreGeneration = id(91); if (input.command.type === "marker.put") input.command.content.label = "Later";
	credential.resolve({ accountId: identity.accountId, accessToken: "synthetic" }); await sending;
	expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-Relay-Restore-Generation")).toBe(id(90));
	expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(command());
});

test("marker intent, lost-response retry and local receipt retain one immutable restore binding", async () => {
	const factory = new IDBFactory(), first = await client(factory);
	await first.store.observeRestoreContext({ supported: true, generation: id(90) }, 0); first.access.restoreGeneration = id(90);
	first.send.mockRejectedValueOnce(new Error("Lost response"));
	await expect(first.manager.save(scope, command())).rejects.toThrow("Lost response");
	expect(await first.manager.state(scope)).toMatchObject({ status: "pending", restoreGeneration: id(90) });
	first.store.close();
	const second = await client(factory); second.access.restoreGeneration = id(90);
	await second.manager.retry(scope);
	expect(second.send).toHaveBeenCalledWith(scope, command(), { restoreGeneration: id(90) }, expect.any(Function));
	expect(await second.manager.state(scope)).toMatchObject({ status: "accepted", restoreGeneration: id(90) });
});

test("restore blocks old marker retries without restamping or discarding their saved intent", async () => {
	const c = await client(); c.send.mockRejectedValueOnce(new Error("Lost response"));
	await expect(c.manager.save(scope, command())).rejects.toThrow("Lost response");
	const before = await c.store.preference("timelineMarkerCommand:" + id(1));
	await c.store.observeRestoreContext({ supported: true, generation: id(90) }, 0); c.access.restoreGeneration = id(90);
	expect(await c.manager.state(scope)).toMatchObject({ status: "pending", error: "restore_generation_changed", request: command() });
	await expect(c.manager.retry(scope)).rejects.toMatchObject({ code: "restore_generation_changed" });
	await expect(c.manager.save(scope, command())).rejects.toMatchObject({ code: "restore_generation_changed" });
	expect(await c.manager.acknowledge(scope, id(50))).toBe(false);
	expect(await c.store.preference("timelineMarkerCommand:" + id(1))).toEqual(before);
	expect(c.send).toHaveBeenCalledTimes(1);
});

test("a marker receipt arriving after another window restores cannot be committed locally", async () => {
	const c = await client(), pending = deferred<TimelineMarkerReceipt>();
	c.send.mockReturnValueOnce(pending.promise);
	const saving = c.manager.save(scope, command());
	const rejected = expect(saving).rejects.toMatchObject({ code: "restore_generation_changed" });
	for (let i = 0; i < 100 && !c.send.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 1));
	expect(c.send).toHaveBeenCalledTimes(1);
	await c.store.observeRestoreContext({ supported: true, generation: id(90) }, 0); c.access.restoreGeneration = id(90);
	pending.resolve(receipt()); await rejected;
	expect(await c.manager.state(scope)).toMatchObject({ status: "pending", error: "restore_generation_changed" });
	expect(await c.store.preference("timelineMarkerCommand:" + id(1))).not.toHaveProperty("receipt");
});

test("a marker save retains its caller's pre-validation binding and requires advertised guards", async () => {
	const c = await client();
	await c.store.observeRestoreContext({ supported: true, generation: id(90) }, 0); c.access.restoreGeneration = id(90);
	await expect(c.manager.save(scope, command(), {})).rejects.toMatchObject({ code: "restore_generation_changed" });
	expect(await c.manager.state(scope)).toBeUndefined(); expect(c.send).not.toHaveBeenCalled();
	c.access.guard = false;
	expect(() => c.manager.save(scope, command())).toThrow(); expect(c.send).not.toHaveBeenCalled();
});


test("marker status parsing requires exact request and scope identity", () => {
	const input = command();
	expect(parseTimelineMarkerCommandStatus({ status: "accepted", result: receipt() }, id(1), input)).toEqual({ status: "accepted", result: receipt() });
	expect(parseTimelineMarkerCommandStatus({ status: "unknown", entry_id: id(1), operation_id: input.operation_id }, id(1), input)).toEqual({ status: "unknown" });
	for (const value of [{ status: "unknown" }, { status: "unknown", entry_id: id(99), operation_id: input.operation_id },
		{ status: "unknown", entry_id: id(1), operation_id: id(99) }, { status: "accepted", result: { ...receipt(), operation_id: id(99) } },
		{ status: "accepted", result: receipt(), extra: true }]) expect(() => parseTimelineMarkerCommandStatus(value, id(1), input)).toThrow();
});

test("read-only marker receipt transport never sends a mutation generation or command", async () => {
	const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify({ status: "accepted", result: receipt() })));
	const transport = new DiscussionTransport(identity, async () => ({ accountId: identity.accountId, accessToken: "synthetic" }), fetcher);
	expect((await transport.timelineMarkerCommandStatus(scope, command())).status).toBe("accepted");
	expect(fetcher.mock.calls[0][0]).toContain("/timeline-markers/commands/status");
	expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(command());
	expect(new Headers(fetcher.mock.calls[0][1].headers).has("X-Relay-Restore-Generation")).toBe(false);
});

async function oldPendingMarker() {
	const c = await client(); c.send.mockRejectedValueOnce(new Error("Lost response"));
	await expect(c.manager.save(scope, command())).rejects.toThrow("Lost response");
	await c.store.observeRestoreContext({ supported: true, generation: id(90) }, 0); c.access.restoreGeneration = id(90); c.access.edit = false;
	c.send.mockClear(); return c;
}

test("an old marker's exact receipt can be checked read-only without rebinding or replay", async () => {
	const c = await oldPendingMarker(); c.inspect.mockResolvedValue({ status: "accepted", result: receipt() });
	expect(await c.manager.check(scope)).toEqual({ status: "accepted", result: receipt() });
	expect(c.send).not.toHaveBeenCalled(); expect(c.inspect).toHaveBeenCalledTimes(1);
	const saved = await c.manager.state(scope); expect(saved).toMatchObject({ status: "accepted", request: command(), receipt: receipt() });
	expect(saved).not.toHaveProperty("restoreGeneration");
	expect(await c.manager.acknowledge(scope, command().operation_id)).toBe(true);
	expect(await c.manager.state(scope)).toBeUndefined(); expect(c.send).not.toHaveBeenCalled();
});

test("an unknown old marker receipt retains the original pending slot and forbids automatic replacement", async () => {
	const c = await oldPendingMarker(), before = await c.store.preference("timelineMarkerCommand:" + id(1));
	expect(await c.manager.check(scope)).toEqual({ status: "unknown" });
	expect(await c.store.preference("timelineMarkerCommand:" + id(1))).toEqual(before);
	expect(await c.manager.acknowledge(scope, command().operation_id)).toBe(false); expect(c.send).not.toHaveBeenCalled();
});

test("a second restore fences a late marker status result before local acceptance", async () => {
	const c = await oldPendingMarker(), result = deferred<TimelineMarkerCommandStatus>(); c.inspect.mockReturnValue(result.promise);
	const checking = c.manager.check(scope), rejected = expect(checking).rejects.toMatchObject({ code: "restore_generation_changed" });
	for (let i = 0; i < 100 && !c.inspect.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 1));
	expect(c.inspect).toHaveBeenCalledTimes(1);
	// Simulate another window's observation before this session gets its broadcast.
	await c.store.observeRestoreContext({ supported: true, generation: id(91) }, (await c.store.restoreCheckpoint()).revision);
	result.resolve({ status: "accepted", result: receipt() }); await rejected;
	expect(await c.manager.state(scope)).toMatchObject({ status: "pending", error: "restore_generation_changed" });
	expect(c.send).not.toHaveBeenCalled();
});
