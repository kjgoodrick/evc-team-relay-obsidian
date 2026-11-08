import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { restoreGeneration } from "../../src/collaboration/RestoreGeneration";
import type { QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.example", accountId: id(1), shareId: id(2) };
const credential = async () => ({ accountId: id(1), accessToken: "synthetic-token" });
const op = (): QueuedCommand => ({ operationId: id(3), scopeId: id(4), type: "reply.create", dependsOn: [],
	payload: { type: "reply.create", thread_id: id(5), message_id: id(6) } });
const result = { operation_id: id(3), scope_id: id(7), thread_id: id(5), message_id: id(6), sequence: 1,
	state: "open", state_revision: 1, message_revision: 1, message_deleted: false, changed: true, removed: false };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test.each(["send", "sendOnline", "withdraw", "withdrawOnline"] as const)("%s freezes the request's original generation before refreshing credentials", async method => {
	let finish!: (value: Awaited<ReturnType<typeof credential>>) => void;
	const token = new Promise<Awaited<ReturnType<typeof credential>>>(resolve => { finish = resolve; });
	const fetcher = jest.fn().mockResolvedValue(response(method.startsWith("withdraw") ? { status: "accepted", result } : result));
	const operation = { ...op(), restoreGeneration: id(90) }, transport = new DiscussionTransport(identity, () => token, fetcher);
	const sending = transport[method](operation);
	operation.restoreGeneration = id(91); operation.operationId = id(92);
	finish(await credential()); await sending;
	expect(fetcher.mock.calls[0][1].headers["X-Relay-Restore-Generation"]).toBe(id(90));
	expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ protocol_version: 1, operation_id: id(3), share_id: id(2), entry_id: id(4), command: op().payload });
});

test("legacy requests retain the original lineage even after a newer capability read", async () => {
	const fetcher = jest.fn().mockResolvedValueOnce(response({ protocol_version: 1, restore_generation: id(90),
		features: { discussion_commands: true, discussion_command_restore_guard: true } })).mockResolvedValue(response(result));
	const transport = new DiscussionTransport(identity, credential, fetcher);
	expect((await transport.capabilities()).restoreContext).toEqual({ supported: true, generation: id(90) });
	await transport.send(op());
	expect(fetcher.mock.calls[1][1].headers["X-Relay-Restore-Generation"]).toBeUndefined();
});

test.each(["commandStatus", "onlineCommandStatus"] as const)("%s remains a read without a current-generation requirement", async method => {
	const fetcher = jest.fn().mockResolvedValue(response({ status: "unknown", operation_id: id(3), entry_id: id(4) }));
	const transport = new DiscussionTransport(identity, credential, fetcher);
	expect(await transport[method]({ ...op(), restoreGeneration: id(90) })).toEqual({ status: "unknown" });
	expect(fetcher.mock.calls[0][1].headers["X-Relay-Restore-Generation"]).toBeUndefined();
});

test("invalid metadata is rejected locally and a server generation conflict pauses delivery", async () => {
	const fetcher = jest.fn().mockResolvedValue(response({ detail: { code: "restore_generation_changed" } }, 409));
	const transport = new DiscussionTransport(identity, credential, fetcher);
	await expect(transport.send({ ...op(), restoreGeneration: "invalid" })).rejects.toMatchObject({ code: "invalid_restore_generation", action: "pause" });
	expect(fetcher).not.toHaveBeenCalled();
	await expect(transport.send(op())).rejects.toMatchObject({ code: "restore_generation_changed", action: "pause" });
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
	{ flag: true }, { flag: true, generation: "invalid" }, { flag: "yes", generation: null },
	{ generation: id(90) }, { flag: false },
])("capabilities reject incomplete or malformed generation metadata %j", async ({ flag, generation }) => {
	const fetcher = jest.fn().mockResolvedValue(response({ protocol_version: 1, restore_generation: generation,
		features: { discussion_commands: true, discussion_command_restore_guard: flag } }));
	await expect(new DiscussionTransport(identity, credential, fetcher).capabilities()).rejects.toMatchObject({ code: "invalid_read_response" });
});

test.each([true, false])("capabilities preserve the declared guard availability: %s", async supported => {
	const fetcher = jest.fn().mockResolvedValue(response({ protocol_version: 1, restore_generation: null,
		features: { discussion_commands: true, discussion_command_restore_guard: supported } }));
	expect((await new DiscussionTransport(identity, credential, fetcher).capabilities()).restoreContext).toEqual({ supported, generation: null });
	expect(restoreGeneration(undefined)).toBeNull();
});
