import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { parseBaseDefinitionCatalog, supportsBaseGroupDefinition, type BaseDefinitionCatalog } from "../../src/collaboration/BaseDefinitionProtocol";
import { DiscussionTransport, DiscussionFailure } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { parseLocalDiscussionAnchor, parsePendingBaseGroupCommand, prepareBaseGroupCommand, type PendingBaseGroupAnchor } from "../../src/collaboration/LocalDiscussionAnchor";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "formula-groups" };
const scope = baseDiscussionScope(id(3), id(4));
const context = { protocol_version: 1 as const, entry_id: id(3), view_id: id(4), definition_id: id(5), generation: id(6), registry_revision: 2 };
const catalog = (): BaseDefinitionCatalog => ({ ...context, computed_values: false, formula_group_ids: [id(7)], targets: [
	{ id: id(7), kind: "group", revision: 2, fingerprint: "a".repeat(64), property: { source: "formula", name: "Bucket" } },
] });
const selection = { group_definition_id: id(7), group_definition_revision: 2, record_id: id(8), record_generation: id(9),
	dependency: "AA==", time_zone: "UTC", value: { type: "number" as const, value: 7 } };
const command = (anchor: PendingBaseGroupAnchor): QueuedCommand => ({ operationId: id(11), scopeId: scope, type: "base.group.create", dependsOn: [],
	payload: protocolJson({ type: "base.group.create", thread_id: id(12), message_id: id(13), anchor, body: bodyFromText("Discuss this calculation") }) });
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function remote() {
	return { identity, capabilities: jest.fn().mockResolvedValue({ discussions: true, baseTargets: ["group"], baseFormulaGroups: true }),
		baseTargetContext: jest.fn(async (_scope: string, _view: string, record?: string) => ({ ...context, ...(record ? { record_id: record, record_generation: id(9) } : {}) })),
		baseDefinitions: jest.fn().mockImplementation(async () => catalog()), permissions: jest.fn().mockResolvedValue({ read: true, comment: true, edit: false, moderate: false }),
		participants: jest.fn().mockResolvedValue({ participants: [], hasMore: false }), changes: jest.fn().mockResolvedValue({ events: [], cursor: "current", has_more: false }), send: jest.fn() };
}

test("formula capture eligibility requires explicit capabilities and valid page-local group identities", async () => {
	const parsed = parseBaseDefinitionCatalog(catalog(), id(3), id(4));
	expect(supportsBaseGroupDefinition(parsed, parsed.targets[0])).toBe(true);
	expect(supportsBaseGroupDefinition({ ...parsed, formula_group_ids: undefined }, parsed.targets[0])).toBe(false);
	for (const ids of [true, [id(99)], [id(7), id(7)], ["Bucket"]]) {
		expect(() => parseBaseDefinitionCatalog({ ...catalog(), formula_group_ids: ids }, id(3), id(4))).toThrow();
	}
	expect(() => parseBaseDefinitionCatalog({ ...catalog(), targets: [{ ...parsed.targets[0], kind: "formula" }] }, id(3), id(4))).toThrow();
	const base = { protocol_version: 1, features: { discussion_commands: true, discussion_bases: true, discussion_base_definition_catalog: true,
		discussion_base_groups: true, discussion_base_formula_groups: true }, discussion_base_targets: ["group"] };
	const fetcher = jest.fn().mockResolvedValue(response(base));
	const transport = new DiscussionTransport(identity, async () => ({ accountId: id(1), accessToken: "synthetic" }), fetcher);
	expect((await transport.capabilities()).baseFormulaGroups).toBe(true);
	for (const feature of ["discussion_bases", "discussion_base_definition_catalog", "discussion_base_groups", "discussion_base_formula_groups"]) {
		fetcher.mockResolvedValue(response({ ...base, features: { ...base.features, [feature]: false } }));
		expect((await transport.capabilities()).baseFormulaGroups).toBe(false);
	}
	fetcher.mockResolvedValue(response({ ...base, features: { ...base.features, discussion_base_formula_groups: "yes" } }));
	await expect(transport.capabilities()).rejects.toMatchObject({ code: "invalid_read_response" });
});

