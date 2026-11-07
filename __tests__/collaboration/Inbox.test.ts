import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionInbox } from "../../src/collaboration/DiscussionInbox";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionTransport, DiscussionFailure } from "../../src/collaboration/DiscussionTransport";
import { inboxScope, parseInboxPage, type InboxItem, type InboxChange, type InboxSubscription } from "../../src/collaboration/InboxProtocol";
import { INBOX_KEY } from "../../src/collaboration/storage/InboxRecords";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "inbox" };
function item(n = 3): InboxItem { return {
	thread_id: id(n), entry_id: id(4), scope_id: id(5), kind: "note", path: "Notes/One.md", view_id: null,
	message_id: id(6), message_revision: 1, reason: "mention", last_sequence: n, activity_at: "2026-11-06T10:00:00+00:00",
	version: 1, read_version: 0, dismissed_version: 0, unread: true, subscription: { version: 0, following: false, muted: false },
}; }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
async function fixture(factory = new IDBFactory()) {
	const store = await DiscussionStore.open(identity, factory);
	const server = { rows: [item()] };
	const subscriptions = new Map<string, InboxSubscription>();
	const transport = {
		inbox: jest.fn(async (_cursor: string | null = null) => ({ items: clone(server.rows), next_cursor: null as string | null })),
		inboxSubscription: jest.fn(async (_scope: string, thread: string) => clone(subscriptions.get(thread) ?? { version: 0, following: false, muted: false })),
		changeInbox: jest.fn(async (_scope: string, thread: string, change: InboxChange) => {
			const row = server.rows.find(row => row.thread_id === thread);
			if (change.type === "subscription") {
				const value = { version: change.expected_version + 1, following: change.following, muted: change.muted };
				subscriptions.set(thread, value); if (row) row.subscription = value; return clone(value);
			}
			if (!row) throw new DiscussionFailure("reject", "target_unavailable", 404);
			if (change.action === "unread") row.read_version = Math.min(row.read_version, change.seen_version - 1);
			else row.read_version = Math.max(row.read_version, change.seen_version);
			if (change.action === "dismiss") row.dismissed_version = Math.max(row.dismissed_version, change.seen_version);
			row.unread = row.read_version < row.version;
			return { version: row.version, read_version: row.read_version, dismissed_version: row.dismissed_version, unread: row.unread };
		}),
	};
	const inbox = new DiscussionInbox(store, transport);
	await store.updateInbox(state => { state.items = clone(server.rows); });
	return { store, server, transport, inbox, factory, close: async () => { await inbox.close(); store.close(); } };
}
async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
	throw new Error("Inbox condition did not settle");
}

test.each([
	{ unread: false }, { read_version: 2 }, { version: 0 }, { kind: "base" }, { view_id: id(7) },
	{ activity_at: "not a date" }, { path: "Secret\nPath" }, { last_sequence: 1.5 }, { subscription: { version: -1, following: true, muted: false } },
])("rejects malformed inbox data %j", patch => {
	expect(() => parseInboxPage({ items: [{ ...item(), ...patch }], next_cursor: null })).toThrow();
});
test("validates page order, duplicate threads, cursors and saved-view identities", () => {
	expect(() => parseInboxPage({ items: [item(), item()], next_cursor: null })).toThrow();
	expect(() => parseInboxPage({ items: [item(3), item(7)], next_cursor: null })).toThrow();
	expect(() => parseInboxPage({ items: [], next_cursor: "opaque" })).toThrow();
	const row = { ...item(), kind: "base", view_id: id(7) };
	expect(inboxScope(parseInboxPage({ items: [row], next_cursor: "opaque=" }).items[0])).toBe(`base:${id(4)}:${id(7)}`);
});

test("transport captures exact scope/filter requests and validates accepted state", async () => {
	const fetcher = jest.fn().mockResolvedValueOnce(response({ items: [item()], next_cursor: null }))
		.mockResolvedValueOnce(response({ version: 1, following: true, muted: false }))
		.mockResolvedValueOnce(response({ version: 1, read_version: 0, dismissed_version: 0, unread: true }));
	const transport = new DiscussionTransport(identity, async () => ({ accountId: id(1), accessToken: "synthetic" }), fetcher);
	await transport.inbox("opaque=");
	expect(fetcher.mock.calls[0][0]).toContain("include_muted=true&include_dismissed=true&cursor=opaque%3D");
	await transport.changeInbox(inboxScope(item()), id(3), { type: "subscription", expected_version: 0, following: true, muted: false });
	expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ expected_version: 0, following: true, muted: false });
	await expect(transport.changeInbox(id(4), id(3), { type: "state", seen_version: 1, action: "read" })).rejects.toMatchObject({ action: "pause" });
});

