import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import type { QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.example", accountId: id(1), shareId: id(2) };
const credential = async () => ({ accountId: id(1), accessToken: "synthetic-token" });
const operation = (): QueuedCommand => ({ operationId: id(3), scopeId: id(4), type: "thread.create", dependsOn: [], payload: {
	type: "thread.create", thread_id: id(5), message_id: id(6), anchor: { version: 1, type: "note" },
	body: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Saved work" }] }] },
} });
const result = () => ({ operation_id: id(3), scope_id: id(7), thread_id: id(5), message_id: id(6), sequence: 1,
	state: "open", state_revision: 1, message_revision: 1, message_deleted: false, changed: true, removed: false });
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

test.each(["withdrawn", "unknown"])("reads %s without sending, withdrawing or altering the request", async status => {
	const fetcher = jest.fn().mockResolvedValue(response({ status, operation_id: id(3), entry_id: id(4) }));
	const op = operation(), before = JSON.stringify(op);
	expect(await new DiscussionTransport(identity, credential, fetcher).commandStatus(op)).toEqual({ status });
	expect(JSON.stringify(op)).toBe(before);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(fetcher.mock.calls[0][0]).toBe("https://relay.example/v1/collaboration/commands/status");
	expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", sensitive: true });
	expect(JSON.parse(fetcher.mock.calls[0][1].body).command).toEqual(op.payload);
});

test("validates an accepted receipt and keeps only protocol fields", async () => {
	const fetcher = jest.fn().mockResolvedValue(response({ status: "accepted", result: { ...result(), private_body: "ignored" } }));
	expect(await new DiscussionTransport(identity, credential, fetcher).commandStatus(operation()))
		.toEqual({ status: "accepted", result: result() });
	fetcher.mockResolvedValue(response({ status: "accepted", result: { ...result(), message_id: id(99) } }));
	await expect(new DiscussionTransport(identity, credential, fetcher).commandStatus(operation()))
		.rejects.toMatchObject({ code: "invalid_command_response", action: "pause" });
});

test.each([
	{ status: "unknown", operation_id: id(9), entry_id: id(4) },
	{ status: "withdrawn", operation_id: id(3), entry_id: id(9) },
	{ status: "not_accepted", operation_id: id(3), entry_id: id(4) },
	{ status: "unknown" },
])("rejects ambiguous or misbound receipt responses %j", async value => {
	const fetcher = jest.fn().mockResolvedValue(response(value));
	await expect(new DiscussionTransport(identity, credential, fetcher).commandStatus(operation()))
		.rejects.toMatchObject({ code: "invalid_command_status_response", action: "pause" });
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test("online moderation receipt inspection does not submit the original mutation", async () => {
	const fetcher = jest.fn().mockResolvedValue(response({ status: "unknown", operation_id: id(3), entry_id: id(4) }));
	const op = { operationId: id(3), scopeId: id(4), payload: {
		type: "thread.remove", thread_id: id(5), expected_state_revision: 1, reason: "Saved reason",
	} };
	expect(await new DiscussionTransport(identity, credential, fetcher).onlineCommandStatus(op)).toEqual({ status: "unknown" });
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(fetcher.mock.calls[0][0]).toBe("https://relay.example/v1/collaboration/commands/status");
});

test("captures the exact request before refresh and cancels a stale review", async () => {
	let finish!: (value: { accountId: string; accessToken: string }) => void;
	const token = new Promise<{ accountId: string; accessToken: string }>(resolve => { finish = resolve; });
	const fetcher = jest.fn().mockResolvedValue(response({ status: "accepted", result: result() }));
	const op = operation(), transport = new DiscussionTransport(identity, () => token, fetcher);
	const read = transport.commandStatus(op);
	(op.payload as Record<string, unknown>).message_id = id(90);
	finish(await credential());
	expect(await read).toEqual({ status: "accepted", result: result() });
	expect(JSON.parse(fetcher.mock.calls[0][1].body).command.message_id).toBe(id(6));
	fetcher.mockClear();
	await expect(transport.commandStatus(operation(), () => false)).rejects.toMatchObject({ code: "action_context_changed" });
	expect(fetcher).not.toHaveBeenCalled();
});

test("a missing endpoint or network error remains an error, never unknown", async () => {
	const fetcher = jest.fn().mockResolvedValue(new Response("not supported", { status: 404 }));
	const transport = new DiscussionTransport(identity, credential, fetcher);
	await expect(transport.commandStatus(operation())).rejects.toMatchObject({ action: "pause" });
	fetcher.mockRejectedValue(new Error("offline secret-token"));
	await expect(transport.commandStatus(operation())).rejects.toMatchObject({ action: "retry" });
	expect(fetcher).toHaveBeenCalledTimes(2);
});

test("capability negotiation is optional and strictly typed", async () => {
	const fetcher = jest.fn().mockResolvedValue(response({ protocol_version: 1,
		features: { discussion_commands: true, discussion_command_status: true } }));
	const transport = new DiscussionTransport(identity, credential, fetcher);
	expect((await transport.capabilities()).commandStatus).toBe(true);
	fetcher.mockResolvedValue(response({ protocol_version: 1, features: { discussion_commands: true } }));
	expect((await transport.capabilities()).commandStatus).toBeUndefined();
	fetcher.mockResolvedValue(response({ protocol_version: 1,
		features: { discussion_commands: true, discussion_command_status: "yes" } }));
	await expect(transport.capabilities()).rejects.toMatchObject({ code: "invalid_read_response" });
});
