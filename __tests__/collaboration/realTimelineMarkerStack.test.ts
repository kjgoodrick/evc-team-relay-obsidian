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
import { parseTimelineMarkerCommand } from "../../src/collaboration/TimelineMarkerManagementProtocol";

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
		{ name: "Roadmap", type: "sabidurian-timeline", startDateProp: "note.start", timeZone: "America/Denver" },
		{ name: "Sequence overview", type: "sabidurian-sequence", orderProp: "note.order" },
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
		const ownerFactory = new IDBFactory(), managementRequests: string[] = []; let loseManagement = true, catalogReads = 0;
		const ownerTransport = new DiscussionTransport(ownerIdentity, ownerCredential, async (url, init) => {
			const management = String(url).endsWith("/timeline-markers/commands");
			if (management) managementRequests.push(String(init?.body));
			if (String(url).endsWith("/timeline-markers/catalog")) catalogReads++;
			const response = await fetch(url, init);
			if (management && loseManagement && response.ok) { loseManagement = false; await response.text(); throw new TypeError("Lost marker save response"); }
			return response;
		});
		let ownerStore = await DiscussionStore.open(ownerIdentity, ownerFactory), ownerSession = new DiscussionSession(ownerStore, ownerTransport);
		const startOwner = async () => { await ownerSession.start(); ownerSession.watch(scope, () => {}, "base"); await ownerSession.refresh(); expect(ownerSession.online).toBe(true); };
		const start = async () => { await session.start(); session.watch(scope, () => {}, "base"); await session.refresh(); session.setForeground(false); await session.outbox.settled(); };
		const operation = (anchor: BaseAnchor) => ({ operationId: randomUUID(), scopeId: scope, type: "thread.create" as const, dependsOn: [], payload: {
			type: "thread.create", thread_id: randomUUID(), message_id: randomUUID(), anchor: protocolJson(anchor), body: protocolJson(bodyFromText("Review milestone")) } });
		try {
			await start(); expect(session.permission(scope)).toEqual({ read: true, comment: true, edit: false, moderate: false });
			const axis = await session.readTimelineAxis(scope), initial = await session.readTimelineMarkers(scope), markerId = randomUUID();
			const range = index === 0 ? { version: 1, kind: "calendar", start: "2026-11-07", end: "2026-11-07", time_zone: "America/Denver", start_inclusive: true, end_inclusive: true } :
				{ version: 1, kind: "ordinal", start: "999999999999999.000000001", end: "999999999999999.000000001", unit: "property-value", start_inclusive: true, end_inclusive: true };
			const put = parseTimelineMarkerCommand({ operation_id: randomUUID(), definition_id: initial.definition_id, generation: initial.generation, registry_revision: initial.registry_revision,
				expected_catalog_revision: initial.catalog_revision, command: { type: "marker.put", marker_id: markerId, expected_marker_revision: 0,
					content: { kind: "point", label: "Original launch", color: "#ABCDEF", range }, placements: [{ view_id: axis.view_id, axis_definition_id: axis.axis.id, axis_definition_revision: axis.axis.revision }] } });
			if (put.command.type !== "marker.put") throw new Error("Expected put");
			const manage = async (payload: unknown, token = f.ownerToken) => fetch(path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(payload) });
			expect((await manage(put, f.reviewerToken)).status).toBe(403);
			await startOwner();
			await expect(ownerSession.markerManagement.save(scope, put)).rejects.toMatchObject({ action: "retry" });
			expect(await ownerSession.markerManagement.state(scope)).toMatchObject({ status: "pending", request: put });
			expect(await ownerSession.markerManagement.acknowledge(scope, put.operation_id)).toBe(false);
			await ownerSession.close(); ownerStore = await DiscussionStore.open(ownerIdentity, ownerFactory); ownerSession = new DiscussionSession(ownerStore, ownerTransport);
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
			// A different device changes metadata while this device retains its lost save.
			const edit = await ownerTransport.manageTimelineMarker(scope, edited);
			await ownerTransport.manageTimelineMarker(scope, { ...put, operation_id: randomUUID(), expected_catalog_revision: edit.catalog_revision,
				command: { type: "marker.archive", marker_id: markerId, expected_marker_revision: 2 } });
			await startOwner();
			const recovered = await ownerSession.markerManagement.retry(scope);
			expect(recovered.marker).toMatchObject({ revision: 1, active: true, content: { label: "Original launch" } });
			expect((await ownerTransport.timelineMarker(scope, markerId)).marker).toMatchObject({ revision: 3, active: false, content: { label: "Moved launch" } });
			const retries = managementRequests.filter(body => (JSON.parse(body) as { operation_id: string }).operation_id === put.operation_id);
			expect(retries).toHaveLength(2); expect(retries[0]).toBe(retries[1]);
			expect(await ownerSession.markerManagement.acknowledge(scope, put.operation_id)).toBe(true);
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
			// Placement failure cannot strand the editor behind an unrecoverable
			// pending slot; acknowledgement permits a reviewed valid restore.
			const current = await ownerTransport.timelineMarkers(scope, axis.view_id);
			const restore = { ...put, operation_id: randomUUID(), expected_catalog_revision: current.catalog_revision,
				command: { ...put.command, expected_marker_revision: 3 } };
			await expect(ownerSession.markerManagement.save(scope, { ...restore, command: { ...restore.command,
				placements: [{ ...restore.command.placements[0], axis_definition_id: randomUUID() }] } })).rejects.toMatchObject({ code: "timeline_axis_unavailable", status: 409 });
			expect(await ownerSession.markerManagement.state(scope)).toMatchObject({ status: "rejected", error: "timeline_axis_unavailable" });
			expect(await ownerSession.markerManagement.acknowledge(scope, restore.operation_id)).toBe(true);
			const restored = await ownerSession.markerManagement.save(scope, { ...restore, operation_id: randomUUID() });
			expect(restored.marker).toMatchObject({ active: true, revision: 4 });
			expect((await ownerTransport.changes(scope)).timeline_markers).toMatchObject({ entry_id: f.markersEntry, view_id: axis.view_id, catalog_revision: restored.catalog_revision });
			const cursor = await ownerStore.cursor(scope); await ownerSession.refresh();
			for (let i = 0; i < 100 && await ownerStore.cursor(scope) === cursor; i++) await new Promise(resolve => setTimeout(resolve, 2));
			expect(await ownerStore.cursor(scope)).not.toBe(cursor);
			expect((await ownerSession.readTimelineMarkerMetadata(scope)).catalog.markers.find(marker => marker.id === markerId)?.revision).toBe(4);
			const reads = catalogReads; await ownerSession.readTimelineMarkerMetadata(scope); expect(catalogReads).toBe(reads);
			// Base-wide management sees a marker even when the destination view
			// has never held it. Adding an explicit checked placement preserves
			// the original one and never rewrites a captured discussion target.
			const destination = snapshot.views[index + 2].id!, destinationScope = baseDiscussionScope(f.markersEntry, destination);
			expect((await ownerTransport.timelineMarkers(destinationScope, destination)).markers).toEqual([]);
			const inventory = await ownerSession.readTimelineMarkerInventory(scope);
			expect(inventory.markers.find(marker => marker.id === markerId)).toMatchObject({ revision: 4, active: true });
			const detail = await ownerSession.readTimelineMarkerDetail(scope, markerId);
			const otherAxis = await ownerSession.readTimelineMarkerPlacementAxis(scope, destination, snapshot.revision);
			const result = await ownerSession.markerManagement.state(scope); expect(result?.status).toBe("accepted");
			expect(await ownerSession.markerManagement.acknowledge(scope, result!.request.operation_id)).toBe(true);
			const placed = await ownerSession.markerManagement.save(scope, { ...put, operation_id: randomUUID(), expected_catalog_revision: inventory.catalog_revision,
				command: { type: "marker.put", marker_id: markerId, expected_marker_revision: detail.marker.revision, content: detail.marker.content,
					placements: [...detail.marker.placements.filter(p => p.active).map(({ view_id, axis_definition_id, axis_definition_revision }) => ({ view_id, axis_definition_id, axis_definition_revision })),
						{ view_id: destination, axis_definition_id: otherAxis.axis.id, axis_definition_revision: otherAxis.axis.revision }] } });
			expect(placed.marker.revision).toBe(5); expect(placed.marker.placements.filter(p => p.active).map(p => p.view_id).sort()).toEqual([axis.view_id, destination].sort());
			expect((await ownerTransport.timelineMarkers(destinationScope, destination)).markers[0]).toMatchObject({ id: markerId, revision: 5, content: detail.marker.content });
			expect((await transport.thread(scope, queued.payload.thread_id)).anchor).toEqual(captured);
		} finally { outbox?.stop(); await outbox?.settled(); await session.close(); await ownerSession.close(); }
	}
	expect((await content.read(f.markersEntry)).state).toEqual(saved.state);
}, 25000);