test("offline read and subscription changes survive reopen and remain account isolated", async () => {
	const f = await fixture();
	try {
		await f.inbox.configure(true, "offline", true);
		await f.inbox.queue(f.inbox.items[0], { type: "state", seen_version: 1, action: "read" });
		await f.inbox.queue(f.inbox.items[0], { type: "subscription", expected_version: 0, following: true, muted: true });
		expect(f.inbox.items[0]).toMatchObject({ unread: false, subscription: { following: true, muted: true } });
		expect(f.transport.changeInbox).not.toHaveBeenCalled();
		await f.inbox.close(); f.store.close();
		const reopened = await DiscussionStore.open(identity, f.factory);
		const other = await DiscussionStore.open({ ...identity, accountId: id(99) }, f.factory);
		const inbox = new DiscussionInbox(reopened, f.transport);
		try {
			expect((await other.inboxState()).operations).toEqual([]);
			await inbox.configure(true, "online", true); await inbox.settled();
			expect((await reopened.inboxState()).operations).toEqual([]);
			expect(f.transport.changeInbox).toHaveBeenCalledTimes(2);
			expect(inbox.items[0].subscription.muted).toBe(true);
		} finally { await inbox.close(); reopened.close(); other.close(); }
	} finally { await f.close(); }
});

test("lost response retains the exact request and another worker can recover after restart", async () => {
	const f = await fixture();
	try {
		await f.inbox.configure(true, "offline", true);
		await f.inbox.queue(f.inbox.items[0], { type: "state", seen_version: 1, action: "read" });
		f.transport.changeInbox.mockRejectedValueOnce(new DiscussionFailure("retry", "request_timeout"));
		await f.inbox.configure(true, "online", true); await f.inbox.settled();
		const original = f.transport.changeInbox.mock.calls[0];
		expect(f.inbox.pending[0].attempted).toBe(true);
		await f.store.updateInbox(state => { state.retryAt = 0; });
		f.inbox.wake(); await f.inbox.settled();
		expect(f.transport.changeInbox.mock.calls[1]).toEqual(original);
		expect(f.inbox.pending).toEqual([]);
	} finally { await f.close(); }
});

test("newly delivered activity stays unread when an older queued read is accepted", async () => {
	const f = await fixture();
	try {
		await f.inbox.configure(true, "offline", true);
		await f.inbox.queue(f.inbox.items[0], { type: "state", seen_version: 1, action: "read" });
		f.server.rows[0].version = 2; f.server.rows[0].last_sequence = 10;
		await f.inbox.configure(true, "online", true); await f.inbox.settled();
		expect(f.inbox.items[0]).toMatchObject({ version: 2, read_version: 1, unread: true });
	} finally { await f.close(); }
});

test("a read acknowledgment cannot expose an unseen newer version for a second mark-read", async () => {
	const f = await fixture();
	try {
		await f.inbox.configure(true, "offline", true);
		await f.inbox.queue(f.inbox.items[0], { type: "state", seen_version: 1, action: "read" });
		f.transport.changeInbox.mockResolvedValueOnce({ version: 2, read_version: 1, dismissed_version: 0, unread: true });
		await f.inbox.configure(true, "online", true); await f.inbox.settled();
		expect(f.inbox.items[0].version).toBe(1);
	} finally { await f.close(); }
});

test("two windows share one lease and never concurrently submit an operation", async () => {
	const f = await fixture(), second = await DiscussionStore.open(identity, f.factory);
	const peer = new DiscussionInbox(second, f.transport);
	try {
		await f.inbox.configure(true, "offline", true);
		await f.inbox.queue(f.inbox.items[0], { type: "state", seen_version: 1, action: "read" });
		await Promise.all([f.inbox.configure(true, "online", true), peer.configure(true, "online", true)]);
		await Promise.all([f.inbox.settled(), peer.settled()]);
		expect(f.transport.changeInbox).toHaveBeenCalledTimes(1);
		await peer.reload(); expect(peer.pending).toEqual([]);
	} finally { await peer.close(); second.close(); await f.close(); }
});

