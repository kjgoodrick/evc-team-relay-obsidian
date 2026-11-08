import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BaseSyncRunner, type BaseSyncAccess, type BaseSyncLock } from "../../src/bases/BaseSyncRunner";
import { BaseSyncStore } from "../../src/bases/BaseSyncStore";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseRegistryTransport } from "../../src/bases/BaseRegistryTransport";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { parseTimelineMarkerCommand } from "../../src/collaboration/TimelineMarkerManagementProtocol";
import { protocolJson } from "../../src/collaboration/DiscussionProtocol";

Object.assign(globalThis, { IDBKeyRange });
const fixturePath = process.env.EVC_BASE_CONTENT_FIXTURE;
const run = fixturePath && JSON.parse(readFileSync(fixturePath, "utf8")).restoreGeneration ? test : test.skip;

run("a restored marker session retains the original request across lost HTTP responses and refuses legacy retries", async () => {
	const f = JSON.parse(readFileSync(fixturePath!, "utf8")) as Record<string, string>;
	if (new URL(f.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const identity = { serverId: f.base, accountId: f.owner, shareId: f.share, vaultId: randomUUID() };
	const credentials = async () => ({ accountId: f.owner, accessToken: f.ownerToken });
	const content = new BaseContentTransport(identity, credentials, fetch), registry = new BaseRegistryTransport(identity, credentials, fetch);
	const before = await content.read(f.markersEntry);
	await content.publish(f.markersEntry, { operationId: randomUUID(), expected: before.state, restoreGeneration: before.restoreContext?.generation, bytes: new TextEncoder().encode(JSON.stringify({ views: [
		{ name: "Timeline", type: "sabidurian-timeline", startDateProp: "note.start", timeZone: "America/Denver" },
	] })).buffer as ArrayBuffer });
	const saved = await content.read(f.markersEntry), snapshot = await registry.inspect(f.markersEntry, saved.state.record.hash!, saved.state.generation!);
	const scope = baseDiscussionScope(f.markersEntry, snapshot.views[0].id!);
	const requests: { body: string; generation: string | null }[] = []; let lose = true;
	const transport = new DiscussionTransport(identity, credentials, async (url, init) => {
		const response = await fetch(url, init);
		if (String(url).endsWith("/timeline-markers/commands")) {
			requests.push({ body: String(init?.body), generation: new Headers(init?.headers).get("X-Relay-Restore-Generation") });
			if (lose && response.ok) { lose = false; await response.text(); throw new TypeError("Synthetic lost marker acknowledgment"); }
		}
		return response;
	});
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory), session = new DiscussionSession(store, transport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		expect(session.canManageTimelineMarkers).toBe(true); expect(session.restoreBinding).toEqual({ restoreGeneration: f.restoreGeneration });
		const axis = await session.readTimelineAxis(scope), catalog = await session.readTimelineMarkers(scope);
		const command = parseTimelineMarkerCommand({ operation_id: randomUUID(), definition_id: catalog.definition_id, generation: catalog.generation,
			registry_revision: catalog.registry_revision, expected_catalog_revision: catalog.catalog_revision,
			command: { type: "marker.put", marker_id: randomUUID(), expected_marker_revision: 0,
				content: { kind: "point", label: "Restored timeline fixture", color: "#123456", range: { version: 1, kind: "calendar", start: "2026-12-01", end: "2026-12-01", start_inclusive: true, end_inclusive: true, time_zone: "America/Denver" } },
				placements: [{ view_id: axis.view_id, axis_definition_id: axis.axis.id, axis_definition_revision: axis.axis.revision }] } });
		await expect(session.markerManagement.save(scope, command)).rejects.toThrow();
		expect(await session.markerManagement.state(scope)).toMatchObject({ status: "pending", restoreGeneration: f.restoreGeneration });
		await session.close(); store = await DiscussionStore.open(identity, factory); session = new DiscussionSession(store, transport);
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const receipt = await session.markerManagement.retry(scope);
		expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(requests[0].generation).toBe(f.restoreGeneration);
		expect(receipt.marker.revision).toBe(1); expect(receipt.catalog_revision).toBe(1);
		expect(await session.markerManagement.state(scope)).toMatchObject({ status: "accepted", restoreGeneration: f.restoreGeneration });
		await expect(transport.manageTimelineMarker(scope, command)).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect((await transport.timelineMarker(scope, command.command.marker_id)).marker.revision).toBe(1);
		expect(await transport.manageTimelineMarker(scope, command, session.restoreBinding)).toEqual(receipt);
		// Represent an older device's pending slot in this disposable store. Its
		// original NULL binding must survive receipt inspection on the restored server.
		const key = "timelineMarkerCommand:" + f.markersEntry;
		await store.setPreference(key, protocolJson({ version: 1, scope_id: scope, request: command, status: "pending" }));
		const sent = requests.length;
		expect(await session.markerManagement.state(scope)).toMatchObject({ status: "pending", error: "restore_generation_changed" });
		expect(await session.markerManagement.check(scope)).toEqual({ status: "accepted", result: receipt });
		expect(requests).toHaveLength(sent);
		expect(await session.markerManagement.state(scope)).not.toHaveProperty("restoreGeneration");
		expect(await session.markerManagement.acknowledge(scope, command.operation_id)).toBe(true);
		const unknown = { ...command, operation_id: randomUUID() };
		const pending = protocolJson({ version: 1, scope_id: scope, request: unknown, status: "pending" });
		await store.setPreference(key, pending);
		expect(await session.markerManagement.check(scope)).toEqual({ status: "unknown" });
		expect(await store.preference(key)).toEqual(pending); expect(requests).toHaveLength(sent);
	} finally { await session.close(); }
}, 15000);


run("restored Bases synchronization requires review, preserves lost-save bindings and refuses older pending work", async () => {
	const f = JSON.parse(readFileSync(fixturePath!, "utf8")) as Record<string, string>;
	if (new URL(f.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const identity = { serverId: f.base, accountId: f.owner, shareId: f.share, vaultId: randomUUID() };
	const requests: { method: string; body: string; generation: string | null }[] = []; let lose = true;
	const transport = new BaseContentTransport(identity, async () => ({ accountId: f.owner, accessToken: f.ownerToken }), async (url, init) => {
		const response = await fetch(url, init);
		if (init.method === "PUT") {
			requests.push({ method: init.method, body: String(init.body), generation: new Headers(init.headers).get("X-Relay-Restore-Generation") });
			if (lose && response.ok) { lose = false; await response.text(); throw new Error("Synthetic lost Bases acknowledgment"); }
		}
		return response;
	});
	const factory = new IDBFactory(); let store = await BaseSyncStore.open(identity, factory);
	let oldStore: BaseSyncStore | undefined;
	const disk = new TextEncoder().encode("views: []\n# reviewed restored copy").buffer as ArrayBuffer;
	const lock: BaseSyncLock = async (_entry, work) => work();
	const access: BaseSyncAccess = { path: "Planning.base", current: () => true, writable: () => true, canInitialize: true,
		read: async () => ({ bytes: disk, identity: "fixture-file" }), replace: async () => { throw new Error("No native write expected"); } };
	try {
		let runner = new BaseSyncRunner(store, transport, lock);
		expect(await runner.sync(f.entry, access)).toBe("conflict"); expect(requests).toHaveLength(0);
		const review = (await runner.review(f.entry, access))!;
		await expect(runner.resolve(f.entry, access, review, "local")).rejects.toMatchObject({ action: "retry" });
		const pending = (await store.get(f.entry)).pending!; expect(pending.restoreGeneration).toBe(f.restoreGeneration);
		store.close(); store = await BaseSyncStore.open(identity, factory); runner = new BaseSyncRunner(store, transport, lock);
		expect(await runner.sync(f.entry, access)).toBe("synced");
		expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(requests[0].generation).toBe(f.restoreGeneration);
		expect((await store.get(f.entry)).baseline?.restoreContext?.generation).toBe(f.restoreGeneration);
		const current = await transport.read(f.entry);
		oldStore = await BaseSyncStore.open({ ...identity, vaultId: randomUUID() }, factory);
		const old = await oldStore.stage(f.entry, 0, current.state, disk);
		const oldRunner = new BaseSyncRunner(oldStore, transport, lock);
		await expect(oldRunner.sync(f.entry, access)).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect(requests).toHaveLength(2); expect((await oldStore.get(f.entry)).pending).toEqual(old);
		expect((await oldRunner.checkStatus(f.entry, access)).status).toBe("unknown");
		await expect(transport.publish(f.entry, old)).rejects.toMatchObject({ code: "restore_generation_changed" });
		await expect(transport.withdraw(f.entry, old)).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect(await transport.read(f.entry)).toEqual(current);
		expect((await transport.status(f.entry, { ...pending, restoreGeneration: null })).status).toBe("accepted");
	} finally { store.close(); oldStore?.close(); }
}, 15000);
