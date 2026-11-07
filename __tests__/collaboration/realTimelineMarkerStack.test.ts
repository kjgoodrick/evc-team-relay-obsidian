import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseRegistryTransport } from "../../src/bases/BaseRegistryTransport";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionDelivery } from "../../src/collaboration/DiscussionDelivery";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { bodyFromText, protocolJson, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";

Object.assign(globalThis, { IDBKeyRange });
const run = process.env.EVC_BASE_CONTENT_FIXTURE ? test : test.skip;

run("actual marker HTTP and offline outbox preserve accepted targets through lost responses, edits and archival", async () => {
	const f = JSON.parse(readFileSync(process.env.EVC_BASE_CONTENT_FIXTURE!, "utf8")) as Record<string, string>;
	expect(new URL(f.base).hostname).toBe("127.0.0.1");
	const identity = { serverId: f.base, accountId: f.reviewer, shareId: f.share, vaultId: randomUUID() };
	const ownerIdentity = { ...identity, accountId: f.owner }, ownerCredential = async () => ({ accountId: f.owner, accessToken: f.ownerToken });
	const content = new BaseContentTransport(ownerIdentity, ownerCredential, fetch), registry = new BaseRegistryTransport(ownerIdentity, ownerCredential, fetch);
	const before = await content.read(f.markersEntry);
	await content.publish(f.markersEntry, { operationId: randomUUID(), expected: before.state, bytes: new TextEncoder().encode(JSON.stringify({ views: [
		{ name: "Timeline", type: "sabidurian-timeline", startDateProp: "note.start", timeZone: "America/Denver" },
		{ name: "Sequence", type: "sabidurian-sequence", orderProp: "note.order" },
	] })).buffer as ArrayBuffer });
	const saved = await content.read(f.markersEntry), snapshot = await registry.inspect(f.markersEntry, saved.state.record.hash!, saved.state.generation!);
	const path = f.base + "/v1/collaboration/shares/" + f.share + "/entries/" + f.markersEntry + "/bases/timeline-markers/commands";
	for (let index = 0; index < 2; index++) {
		const scope = baseDiscussionScope(f.markersEntry, snapshot.views[index].id!);
		let connected = true, lose = false;
		const requests: string[] = [];
		const transport = new DiscussionTransport(identity, async () => ({ accountId: f.reviewer, accessToken: f.reviewerToken }), async (url, init) => {
			if (!connected) throw new TypeError("Offline fixture");
			if (String(url).endsWith("/commands")) requests.push(String(init?.body));
			const response = await fetch(url, init);
			if (lose && response.ok && String(url).endsWith("/commands")) { lose = false; await response.text(); throw new TypeError("Synthetic lost response"); }
			return response;
		});
		const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory), session = new DiscussionSession(store, transport), outbox: DiscussionOutbox | undefined;
		const start = async () => { await session.start(); session.watch(scope, () => {}, "base"); await session.refresh(); session.setForeground(false); await session.outbox.settled(); };
		const operation = (anchor: BaseAnchor) => ({ operationId: randomUUID(), scopeId: scope, type: "thread.create" as const, dependsOn: [], payload: {
			type: "thread.create", thread_id: randomUUID(), message_id: randomUUID(), anchor: protocolJson(anchor), body: protocolJson(bodyFromText("Review milestone")) } });
		try {
			await start(); expect(session.permission(scope)).toEqual({ read: true, comment: true, edit: false, moderate: false });
			const axis = await session.readTimelineAxis(scope), initial = await session.readTimelineMarkers(scope), markerId = randomUUID();
			const range = index === 0 ? { version: 1, kind: "calendar", start: "2026-11-07", end: "2026-11-07", time_zone: "America/Denver", start_inclusive: true, end_inclusive: true } :
				{ version: 1, kind: "ordinal", start: "999999999999999.000000001", end: "999999999999999.000000001", unit: "property-value", start_inclusive: true, end_inclusive: true };
			const put = { operation_id: randomUUID(), definition_id: initial.definition_id, generation: initial.generation, registry_revision: initial.registry_revision,
				expected_catalog_revision: initial.catalog_revision, command: { type: "marker.put", marker_id: markerId, expected_marker_revision: 0,
					content: { kind: "point", label: "Original launch", color: "#ABCDEF", range }, placements: [{ view_id: axis.view_id, axis_definition_id: axis.axis.id, axis_definition_revision: axis.axis.revision }] } };
			const manage = async (payload: unknown, token = f.ownerToken) => fetch(path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(payload) });
			expect((await manage(put, f.reviewerToken)).status).toBe(403);
			expect((await manage(put)).status).toBe(200);
			const selected = await session.readTimelineMarkers(scope), captured = await session.captureTimelineMarker(scope, selected, markerId);
			expect(captured.target).toMatchObject({ marker_id: markerId, marker_revision: 1, content: { label: "Original launch", color: "#abcdef", range } });
			await store.saveDraft({ id: "marker", scopeId: scope, revision: 1, body: "Offline milestone", target: protocolJson(captured) });
			await session.close(); connected = false;
			store = await DiscussionStore.open(identity, factory); session = new DiscussionSession(store, transport); await start();
			expect(await session.captureTimelineMarker(scope, selected, markerId)).toEqual(captured);
			const queued = operation(captured); await session.queue(queued, { id: "marker", revision: 1 });
			expect(await store.getDraft("marker")).toBeUndefined();
			connected = true; lose = true;
			outbox = new DiscussionOutbox(store, new DiscussionDelivery(store, transport), randomUUID()); outbox.resume(); await outbox.settled(); outbox.stop();
			expect((await store.getOperation(queued.operationId))?.state).toBe("queued");
			expect((await transport.thread(scope, queued.payload.thread_id)).anchor).toEqual(captured);
			await session.close(); store = await DiscussionStore.open(identity, factory); session = new DiscussionSession(store, transport);
			// Change and archive before retrying the accepted-but-unacknowledged comment.
			const latest = await transport.timelineMarkers(scope, axis.view_id);
			const edited = { ...put, operation_id: randomUUID(), expected_catalog_revision: latest.catalog_revision,
				command: { ...put.command, expected_marker_revision: 1, content: { ...put.command.content, label: "Moved launch" } } };
			const editResponse = await manage(edited); expect(editResponse.status).toBe(200);
			const edit = await editResponse.json() as { catalog_revision: number };
			expect((await manage({ ...put, operation_id: randomUUID(), expected_catalog_revision: edit.catalog_revision,
				command: { type: "marker.archive", marker_id: markerId, expected_marker_revision: 2 } })).status).toBe(200);
			outbox = new DiscussionOutbox(store, new DiscussionDelivery(store, transport), randomUUID(), () => {}, () => Date.now() + 120000);
			outbox.resume(); await outbox.settled(); outbox.stop();
			expect((await store.getOperation(queued.operationId))?.state).toBe("accepted");
			expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0]);
			expect((await transport.thread(scope, queued.payload.thread_id)).anchor).toEqual(captured);
			await expect(transport.send(operation(captured))).rejects.toMatchObject({ code: "timeline_marker_changed", status: 409 });
			await transport.send({ operationId: randomUUID(), scopeId: scope, type: "reply.create", dependsOn: [], payload: {
				type: "reply.create", thread_id: queued.payload.thread_id, message_id: randomUUID(), body: protocolJson(bodyFromText("Discuss archived launch")) } });
			expect((await transport.thread(scope, queued.payload.thread_id)).messages).toHaveLength(2);
			await start(); expect(await session.baseDefinitionStatus(scope, captured)).toContain("archived");
			await expect(session.captureTimelineMarker(scope, selected, markerId)).rejects.toThrow("changed");
		} finally { outbox?.stop(); await outbox?.settled(); await session.close(); }
	}
	expect((await content.read(f.markersEntry)).state).toEqual(saved.state);
}, 25000);
