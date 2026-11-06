import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseRegistryTransport } from "../../src/bases/BaseRegistryTransport";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { bodyFromText, protocolJson, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";

Object.assign(globalThis, { IDBKeyRange });
const run = process.env.EVC_BASE_CONTENT_FIXTURE ? test : test.skip;

run("actual formula/summary discussions preserve offline targets, reject changed definitions and retain historical replies", async () => {
	const f = JSON.parse(readFileSync(process.env.EVC_BASE_CONTENT_FIXTURE!, "utf8")) as Record<string, string>;
	expect(new URL(f.base).hostname).toBe("127.0.0.1");
	const identity = { serverId: f.base, accountId: f.reviewer, shareId: f.share, vaultId: randomUUID() };
	const ownerIdentity = { ...identity, accountId: f.owner }, ownerCredential = async () => ({ accountId: f.owner, accessToken: f.ownerToken });
	const content = new BaseContentTransport(ownerIdentity, ownerCredential, fetch), registry = new BaseRegistryTransport(ownerIdentity, ownerCredential, fetch);
	const publish = async (expression: string, name = "Review") => {
		const before = await content.read(f.definitionsEntry);
		await content.publish(f.definitionsEntry, { operationId: randomUUID(), expected: before.state, bytes: new TextEncoder().encode(JSON.stringify({
			formulas: { total: expression }, views: [{ name, type: "table", summaries: { "formula.total": "Average" } }, { name: "Cards", type: "cards" }],
		})).buffer as ArrayBuffer });
		const saved = await content.read(f.definitionsEntry);
		return registry.inspect(f.definitionsEntry, saved.state.record.hash!, saved.state.generation!);
	};
	const snapshot = await publish("price * 2"), view = snapshot.views[0].id!, scope = baseDiscussionScope(f.definitionsEntry, view);
	let connected = true;
	const transport = new DiscussionTransport(identity, async () => ({ accountId: f.reviewer, accessToken: f.reviewerToken }),
		async (...args: Parameters<typeof fetch>) => { if (!connected) throw new TypeError("Offline fixture"); return fetch(...args); });
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory), session = new DiscussionSession(store, transport);
	const start = async () => { await session.start(); session.watch(scope, () => {}, "base"); await session.refresh(); session.setForeground(false); await session.outbox.settled(); };
	const operation = (anchor: BaseAnchor) => ({ operationId: randomUUID(), scopeId: scope, type: "thread.create" as const, dependsOn: [], payload: {
		type: "thread.create", thread_id: randomUUID(), message_id: randomUUID(), anchor: protocolJson(anchor), body: protocolJson(bodyFromText("Review this definition")) } });
	try {
		await start();
		expect(session.permission(scope)).toEqual({ read: true, comment: true, edit: false, moderate: false });
		const definitions = await session.readBaseDefinitions(scope), formula = definitions.targets.find(item => item.kind === "formula")!, summary = definitions.targets.find(item => item.kind === "summary")!;
		const selection = { type: "formula" as const, definitionId: formula.id, definitionRevision: formula.revision };
		const captured = await session.captureBaseTarget(scope, selection), summaryAnchor = await session.captureBaseTarget(scope, { type: "summary", definitionId: summary.id, definitionRevision: summary.revision });
		const cellSelection = { ...selection, type: "formula_cell" as const, recordId: f.record };
		const cellAnchor = await session.captureBaseTarget(scope, cellSelection);
		expect(cellAnchor.target).toMatchObject({ type: "formula_cell", record_id: f.record, definition_id: formula.id });
		await store.saveDraft({ id: "kept", scopeId: scope, revision: 1, body: "Review offline", target: protocolJson(captured) });
		await store.saveDraft({ id: "cell", scopeId: scope, revision: 1, body: "Cell review offline", target: protocolJson(cellAnchor) });
		await session.close(); connected = false;
		store = await DiscussionStore.open(identity, factory); session = new DiscussionSession(store, transport); await start();
		expect(await session.captureBaseTarget(scope, selection)).toEqual(captured);
		expect(await session.captureBaseTarget(scope, cellSelection)).toEqual(cellAnchor);
		expect((await store.getDraft("cell"))?.target).toEqual(cellAnchor);
		expect((await store.getDraft("kept"))?.body).toBe("Review offline");
		const queued = operation(captured); await session.queue(queued); expect(await store.pending(scope)).toHaveLength(1);
		connected = true;
		await publish("price * 2", "Renamed");
		const accepted = await transport.send(queued); expect(await transport.send(queued)).toEqual(accepted);
		const summaryAccepted = await transport.send(operation(summaryAnchor));
		const cellOperation = operation(cellAnchor), cellAccepted = await transport.send(cellOperation);
		expect(await transport.send(cellOperation)).toEqual(cellAccepted);
		expect((await transport.thread(scope, cellAccepted.thread_id)).anchor).toEqual(cellAnchor);
		expect((await transport.thread(scope, summaryAccepted.thread_id)).anchor).toEqual(summaryAnchor);
		await publish("price * 3", "Renamed");
		await expect(transport.send(operation(captured))).rejects.toMatchObject({ code: "base_target_definition_changed", status: 409 });
		await expect(transport.send(operation(cellAnchor))).rejects.toMatchObject({ code: "base_target_definition_changed", status: 409 });
		expect(await transport.send(cellOperation)).toEqual(cellAccepted);
		await transport.send({ operationId: randomUUID(), scopeId: scope, type: "reply.create", dependsOn: [], payload: {
			type: "reply.create", thread_id: cellAccepted.thread_id, message_id: randomUUID(), body: protocolJson(bodyFromText("Cell discussion after formula edit")) } });
		expect(await transport.send(queued)).toEqual(accepted);
		expect((await transport.thread(scope, accepted.thread_id)).anchor).toEqual(captured);
		await transport.send({ operationId: randomUUID(), scopeId: scope, type: "reply.create", dependsOn: [], payload: {
			type: "reply.create", thread_id: accepted.thread_id, message_id: randomUUID(), body: protocolJson(bodyFromText("The formula changed")) } });
		await session.start(); expect(await session.baseDefinitionStatus(scope, captured)).toContain("has changed");
		await expect(session.captureBaseTarget(scope, selection)).rejects.toThrow("definition changed");
		await expect(session.captureBaseTarget(scope, cellSelection)).rejects.toThrow("definition changed");
		expect((await store.getDraft("kept"))?.target).toEqual(captured);
	} finally { await session.close(); }
}, 25000);
