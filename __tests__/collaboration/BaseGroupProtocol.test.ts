import { parseBaseGroupValue } from "../../src/collaboration/BaseGroupValue";
import { copyBaseGroupCapture, parseBaseGroupCaptureResult, type BaseGroupCapture } from "../../src/collaboration/BaseGroupProtocol";
import { parseAnchor, protocolJson, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { DiscussionTransport, queuedEnvelope } from "../../src/collaboration/DiscussionTransport";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2) };
const credential = async () => ({ accountId: id(1), accessToken: "synthetic" });
const request = (): BaseGroupCapture => ({ operation_id: id(3), definition_id: id(4), view_id: id(5), generation: id(6),
	registry_revision: 2, group_definition_id: id(7), group_definition_revision: 2, record_id: id(8), record_generation: id(9),
	dependency: "AA==", time_zone: "UTC", value: { type: "text", value: "Done" } });
const anchor = (): BaseAnchor => ({ version: 1, type: "base", definition_id: id(4), view_id: id(5), generation: id(6), registry_revision: 3,
	target: { type: "group", definition_id: id(7), definition_revision: 2, property: { source: "note", name: "status" },
		group_id: id(10), witness_id: id(11), value: request().value } });
const result = () => ({ protocol_version: 1, entry_id: id(12), anchor: anchor() });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test.each([
	{ type: "empty" }, { type: "text", value: "" }, { type: "text", value: "0" }, { type: "number", value: 0 }, { type: "boolean", value: false },
	{ type: "date", value: "2026-11-06" }, { type: "instant", value: "2026-11-06T00:00:00.000Z" }, { type: "url", value: "https://example.test/" },
	{ type: "tag", value: "#tag" }, { type: "duration", value: [1, 2, 3, 4, 5, 6, 7] }, { type: "list", value: [{ type: "empty" }] },
	{ type: "file", record_id: id(1), record_generation: id(2) }, { type: "link", record_id: id(1), record_generation: id(2), subpath: "#heading" },
	{ type: "unresolved_link", record_id: id(1), record_generation: id(2), link: "Missing", source_path_sha256: "a".repeat(64) },
])("preserves typed group identity %j without source authority", value => {
	expect(parseBaseGroupValue(value)).toEqual(value);
	const a = anchor(); a.target = { ...a.target, value } as typeof a.target;
	expect(parseAnchor(a)).toEqual(a);
});

test.each([
	{ type: "text", value: "a".repeat(8193) }, { type: "text", value: "\ud800" }, { type: "number", value: true }, { type: "number", value: Infinity },
	{ type: "list", value: Array.from({ length: 256 }, () => ({ type: "empty" })) }, { type: "date", value: "today" },
	{ type: "instant", value: "2026-11-06" }, { type: "duration", value: [1, 2] }, { type: "duration", value: [1, 2, 3, 4, 5, 6, NaN] },
	{ type: "file", record_id: "path.md", record_generation: id(2) }, { type: "tag", value: "untyped" },
	{ type: "link", record_id: id(1), record_generation: id(2), subpath: "path.md" }, { type: "text", value: "X", dependencies: [] },
	{ type: "constructor" }, { type: "__proto__" },
])("rejects invalid or unbounded group value %j", value => expect(() => parseBaseGroupValue(value)).toThrow());

test("bounds recursive structures and total text across siblings, while normalizing negative zero", () => {
	const cyclic: Record<string, unknown> = { type: "list" }; cyclic.value = [cyclic];
	expect(() => parseBaseGroupValue(cyclic)).toThrow();
	expect(() => parseBaseGroupValue({ type: "list", value: [{ type: "text", value: "a".repeat(5000) }, { type: "text", value: "a".repeat(5000) }] })).toThrow();
	expect(Object.is((parseBaseGroupValue({ type: "number", value: -0 }) as { value: number }).value, -0)).toBe(false);
});

test("capture results bind definition, view, lineage, definition revision and typed value", () => {
	expect(parseBaseGroupCaptureResult(result(), id(12), request())).toEqual(anchor());
	for (const patch of [{ definition_id: id(19) }, { view_id: id(19) }, { generation: id(19) }, { registry_revision: 1 }]) {
		expect(() => parseBaseGroupCaptureResult({ ...result(), anchor: { ...anchor(), ...patch } }, id(12), request())).toThrow();
	}
	for (const patch of [{ definition_id: id(19) }, { definition_revision: 1 }, { witness_id: "path" }, { value: { type: "number", value: 0 } }]) {
		expect(() => parseBaseGroupCaptureResult({ ...result(), anchor: { ...anchor(), target: { ...anchor().target, ...patch } } }, id(12), request())).toThrow();
	}
	expect(() => parseBaseGroupCaptureResult(result(), id(19), request())).toThrow();
});

