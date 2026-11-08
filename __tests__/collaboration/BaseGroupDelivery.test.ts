import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionDelivery } from "../../src/collaboration/DiscussionDelivery";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { DiscussionFailure, queuedEnvelope, type CommandResult, type DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { bodyFromText, parseAnchor, protocolJson, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { parseLocalDiscussionAnchor, parsePendingBaseGroupCommand, prepareBaseGroupCommand, type PendingBaseGroupAnchor } from "../../src/collaboration/LocalDiscussionAnchor";
import { prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { savedCommandReview } from "../../src/collaboration/SavedCommandReview";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "group-delivery" };
const scope = baseDiscussionScope(id(3), id(4));
const target = (): PendingBaseGroupAnchor => ({ version: 1, type: "base_group_pending", entry_id: id(3), property: { source: "note", name: "status" },
	capture: { operation_id: id(5), definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 2,
		group_definition_id: id(8), group_definition_revision: 2, record_id: id(9), record_generation: id(10), dependency: "AA==", time_zone: "UTC",
		value: { type: "text", value: "Done" } } });
const anchor = (): BaseAnchor => ({ version: 1, type: "base", definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 3,
	target: { type: "group", definition_id: id(8), definition_revision: 2, property: { source: "note", name: "status" }, group_id: id(11), witness_id: id(12), value: target().capture.value } });
const command = (): QueuedCommand => ({ operationId: id(13), scopeId: scope, type: "base.group.create", dependsOn: [],
	payload: protocolJson({ type: "base.group.create", thread_id: id(14), message_id: id(15), body: bodyFromText("Keep this offline comment"), anchor: target() }) });
const rangeTarget = (): NonNullable<PendingBaseGroupAnchor["range"]> => ({ type: "timeline_range", axis_definition_id: id(60), axis_definition_revision: 2,
	axis: { version: 1, renderer: "sabidurian-sequence", start_property: { source: "note", name: "order" }, end_property: null, time_zone: null },
	range: { version: 1, kind: "ordinal", start: "999999999999998.000000001", end: "999999999999998.000000002", start_inclusive: true, end_inclusive: false, unit: "property-value" } });
const rangeCommand = (): QueuedCommand => ({ ...command(), payload: protocolJson({ type: "base.group.create", thread_id: id(14), message_id: id(15),
	body: bodyFromText("Range in this exact lane"), anchor: { ...target(), range: rangeTarget() } }) });
const summaryTarget = () => ({ type: "summary" as const, definition_id: id(70), definition_revision: 2,
	property: { source: "formula" as const, name: "Total" }, summary: "Average" });
const summaryCommand = (): QueuedCommand => ({ ...command(), payload: protocolJson({ type: "base.group.create", thread_id: id(14), message_id: id(15),
	body: bodyFromText("This group's summary"), anchor: { ...target(), summary: summaryTarget() } }) });
const accepted = (op: QueuedCommand): CommandResult => ({ operation_id: op.operationId, scope_id: id(16), thread_id: id(14), sequence: 1,
	state: "open", state_revision: 1, removed: false, changed: true });
let store: DiscussionStore, factory: IDBFactory;
const workers: DiscussionOutbox[] = [];
beforeEach(async () => { factory = new IDBFactory(); store = await DiscussionStore.open(identity, factory); });
afterEach(async () => { workers.forEach(w => w.stop()); await Promise.all(workers.splice(0).map(w => w.settled())); store.close(); jest.restoreAllMocks(); });
function remote() {
	return { identity, captureBaseGroup: jest.fn().mockResolvedValue(anchor()), send: jest.fn(async (op: QueuedCommand) => {
		queuedEnvelope(identity.shareId, op); return accepted(op);
	}) };
}
const delivery = (transport: ReturnType<typeof remote>) => new DiscussionDelivery(store, transport as unknown as DiscussionTransport);
const claim = (owner = "a", now = Date.now()) => store.claimNext(owner, now);
function worker(transport: ReturnType<typeof remote>) {
	const w = new DiscussionOutbox(store, delivery(transport), "worker"); workers.push(w); return w;
}

test("a local pending selection cannot masquerade as a server anchor or wire command", async () => {
	expect(parseLocalDiscussionAnchor(target())).toEqual(target());
	expect(() => parseAnchor(target())).toThrow();
	expect(() => queuedEnvelope(identity.shareId, command())).toThrow("invalid_local_command");
	for (const patch of [{ scopeId: id(3) }, { scopeId: baseDiscussionScope(id(20), id(4)) }, { scopeId: baseDiscussionScope(id(3), id(20)) }, { operationId: id(5) }]) {
		await expect(store.enqueue({ ...command(), ...patch })).rejects.toThrow();
	}
	expect(await store.pending(scope)).toHaveLength(0);
});

test("pending lane ranges preserve exact coordinates while only a verified receipt supplies the lane", () => {
	const pending = parsePendingBaseGroupCommand(rangeCommand()).anchor;
	expect(parseLocalDiscussionAnchor(pending)).toEqual(pending); expect(() => parseAnchor(pending)).toThrow();
	const prepared = prepareBaseGroupCommand(rangeCommand(), anchor());
	const wire = JSON.parse(queuedEnvelope(identity.shareId, prepared)).command.anchor;
	expect(wire.registry_revision).toBe(3); expect(wire.target).toEqual({ ...rangeTarget(), lane: anchor().target });
	expect(() => queuedEnvelope(identity.shareId, rangeCommand())).toThrow("invalid_local_command");
	for (const range of [{ ...rangeTarget(), lane: anchor().target }, { ...rangeTarget(), axis_definition_revision: 3 },
		{ ...rangeTarget(), range: { ...rangeTarget().range, unit: "pixels" } }, { ...rangeTarget(), type: "group" }]) {
		expect(() => parseLocalDiscussionAnchor({ ...target(), range })).toThrow();
	}
});

test("group preparation and archived request review preserve immutable restore metadata", () => {
	const operation = { ...command(), restoreGeneration: id(90) };
	const prepared = prepareBaseGroupCommand(operation, anchor());
	expect(prepared.restoreGeneration).toBe(id(90));
	expect(savedCommandReview({ ...operation, preparedAnchor: protocolJson(anchor()) }, identity.shareId).operation.restoreGeneration).toBe(id(90));
	expect(JSON.parse(queuedEnvelope(identity.shareId, prepared))).not.toHaveProperty("restoreGeneration");
	expect(JSON.parse(queuedEnvelope(identity.shareId, prepared)).command).not.toHaveProperty("restoreGeneration");
});

test.each(["group", "range", "summary"])("receipt review preserves the previously prepared %s target and cannot create one", kind => {
	const operation = kind === "range" ? rangeCommand() : kind === "summary" ? summaryCommand() : command();
	expect(() => savedCommandReview(operation, identity.shareId)).toThrow("no saved final target");
	const before = JSON.stringify(operation), captured = anchor();
	const review = savedCommandReview({ ...operation, preparedAnchor: protocolJson(captured) }, identity.shareId);
	expect(queuedEnvelope(identity.shareId, review.operation)).toBe(queuedEnvelope(identity.shareId, prepareBaseGroupCommand(operation, captured)));
	expect(JSON.stringify(operation)).toBe(before);
	expect(() => savedCommandReview({ ...operation, preparedAnchor: protocolJson({ ...captured, view_id: id(99) }) }, identity.shareId)).toThrow();
});

test.each(["range", "summary"])("%s capture and send response loss recover across cache reopen without dropping the selection", async kind => {
	const op = kind === "range" ? rangeCommand() : summaryCommand(), original = parsePendingBaseGroupCommand(op).anchor;
	await store.saveDraft({ id: "lane-range", scopeId: scope, revision: 0, body: "Keep", target: protocolJson(original) }, null);
	await store.enqueue(op, Date.now(), { id: "lane-range", revision: 0 });
	const transport = remote(); transport.captureBaseGroup.mockRejectedValueOnce(new DiscussionFailure("retry", "network_unavailable"));
	transport.send.mockRejectedValueOnce(new DiscussionFailure("retry", "network_unavailable"));
	for (let attempt = 0; attempt < 2; attempt++) {
		const leased = (await claim("range-" + attempt))!;
		await expect(delivery(transport).send(leased)).rejects.toMatchObject({ action: "retry" });
		await store.fail(op.operationId, leased.lease!, "network_unavailable", 0);
		store.close(); store = await DiscussionStore.open(identity, factory);
		expect(parsePendingBaseGroupCommand((await store.getOperation(op.operationId))!).anchor).toEqual(original);
	}
	const next = (await claim("range-restarted"))!, result = await delivery(transport).send(next); await store.accept(op.operationId, protocolJson(result));
	expect(transport.captureBaseGroup).toHaveBeenCalledTimes(2); expect(transport.send).toHaveBeenCalledTimes(2);
	expect(transport.send.mock.calls[0][0]).toEqual(transport.send.mock.calls[1][0]);
	expect(transport.send.mock.calls[1][0].payload).toMatchObject({ anchor: { target: kind === "range" ? { ...rangeTarget(), lane: anchor().target } :
		{ ...summaryTarget(), type: "group_summary", group: anchor().target } } });
	expect(await store.getDraft("lane-range")).toBeUndefined(); expect((await store.getOperation(op.operationId))!.state).toBe("accepted");
});

test("summary selections require bounded exact definitions and cannot acquire a different group or range", () => {
	const pending = parsePendingBaseGroupCommand(summaryCommand()).anchor;
	expect(parseLocalDiscussionAnchor(pending)).toEqual(pending);
	const prepared = prepareBaseGroupCommand(summaryCommand(), anchor());
	const wire = JSON.parse(queuedEnvelope(identity.shareId, prepared)).command.anchor;
	expect(parseAnchor(wire)).toEqual(wire);
	expect(wire.target).toEqual({ ...summaryTarget(), type: "group_summary", group: anchor().target });
	for (const summary of [{ ...summaryTarget(), definition_revision: 3 }, { ...summaryTarget(), type: "group_summary", group: anchor().target },
		{ ...summaryTarget(), computed_value: "secret" }, { ...summaryTarget(), dependency_ids: [id(99)] }]) {
		expect(() => parseLocalDiscussionAnchor({ ...target(), summary })).toThrow();
	}
	expect(() => parseLocalDiscussionAnchor({ ...pending, range: rangeTarget() })).toThrow();
	for (const group of [wire.target, { ...anchor().target, definition_revision: 4 }, { ...anchor().target, computed_value: 3 }, null]) {
		expect(() => parseAnchor({ ...wire, target: { ...wire.target, group } })).toThrow();
	}
	const wrong = anchor(); if (wrong.target.type === "group") wrong.target.value = { type: "text", value: "Different" };
	expect(() => prepareBaseGroupCommand(summaryCommand(), wrong)).toThrow();
});

test("a different verified group cannot replace a pending range's lane", async () => {
	await store.enqueue(rangeCommand()); const leased = (await claim())!, transport = remote(), changed = anchor();
	if (changed.target.type === "group") changed.target.value = { type: "text", value: "Other lane" };
	transport.captureBaseGroup.mockResolvedValue(changed);
	await expect(delivery(transport).send(leased)).rejects.toThrow(); expect(transport.send).not.toHaveBeenCalled();
	expect((await store.getOperation(leased.operationId))!.preparedAnchor).toBeUndefined();
});

test("offline draft transfer and two phases survive reopen, retaining original evidence and exact command", async () => {
	await store.saveDraft({ id: "selection:group", scopeId: scope, revision: 0, body: "original draft", target: protocolJson(target()) }, null);
	await store.enqueue(command(), Date.now(), { id: "selection:group", revision: 0 });
	expect(await store.getDraft("selection:group")).toBeUndefined();
	store.close(); store = await DiscussionStore.open(identity, factory);
	const transport = remote(); transport.send.mockRejectedValueOnce(new DiscussionFailure("retry", "network_unavailable"));
	const op = (await claim())!;
	await expect(delivery(transport).send(op)).rejects.toMatchObject({ action: "retry" });
	const prepared = await store.getOperation(op.operationId);
	expect(prepared?.preparedAnchor).toEqual(anchor()); expect(prepared?.payload).toEqual(command().payload);
	await store.fail(op.operationId, op.lease!, "network_unavailable", 0);
	store.close(); store = await DiscussionStore.open(identity, factory);
	const retry = (await claim("b"))!;
	await delivery(transport).send(retry);
	expect(transport.captureBaseGroup).toHaveBeenCalledTimes(1);
	expect(transport.send.mock.calls[1][0]).toEqual(transport.send.mock.calls[0][0]);
	expect(transport.send.mock.calls[0][0]).toMatchObject({ type: "thread.create", operationId: op.operationId });
});

test("lost capture reply retries the original evidence, without prematurely sending a thread", async () => {
	const transport = remote(); transport.captureBaseGroup.mockRejectedValueOnce(new DiscussionFailure("retry", "network_unavailable"));
	await store.enqueue(command()); const op = (await claim())!;
	await expect(delivery(transport).send(op)).rejects.toMatchObject({ action: "retry" });
	expect(transport.send).not.toHaveBeenCalled(); expect((await store.getOperation(op.operationId))?.preparedAnchor).toBeUndefined();
	await store.fail(op.operationId, op.lease!, "offline", 0);
	store.close(); store = await DiscussionStore.open(identity, factory);
	await delivery(transport).send((await claim("b"))!);
	expect(transport.captureBaseGroup.mock.calls[0]).toEqual(transport.captureBaseGroup.mock.calls[1]);
	expect(transport.captureBaseGroup.mock.calls[1]).toEqual([scope, target().capture]);
});

test("capture proof must be saved before any thread request, including storage failures", async () => {
	await store.enqueue(command()); const op = (await claim())!, transport = remote();
	const save = store.prepareBaseGroup.bind(store);
	jest.spyOn(store, "prepareBaseGroup").mockImplementation(async (...args) => {
		if (args[2]) throw new Error("Storage full"); return save(...args);
	});
	await expect(delivery(transport).send(op)).rejects.toThrow("Storage full");
	expect(transport.send).not.toHaveBeenCalled();
	expect((await store.getOperation(op.operationId))?.payload).toEqual(command().payload);
});

test.each(["generation", "property", "value", "view", "definition"])("a mismatched %s proof cannot replace the captured target", async field => {
	await store.enqueue(command()); const op = (await claim())!, transport = remote(), proof = anchor();
	if (field === "generation") proof.generation = id(20);
	if (field === "view") proof.view_id = id(20);
	if (proof.target.type === "group") {
		if (field === "property") proof.target.property.name = "secret";
		if (field === "value") proof.target.value = { type: "number", value: 1 };
		if (field === "definition") proof.target.definition_id = id(20);
	}
	transport.captureBaseGroup.mockResolvedValue(proof);
	await expect(delivery(transport).send(op)).rejects.toThrow();
	expect(transport.send).not.toHaveBeenCalled(); expect((await store.getOperation(op.operationId))?.preparedAnchor).toBeUndefined();
});

test("an expired worker cannot prepare or send after another window claims the same intent", async () => {
	await store.enqueue(command()); const op = (await claim())!, transport = remote();
	let finish!: (proof: BaseAnchor) => void, began!: () => void;
	const started = new Promise<void>(r => { began = r; });
	transport.captureBaseGroup.mockImplementationOnce(() => { began(); return new Promise<BaseAnchor>(r => { finish = r; }); });
	const first = delivery(transport).send(op); await started;
	const second = (await claim("b", op.lease!.expiresAt))!;
	finish(anchor()); await expect(first).rejects.toMatchObject({ code: "local_operation_changed" });
	expect(transport.send).not.toHaveBeenCalled();
	await delivery(transport).send(second); expect(transport.send).toHaveBeenCalledTimes(1);
});

test("stopping the worker during capture never starts a thread send", async () => {
	await store.enqueue(command()); const transport = remote();
	let finish!: (proof: BaseAnchor) => void, began!: () => void;
	const started = new Promise<void>(r => { began = r; });
	transport.captureBaseGroup.mockImplementationOnce(() => { began(); return new Promise<BaseAnchor>(r => { finish = r; }); });
	const w = worker(transport); w.resume(); await started; w.stop(); finish(anchor()); await w.settled();
	expect(transport.send).not.toHaveBeenCalled();
	expect(await store.getOperation(id(13))).toMatchObject({ state: "sending", payload: command().payload });
});

test("editing an unprepared group draft fences a capture already in flight before any thread send", async () => {
	const original = await store.enqueue(command()), transport = remote();
	let finish!: (proof: BaseAnchor) => void, began!: () => void;
	const started = new Promise<void>(resolve => { began = resolve; });
	transport.captureBaseGroup.mockImplementationOnce(() => { began(); return new Promise<BaseAnchor>(resolve => { finish = resolve; }); });
	const w = worker(transport); w.resume(); await started;
	const recovered = await store.restoreCommandForReview(original, protocolJson(editableCommentDraft(parsePendingBaseGroupCommand(command()).body, () => "Member")), true);
	finish(anchor()); await w.settled();
		expect(transport.send).not.toHaveBeenCalled();
		expect(await store.getOperation(original.operationId)).toMatchObject({ state: "review", reviewDraftId: recovered.id });
		expect(recovered.target).toEqual(target());
});

test("capture rejection retains the original comment and keeps dependent replies blocked", async () => {
	await store.enqueue(command()); await store.enqueue({ ...command(), operationId: id(21), type: "reply.create", dependsOn: [id(13)],
		payload: { type: "reply.create", thread_id: id(14), message_id: id(22), body: protocolJson(bodyFromText("Reply")) } });
	const transport = remote(); transport.captureBaseGroup.mockRejectedValue(new DiscussionFailure("reject", "base_group_source_changed", 403));
	const w = worker(transport); w.resume(); await w.settled(); w.stop();
	expect(await store.getOperation(id(13))).toMatchObject({ state: "rejected", payload: command().payload });
	expect((await store.getOperation(id(21)))?.state).toBe("queued");
	expect(transport.send).not.toHaveBeenCalled(); expect(await store.nextWakeAt()).toBeUndefined();
});

test.each(["group", "range", "summary"])("picture recovery fences an unprepared %s selection but requires withdrawal once prepared", async kind => {
	const image = await prepareLocalPicture(id(30), scope, new Uint8Array([1, 2, 3]).buffer);
	await store.saveDraft({ id: "picture-draft", scopeId: scope, revision: 0, body: { text: "picture", mentions: [], pictures: [{ type: "picture", picture_id: id(30) }] } }, null, [image]);
	const op = kind === "range" ? rangeCommand() : kind === "summary" ? summaryCommand() : command(), payload = parsePendingBaseGroupCommand(op), expectedAnchor = payload.anchor;
	payload.body.blocks.push({ type: "picture", picture_id: id(30) }); op.payload = protocolJson(payload);
	await store.enqueue(op);
	const upload = (await claim())!; expect(upload.type).toBe("picture.upload"); await store.accept(upload.operationId, {});
	const claimed = (await claim())!;
	await store.replacePicturesAfterWithdrawal(op, id(31), [{ oldId: id(30), newId: id(32) }], Date.now(), true);
	expect(await store.prepareBaseGroup(op.operationId, claimed.lease!, protocolJson(anchor()))).toBeUndefined();
	expect((await store.getOperation(id(31)))?.payload).toMatchObject({ anchor: expectedAnchor });
	const nextUpload = (await claim())!; await store.accept(nextUpload.operationId, {});
	const next = (await claim())!; await store.prepareBaseGroup(next.operationId, next.lease!, protocolJson(anchor()));
	await expect(store.replacePicturesAfterWithdrawal(next, id(33), [{ oldId: id(32), newId: id(34) }], Date.now(), true)).rejects.toThrow("advanced");
	expect((await store.getOperation(id(31)))?.state).toBe("sending");
});
