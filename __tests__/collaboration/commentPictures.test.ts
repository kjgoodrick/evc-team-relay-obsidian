import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionDelivery } from "../../src/collaboration/DiscussionDelivery";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { DiscussionTransport, DiscussionFailure } from "../../src/collaboration/DiscussionTransport";
import { bodyFromText, parseBody, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { parsePictureMetadata, pictureHash, prepareLocalPicture, PICTURE_SOURCE_QUOTA, type PictureMetadata, type LocalPicture } from "../../src/collaboration/PictureProtocol";
import { DiscussionStore, type Draft, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { commentDraftBody, editableCommentDraft, readCommentDraft } from "../../src/collaboration/ui/CommentDraft";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.example", accountId: id(1), shareId: id(2), vaultId: id(3) };
const entry = id(4), pid = id(5);
const bytes = () => new TextEncoder().encode("private picture pixels").buffer;
const credentials = async () => ({ accountId: identity.accountId, accessToken: "synthetic-picture-token" });
const block = (pictureId = pid) => ({ type: "picture" as const, picture_id: pictureId, alt: "A diagram" });
const draft = (revision = 0, pictureId = pid): Draft => ({ id: "draft", scopeId: entry, revision, body: { text: "", mentions: [], pictures: [block(pictureId)] } });
const command = (operationId = id(10), pictureId: string | null = pid): QueuedCommand => ({ operationId, scopeId: entry, type: "thread.create", dependsOn: [], payload: {
	type: "thread.create", thread_id: id(11), message_id: id(12), anchor: { version: 1, type: "note" },
	body: pictureId ? { version: 1, blocks: [block(pictureId)] } : protocolJson(bodyFromText("Unrelated comment")),
} });
const result = (operationId = id(10)) => ({ operation_id: operationId, scope_id: id(13), thread_id: id(11), message_id: id(12),
	sequence: 1, state: "open", state_revision: 1, message_revision: 1, message_deleted: false, changed: true, removed: false });
function metadata(source: LocalPicture, state: PictureMetadata["state"] = "verified"): PictureMetadata {
	return { picture_id: source.id, state, source_sha256: source.sha256, source_size: source.size,
		source_mime: state === "staged" ? null : "image/png", expires_at: state === "attached" ? null : "2027-01-01T00:00:00Z",
		renditions: state === "staged" ? {} : {
			content: { sha256: source.sha256, size: source.size, mime: "image/png", width: 1, height: 1 },
			thumbnail: { sha256: source.sha256, size: source.size, mime: "image/png", width: 1, height: 1 },
		} };
}
const response = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers });
let factory: IDBFactory, store: DiscussionStore, source: LocalPicture, workers: DiscussionOutbox[], time: number;
beforeEach(async () => { factory = new IDBFactory(); store = await DiscussionStore.open(identity, factory); source = await prepareLocalPicture(pid, entry, bytes()); workers = []; time = 100; });
afterEach(async () => { workers.forEach(worker => worker.stop()); await Promise.all(workers.map(worker => worker.settled())); store.close(); });
function worker(fetcher: jest.Mock): DiscussionOutbox {
	const transport = new DiscussionTransport(identity, credentials, fetcher);
	const worker = new DiscussionOutbox(store, new DiscussionDelivery(store, transport), "picture-worker", undefined, () => time, () => 0.5);
	workers.push(worker); return worker;
}
async function saved(picture = source, selected = draft()): Promise<void> { await store.saveDraft(selected, null, [picture]); }

test("picture-only drafts retain references and bounded metadata never retains storage keys or URLs", () => {
	expect(commentDraftBody(readCommentDraft(draft().body))).toEqual({ version: 1, blocks: [block()] });
	expect(() => readCommentDraft({ text: "Do not silently drop", mentions: [], pictures: [{ type: "picture", picture_id: "broken" }] })).toThrow();
	expect(() => parseBody({ version: 1, blocks: Array.from({ length: 11 }, () => block()) })).toThrow();
	const remote = metadata(source);
	expect(parsePictureMetadata({ ...remote, url: "https://untrusted.example", renditions: { ...remote.renditions,
		content: { ...remote.renditions.content, key: "private-object-key" } } }, pid)).toEqual(remote);
	expect(() => parsePictureMetadata(remote, id(99))).toThrow();
	expect(() => parsePictureMetadata({ ...remote, renditions: { ...remote.renditions, content: { ...remote.renditions.content, width: 20_000_000, height: 2 } } }, pid)).toThrow();
	expect(() => parsePictureMetadata({ ...remote, state: "staged" }, pid)).toThrow();
});

