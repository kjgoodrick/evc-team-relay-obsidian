import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionFailure, type DiscussionTransport } from "../../src/collaboration/DiscussionTransport";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "moderation-test" }, scope = id(3);
async function fixture() {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	const transport = { identity, capabilities: jest.fn().mockResolvedValue({ discussions: true, moderationRecovery: true }),
		anchorContext: jest.fn().mockResolvedValue({ entryId: scope, generation: id(30) }),
		permissions: jest.fn().mockResolvedValue({ read: true, comment: true, edit: true, moderate: true }),
		participants: jest.fn().mockResolvedValue({ participants: [], hasMore: false }),
		changes: jest.fn().mockResolvedValue({ events: [], cursor: "current", has_more: false }),
		moderationCatalog: jest.fn().mockResolvedValue({ audit_id: id(9), items: [], has_more: false, next_after: 0 }),
		moderationHistory: jest.fn().mockResolvedValue({ audit_id: id(9), revisions: [] }),
		moderationPicture: jest.fn().mockResolvedValue({ audit_id: id(9), picture: { renditions: { thumbnail: { size: 1, mime: "image/png", width: 1, height: 1, sha256: "a".repeat(64) } } } }),
		moderationPictureContent: jest.fn().mockResolvedValue({ audit_id: id(10), bytes: new ArrayBuffer(1) }),
	};
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	await session.start(); const stop = session.watch(scope, () => {}); await session.refresh();
	return { store, transport, session, close: async () => { stop(); await session.close(); } };
}

test("administrative reads stay outside entities, picture cache and outbox", async () => {
	const f = await fixture();
	const save = jest.spyOn(f.store, "cacheRemoteRead"), ordinary = jest.spyOn(f.session.pictures, "load"), wake = jest.spyOn(f.session.outbox, "wake");
	try {
		expect(f.session.canReviewRemoved(scope)).toBe(true);
		await f.session.reviewRemovedCatalog(scope, "Review", 0, () => true);
		await f.session.reviewRemovedHistory(scope, id(4), id(5), "Review", 0, () => true);
		expect(await f.session.reviewRemovedPicture(scope, id(4), id(5), id(6), "Review", "thumbnail", () => true)).toMatchObject({ audit_id: id(10), bytes: new ArrayBuffer(1) });
		expect(save).not.toHaveBeenCalled(); expect(ordinary).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled();
		expect(await f.store.orderedEntities(scope, "message:", 0, 50)).toEqual([]);
	} finally { await f.close(); }
});

test.each(["offline", "role", "hidden", "disabled"])("blocks %s review before HTTP", async change => {
	const f = await fixture();
	try {
		if (change === "offline") f.session.setForeground(false);
		if (change === "role") { f.transport.permissions.mockResolvedValue({ read: true, comment: true, edit: false, moderate: false }); await f.session.refresh(); }
		if (change === "disabled") { f.transport.capabilities.mockResolvedValue({ discussions: true }); await f.session.start(); }
		await expect(f.session.reviewRemovedCatalog(scope, "Review", 0, () => change !== "hidden")).rejects.toThrow();
		expect(f.transport.moderationCatalog).not.toHaveBeenCalled();
	} finally { await f.close(); }
});

test.each(["generation", "role", "close", "hidden"])("rejects delayed recovered content after %s", async change => {
	const f = await fixture(); let finish!: (value: unknown) => void, entered!: () => void, visible = true;
	const waiting = new Promise<void>(resolve => { entered = resolve; });
	f.transport.moderationHistory.mockImplementation(() => new Promise(resolve => { finish = resolve; entered(); }));
	try {
		const reading = f.session.reviewRemovedHistory(scope, id(4), id(5), "Review", 0, () => visible);
		const rejected = expect(reading).rejects.toThrow(); await waiting;
		let closing: Promise<void> | undefined;
		if (change === "generation") await f.store.clearRemoteScope(scope);
		if (change === "role") { f.transport.permissions.mockResolvedValue({ read: true, comment: true, edit: false, moderate: false }); await f.session.refresh(); }
		if (change === "close") closing = f.session.close();
		if (change === "hidden") visible = false;
		finish({ revisions: [{ private: "retained body" }] }); await rejected; if (closing) await closing;
	} finally { await f.close(); }
});

test("picture metadata denial never falls through to ordinary storage, and authentication loss closes the review", async () => {
	const f = await fixture();
	try {
		f.transport.moderationPicture.mockRejectedValue(new DiscussionFailure("authenticate", "session_revoked", 401));
		await expect(f.session.reviewRemovedPicture(scope, id(4), id(5), id(6), "Review", "thumbnail", () => true)).rejects.toThrow();
		expect(f.transport.moderationPictureContent).not.toHaveBeenCalled(); expect(f.session.status).toBe("authentication_required");
	} finally { await f.close(); }
});