test("scope revocation fences a delayed refresh and preserves pending intent only", async () => {
	const f = await fixture();
	try {
		let release!: (value: { items: InboxItem[]; next_cursor: null }) => void;
		f.transport.inbox.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
		await f.inbox.configure(true, "online", true); await until(() => !!release);
		await f.store.clearRemoteScope(id(4)); await f.inbox.reload();
		release({ items: [item()], next_cursor: null }); await f.inbox.settled();
		expect(f.inbox.items).toEqual([]); expect((await f.store.inboxState()).items).toEqual([]);
	} finally { await f.close(); }
});

test("closing an account hides references and drains a late response without caching it", async () => {
	const f = await fixture();
	let release!: (value: { items: InboxItem[]; next_cursor: null }) => void;
	f.transport.inbox.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
	await f.inbox.configure(true, "online", true); await until(() => !!release);
	const closing = f.inbox.close(); expect(f.inbox.items).toEqual([]);
	release({ items: [item(9)], next_cursor: null }); await closing;
	expect((await f.store.inboxState()).items[0].thread_id).toBe(id(3)); f.store.close();
});

test("rejected preference conflicts reject dependent changes until explicit review", async () => {
	const f = await fixture();
	try {
		await f.inbox.configure(true, "offline", true);
		await f.inbox.queue(f.inbox.items[0], { type: "subscription", expected_version: 0, following: true, muted: false });
		await f.inbox.queue(f.inbox.items[0], { type: "subscription", expected_version: 1, following: true, muted: true });
		f.transport.changeInbox.mockRejectedValueOnce(new DiscussionFailure("reject", "stale_subscription_version", 409));
		await f.inbox.configure(true, "online", true); await f.inbox.settled();
		expect(f.inbox.pending.map(op => op.state)).toEqual(["rejected", "rejected"]);
		await f.inbox.discard(f.inbox.pending[0].id); await f.inbox.settled();
		expect(f.transport.changeInbox).toHaveBeenCalledTimes(1);
		await expect(f.inbox.queue(f.inbox.items[0], { type: "state", action: "read", seen_version: 1 })).rejects.toThrow("Review");
	} finally { await f.close(); }
});

test("recipient denial clears the visible cache without discarding queued choices", async () => {
	const f = await fixture();
	try {
		await f.inbox.configure(true, "offline", true);
		await f.inbox.queue(f.inbox.items[0], { type: "state", action: "read", seen_version: 1 });
		f.transport.inbox.mockRejectedValueOnce(new DiscussionFailure("authenticate", "authentication_required", 401));
		await f.inbox.configure(true, "online", true); await f.inbox.settled();
		expect(f.inbox.items).toEqual([]); expect((await f.store.inboxState()).items).toEqual([]);
		expect(f.inbox.pending).toHaveLength(1); expect(f.transport.changeInbox).not.toHaveBeenCalled();
	} finally { await f.close(); }
});

test("readers can follow a discussion without an inbox entry, including offline", async () => {
	const f = await fixture();
	try {
		await f.inbox.configure(true, "online", true); await f.inbox.settled();
		await f.inbox.loadSubscription(id(4), id(77));
		await f.inbox.configure(true, "offline", true);
		await f.inbox.queueSubscription(id(4), id(77), f.inbox.subscription(id(4), id(77))!, true, false);
		expect(f.inbox.subscription(id(4), id(77))?.following).toBe(true);
		await f.inbox.configure(true, "online", true); await f.inbox.settled();
		expect(f.transport.changeInbox).toHaveBeenCalledWith(id(4), id(77), { type: "subscription", expected_version: 0, following: true, muted: false });
	} finally { await f.close(); }
});

test("a cached notification supplies offline follow controls without a separate preference lookup", async () => {
	const f = await fixture();
	try {
		await f.inbox.configure(true, "offline", true);
		expect((await f.store.inboxState()).subscriptions).toEqual([]);
		await f.inbox.queueSubscription(id(4), id(3), f.inbox.subscription(id(4), id(3))!, true, false);
		expect(f.inbox.subscription(id(4), id(3))).toEqual({ version: 1, following: true, muted: false });
		expect(f.transport.inboxSubscription).not.toHaveBeenCalled();
		await f.inbox.forgetScope(id(4));
		await expect(f.inbox.queueSubscription(id(4), id(3), { version: 1, following: true, muted: false }, false, false)).rejects.toThrow("Refresh");
		expect(f.inbox.pending).toHaveLength(1);
	} finally { await f.close(); }
});