test("pagination retains formula eligibility from later pages and refuses a mid-read gate change", async () => {
	const first = { ...catalog(), formula_group_ids: [], targets: [{ ...catalog().targets[0], id: id(1), kind: "formula" }], has_more: true, next_after: id(1) };
	const second = { ...catalog(), has_more: false, next_after: id(7) };
	const fetcher = jest.fn().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(second));
	const transport = new DiscussionTransport(identity, async () => ({ accountId: id(1), accessToken: "synthetic" }), fetcher);
	const result = await transport.baseDefinitions(scope, id(4));
	expect(result.formula_group_ids).toEqual([id(7)]); expect(result.targets).toHaveLength(2);
	fetcher.mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response({ ...second, formula_group_ids: undefined }));
	await expect(transport.baseDefinitions(scope, id(4))).rejects.toMatchObject({ code: "invalid_read_response" });
});

test("formula group snapshot, value and eligibility survive offline restart; downgrade keeps pending work", async () => {
	const factory = new IDBFactory(), source = remote(); let store = await DiscussionStore.open(identity, factory);
	let session = new DiscussionSession(store, source as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const captured = await session.captureBaseGroupSelection(scope, selection);
		expect(captured.property).toEqual({ source: "formula", name: "Bucket" });
		session.setForeground(false); await session.outbox.settled();
		await session.queue(command(captured)); await session.close();
		for (const call of [source.capabilities, source.permissions, source.baseTargetContext, source.baseDefinitions, source.changes]) {
			call.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		}
		store = await DiscussionStore.open(identity, factory); session = new DiscussionSession(store, source as unknown as DiscussionTransport);
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh(); session.setForeground(false); await session.outbox.settled();
		const restored = await session.captureBaseGroupSelection(scope, selection);
		expect(restored.capture).toEqual({ ...captured.capture, operation_id: restored.capture.operation_id });
		expect(parsePendingBaseGroupCommand((await store.getOperation(id(11)))!).anchor).toEqual(captured);
		source.capabilities.mockResolvedValue({ discussions: true, baseTargets: ["group"] });
		await session.start(); expect(session.canAnchorBaseGroup(captured.property)).toBe(false);
		await expect(session.captureBaseGroupSelection(scope, selection)).rejects.toThrow();
		expect((await store.pending(scope))).toHaveLength(1);
	} finally { await session.close(); }
});

test("a valid capability does not authorize an unadvertised formula or inventory substitute", async () => {
	const source = remote(), store = await DiscussionStore.open(identity, new IDBFactory());
	const session = new DiscussionSession(store, source as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		source.baseDefinitions.mockResolvedValue({ ...catalog(), formula_group_ids: [] });
		await expect(session.captureBaseGroupSelection(scope, selection)).rejects.toThrow("changed");
		source.baseDefinitions.mockResolvedValue(catalog());
		const captured = await session.captureBaseGroupSelection(scope, selection);
		const { dependency: _dependency, time_zone: _zone, ...common } = captured.capture;
		expect(() => parseLocalDiscussionAnchor({ ...captured, capture: { ...common, source_kind: "file", source_path_sha256: "a".repeat(64) } })).toThrow();
		const wire = { version: 1 as const, type: "base" as const, definition_id: id(5), view_id: id(4), generation: id(6), registry_revision: 2,
			target: { type: "group" as const, definition_id: id(7), definition_revision: 2, property: captured.property, group_id: id(20), witness_id: id(21), value: selection.value } };
		expect(prepareBaseGroupCommand(command(captured), wire).type).toBe("thread.create");
		expect(() => prepareBaseGroupCommand(command(captured), { ...wire, target: { ...wire.target, property: { source: "note", name: "Bucket" } } })).toThrow();
	} finally { await session.close(); }
});