test.each([{ dependency: "" }, { dependency: "AB==" }, { source: "untrusted" }, { registry_revision: true }, { time_zone: "" },
	{ dependency: Buffer.alloc(65537).toString("base64") }, { group_definition_revision: 3 }])("invalid capture fails before HTTP %j", async patch => {
	const invalid = { ...request(), ...patch };
	expect(() => copyBaseGroupCapture(invalid)).toThrow();
	const fetcher = jest.fn();
	await expect(new DiscussionTransport(identity, credential, fetcher).captureBaseGroup(id(12), invalid as BaseGroupCapture))
		.rejects.toMatchObject({ action: "reject", code: "invalid_local_target" });
	expect(fetcher).not.toHaveBeenCalled();
});

test("capture freezes its request before credential refresh and validates the saved-view scope", async () => {
	let ready!: (value: { accountId: string; accessToken: string }) => void;
	const credential = new Promise<{ accountId: string; accessToken: string }>(resolve => { ready = resolve; });
	const fetcher = jest.fn().mockImplementation(async () => reply(result()));
	const transport = new DiscussionTransport(identity, () => credential, fetcher), mutable = request();
	const pending = transport.captureBaseGroup(baseDiscussionScope(id(12), id(5)), mutable);
	mutable.value = { type: "text", value: "Changed" }; mutable.operation_id = id(19);
	ready({ accountId: id(1), accessToken: "synthetic" });
	expect(await pending).toEqual(anchor());
	expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(request());
	await expect(transport.captureBaseGroup(baseDiscussionScope(id(12), id(19)), request())).rejects.toMatchObject({ action: "reject" });
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([[true, true, ["group"]], [true, false, []], [false, true, []]])("group capability requires both protocol gates", async (catalog, group, expected) => {
	const fetcher = jest.fn().mockImplementation(async () => reply({ protocol_version: 1, features: { discussion_commands: true,
		discussion_bases: true, discussion_base_definition_catalog: catalog, discussion_base_groups: group }, discussion_base_targets: ["group"] }));
	expect((await new DiscussionTransport(identity, credential, fetcher).capabilities()).baseTargets).toEqual(expected);
});

test("large bounded group values fit capture responses and queued commands", async () => {
	const value = parseBaseGroupValue({ type: "list", value: [{ type: "text", value: "\x01".repeat(4800) }, ...Array.from({ length: 200 }, () => ({
		type: "unresolved_link", record_id: id(8), record_generation: id(9), link: "x", source_path_sha256: "a".repeat(64),
	}))] });
	const captured = anchor(); captured.target = { ...captured.target, value } as typeof captured.target;
	const response = { ...result(), anchor: captured }; expect(JSON.stringify(response).length).toBeGreaterThan(65536);
	const transport = new DiscussionTransport(identity, credential, async () => reply(response));
	expect(await transport.captureBaseGroup(id(12), { ...request(), value })).toEqual(captured);
	const serialized = queuedEnvelope(id(2), { operationId: id(3), scopeId: baseDiscussionScope(id(12), id(5)), type: "thread.create", dependsOn: [],
		payload: { type: "thread.create", thread_id: id(13), message_id: id(14), anchor: protocolJson(captured) } });
	expect(JSON.parse(serialized).command.anchor).toEqual(captured);
});

test.each([["base_groups_disabled", "pause"], ["base_group_value_changed", "reject"], ["base_group_source_changed", "reject"],
	["anchor_dependency_not_ready", "retry"], ["operation_conflict", "reject"]])("group error %s remains actionable without exposing response bodies", async (code, action) => {
	const transport = new DiscussionTransport(identity, credential, async () => reply({ detail: { code, private_source: "secret" } }, 409));
	const error = await transport.captureBaseGroup(id(12), request()).catch(e => e);
	expect(error).toMatchObject({ code, action }); expect(String(error)).not.toContain("secret");
});
