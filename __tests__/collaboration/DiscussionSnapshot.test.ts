import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionSync, messageKey, threadKey } from "../../src/collaboration/DiscussionSync";
import { DiscussionFailure } from "../../src/collaboration/DiscussionTransport";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { parseDiscussionSnapshot, type DiscussionSnapshot } from "../../src/collaboration/DiscussionSnapshotProtocol";
import { pictureHash, prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "snapshot", accountId: id(1), shareId: id(2), vaultId: "test" };
const entry = id(3), thread = id(4), message = id(5), date = "2026-11-08T00:00:00Z";
const stores: DiscussionStore[] = [], workers: DiscussionSync[] = [];
async function store(factory = new IDBFactory()) { const value = await DiscussionStore.open(identity, factory); stores.push(value); return value; }
afterEach(async () => { workers.splice(0).forEach(worker => worker.stop()); for (const item of stores.splice(0)) item.close(); jest.restoreAllMocks(); });
function snapshot(): DiscussionSnapshot {
	return { protocol_version: 1, entry_id: entry, through_sequence: 10, restore_generation: null, cursor: "baseline10", threads: [{
		thread: { id: thread, author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1, removed: false, created_sequence: 1, activity_sequence: 10, created_at: date },
		anchor: { type: "note", version: 1 }, messages: [{ id: message, author_id: id(1), revision: 2, deleted: false, body: bodyFromText("Current baseline"),
			created_sequence: 1, created_at: date, edited_at: date, reactions: [] }],
	}] };
}

test("complete baselines parse with a zero-entry case and exact source/view identity", () => {
	expect(parseDiscussionSnapshot(snapshot(), entry)).toEqual(snapshot());
	expect(parseDiscussionSnapshot({ ...snapshot(), through_sequence: 0, threads: [] }, entry).threads).toEqual([]);
	expect(() => parseDiscussionSnapshot(snapshot(), id(40))).toThrow();
	expect(() => parseDiscussionSnapshot(snapshot(), entry, id(41))).toThrow();
});

test.each([
	["missing generation", (s: any) => { delete s.restore_generation; }],
	["bad generation", (s: any) => { s.restore_generation = "unknown"; }],
	["future version", (s: any) => { s.protocol_version = 2; }],
	["partial thread", (s: any) => { s.threads[0].messages = []; }],
	["future thread activity", (s: any) => { s.through_sequence = 9; }],
	["duplicate thread", (s: any) => { s.threads.push(s.threads[0]); }],
	["duplicate message", (s: any) => { s.threads[0].messages.push(s.threads[0].messages[0]); }],
	["future message", (s: any) => { s.threads[0].messages[0].created_sequence = 11; }],
	["removed thread", (s: any) => { s.threads[0].thread.removed = true; }],
	["removed body", (s: any) => { s.threads[0].messages[0].deleted = true; }],
	["too many records", (s: any) => { s.threads = Array(5001).fill(s.threads[0]); }],
	["oversized body", (s: any) => { s.threads[0].messages[0].body.blocks[0].children[0].text = "a".repeat(8 * 1024 * 1024); }],
])("invalid %s cannot become a complete baseline", (_label, change) => {
	const value = snapshot(); change(value); expect(() => parseDiscussionSnapshot(value, entry)).toThrow();
});

test("snapshot replacement removes obsolete remote data, preserves drafts/outbox, and fences late reads", async () => {
	const saved = await store(), before = await saved.checkpoint(entry);
	await saved.cacheRemoteRead(entry, before.generation, [{ id: "thread:obsolete", revision: 2, value: "old" }]);
	await saved.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: "Unsent text" });
	await saved.enqueue({ operationId: id(20), scopeId: entry, type: "reply.create", payload: { body: "Unsent reply" }, dependsOn: [] }, 1);
	expect(await saved.applyRemoteSnapshot(entry, before, snapshot())).toBe(true);
	expect(await saved.entity(entry, "thread:obsolete")).toBeUndefined();
	expect((await saved.entity(entry, messageKey(thread, message)))?.value).toMatchObject({ body: bodyFromText("Current baseline") });
	expect(await saved.checkpoint(entry)).toEqual({ cursor: "baseline10", generation: before.generation + 1 });
	expect((await saved.getDraft("draft"))?.body).toBe("Unsent text"); expect((await saved.getOperation(id(20)))?.state).toBe("queued");
	expect(await saved.cacheRemoteRead(entry, before.generation, [{ id: "thread:obsolete", revision: 5, value: "late old read" }])).toBe(false);
});

