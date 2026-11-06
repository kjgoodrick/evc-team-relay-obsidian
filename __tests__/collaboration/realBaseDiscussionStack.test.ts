import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseRegistryTransport } from "../../src/bases/BaseRegistryTransport";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";

Object.assign(globalThis, { IDBKeyRange });
const run = process.env.EVC_BASE_CONTENT_FIXTURE ? test : test.skip;

run("real Bases discussions preserve offline targets, saved-view isolation, exact retries and revoked-record filtering", async () => {
	const f = JSON.parse(readFileSync(process.env.EVC_BASE_CONTENT_FIXTURE!, "utf8")) as Record<string, string>;
	expect(new URL(f.base).hostname).toBe("127.0.0.1");
	const identity = { serverId: f.base, accountId: f.reviewer, shareId: f.share, vaultId: randomUUID() };
	const transport = new DiscussionTransport(identity, async () => ({ accountId: f.reviewer, accessToken: f.reviewerToken }), fetch);
	const ownerIdentity = { ...identity, accountId: f.owner };
	const ownerCredential = async () => ({ accountId: f.owner, accessToken: f.ownerToken });
	const owner = new DiscussionTransport(ownerIdentity, ownerCredential, fetch);
	const content = new BaseContentTransport(ownerIdentity, ownerCredential, fetch);
	const registry = new BaseRegistryTransport(ownerIdentity, ownerCredential, fetch);
	const publish = async (name: string) => {
		const current = await content.read(f.discussionEntry);
		await content.publish(f.discussionEntry, { operationId: randomUUID(), expected: current.state,
			bytes: new TextEncoder().encode(JSON.stringify({ views: [{ type: "table", name }, { type: "cards", name: "Cards" }] })).buffer as ArrayBuffer });
		const saved = await content.read(f.discussionEntry);
		return registry.inspect(f.discussionEntry, saved.state.record.hash!, saved.state.generation!);
	};
	const snapshot = await publish("Table"), [view, cards] = snapshot.views.map(v => v.id!);
	const captured = await transport.baseTargetContext(f.discussionEntry, view, f.record);
	expect((await transport.capabilities()).baseTargets).toEqual(["view", "item", "cell", "property"]);
	expect(await transport.permissions(f.discussionEntry)).toEqual({ read: true, comment: true, edit: false, moderate: false });
	const anchor: BaseAnchor = { version: 1, type: "base", definition_id: captured.definition_id, view_id: view,
		generation: captured.generation, registry_revision: captured.registry_revision,
		target: { type: "cell", record_id: f.record, record_generation: captured.record_generation!, property: { source: "note", name: "status" } } };
	const operation = (target = anchor): QueuedCommand => ({ operationId: randomUUID(), scopeId: f.discussionEntry, type: "thread.create", dependsOn: [], payload: {
		type: "thread.create", thread_id: randomUUID(), message_id: randomUUID(), anchor: protocolJson(target), body: protocolJson(bodyFromText("Review this saved view")) } });
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory);
	let outbox: DiscussionOutbox | undefined;
	try {
		const draft = { id: "base-cell", scopeId: f.discussionEntry, revision: 1, body: "Review", target: protocolJson(anchor) };
		await store.saveDraft(draft, null); store.close(); store = await DiscussionStore.open(identity, factory);
		expect(await store.getDraft(draft.id)).toEqual(draft);
		const first = operation(), second = operation({ ...anchor, view_id: cards, target: { type: "item", record_id: f.record, record_generation: captured.record_generation! } });
		await store.enqueue(first, Date.now(), { id: draft.id, revision: 1 }); await store.enqueue(second);
		store.close(); store = await DiscussionStore.open(identity, factory);
		expect((await store.getOperation(first.operationId))?.payload).toEqual(first.payload);
		expect((await transport.threads(f.discussionEntry, 0, view)).threads).toHaveLength(0);
		const renamed = await publish("Renamed table"); expect(renamed.views[0].id).toBe(view);
		outbox = new DiscussionOutbox(store, transport, randomUUID()); outbox.resume(); await outbox.settled(); outbox.stop();
		expect((await store.getOperation(first.operationId))?.state).toBe("accepted");
		expect((await store.getOperation(second.operationId))?.state).toBe("accepted");
		const accepted = await transport.send(first); expect(await transport.send(first)).toEqual(accepted);
		expect((await transport.thread(f.discussionEntry, accepted.thread_id, 0, view)).anchor).toEqual(anchor);
		expect((await transport.threads(f.discussionEntry, 0, view)).threads.map(t => t.id)).toEqual([accepted.thread_id]);
		expect((await transport.threads(f.discussionEntry, 0, cards)).threads).toHaveLength(1);
		await expect(transport.thread(f.discussionEntry, accepted.thread_id, 0, cards)).rejects.toMatchObject({ code: "invalid_read_response" });
		const cursor = (await transport.changes(f.discussionEntry, undefined, view)).cursor;
		await expect(transport.changes(f.discussionEntry, cursor, cards)).rejects.toMatchObject({ code: "snapshot_required" });
		// Enough hidden candidates to force an empty page with has_more=true.
		for (let n = 0; n < 25; n++) await owner.send(operation());
		const viewThread = await transport.send(operation({ ...anchor, target: { type: "view" } }));
		await transport.send(operation({ ...anchor, view_id: cards, target: { type: "property", property: { source: "file", name: "name" } } }));
		const rulesUrl = f.base + "/v1/managed/shares/" + f.share + "/rules";
		const auth = { Authorization: "Bearer " + f.ownerToken, "Content-Type": "application/json" };
		const original = await (await fetch(rulesUrl, { headers: auth })).json();
		const denied = [...original, { user_id: f.reviewer, path: "Record.md", recursive: false, permission: "none" }];
		expect((await fetch(rulesUrl, { method: "PUT", headers: auth, body: JSON.stringify(denied) })).status).toBe(200);
		await expect(transport.send(first)).rejects.toMatchObject({ status: 404, code: "target_unavailable" });
		await expect(transport.thread(f.discussionEntry, accepted.thread_id)).rejects.toMatchObject({ status: 404 });
		await expect(transport.changes(f.discussionEntry, cursor, view)).rejects.toMatchObject({ code: "snapshot_required" });
		const hidden = await transport.changes(f.discussionEntry, undefined, view);
		expect(hidden).toMatchObject({ events: [], has_more: true, filtered: true, view_id: view });
		const remaining = await transport.changes(f.discussionEntry, hidden.cursor, view);
		expect(remaining.events.map(e => e.data.thread_id)).toEqual([viewThread.thread_id]);
		expect((await transport.threads(f.discussionEntry, 0, view)).threads.map(t => t.id)).toEqual([viewThread.thread_id]);
		expect((await fetch(rulesUrl, { method: "PUT", headers: auth, body: JSON.stringify(original) })).status).toBe(200);
		await expect(transport.changes(f.discussionEntry, remaining.cursor, view)).rejects.toMatchObject({ code: "snapshot_required" });
		expect((await transport.threads(f.discussionEntry, 0, view)).threads).toHaveLength(27);
		expect((await transport.thread(f.discussionEntry, accepted.thread_id)).anchor).toEqual(anchor);
	} finally { outbox?.stop(); await outbox?.settled(); store.close(); }
}, 45_000);
