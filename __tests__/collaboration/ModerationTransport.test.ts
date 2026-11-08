import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { bodyFromText } from "../../src/collaboration/DiscussionProtocol";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { moderationReason, parseModerationCatalog, parseModerationHistory } from "../../src/collaboration/ModerationProtocol";
import { pictureHash } from "../../src/collaboration/PictureProtocol";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2) };
const scope = id(3), target = [scope, id(4), id(5), "Synthetic review"] as const;
const credentials = async () => ({ accountId: id(1), accessToken: "synthetic-only" });
const common = () => ({ protocol_version: 1, audit_id: id(9), entry_id: scope, view_id: null });
const history = () => ({ ...common(), thread_id: id(4), message_id: id(5), recoverable_until: "2026-12-07T12:00:00Z",
	thread_removed: false, message_removed: true, thread_removal_reason: null,
	revisions: [{ revision: 1, body: bodyFromText("Retained"), actor_id: id(1), created_at: "2026-11-07T12:00:00Z", reason: null }], has_more: false, next_after: 1 });
const reply = (value: unknown, headers: Record<string, string> = { "Cache-Control": "no-store" }) => new Response(JSON.stringify(value), { headers });

test("explicit POST history is bounded, audited, sensitive and never retried", async () => {
	const fetcher = jest.fn().mockResolvedValue(reply(history()));
	const transport = new DiscussionTransport(identity, credentials, fetcher);
	expect((await transport.moderationHistory(...target)).revisions[0].body).toEqual(bodyFromText("Retained"));
	expect(fetcher).toHaveBeenCalledTimes(1);
	const [url, config] = fetcher.mock.calls[0];
	expect(url).toContain(`/threads/${id(4)}/messages/${id(5)}/moderation-history`);
	expect(config).toMatchObject({ method: "POST", sensitive: true, cache: "no-store" });
	expect(JSON.parse(config.body)).toEqual({ protocol_version: 1, reason: "Synthetic review", after: 0, limit: 10 });
	fetcher.mockResolvedValue(new Response("", { status: 503 }));
	await expect(transport.moderationHistory(...target)).rejects.toMatchObject({ action: "retry" });
	expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each(["audit", "entry", "view", "thread", "message", "live", "deadline", "oversize", "cache"])("refuses untrusted history: %s", async kind => {
	const value = history();
	if (kind === "audit") value.audit_id = "missing";
	if (kind === "entry") value.entry_id = id(99);
	if (kind === "view") Object.assign(value, { view_id: id(99) });
	if (kind === "thread") value.thread_id = id(99);
	if (kind === "message") value.message_id = id(99);
	if (kind === "live") value.message_removed = false;
	if (kind === "deadline") value.recoverable_until = "invalid";
	if (kind === "oversize") value.revisions = [...value.revisions, { ...value.revisions[0], revision: 2 }];
	const transport = new DiscussionTransport(identity, credentials, jest.fn().mockResolvedValue(reply(value, kind === "cache" ? {} : undefined)));
	await expect(transport.moderationHistory(...target, 0, 1)).rejects.toMatchObject({ code: "invalid_read_response" });
});

test.each(["", "  ", "x\nprivate", "\ud800", "x".repeat(513)])("rejects a reason before credentials or HTTP: %p", async reason => {
	const credential = jest.fn(credentials), fetcher = jest.fn();
	await expect(new DiscussionTransport(identity, credential, fetcher).moderationHistory(scope, id(4), id(5), reason)).rejects.toThrow();
	expect(credential).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

test("Unicode reasons and saved-view requests preserve exact scope", async () => {
	const view = baseDiscussionScope(scope, id(7));
	expect(moderationReason(view, "  Review 😀  ")).toEqual({ protocol_version: 1, reason: "Review 😀", view_id: id(7) });
	expect(parseModerationHistory({ ...history(), view_id: id(7) }, view, id(4), id(5), 0, 10).audit_id).toBe(id(9));
	const fetcher = jest.fn().mockResolvedValue(reply({ ...common(), view_id: id(7), items: [], has_more: true, next_after: 11 }));
	const result = await new DiscussionTransport(identity, credentials, fetcher).moderationCatalog(view, "Review", 10);
	expect(result).toEqual({ audit_id: id(9), items: [], has_more: true, next_after: 11 });
	expect(JSON.parse(fetcher.mock.calls[0][1].body).view_id).toBe(id(7));
	expect(() => parseModerationCatalog({ ...common(), items: [], has_more: true, next_after: 10 }, scope, 10, 20)).toThrow();
	const unicodeReason = { ...history(), revisions: [{ ...history().revisions[0], reason: "😀".repeat(512) }] };
	expect(parseModerationHistory(unicodeReason, scope, id(4), id(5), 0, 10).revisions[0].reason).toBe("😀".repeat(512));
	expect(() => parseModerationHistory({ ...unicodeReason, revisions: [{ ...unicodeReason.revisions[0], reason: "😀".repeat(513) }] }, scope, id(4), id(5), 0, 10)).toThrow();
});

test("a closed review prevents credential-time sends and rejects delayed response disclosure", async () => {
	let finish!: (value: Awaited<ReturnType<typeof credentials>>) => void, current = true;
	const fetcher = jest.fn();
	const transport = new DiscussionTransport(identity, () => new Promise(resolve => { finish = resolve; }), fetcher);
	const promise = transport.moderationHistory(...target, 0, 10, () => current);
	const expected = expect(promise).rejects.toMatchObject({ code: "action_context_changed" });
	current = false; finish(await credentials()); await expected; expect(fetcher).not.toHaveBeenCalled();
	current = true;
	let respond!: (response: Response) => void;
	const later = new DiscussionTransport(identity, credentials, jest.fn(() => new Promise(resolve => { respond = resolve; })));
	const reading = later.moderationHistory(...target, 0, 10, () => current);
	await Promise.resolve(); current = false; respond(reply(history()));
	await expect(reading).rejects.toMatchObject({ code: "action_context_changed" });
});

test("picture POSTs require an audit header and verify exact bytes without ordinary cache routes", async () => {
	const bytes = new Uint8Array([1, 2, 3]).buffer, sha256 = await pictureHash(bytes);
	const expected = { sha256, size: 3, mime: "image/png" as const, width: 1, height: 1 };
	const headers = { "Cache-Control": "no-store", "Content-Type": "image/png", "X-Discussion-Audit-Id": id(10) };
	const fetcher = jest.fn().mockResolvedValue(new Response(bytes, { headers }));
	const transport = new DiscussionTransport(identity, credentials, fetcher);
	const result = await transport.moderationPictureContent(scope, id(4), id(5), id(6), "Review picture", "thumbnail", expected);
	expect(result).toEqual({ bytes, audit_id: id(10) });
	expect(fetcher.mock.calls[0][1].method).toBe("POST");
	for (const response of [new Response(bytes, { headers: { ...headers, "X-Discussion-Audit-Id": "" } }), new Response(new Uint8Array([9, 9, 9]), { headers })]) {
		fetcher.mockResolvedValue(response);
		await expect(transport.moderationPictureContent(scope, id(4), id(5), id(6), "Review picture", "thumbnail", expected)).rejects.toThrow();
	}
});
