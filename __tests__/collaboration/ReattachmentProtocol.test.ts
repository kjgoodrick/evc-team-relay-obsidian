import * as Y from "yjs";
import { captureTextAnchor } from "../../src/collaboration/anchors/text";
import { parseChanges, protocolJson, wireTextAnchor } from "../../src/collaboration/DiscussionProtocol";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { parseAnchorHistory } from "../../src/collaboration/ReattachmentProtocol";
import { DiscussionTransport, queuedEnvelope, type OnlineOperation } from "../../src/collaboration/DiscussionTransport";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2) };
const credential = async () => ({ accountId: id(1), accessToken: "synthetic" });
const op = (): OnlineOperation => ({ operationId: id(3), scopeId: id(4), payload: { type: "thread.reattach", thread_id: id(5), expected_anchor_revision: 1, anchor: { version: 1, type: "note" } } });
const result = () => ({ operation_id: id(3), scope_id: id(8), thread_id: id(5), sequence: 2, state: "resolved", state_revision: 2, removed: false, changed: true, anchor_revision: 2 });
const thread = () => ({ id: id(5), author_id: id(1), state: "resolved", state_revision: 2, anchor_revision: 2, removed: false, created_sequence: 1, activity_sequence: 3, created_at: "2026-11-07T00:00:00Z" });
const page = () => ({ entry_id: id(4), thread: thread(), revisions: [1, 2].map(revision => ({ revision, actor_id: id(1), created_at: "2026-11-07T00:00:00Z", anchor: { version: 1, type: "note" }, unavailable: false })), has_more: false, next_after: 2 });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("reattachment is online only, validates scope/revision and verifies the accepted target revision", async () => {
	const fetcher = jest.fn().mockImplementation(async () => response(result())), transport = new DiscussionTransport(identity, credential, fetcher);
	expect(await transport.sendOnline(op())).toEqual(result());
	for (const patch of [{ expected_anchor_revision: true }, { expected_anchor_revision: 0 }, { body: {} }, { anchor: { version: 1, type: "base", view_id: id(9) } }]) {
		await expect(transport.sendOnline({ ...op(), payload: protocolJson({ ...(op().payload as object), ...patch }) })).rejects.toThrow("invalid_local_anchor");
	}
	expect(fetcher).toHaveBeenCalledTimes(1);
	fetcher.mockImplementation(async () => response({ ...result(), anchor_revision: 5 }));
	await expect(transport.sendOnline(op())).rejects.toMatchObject({ code: "invalid_command_response" });
	expect(() => queuedEnvelope(id(2), { ...op(), type: "thread.reattach", dependsOn: [] } as never)).toThrow("invalid_local_command");
});

test("text moves support bounded dependency evidence and cannot target another document", async () => {
	const document = new Y.Doc(); document.getText("content").insert(0, "alpha beta gamma");
	try {
		const anchor = wireTextAnchor(captureTextAnchor(document.getText("content"), id(4), id(9), 6, 10));
		const fetcher = jest.fn().mockResolvedValue(response(result())), transport = new DiscussionTransport(identity, credential, fetcher);
		await transport.sendOnline({ ...op(), payload: protocolJson({ ...(op().payload as object), anchor }) });
		await expect(transport.sendOnline({ ...op(), payload: protocolJson({ ...(op().payload as object), anchor: { ...anchor, document_id: id(10) } }) })).rejects.toThrow("invalid_local_anchor");
		expect(fetcher).toHaveBeenCalledTimes(1);
	} finally { document.destroy(); }
});

test("a closed action cannot dispatch after credential refresh, and neither sends nor withdrawals retry automatically", async () => {
	for (const action of ["sendOnline", "withdrawOnline"] as const) {
		let finish!: (value: Awaited<ReturnType<typeof credential>>) => void, current = true;
		const fetcher = jest.fn(), transport = new DiscussionTransport(identity, () => new Promise(resolve => { finish = resolve; }), fetcher);
		const flight = transport[action](op(), () => current); current = false; finish(await credential());
		await expect(flight).rejects.toMatchObject({ code: "action_context_changed" }); expect(fetcher).not.toHaveBeenCalled();
	}
});

test("target history is scoped, bounded, ordered and cannot leak unavailable anchors", async () => {
	expect(parseAnchorHistory(page(), id(4), id(5), 0, 10).revisions).toHaveLength(2);
	const unavailable = page(); unavailable.revisions[0] = { ...unavailable.revisions[0], anchor: null as never, unavailable: true };
	expect(parseAnchorHistory(unavailable, id(4), id(5), 0, 10).revisions[0].anchor).toBeNull();
	for (const bad of [{ ...page(), entry_id: id(20) }, { ...page(), next_after: 4 }, { ...page(), revisions: [...page().revisions].reverse() },
		{ ...page(), revisions: [{ ...page().revisions[0], unavailable: true }] }, { ...page(), thread: { ...thread(), anchor_revision: 1 } }]) {
		expect(() => parseAnchorHistory(bad, id(4), id(5), 0, 10)).toThrow();
	}
	expect(() => parseAnchorHistory(page(), baseDiscussionScope(id(4), id(9)), id(5), 0, 10)).toThrow();
	const fetcher = jest.fn().mockResolvedValue(response(page())), transport = new DiscussionTransport(identity, credential, fetcher);
	await transport.anchorHistory(id(4), id(5)); expect(fetcher.mock.calls[0][0]).toContain("/anchor-history?after=0&limit=10");
	await expect(transport.anchorHistory(id(4), id(5), 0, 21)).rejects.toMatchObject({ code: "invalid_local_target" });
});

test("protocol-v1 change readers accept a target move as a thread refresh without a message", () => {
	const event = { kind: "thread.state", sequence: 2, data: { ...result(), actor_id: id(1), change_type: "thread.reattach" } };
	expect(parseChanges({ events: [event], cursor: "next", has_more: false }).events[0]).toMatchObject({ kind: "thread.state", data: { thread_id: id(5), state_revision: 2 } });
});