test("bytes and draft survive restart, are cloned before awaiting, and stay account/server isolated", async () => {
	const pending = saved(); new Uint8Array(source.bytes)[0] ^= 1; await pending;
	expect(await pictureHash((await store.pictureSource(pid, entry))!.bytes)).toBe(source.sha256);
	store.close(); store = await DiscussionStore.open(identity, factory);
	expect(await store.getDraft("draft")).toEqual(draft());
	expect((await store.pictureSource(pid, entry))?.sha256).toBe(source.sha256);
	for (const other of [{ ...identity, accountId: id(90) }, { ...identity, serverId: "https://elsewhere.example" }, { ...identity, vaultId: id(91) }]) {
		const isolated = await DiscussionStore.open(other, factory);
		try { expect(await isolated.pictureSource(pid, entry)).toBeUndefined(); } finally { isolated.close(); }
	}
	expect(await store.pictureSource(pid, id(90))).toBeUndefined();
});

test("local quota failure rolls back the entire draft and blob transaction", async () => {
	await store.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: "Existing text" });
	await store.setPreference("pictureSourceBytes", PICTURE_SOURCE_QUOTA);
	await expect(store.saveDraft(draft(1), 0, [source])).rejects.toThrow("100 MiB");
	expect((await store.getDraft("draft"))?.body).toBe("Existing text");
	expect(await store.pictureSource(pid, entry)).toBeUndefined();
	expect(await store.preference("pictureSourceBytes")).toBe(PICTURE_SOURCE_QUOTA);
});

test("two windows competing to save a picture leave only the winning bytes and references", async () => {
	await store.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: "Original" });
	const other = await DiscussionStore.open(identity, factory), second = await prepareLocalPicture(id(6), entry, bytes());
	try {
		const writes = await Promise.allSettled([store.saveDraft(draft(1), 0, [source]), other.saveDraft(draft(1, second.id), 0, [second])]);
		expect(writes.filter(write => write.status === "fulfilled")).toHaveLength(1);
		const winner = readCommentDraft((await store.getDraft("draft"))?.body).pictures![0].picture_id;
		expect(await store.pictureSource(winner, entry)).toBeDefined();
		expect(await store.pictureSource(winner === pid ? second.id : pid, entry)).toBeUndefined();
		expect(await store.preference("pictureSourceBytes")).toBe(source.size);
	} finally { other.close(); }
});

test("reference removal preserves another draft's original, then reclaims the last reference", async () => {
	await saved(); await store.saveDraft({ ...draft(), id: "second" });
	expect(await store.removeDraft("draft", 0)).toBe(true);
	expect(await store.pictureSource(pid, entry)).toBeDefined();
	expect(await store.removeDraft("second", 0)).toBe(true);
	expect(await store.pictureSource(pid, entry)).toBeUndefined();
	expect(await store.preference("pictureSourceBytes")).toBe(0);
});

test("rich undo references retain originals across removal and send only active pictures", async () => {
	const second = await prepareLocalPicture(id(6), entry, bytes());
	const rich = editableCommentDraft({ version: 1, blocks: [...bodyFromText("Before").blocks, block(), ...bodyFromText("After").blocks] }, () => "Member");
	const body = { ...rich, undoPictures: [block(second.id)], editBaseRevision: 7 };
	await store.saveDraft({ ...draft(), body: protocolJson(body) }, null, [source, second]);
	expect(await store.preference("pictureSourceBytes")).toBe(source.size + second.size);
	await store.enqueue({ ...command(), payload: { ...command().payload as object, body: protocolJson(commentDraftBody(body)) } }, 1, { id: "draft", revision: 0 });
	expect(await store.pictureSource(pid, entry)).toBeDefined(); expect(await store.pictureSource(second.id, entry)).toBeUndefined();
	expect((await store.getOperation(id(10)))?.dependsOn).toEqual([pid]); expect(await store.getOperation(second.id)).toBeUndefined();
	expect(await store.preference("pictureSourceBytes")).toBe(source.size);
});

