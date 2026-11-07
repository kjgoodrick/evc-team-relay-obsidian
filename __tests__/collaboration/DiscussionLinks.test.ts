import { discussionLinkScope, discussionLinkUrl, discussionServerKey, parseDiscussionLink, DISCUSSION_LINK_ACTION } from "../../src/collaboration/DiscussionLinks";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const link = { version: 1 as const, server: "a".repeat(64), shareId: id(1), entryId: id(2), threadId: id(3), kind: "note" as const };

test.each(["note", "image", "base"] as const)("portable %s links round-trip without a vault path or account", kind => {
	const value = { ...link, kind, ...(kind === "base" ? { viewId: id(4) } : {}), messageId: id(5) };
	const url = discussionLinkUrl(value), parsed = parseDiscussionLink(url);
	expect(parsed).toEqual(value); expect(Object.isFrozen(parsed)).toBe(true);
	expect(parseDiscussionLink({ action: DISCUSSION_LINK_ACTION, ...Object.fromEntries(new URL(url).searchParams) })).toEqual(value);
	expect(discussionLinkScope(parsed)).toBe(kind === "base" ? baseDiscussionScope(id(2), id(4)) : id(2));
	expect(url).not.toMatch(/account|vault|token|https|filename/i);
});

test.each([
	(url: string) => url + "&thread=" + id(3),
	(url: string) => url + "&token=secret",
	(url: string) => url + "&vault=Another",
	(url: string) => url + "#fragment",
	(url: string) => url.replace("obsidian:", "https:"),
	(url: string) => url.replace("evc-team-relay-comment", "user@evc-team-relay-comment"),
	(url: string) => url.replace("comment?", "comment/other?"),
	(url: string) => url.replace("v=1", "v=2"),
	(url: string) => url.replace("kind=note", "kind=base"),
	(url: string) => url + "&view=" + id(4),
	(url: string) => url.replace(id(3), "not-an-id"),
	(url: string) => url + "&message=" + "x".repeat(2100),
])("rejects malformed or ambiguous link %s", change => {
	expect(() => parseDiscussionLink(change(discussionLinkUrl(link)))).toThrow("supported");
});

test("protocol parameters validate the action, exact keys and scalar values", () => {
	const params = Object.fromEntries(new URL(discussionLinkUrl(link)).searchParams);
	for (const bad of [null, {}, { ...params, action: "other" }, { ...params, action: DISCUSSION_LINK_ACTION, message: [id(4)] },
		{ ...params, action: DISCUSSION_LINK_ACTION, entry: id(2), extra: "x" }]) expect(() => parseDiscussionLink(bad)).toThrow("supported");
});

test("endpoint identity normalizes equivalent URLs while retaining scheme, port and path boundaries", async () => {
	const key = await discussionServerKey("https://RELAY.test:443/api/");
	expect(key).toMatch(/^[a-f0-9]{64}$/);
	expect(await discussionServerKey("https://relay.test/api")).toBe(key);
	for (const endpoint of ["http://relay.test/api", "https://relay.test:8443/api", "https://relay.test/other", "https://other.test/api"])
		expect(await discussionServerKey(endpoint)).not.toBe(key);
	for (const endpoint of ["file:///etc/passwd", "https://user:password@relay.test", "https://relay.test/?token=x", "https://relay.test/#x"])
		await expect(discussionServerKey(endpoint)).rejects.toThrow();
});
