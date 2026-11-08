import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionStore, type Json, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionSync, messageKey, threadKey } from "../../src/collaboration/DiscussionSync";
import { bodyFromText } from "../../src/collaboration/DiscussionProtocol";
import { PermissionPolicyClient } from "../../src/collaboration/PermissionPolicy";

const fixturePath = process.env.EVC_SNAPSHOT_FIXTURE;
const integration = fixturePath ? test : test.skip;
Object.assign(globalThis, { IDBKeyRange });

integration("real baselines replace stale caches, recover expired cursors and retain offline work after revocation", async () => {
	const f = JSON.parse(readFileSync(fixturePath!, "utf8")) as {
		base: string; share: string; entry: string; reviewer: string; owner: string; token: string; ownerToken: string;
	};
	if (new URL(f.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const identity = { serverId: f.base, accountId: f.reviewer, shareId: f.share, vaultId: "snapshot-proof" };
	const store = await DiscussionStore.open(identity, new IDBFactory());
	const fetcher = jest.fn((url: string, config: RequestInit) => fetch(url, config));
	const transport = new DiscussionTransport(identity, async () => ({ accountId: f.reviewer, accessToken: f.token }), fetcher);
	const thread = randomUUID(), message = randomUUID(), reply = randomUUID(), unsent = randomUUID();
	const send = (payload: Json) => transport.send({ operationId: randomUUID(), scopeId: f.entry, payload,
		type: (payload as { type: QueuedCommand["type"] }).type, dependsOn: [] });
	const reauthorize = jest.fn(async () => { expect((await transport.permissions(f.entry)).read).toBe(true); });
	const worker = new DiscussionSync(store, transport, f.entry, () => {}, undefined, undefined, reauthorize, undefined, () => true);
	try {
		expect((await transport.capabilities()).snapshot).toBe(true);
		await send({ type: "thread.create", thread_id: thread, message_id: message, anchor: { version: 1, type: "note" }, body: bodyFromText("First revision") });
		await send({ type: "message.edit", thread_id: thread, message_id: message, expected_revision: 1, body: bodyFromText("Current revision") });
		await send({ type: "reaction.set", thread_id: thread, message_id: message, emoji: "heart", present: true });
		const baseline = await transport.snapshot(f.entry);
		expect(baseline.through_sequence).toBe(3);
		expect(baseline.threads[0].messages[0]).toMatchObject({ revision: 2, body: bodyFromText("Current revision"), reactions: [{ emoji: "heart", count: 1, mine: true }] });
		expect(JSON.stringify(baseline)).not.toContain("First revision");
		await send({ type: "reply.create", thread_id: thread, message_id: reply, body: bodyFromText("After baseline") });
		expect((await transport.changes(f.entry, baseline.cursor)).events.map(event => event.sequence)).toEqual([4]);
		await store.saveDraft({ id: "draft", scopeId: f.entry, revision: 0, body: "Keep offline draft" });
		await store.enqueue({ operationId: unsent, scopeId: f.entry, type: "reply.create", dependsOn: [], payload: {
			type: "reply.create", thread_id: thread, message_id: randomUUID(), body: bodyFromText("Keep queued reply"),
		} }, Date.now());
		await store.cacheRemoteRead(f.entry, 0, [{ id: "thread:obsolete", revision: 1, value: "Stale remote data" }]);
		fetcher.mockClear(); worker.resume(); await worker.settled();
		expect(worker.status).toBe("current");
		expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname.split("/").at(-1))).toEqual(["snapshot", "changes"]);
		expect(await store.entity(f.entry, "thread:obsolete")).toBeUndefined();
		expect((await store.entity(f.entry, messageKey(thread, reply)))?.value).toMatchObject({ body: bodyFromText("After baseline") });
		worker.stop(); await worker.settled();
		await store.applyRemoteBatch(f.entry, await store.cursor(f.entry), "expired-invalid-cursor", []);
		fetcher.mockClear(); worker.resume(); await worker.settled();
		expect(reauthorize).toHaveBeenCalledTimes(1); expect(worker.status).toBe("current");
		expect(fetcher.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/snapshot"))).toHaveLength(1);
		const policy = new PermissionPolicyClient(f.base, { shareId: f.share, actorId: f.owner }, () => f.ownerToken, () => true, fetch);
		await policy.save(await policy.read(), { file_rules: [{ user_id: f.reviewer, path: "", recursive: true, permission: "none" }], comment_rules: [] });
		worker.wake(); await worker.settled();
		expect(worker.status).toBe("unavailable");
		expect(await store.entity(f.entry, threadKey(thread))).toBeUndefined();
		expect(await store.entity(f.entry, messageKey(thread, message))).toBeUndefined();
		expect((await store.getDraft("draft"))?.body).toBe("Keep offline draft");
		expect((await store.getOperation(unsent))?.state).toBe("queued");
		await expect(transport.snapshot(f.entry)).rejects.toMatchObject({ status: 404, code: "target_unavailable" });
	} finally { worker.stop(); await worker.settled(); store.close(); }
}, 30_000);
