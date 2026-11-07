import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseRegistryTransport } from "../../src/bases/BaseRegistryTransport";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
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
	expect((await transport.capabilities()).baseTargets).toEqual(["view", "item", "cell", "property", "formula", "summary", "formula_cell", "timeline_range", "timeline_marker"]);
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

run("real saved-view sessions retain separate offline work and refresh authorized caches after record access changes", async () => {
	const f = JSON.parse(readFileSync(process.env.EVC_BASE_CONTENT_FIXTURE!, "utf8")) as Record<string, string>;
	expect(new URL(f.base).hostname).toBe("127.0.0.1");
	const identity = { serverId: f.base, accountId: f.reviewer, shareId: f.share, vaultId: randomUUID() };
	const ownerIdentity = { ...identity, accountId: f.owner };
	const ownerCredential = async () => ({ accountId: f.owner, accessToken: f.ownerToken });
	const content = new BaseContentTransport(ownerIdentity, ownerCredential, fetch);
	const registry = new BaseRegistryTransport(ownerIdentity, ownerCredential, fetch);
	const initial = await content.read(f.sessionEntry);
	await content.publish(f.sessionEntry, { operationId: randomUUID(), expected: initial.state,
		bytes: new TextEncoder().encode(JSON.stringify({ views: [{ type: "table", name: "Session table" }, { type: "cards", name: "Session cards" }] })).buffer as ArrayBuffer });
	const published = await content.read(f.sessionEntry);
	const snapshot = await registry.inspect(f.sessionEntry, published.state.record.hash!, published.state.generation!);
	const [view, cards] = snapshot.views.map(v => v.id!);
	const tableScope = baseDiscussionScope(f.sessionEntry, view), cardsScope = baseDiscussionScope(f.sessionEntry, cards);
	let connected = true;
	const transport = new DiscussionTransport(identity, async () => ({ accountId: f.reviewer, accessToken: f.reviewerToken }),
		async (...args: Parameters<typeof fetch>) => { if (!connected) throw new TypeError("Offline fixture"); return fetch(...args); });
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory);
	let session = new DiscussionSession(store, transport);
	const rulesUrl = f.base + "/v1/managed/shares/" + f.share + "/rules";
	const auth = { Authorization: "Bearer " + f.ownerToken, "Content-Type": "application/json" };
	const original = await (await fetch(rulesUrl, { headers: auth })).json();
	let changedRules = false;
	const until = async (check: () => Promise<boolean>) => {
		const end = Date.now() + 8000;
		while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
		throw new Error("Saved-view session did not converge");
	};
	const watch = () => { session.watch(tableScope, () => {}, "base"); session.watch(cardsScope, () => {}, "base"); };
	const operation = (scopeId: string, anchor: BaseAnchor) => ({ operationId: randomUUID(), scopeId,
		type: "thread.create" as const, dependsOn: [], payload: { type: "thread.create", thread_id: randomUUID(), message_id: randomUUID(),
			anchor: protocolJson(anchor), body: protocolJson(bodyFromText("Session review")) } });
	try {
		await session.start(); watch(); await session.refresh();
		expect(session.canAnchorBaseRecord("image")).toBe(true);
		const cell = await session.captureBaseTarget(tableScope, { type: "cell", recordId: f.imageRecord, property: { source: "file", name: "size" } });
		const wholeView = await session.captureBaseTarget(cardsScope, { type: "view" });
		const navigationProof = await session.readBaseContext(tableScope, f.imageRecord);
		session.setForeground(false); await session.outbox.settled();
		for (const [scopeId, anchor] of [[tableScope, cell], [cardsScope, wholeView]] as const) {
			await store.saveDraft({ id: "selection:" + scopeId + ":saved", scopeId, revision: 1, body: "Keep this draft", target: protocolJson(anchor) });
		}
		const first = operation(tableScope, cell), second = operation(cardsScope, wholeView);
		await session.queue(first); await session.queue(second); await session.close();
		connected = false; store = await DiscussionStore.open(identity, factory); session = new DiscussionSession(store, transport);
		await session.start(); watch(); await session.refresh();
		expect(session.status).toBe("offline");
		expect(await session.readBaseContext(tableScope, f.imageRecord)).toEqual(navigationProof);
		expect(session.canAnchorBaseRecord("image")).toBe(true);
		expect(await session.captureBaseTarget(tableScope, { type: "cell", recordId: f.imageRecord, property: { source: "file", name: "size" } })).toEqual(cell);
		expect((await store.selectionDrafts(tableScope)).drafts.map(d => d.target)).toEqual([cell]);
		expect((await store.selectionDrafts(cardsScope)).drafts.map(d => d.target)).toEqual([wholeView]);
		expect((await store.pending(tableScope)).map(op => op.operationId)).toEqual([first.operationId]);
		expect((await store.pending(cardsScope)).map(op => op.operationId)).toEqual([second.operationId]);
		connected = true; await session.refresh();
		await until(async () => (await store.getOperation(first.operationId))?.state === "accepted" && (await store.getOperation(second.operationId))?.state === "accepted");
		await until(async () => (await session.local(tableScope)).threads.length === 1 && (await session.local(cardsScope)).threads.length === 1);
		expect((await session.local(tableScope)).threads.map(t => t.id)).toEqual([first.payload.thread_id]);
		expect((await session.local(cardsScope)).threads.map(t => t.id)).toEqual([second.payload.thread_id]);
		expect((await transport.thread(tableScope, String(first.payload.thread_id))).anchor).toEqual(cell);
		await expect(transport.thread(cardsScope, String(first.payload.thread_id))).rejects.toMatchObject({ code: "invalid_read_response" });
		expect((await store.checkpoint(tableScope)).cursor).not.toBe((await store.checkpoint(cardsScope)).cursor);
		expect((await fetch(rulesUrl, { method: "PUT", headers: auth, body: JSON.stringify([...original,
			{ user_id: f.reviewer, path: "Image.png", recursive: false, permission: "none" }]) })).status).toBe(200);
		changedRules = true; await session.refresh();
		await until(async () => session.syncStatus(tableScope) === "current" && session.syncStatus(cardsScope) === "current" &&
			(await session.local(tableScope)).threads.length === 0 && (await session.local(cardsScope)).threads.length === 1);
		expect((await session.local(cardsScope)).threads.map(t => t.id)).toEqual([second.payload.thread_id]);
		await expect(session.captureBaseTarget(tableScope, { type: "item", recordId: f.imageRecord })).rejects.toMatchObject({ status: 404 });
		await expect(session.readBaseContext(tableScope, f.imageRecord)).rejects.toMatchObject({ status: 404 });
		expect((await store.selectionDrafts(tableScope)).drafts).toHaveLength(1);
		expect((await fetch(rulesUrl, { method: "PUT", headers: auth, body: JSON.stringify(original) })).status).toBe(200);
		changedRules = false; await session.refresh();
		await until(async () => (await session.local(tableScope)).threads.length === 1);
		await until(async () => (await store.preference("permission:" + tableScope) as { read?: boolean } | undefined)?.read === true &&
			(await store.preference("permission:" + cardsScope) as { read?: boolean } | undefined)?.read === true);
		await session.close(); connected = false;
		store = await DiscussionStore.open(identity, factory); session = new DiscussionSession(store, transport);
		await session.start(); watch(); await session.refresh();
		expect(session.permission(tableScope)?.read).toBe(true);
		expect(session.permission(cardsScope)?.read).toBe(true);
		expect(session.documentGeneration(tableScope)).toBe(cell.generation);
		expect(session.documentGeneration(cardsScope)).toBe(wholeView.generation);
		expect((await session.local(tableScope)).threads.map(t => t.id)).toEqual([first.payload.thread_id]);
		expect((await session.local(cardsScope)).threads.map(t => t.id)).toEqual([second.payload.thread_id]);
		// A binary content update and a rename preserve the file-property target.
		// Type conversion must invalidate it even if the file later changes back.
		connected = true; await session.refresh();
		const indexUrl = f.base + "/v1/managed/index/" + f.share;
		const grantResponse = await fetch(f.base + "/v1/tokens/relay", { method: "POST", headers: auth,
			body: JSON.stringify({ share_id: f.share, doc_id: f.share, mode: "write" }) });
		expect(grantResponse.status).toBe(200);
		const grant = await grantResponse.json();
		const indexAuth = { ...auth, Authorization: "Bearer " + grant.token };
		const indexResponse = await fetch(indexUrl, { headers: indexAuth }); expect(indexResponse.status).toBe(200);
		const index = await indexResponse.json();
		const previous = index.records["Image.png"];
		const updated = { ...previous, hash: "b".repeat(64) };
		const batch = async (changes: unknown[]) => {
			const response = await fetch(indexUrl, { method: "POST", headers: indexAuth, body: JSON.stringify({ changes }) });
			expect(response.status).toBe(200); return response.json();
		};
		await batch([{ path: "Image.png", previous, value: updated }]);
		await batch([{ path: "Image.png", previous: updated, value: null }, { path: "Renamed.png", previous: null, value: updated }]);
		expect((await transport.thread(tableScope, String(first.payload.thread_id))).anchor).toEqual(cell);
		const converted = { ...updated, type: "file" };
		const conversion = [{ path: "Renamed.png", previous: updated, value: null }, { path: "Converted.txt", previous: null, value: converted }];
		await batch(conversion);
		await expect(transport.send(first)).rejects.toMatchObject({ status: 404 });
		await expect(transport.send(operation(tableScope, cell))).rejects.toMatchObject({ code: "anchor_generation_mismatch" });
		const fresh = await transport.baseTargetContext(tableScope, view, f.imageRecord);
		expect(fresh.record_generation).not.toBe(cell.target.type === "cell" ? cell.target.record_generation : undefined);
		await batch(conversion);
		expect((await transport.baseTargetContext(tableScope, view, f.imageRecord)).record_generation).toBe(fresh.record_generation);
		await session.refresh();
		await until(async () => session.syncStatus(tableScope) === "current" && (await session.local(tableScope)).threads.length === 0);
		expect((await store.selectionDrafts(tableScope)).drafts).toHaveLength(1);
	} finally {
		await session.close();
		if (changedRules) await fetch(rulesUrl, { method: "PUT", headers: auth, body: JSON.stringify(original) });
	}
}, 45_000);