test("picture recovery atomically remaps rich positions and undo references without changing edit revision or target", async () => {
	const second = await prepareLocalPicture(id(6), entry, bytes()), target = { version: 1, type: "note" };
	const body = { ...editableCommentDraft({ version: 1, blocks: [...bodyFromText("Before").blocks, block(), ...bodyFromText("After").blocks] }, () => "Member"),
		undoPictures: [block(second.id)], editBaseRevision: 7 };
	await store.saveDraft({ ...draft(), body: protocolJson(body), target }, null, [source, second]);
	const updated = await store.refreshDraftPictures("draft", 0, [{ oldId: pid, newId: id(60) }, { oldId: second.id, newId: id(61) }]);
	expect(readCommentDraft(updated.body)).toMatchObject({ editBaseRevision: 7, pictures: [block(id(60))], undoPictures: [block(id(61))],
		rich: { blocks: [...bodyFromText("Before").blocks, block(id(60)), ...bodyFromText("After").blocks] } });
	expect(updated.target).toEqual(target); expect(await store.pictureSource(pid, entry)).toBeUndefined();
	expect((await store.pictureSource(id(60), entry))?.bytes).toEqual(source.bytes);
	expect((await store.pictureSource(id(61), entry))?.bytes).toEqual(second.bytes); expect(await store.preference("pictureSourceBytes")).toBe(source.size + second.size);
	await expect(store.refreshDraftPictures("draft", 0, [{ oldId: id(60), newId: id(62) }])).rejects.toThrow();
	expect(await store.pictureSource(id(62), entry)).toBeUndefined();
});

test("mismatched rich references roll back bytes and leave the previous draft intact", async () => {
	await store.saveDraft({ ...draft(), body: "Original" }, null);
	const body = editableCommentDraft({ version: 1, blocks: [block()] }, () => "Member");
	await expect(store.saveDraft({ ...draft(1), body: protocolJson({ ...body, pictures: [] }) }, 0, [source])).rejects.toThrow("do not match");
	expect((await store.getDraft("draft"))?.body).toBe("Original"); expect(await store.pictureSource(pid, entry)).toBeUndefined();
});

test("draft-to-outbox transfer inserts upload dependencies atomically and frees bytes only after message acceptance", async () => {
	await saved(); const queued = await store.enqueue(command(), 1, { id: "draft", revision: 0 });
	expect(queued.dependsOn).toEqual([pid]); expect(await store.getDraft("draft")).toBeUndefined();
	expect((await store.claimNext("worker", 2))?.type).toBe("picture.upload");
	expect((await store.getOperation(pid))?.lease?.expiresAt).toBe(120002);
	expect(await store.claimNext("other", 30_003)).toBeUndefined();
	await store.accept(pid, protocolJson(metadata(source)));
	expect(await store.pictureSource(pid, entry)).toBeDefined();
	expect((await store.claimNext("worker", 3))?.operationId).toBe(id(10));
	await store.accept(id(10), result());
	expect(await store.pictureSource(pid, entry)).toBeUndefined();
	expect(await store.preference("pictureSourceBytes")).toBe(0);
	expect((await store.enqueue(command(), 4)).state).toBe("accepted");
	const changed = await prepareLocalPicture(pid, entry, new TextEncoder().encode("Different content").buffer);
	await expect(store.saveDraft({ ...draft(), id: "reuse" }, null, [changed])).rejects.toThrow("identity");
});

test("stale enqueue rolls back upload jobs and preserves all original work", async () => {
	await saved(); await expect(store.enqueue(command(), 1, { id: "draft", revision: 7 })).rejects.toThrow("Draft changed");
	expect(await store.getOperation(pid)).toBeUndefined(); expect(await store.getOperation(id(10))).toBeUndefined();
	expect(await store.pictureSource(pid, entry)).toBeDefined(); expect(await store.getDraft("draft")).toEqual(draft());
});

test("authorization cache purge never deletes original unsent picture bytes", async () => {
	await saved(); await store.enqueue(command(), 1, { id: "draft", revision: 0 });
	await store.clearRemoteScope(entry); expect(await store.pictureSource(pid, entry)).toBeDefined();
	await store.clearAll(); expect(await store.pictureSource(pid, entry)).toBeUndefined();
});

test("a committed event acknowledgment atomically releases only unreferenced source bytes", async () => {
	await saved(); await store.enqueue(command(), 1, { id: "draft", revision: 0 });
	await store.accept(pid, protocolJson(metadata(source)));
	expect(await store.applyRemoteBatch(entry, undefined, "accepted-cursor", [], [{ operationId: id(10), result: result() }], 0)).toBe(true);
	expect((await store.getOperation(id(10)))?.state).toBe("accepted");
	expect(await store.pictureSource(pid, entry)).toBeUndefined();
	expect(await store.cursor(entry)).toBe("accepted-cursor");
});