test("newer message reads and removal tombstones survive an older baseline", async () => {
	const saved = await store(), before = await saved.checkpoint(entry);
	await saved.cacheRemoteRead(entry, before.generation, [{ id: messageKey(thread, message), revision: 12, value: "Newer message" }]);
	await saved.applyRemoteSnapshot(entry, before, snapshot());
	expect((await saved.entity(entry, messageKey(thread, message)))?.value).toBe("Newer message");
	const next = await saved.checkpoint(entry);
	await saved.cacheRemoteRead(entry, next.generation, [{ id: threadKey(thread), revision: 13, value: { id: thread, removed: true } }]);
	await saved.applyRemoteSnapshot(entry, next, snapshot());
	expect((await saved.entity(entry, threadKey(thread)))?.value).toEqual({ id: thread, removed: true });
});

test("a newer removed thread cannot regain older message bodies through a snapshot", async () => {
	const saved = await store(), before = await saved.checkpoint(entry);
	await saved.cacheRemoteRead(entry, before.generation, [{ id: threadKey(thread), revision: 13, value: { id: thread, removed: true } }]);
	await saved.applyRemoteSnapshot(entry, before, snapshot());
	expect(await saved.entity(entry, messageKey(thread, message))).toBeUndefined();
});

test("competing baseline installs commit once and a changed scope generation refuses old work", async () => {
	const factory = new IDBFactory(), first = await store(factory), second = await store(factory), before = await first.checkpoint(entry);
	const results = await Promise.all([first.applyRemoteSnapshot(entry, before, snapshot()), second.applyRemoteSnapshot(entry, before, snapshot())]);
	expect(results.filter(Boolean)).toHaveLength(1);
	const current = await first.checkpoint(entry); await second.clearRemoteScope(entry);
	expect(await first.applyRemoteSnapshot(entry, current, snapshot())).toBe(false); expect(await first.cursor(entry)).toBeUndefined();
});

test("a snapshot from an unobserved restored server cannot overwrite retained remote state", async () => {
	const saved = await store(), before = await saved.checkpoint(entry);
	await saved.cacheRemoteRead(entry, before.generation, [{ id: "thread:retained", revision: 1, value: "Retained" }]);
	await expect(saved.applyRemoteSnapshot(entry, before, { ...snapshot(), restore_generation: id(80) })).rejects.toMatchObject({ code: "restore_generation_changed" });
	expect((await saved.entity(entry, "thread:retained"))?.value).toBe("Retained"); expect(await saved.checkpoint(entry)).toEqual(before);
});

test("replacement clears only this scope's downloaded pictures and retains local originals and other accounts", async () => {
	const factory = new IDBFactory(), saved = await store(factory);
	const other = await DiscussionStore.open({ ...identity, accountId: id(90) }, factory); stores.push(other);
	const bytes = new Uint8Array([1, 2, 3]).buffer;
	const rendition = { sha256: await pictureHash(bytes), size: 3, mime: "image/png" as const, width: 1, height: 1 };
	const source = await prepareLocalPicture(id(20), entry, bytes);
	await saved.saveDraft({ id: "picture-draft", scopeId: entry, revision: 0,
		body: protocolJson(editableCommentDraft({ version: 1, blocks: [{ type: "picture", picture_id: source.id }] }, () => "Alice")) }, null, [source]);
	await saved.cachePicture(entry, id(30), "content", rendition, bytes, 0);
	await saved.cachePicture(id(40), id(31), "content", rendition, bytes, 0);
	await other.cachePicture(entry, id(30), "content", rendition, bytes, 0);
	await saved.applyRemoteSnapshot(entry, await saved.checkpoint(entry), snapshot());
	expect(await saved.storageUsage()).toMatchObject({ drafts: 1, savedPictures: 1, savedPictureBytes: 3, cachedPictures: 1, cachedPictureBytes: 3 });
	expect(await saved.pictureSource(source.id, entry)).toBeDefined();
	expect(await saved.cachedPicture(entry, id(30), "content")).toBeUndefined();
	expect(await saved.cachedPicture(id(40), id(31), "content")).toBeDefined();
	expect(await other.cachedPicture(entry, id(30), "content")).toBeDefined();
	expect(await saved.cachePicture(entry, id(30), "content", rendition, bytes, 0, 0)).toBe(false);
	expect(await saved.cachePicture(entry, id(30), "content", rendition, bytes, 1, 0)).toBe(false);
});

test("a late transaction abort rolls back deletion, new entities, generation and cursor together", async () => {
	const saved = await store(), before = await saved.checkpoint(entry);
	await saved.cacheRemoteRead(entry, before.generation, [{ id: "thread:retained", revision: 1, value: "Retained" }]);
	const put = IDBObjectStore.prototype.put;
	jest.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
		const request = put.call(this, value, key);
		if (this.name === "cursors") request.addEventListener("success", () => queueMicrotask(() => this.transaction.abort()), { once: true });
		return request;
	});
	await expect(saved.applyRemoteSnapshot(entry, before, snapshot())).rejects.toThrow();
	expect((await saved.entity(entry, "thread:retained"))?.value).toBe("Retained");
	expect(await saved.entity(entry, threadKey(thread))).toBeUndefined(); expect(await saved.checkpoint(entry)).toEqual(before);
});

