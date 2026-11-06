import { DiscussionFailure, DiscussionTransport, queuedEnvelope } from "../../src/collaboration/DiscussionTransport";
import type { QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { RelayHttpError } from "../../src/relayRequestErrors";
import { toBase64 } from "lib0/buffer";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.example", accountId: id(1), shareId: id(2) };
const credentials = () => Promise.resolve({ accountId: id(1), accessToken: "synthetic-token" });
const op = (): QueuedCommand => ({ operationId: id(3), scopeId: id(4), type: "thread.create", dependsOn: [], payload: {
	type: "thread.create", thread_id: id(5), message_id: id(6), anchor: { version: 1, type: "note" },
	body: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Comment" }] }] },
} });
const result = () => ({ operation_id: id(3), scope_id: id(7), thread_id: id(5), message_id: id(6), sequence: 1,
	state: "open", state_revision: 1, message_revision: 1, message_deleted: false, changed: true, removed: false });
const reply = (status: number, body: unknown, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });

test("sends stable entry identity, refreshable same-account token, and sensitive diagnostics option", async () => {
	const fetcher = jest.fn().mockResolvedValue(reply(200, { ...result(), ignored: "not persisted" }));
	const transport = new DiscussionTransport(identity, credentials, fetcher);
	expect(await transport.send(op())).toEqual(result());
	const [url, config] = fetcher.mock.calls[0];
	expect(url).toBe("https://relay.example/v1/collaboration/commands");
	expect(config).toMatchObject({ method: "POST", sensitive: true, headers: { Authorization: "Bearer synthetic-token" } });
	expect(JSON.parse(config.body)).toMatchObject({ operation_id: id(3), entry_id: id(4), share_id: id(2), command: op().payload });
});

test("does not submit another account's credential or alter payload during refresh", async () => {
	const fetcher = jest.fn().mockResolvedValue(reply(200, result()));
	await expect(new DiscussionTransport(identity, async () => ({ accountId: id(9), accessToken: "wrong" }), fetcher).send(op()))
		.rejects.toMatchObject({ action: "authenticate" });
	expect(fetcher).not.toHaveBeenCalled();
	let ready!: (value: { accountId: string; accessToken: string }) => void;
	const token = new Promise<{ accountId: string; accessToken: string }>(resolve => { ready = resolve; });
	const operation = op(), pending = new DiscussionTransport(identity, () => token, fetcher).send(operation);
	(operation.payload as Record<string, unknown>).body = "changed after send";
	ready({ accountId: id(1), accessToken: "refreshed" });
	await pending;
	expect(JSON.parse(fetcher.mock.calls[0][1].body).command.body).toEqual((op().payload as Record<string, unknown>).body);
});