test("unconfirmed online work protects picture originals until exact draft completion", async () => {
	await saved();
	await store.prepareOnlineDraft("draft", 0, { operationId: id(20), scopeId: entry, payload: command().payload });
	await expect(store.removeDraft("draft", 0)).rejects.toThrow("unconfirmed");
	expect(await store.pictureSource(pid, entry)).toBeDefined();
	await expect(store.completeOnlineDraft("draft", 0, id(21))).rejects.toThrow();
	expect(await store.pictureSource(pid, entry)).toBeDefined();
	await store.completeOnlineDraft("draft", 0, id(20));
	expect(await store.pictureSource(pid, entry)).toBeUndefined();
});

test("upgrading a version-five store preserves existing drafts and creates usable picture stores", async () => {
	const oldFactory = new IDBFactory(), name = "team-relay-discussions:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]);
	const old = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = oldFactory.open(name, 5); request.onerror = () => reject(request.error);
		request.onupgradeneeded = () => {
			const db = request.result;
			db.createObjectStore("drafts", { keyPath: "id" }).createIndex("scopeId", ["scopeId", "id"]);
			for (const name of ["preferences", "cursors", "generations"]) db.createObjectStore(name);
			const outbox = db.createObjectStore("outbox", { keyPath: "operationId" });
			outbox.createIndex("state", "state"); outbox.createIndex("scope", "scopeId"); outbox.createIndex("scopeState", ["scopeId", "state", "createdAt", "operationId"]);
			const entities = db.createObjectStore("entities", { keyPath: ["scopeId", "id"] }); entities.createIndex("scope", "scopeId"); entities.createIndex("ordered", ["scopeId", "collection", "position"]);
		};
		request.onsuccess = () => resolve(request.result);
	});
	await new Promise<void>((resolve, reject) => {
		const tx = old.transaction("drafts", "readwrite"); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
		tx.objectStore("drafts").put({ id: "draft", scopeId: entry, revision: 0, body: "Legacy unsent text" });
	});
	old.close(); const upgraded = await DiscussionStore.open(identity, oldFactory);
	try {
		expect((await upgraded.getDraft("draft"))?.body).toBe("Legacy unsent text");
		await upgraded.saveDraft(draft(1), 0, [source]);
		await upgraded.enqueue(command(), 1, { id: "draft", revision: 1 });
		expect((await upgraded.getOperation(pid))?.type).toBe("picture.upload");
		expect((await upgraded.pictureSource(pid, entry))?.sha256).toBe(source.sha256);
	} finally { upgraded.close(); }
});

test("uploads authenticated raw bytes before sending the comment, without putting tokens in URLs", async () => {
	await saved(); await store.enqueue(command(), 1, { id: "draft", revision: 0 });
	const requests: string[] = [];
	const fetcher = jest.fn(async (url, init) => {
		expect(url).not.toContain("token"); expect(init).toMatchObject({ sensitive: true, headers: { Authorization: "Bearer synthetic-picture-token" } });
		if (url.endsWith("/pictures")) { requests.push("stage"); return response(metadata(source, "staged")); }
		if (init.method === "PUT") { requests.push("upload"); expect(init.body).toEqual(source.bytes); return response(metadata(source)); }
		requests.push("comment"); expect(JSON.parse(init.body).command.body.blocks).toEqual([block()]); return response(result());
	});
	const delivery = worker(fetcher); delivery.resume(); await delivery.settled();
	expect(requests).toEqual(["stage", "upload", "comment"]);
	expect((await store.getOperation(id(10)))?.state).toBe("accepted");
	expect(await store.pictureSource(pid, entry)).toBeUndefined();
});

test("lost upload acknowledgment retries the same identity and does not retransmit verified bytes", async () => {
	await saved(); await store.enqueue(command(), 1, { id: "draft", revision: 0 });
	let stored = false, puts = 0; const stageBodies: string[] = [];
	const fetcher = jest.fn(async (url, init) => {
		if (url.endsWith("/pictures")) { stageBodies.push(init.body); return response(metadata(source, stored ? "verified" : "staged")); }
		if (init.method === "PUT") { stored = true; puts++; throw new Error("Response lost"); }
		return response(result());
	});
	const delivery = worker(fetcher); delivery.resume(); await delivery.settled();
	expect((await store.getOperation(pid))?.state).toBe("queued");
	expect(await store.pictureSource(pid, entry)).toBeDefined();
	time = 1100; delivery.wake(); await delivery.settled();
	expect(stageBodies).toHaveLength(2); expect(stageBodies[0]).toBe(stageBodies[1]); expect(puts).toBe(1);
	expect((await store.getOperation(id(10)))?.state).toBe("accepted");
});