function remote() {
	return { identity, snapshot: jest.fn(async () => snapshot()), changes: jest.fn(async (_scope: string, _cursor?: string) => ({ events: [], cursor: "caught-up", has_more: false })),
		state: jest.fn(), message: jest.fn() };
}
function worker(saved: DiscussionStore, reader = remote(), enabled = true) {
	const sync = new DiscussionSync(saved, reader, entry, () => {}, undefined, undefined, undefined, undefined, () => enabled);
	workers.push(sync); return sync;
}

test("initial synchronization installs the baseline then catches up from its exact cursor", async () => {
	const saved = await store(), reader = remote(), sync = worker(saved, reader);
	sync.resume(); await sync.settled();
	expect(reader.snapshot).toHaveBeenCalledTimes(1); expect(reader.changes).toHaveBeenCalledWith(entry, "baseline10");
	expect(await saved.cursor(entry)).toBe("caught-up"); expect(sync.status).toBe("current"); expect(reader.message).not.toHaveBeenCalled();
	expect((await saved.entity(entry, threadKey(thread)))?.value).toEqual(protocolJson({ ...snapshot().threads[0].thread, anchor: snapshot().threads[0].anchor }));
});

test.each([[404, "discussion_snapshot_disabled"], [413, "discussion_snapshot_limit"]])("explicit snapshot unavailability %s falls back to retained events", async (status, code) => {
	const saved = await store(), reader = remote(), sync = worker(saved, reader);
	reader.snapshot.mockRejectedValue(new DiscussionFailure("pause", String(code), Number(status)));
	sync.resume(); await sync.settled(); expect(reader.changes).toHaveBeenCalledWith(entry, undefined); expect(sync.status).toBe("current");
});

test("a legacy server does not receive snapshot requests", async () => {
	const saved = await store(), reader = remote(), sync = worker(saved, reader, false);
	sync.resume(); await sync.settled(); expect(reader.snapshot).not.toHaveBeenCalled(); expect(reader.changes).toHaveBeenCalledWith(entry, undefined);
});

test("an expired cursor reauthorizes before replacing the baseline and then catches up", async () => {
	const saved = await store(), reader = remote(), order: string[] = [];
	await saved.applyRemoteBatch(entry, undefined, "expired", []);
	reader.changes.mockImplementation(async (_scope, cursor) => {
		if (cursor === "expired") { order.push("expired"); throw new DiscussionFailure("pause", "snapshot_required", 409); }
		order.push("catch-up"); return { events: [], cursor: "caught-up", has_more: false };
	});
	reader.snapshot.mockImplementation(async () => { order.push("snapshot"); return snapshot(); });
	const sync = new DiscussionSync(saved, reader, entry, () => {}, undefined, undefined,
		async () => { order.push("authorize"); }, undefined, () => true);
	workers.push(sync); sync.resume(); await sync.settled();
	expect(order).toEqual(["expired", "authorize", "snapshot", "catch-up"]);
	expect(await saved.cursor(entry)).toBe("caught-up"); expect(sync.status).toBe("current");
});

test.each([[403, "read_forbidden"], [404, "target_unavailable"]])("snapshot denial %s clears remote data but keeps unsent work", async (status, code) => {
	const saved = await store(), reader = remote(), sync = worker(saved, reader);
	await saved.cacheRemoteRead(entry, 0, [{ id: "thread:private", revision: 1, value: "Previous private content" }]);
	await saved.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: "Unsent text" });
	reader.snapshot.mockRejectedValue(new DiscussionFailure("reject", String(code), Number(status)));
	sync.resume(); await sync.settled();
	expect(await saved.entity(entry, "thread:private")).toBeUndefined();
	expect((await saved.getDraft("draft"))?.body).toBe("Unsent text");
	expect(reader.changes).not.toHaveBeenCalled(); expect(sync.status).toBe("unavailable");
});

test("a busy snapshot endpoint retries without falling through to an unbounded replay", async () => {
	const saved = await store(), reader = remote(), sync = worker(saved, reader);
	reader.snapshot.mockRejectedValue(new DiscussionFailure("retry", "discussion_snapshot_busy", 503, 2000));
	sync.resume(); await sync.settled();
	expect(reader.changes).not.toHaveBeenCalled(); expect(sync.status).toBe("offline");
	expect(await saved.cursor(entry)).toBeUndefined();
});

test("a stopped worker cannot apply a late baseline", async () => {
	const saved = await store(), reader = remote(); let finish!: (value: DiscussionSnapshot) => void;
	const started = new Promise<void>(resolve => { reader.snapshot.mockImplementation(() => { resolve(); return new Promise(done => { finish = done; }); }); });
	const sync = worker(saved, reader); sync.resume(); await started; sync.stop(); finish(snapshot()); await sync.settled();
	expect(await saved.entity(entry, threadKey(thread))).toBeUndefined(); expect(await saved.cursor(entry)).toBeUndefined(); expect(reader.changes).not.toHaveBeenCalled();
});
