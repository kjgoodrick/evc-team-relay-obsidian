import * as Y from "yjs";
import { captureTextAnchor, resolveTextAnchor } from "../../src/collaboration/anchors/text";
import { bodyFromText, localTextAnchor, parseAnchor, parseBody, parseChanges, parseMessage, parseThreadPage, safeDiscussionUrl, wireTextAnchor } from "../../src/collaboration/DiscussionProtocol";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2) };
const credential = async () => ({ accountId: id(1), accessToken: "synthetic" });
const thread = () => ({ id: id(4), author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1,
	removed: false, created_sequence: 1, activity_sequence: 1, created_at: "2026-11-05T00:00:00Z" });
const message = () => ({ id: id(5), author_id: id(1), revision: 1, deleted: false, body: bodyFromText("Message"),
	created_sequence: 1, created_at: "2026-11-05T00:00:00Z", edited_at: null, reactions: [] });
const page = () => ({ thread: thread(), anchor: { version: 1, type: "note" }, messages: [message()], has_more: false, next_after: 1 });

test("accepts supported structured bodies and rejects unsafe links, unsupported blocks and marks", () => {
	const body = { version: 1, blocks: [{ type: "paragraph", children: [
		{ type: "mention", user_id: id(1) }, { type: "link", url: "https://example.test/?q=value", children: [{ type: "text", text: "Link", marks: ["bold"] }] },
	] }, { type: "list", ordered: true, items: [{ type: "paragraph", children: [{ type: "text", text: "Item" }] }] },
	{ type: "code", text: "<script>not executable</script>", language: "html" }] };
	expect(parseBody(body)).toEqual(body);
	for (const url of ["javascript:alert(1)", "file:///secret", "https://user:password@example.test", "https://example.test/\nfoo", " https://example.test"]) {
		expect(safeDiscussionUrl(url)).toBe(false);
		expect(() => parseBody({ version: 1, blocks: [{ type: "paragraph", children: [{ type: "link", url, children: [{ type: "text", text: "Link" }] }] }] })).toThrow();
	}
	expect(() => parseBody({ version: 1, blocks: [{ type: "html", text: "<img onerror=alert(1)>" }] })).toThrow();
	expect(() => parseBody({ version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Text", marks: ["bold", "bold"] }] }] })).toThrow();
	expect(() => bodyFromText("  \n")).toThrow();
	expect(() => bodyFromText("😀".repeat(8192))).toThrow(); // UTF-8 byte limit includes JSON.
});

test("deleted messages must carry no body/reactions; invalid reaction keys cannot reach rendering", () => {
	expect(parseMessage({ ...message(), deleted: true, body: null })).toMatchObject({ deleted: true, body: null });
	expect(() => parseMessage({ ...message(), deleted: true })).toThrow();
	expect(() => parseMessage({ ...message(), reactions: [{ emoji: "__proto__", count: 1, mine: false }] })).toThrow();
	expect(() => parseMessage({ ...message(), reactions: [{ emoji: "heart", count: 0, mine: false }] })).toThrow();
});

test("read pages reject wrong targets, duplicate/nonprogressing positions, and unsafe revisions", () => {
	expect(parseThreadPage(page(), id(4), 0).messages).toHaveLength(1);
	for (const invalid of [
		{ ...page(), thread: { ...thread(), id: id(9) } },
		{ ...page(), messages: [message(), message()] },
		{ ...page(), messages: [], has_more: true, next_after: 0 },
		{ ...page(), next_after: 0 },
		{ ...page(), thread: { ...thread(), activity_sequence: Number.MAX_SAFE_INTEGER + 1 } },
	]) expect(() => parseThreadPage(invalid, id(4), 0)).toThrow();
});

test("changes reject unknown event kinds and malformed metadata instead of skipping an event", () => {
	const event = { kind: "thread.state", sequence: 2, data: { operation_id: id(6), scope_id: id(7), thread_id: id(4),
		actor_id: id(1), sequence: 2, state: "resolved", state_revision: 2, removed: false, changed: true } };
	expect(parseChanges({ events: [event], cursor: "opaque", has_more: false }).events).toHaveLength(1);
	for (const invalid of [{ ...event, kind: "unsupported" }, { ...event, sequence: 3 }, { ...event, kind: "reply.create" }]) {
		expect(() => parseChanges({ events: [invalid], cursor: "opaque", has_more: false })).toThrow();
	}
	expect(() => parseChanges({ events: [event, event], cursor: "opaque", has_more: false })).toThrow();
});

test("read transport bounds and encodes cursors, validates targets, and never exposes bad response text", async () => {
	const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify({ events: [], cursor: "new", has_more: false })));
	const transport = new DiscussionTransport(identity, credential, fetcher);
	await transport.changes(id(3), "opaque&injected=true");
	expect(fetcher.mock.calls[0][0]).toBe(`https://relay.test/v1/collaboration/shares/${id(2)}/entries/${id(3)}/changes?limit=25&cursor=opaque%26injected%3Dtrue`);
	expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", sensitive: true });
	await expect(transport.message(id(3), "../elsewhere", id(5))).rejects.toMatchObject({ code: "invalid_local_target" });
	fetcher.mockResolvedValue(new Response(JSON.stringify({ ...page(), next_after: -1, private: "secret" })));
	await expect(transport.thread(id(3), id(4))).rejects.toMatchObject({ action: "pause", code: "invalid_read_response" });
});

test("online-only state changes accept responses without inventing message fields and never enter the outbox", async () => {
	const result = { operation_id: id(6), scope_id: id(7), thread_id: id(4), sequence: 2, state: "resolved", state_revision: 2,
		removed: false, changed: true };
	const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify(result)));
	const transport = new DiscussionTransport(identity, credential, fetcher);
	expect(await transport.sendOnline({ operationId: id(6), scopeId: id(3), payload: { type: "thread.state", thread_id: id(4),
		expected_state_revision: 1, state: "resolved" } })).toEqual(result);
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test("text anchors round-trip the real Yjs selection and reject malformed metadata", async () => {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "🙂 café beta");
	try {
		const local = captureTextAnchor(text, id(3), id(8), 3, 7), wire = wireTextAnchor(local);
		expect(localTextAnchor(wire)).toEqual(local);
		expect(parseThreadPage({ ...page(), anchor: wire }, id(4), 0).anchor).toEqual(wire);
		text.insert(0, "prefix ");
		expect(resolveTextAnchor(text, id(3), id(8), localTextAnchor(wire))).toEqual({ status: "attached", from: 10, to: 14 });
		for (const patch of [{ document_id: "Note.md" }, { selected_length: -1 }, { selected_length: 2 ** 32 },
			{ dependency: "" }, { start: "AB==" }, { end: "a".repeat(400) }, { generation: null },
			{ context: { ...wire.context, quote: "\ud83d" } }, { context: { ...wire.context, prefix: "x".repeat(65) } }]) {
			expect(() => parseAnchor({ ...wire, ...patch })).toThrow();
		}
		const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify({ ...page(), anchor: wire })));
		await expect(new DiscussionTransport(identity, credential, fetcher).thread(id(9), id(4)))
			.rejects.toMatchObject({ action: "pause", code: "invalid_read_response" });
	} finally { doc.destroy(); }
});