test("rejected pictures keep their comment blocked but unrelated comments continue", async () => {
	await saved(); await store.enqueue(command(), 1, { id: "draft", revision: 0 });
	await store.enqueue(command(id(30), null), 2);
	const fetcher = jest.fn(async (url, init) => {
		if (url.endsWith("/pictures")) return response(metadata(source, "staged"));
		if (init.method === "PUT") return response({ error: { message: { code: "invalid_picture" } } }, 415);
		return response(result(id(30)));
	});
	const delivery = worker(fetcher); delivery.resume(); await delivery.settled();
	expect((await store.getOperation(pid))?.state).toBe("rejected");
	expect((await store.getOperation(id(10)))?.state).toBe("queued");
	expect((await store.getOperation(id(30)))?.state).toBe("accepted");
	expect(await store.pictureSource(pid, entry)).toBeDefined(); expect(delivery.status).toBe("idle");
});

test("an upload outage defers other pictures without deferring newly queued ordinary comments", async () => {
	await saved(); await store.enqueue(command(), 1, { id: "draft", revision: 0 });
	const fetcher = jest.fn(async (url) => url.endsWith("/pictures") ? response({}, 503, { "Retry-After": "60" }) : response(result(id(30))));
	const delivery = worker(fetcher); delivery.resume(); await delivery.settled();
	await store.enqueue(command(id(30), null), 2); delivery.wake(); await delivery.settled();
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect((await store.getOperation(id(30)))?.state).toBe("accepted");
	expect((await store.getOperation(pid))?.nextAttemptAt).toBe(60100);
});

test("wrong accounts and mismatched upload responses cannot publish a picture receipt", async () => {
	const fetcher = jest.fn().mockResolvedValue(response({ ...metadata(source), source_sha256: "f".repeat(64) }));
	const upload = { type: "picture.upload" as const, picture_id: pid, sha256: source.sha256, size: source.size };
	await expect(new DiscussionTransport(identity, async () => ({ accountId: id(99), accessToken: "wrong" }), fetcher).uploadPicture(entry, upload, source.bytes))
		.rejects.toMatchObject({ action: "authenticate" }); expect(fetcher).not.toHaveBeenCalled();
	await expect(new DiscussionTransport(identity, credentials, fetcher).uploadPicture(entry, upload, source.bytes)).rejects.toMatchObject({ action: "pause", code: "invalid_picture_response" });
});

test("a server rollback disables picture jobs without hitting an absent endpoint or stopping ordinary comments", async () => {
	await saved(); await store.enqueue(command(), 1, { id: "draft", revision: 0 });
	await store.enqueue(command(id(30), null), 2);
	const fetcher = jest.fn().mockResolvedValue(response(result(id(30))));
	const transport = new DiscussionTransport(identity, credentials, fetcher);
	const delivery = new DiscussionOutbox(store, new DiscussionDelivery(store, transport, () => false), "rollback-worker");
	workers.push(delivery); delivery.resume(); await delivery.settled();
	expect((await store.getOperation(pid))?.error).toBe("pictures_disabled");
	expect((await store.getOperation(id(30)))?.state).toBe("accepted");
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(await store.pictureSource(pid, entry)).toBeDefined();
	expect(delivery.status).toBe("idle");
});

test("content downloads validate MIME, size and digest and cancel oversized streams", async () => {
	const expected = metadata(source).renditions.content!;
	const fetcher = jest.fn().mockResolvedValueOnce(new Response(source.bytes, { headers: { "Content-Type": "image/png" } }))
		.mockResolvedValueOnce(new Response(source.bytes, { headers: { "Content-Type": "text/html" } }));
	const transport = new DiscussionTransport(identity, credentials, fetcher);
	expect(await transport.pictureContent(entry, pid, "content", expected)).toEqual(source.bytes);
	await expect(transport.pictureContent(entry, pid, "content", expected)).rejects.toMatchObject({ code: "invalid_picture_content" });
	let cancelled = false;
	fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(source.size + 1)); }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "image/png" } }));
	await expect(transport.pictureContent(entry, pid, "content", expected)).rejects.toMatchObject({ code: "invalid_picture_content" }); expect(cancelled).toBe(true);
	fetcher.mockResolvedValueOnce(new Response(new Uint8Array(source.size), { headers: { "Content-Type": "image/png" } }));
	await expect(transport.pictureContent(entry, pid, "content", expected)).rejects.toBeInstanceOf(DiscussionFailure);
});