test.each([
	[401, "authentication_required", "authenticate"], [403, "comment_forbidden", "reject"],
	[404, "target_unavailable", "reject"], [409, "stale_message_revision", "reject"],
	[413, "command_too_large", "reject"], [422, "invalid_command", "reject"],
	[429, "server_unavailable", "retry"], [503, "server_unavailable", "retry"],
	[409, "anchor_dependency_not_ready", "retry"], [409, "anchor_generation_mismatch", "reject"],
	[409, "text_anchors_disabled", "pause"], [422, "invalid_anchor", "reject"],
	[409, "image_files_disabled", "pause"], [422, "invalid_anchor_scope", "reject"],
])("classifies HTTP %s without exposing response content", async (status, code, action) => {
	const fetcher = jest.fn().mockResolvedValue(reply(status as number, { error: { message: { code }, private_body: "secret-comment" } }, { "Retry-After": "60" }));
	const failure = await new DiscussionTransport(identity, credentials, fetcher).send(op()).catch(e => e);
	expect(failure).toMatchObject({ action, code, status });
	expect(String(failure)).not.toContain("secret-comment");
	if (action === "retry") expect(failure.retryAfterMs).toBe(60_000);
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test("native HTTP/network failures are sanitized and never retried inside transport", async () => {
	for (const error of [new Error("network failed synthetic-token"), new RelayHttpError(503, "secret-comment", 120_000)]) {
		const fetcher = jest.fn().mockRejectedValue(error);
		const failure = await new DiscussionTransport(identity, credentials, fetcher).send(op()).catch(e => e);
		expect(failure).toBeInstanceOf(DiscussionFailure);
		expect(failure.action).toBe("retry"); expect(String(failure)).not.toMatch(/synthetic-token|secret-comment/);
		expect(fetcher).toHaveBeenCalledTimes(1);
	}
});

test.each([{ operation_id: id(8) }, { message_id: id(9) }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { state_revision: 0 }])(
	"does not acknowledge a mismatched or invalid successful response %j", async patch => {
		const fetcher = jest.fn().mockResolvedValue(reply(200, { ...result(), ...patch }));
		await expect(new DiscussionTransport(identity, credentials, fetcher).send(op())).rejects.toMatchObject({ action: "pause", code: "invalid_command_response" });
	});

test("rejects offline moderation, malformed IDs, and oversized UTF-8 bodies before HTTP", () => {
	const operation = op();
	expect(() => queuedEnvelope(id(2), { ...operation, type: "reply.create", payload: { ...(operation.payload as object), type: "reply.create", reopen: true } })).toThrow("online_command_required");
	expect(() => queuedEnvelope(id(2), { ...operation, scopeId: "note/path.md" })).toThrow("invalid_local_command");
	expect(() => queuedEnvelope(id(2), { ...operation, payload: { ...(operation.payload as object), body: "😀".repeat(20000) } })).toThrow("command_too_large");
});

test("timeout during credential refresh cannot send after the timeout", async () => {
	jest.useFakeTimers();
	try {
		let ready!: (value: { accountId: string; accessToken: string }) => void;
		const credential = new Promise<{ accountId: string; accessToken: string }>(resolve => { ready = resolve; });
		const fetcher = jest.fn(), pending = new DiscussionTransport(identity, () => credential, fetcher, 50).send(op()).catch(e => e);
		await jest.advanceTimersByTimeAsync(50);
		expect(await pending).toMatchObject({ action: "retry", code: "request_timeout" });
		ready({ accountId: id(1), accessToken: "late" }); await Promise.resolve(); await Promise.resolve();
		expect(fetcher).not.toHaveBeenCalled();
	} finally { jest.useRealTimers(); }
});

test("missing or disabled preview pauses the queue without marking drafts rejected", async () => {
	for (const response of [reply(404, { error: { message: { code: "discussion_preview_disabled" } } }), new Response("not found", { status: 404 })]) {
		await expect(new DiscussionTransport(identity, credentials, jest.fn().mockResolvedValue(response)).send(op()))
			.rejects.toMatchObject({ action: "pause", code: "discussion_endpoint_unavailable" });
	}
});

test("non-JSON forbidden responses still invalidate access and do not expose raw response text", async () => {
	await expect(new DiscussionTransport(identity, credentials, jest.fn().mockResolvedValue(new Response("private text", { status: 403 }))).send(op()))
		.rejects.toMatchObject({ action: "reject", code: "command_rejected", status: 403 });
});

test("negotiates text anchors and binds document context to the requested entry", async () => {
	const fetcher = jest.fn().mockResolvedValue(reply(200, { protocol_version: 1, features: { discussion_commands: true, discussion_text_anchors: true } }));
	const transport = new DiscussionTransport(identity, credentials, fetcher);
	expect(await transport.capabilities()).toEqual({ discussions: true, textAnchors: true, blockAnchors: false, imageOccurrences: false, imageFiles: false, pictures: false, recovery: false, baseTargets: [], baseRecordTypes: [] });
	fetcher.mockResolvedValue(reply(200, { protocol_version: 1, features: { discussion_commands: true, discussion_text_anchors: true, discussion_block_anchors: "true" } }));
	await expect(transport.capabilities()).rejects.toMatchObject({ action: "pause", code: "invalid_read_response" });
	fetcher.mockResolvedValue(reply(200, { protocol_version: 1, features: { discussion_commands: true, discussion_text_anchors: true, discussion_block_anchors: true } }));
	expect(await transport.capabilities()).toEqual({ discussions: true, textAnchors: true, blockAnchors: true, imageOccurrences: false, imageFiles: false, pictures: false, recovery: false, baseTargets: [], baseRecordTypes: [] });
	fetcher.mockResolvedValue(reply(200, { protocol_version: 1, entry_id: id(4), generation: id(8) }));
	expect(await transport.anchorContext(id(4))).toEqual({ entryId: id(4), generation: id(8) });
	expect(fetcher.mock.calls[3][0]).toContain(`/entries/${id(4)}/anchor-context`);
	fetcher.mockResolvedValue(reply(200, { protocol_version: 1, entry_id: id(9), generation: id(8) }));
	await expect(transport.anchorContext(id(4))).rejects.toMatchObject({ action: "pause", code: "invalid_read_response" });
});

test("text commands allow a bounded 64 KiB dependency without increasing whole-note limits", () => {
	const anchor = { version: 1, type: "text", document_id: id(4), generation: id(8), start: "AA==", end: "AA==",
		dependency: toBase64(new Uint8Array(65536)), selected_length: 0, context: { quote: "", prefix: "", suffix: "", truncated: false } };
	const operation = { ...op(), payload: { ...op().payload as object, anchor } };
	expect(queuedEnvelope(id(2), operation).length).toBeGreaterThan(65536);
	expect(() => queuedEnvelope(id(2), { ...operation, payload: { ...operation.payload, anchor: { ...anchor, document_id: id(9) } } })).toThrow("invalid_local_anchor");
	expect(() => queuedEnvelope(id(2), { ...operation, payload: { ...operation.payload, anchor: { ...anchor, dependency: toBase64(new Uint8Array(65537)) } } })).toThrow("invalid_local_anchor");
});