test("Retry-After survives restart and prevents another window from retrying early", async () => {
	const f = await fixture();
	try {
		f.transport.inbox.mockRejectedValueOnce(new DiscussionFailure("retry", "server_unavailable", 429, 120_000));
		await f.inbox.configure(true, "online", true); await f.inbox.settled();
		expect((await f.store.inboxState()).retryAt).toBeGreaterThan(Date.now() + 119_000);
		f.inbox.wake(); await f.inbox.settled(); expect(f.transport.inbox).toHaveBeenCalledTimes(1);
	} finally { await f.close(); }
});

test("older windows stay bounded and survive refresh and reopen with an explicit return to latest", async () => {
	const f = await fixture();
	f.server.rows = Array.from({ length: 550 }, (_, index) => item(1000 - index));
	f.transport.inbox.mockImplementation(async (cursor = null) => {
		const offset = Number(cursor ?? 0), end = offset + 50;
		return { items: clone(f.server.rows.slice(offset, end)), next_cursor: end < f.server.rows.length ? String(end) : null };
	});
	await f.store.updateInbox(state => { state.items = clone(f.server.rows.slice(0, 500)); state.nextCursor = "500"; });
	try {
		await f.inbox.configure(true, "online", true); await f.inbox.settled();
		expect(f.inbox.items).toHaveLength(500); expect(f.transport.inbox).toHaveBeenCalledTimes(10);
		f.inbox.loadMore(); await f.inbox.settled();
		expect(f.inbox.items).toHaveLength(50); expect(f.inbox.viewingOlder).toBe(true);
		expect(f.inbox.items[0].thread_id).toBe(id(500));
		f.inbox.wake(); await f.inbox.settled();
		expect(f.transport.inbox).toHaveBeenLastCalledWith("500"); expect(f.inbox.items[0].thread_id).toBe(id(500));
		await f.inbox.close(); f.store.close();
		const reopened = await DiscussionStore.open(identity, f.factory), inbox = new DiscussionInbox(reopened, f.transport);
		try {
			await inbox.configure(true, "offline", true); expect(inbox.viewingOlder).toBe(true); expect(inbox.items).toHaveLength(50);
			await inbox.configure(true, "online", true); await inbox.settled(); expect(f.transport.inbox).toHaveBeenLastCalledWith("500");
			await inbox.latest(); await inbox.settled();
			expect(inbox.viewingOlder).toBe(false); expect(inbox.items[0].thread_id).toBe(id(1000)); expect(inbox.items).toHaveLength(50);
		} finally { await inbox.close(); reopened.close(); }
	} finally { await f.close(); }
});

test("an expired older-window cursor returns to the latest authorized page", async () => {
	const f = await fixture();
	await f.store.updateInbox(state => { state.startCursor = "expired"; });
	f.transport.inbox.mockRejectedValueOnce(new DiscussionFailure("reject", "inbox_cursor_reset", 409));
	try {
		await f.inbox.configure(true, "online", true);
		await until(() => f.transport.inbox.mock.calls.length === 2); await f.inbox.settled();
		expect(f.transport.inbox.mock.calls.map(call => call[0])).toEqual(["expired", null]);
		expect(f.inbox.viewingOlder).toBe(false); expect(f.inbox.items).toEqual(f.server.rows);
	} finally { await f.close(); }
});

test("corrupted inbox data cannot prevent ordinary authorization-cache cleanup", async () => {
	const f = await fixture();
	try {
		await f.store.saveDraft({ id: "saved", scopeId: id(4), revision: 0, body: "keep draft" });
		await f.store.setPreference(INBOX_KEY, { broken: true });
		await f.store.clearRemoteScope(id(4));
		expect((await f.store.inboxState()).items).toEqual([]);
		expect(await f.store.preference("inbox:recovery")).toEqual({ broken: true });
		expect((await f.store.getDraft("saved"))?.body).toBe("keep draft");
	} finally { await f.close(); }
});
