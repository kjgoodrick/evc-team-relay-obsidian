import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionFailure, DiscussionTransport, queuedEnvelope } from "../../src/collaboration/DiscussionTransport";
import { baseDiscussionScope, parseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
import { parseTimelineMarkerCatalog } from "../../src/collaboration/TimelineMarkerProtocol";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "base-session" };
const scope = baseDiscussionScope(id(3), id(4)), other = baseDiscussionScope(id(3), id(5));
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1)); expect(check()).toBe(true); }
function remote() {
	return { identity, capabilities: jest.fn().mockResolvedValue({ discussions: true, baseTargets: ["view", "item", "cell", "property"], baseRecordTypes: ["markdown", "image", "file"] }),
		baseTargetContext: jest.fn().mockImplementation(async (key: string, view: string, record?: string) => ({ protocol_version: 1,
			entry_id: parseDiscussionScope(key)!.entryId, view_id: view, definition_id: id(6), generation: id(7), registry_revision: 1,
			...(record ? { record_id: record, record_generation: id(8) } : {}) })),
		permissions: jest.fn().mockResolvedValue({ read: true, comment: true, edit: false, moderate: false }),
		participants: jest.fn().mockResolvedValue({ participants: [], hasMore: false }),
		changes: jest.fn().mockResolvedValue({ events: [], cursor: "current", has_more: false }),
		send: jest.fn(),
	};
}
const op = (scopeId: string, anchor: unknown, operationId = id(10)) => ({ operationId, scopeId, type: "thread.create" as const,
	dependsOn: [], payload: { type: "thread.create", thread_id: id(11), message_id: id(12), anchor: protocolJson(anchor), body: protocolJson(bodyFromText("Saved")) } });

test("saved-view local scopes preserve independent drafts, contexts and pending work across offline restart", async () => {
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory);
	const transport = remote(); let session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); session.watch(other, () => {}, "base"); await session.refresh();
		expect(session.canAnchorBaseRecord("image")).toBe(true); expect(session.canAnchorBaseRecord("folder")).toBe(false);
		const first = await session.captureBaseTarget(scope, { type: "cell", recordId: id(9), property: { source: "note", name: "status" } });
		const second = await session.captureBaseTarget(other, { type: "view" });
		expect(first.view_id).toBe(id(4)); expect(second.view_id).toBe(id(5));
		session.setForeground(false); await session.outbox.settled();
		await store.saveDraft({ id: "selection:" + scope + ":draft", scopeId: scope, revision: 1, body: "Unsent", target: protocolJson(first) });
		await session.queue(op(other, second));
		await expect(session.queue(op(other, first, id(13)))).rejects.toThrow("invalid_local_anchor");
		await session.close();
		store = await DiscussionStore.open(identity, factory);
		transport.capabilities.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		transport.permissions.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		transport.baseTargetContext.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		transport.changes.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		transport.send.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
		await session.start(); session.watch(scope, () => {}, "base"); session.watch(other, () => {}, "base"); await session.refresh();
		expect(session.canAnchorBaseRecord("image")).toBe(true); expect(session.canAnchorBaseRecord("audio")).toBe(false);
		expect(await session.captureBaseTarget(scope, { type: "cell", recordId: id(9), property: { source: "note", name: "status" } })).toEqual(first);
		await expect(session.captureBaseTarget(other, { type: "cell", recordId: id(9), property: { source: "note", name: "status" } })).rejects.toThrow("Connect once");
		expect((await store.selectionDrafts(scope)).drafts).toHaveLength(1);
		expect((await store.selectionDrafts(other)).drafts).toHaveLength(0);
		expect(await store.pending(scope)).toHaveLength(0); expect(await store.pending(other)).toHaveLength(1);
		const picture = await prepareLocalPicture(id(14), scope, new Uint8Array([1, 2, 3]).buffer);
		expect(picture.scopeId).toBe(scope);
	} finally { await session.close(); }
});

test("a server downgrade replaces cached record capabilities while keeping existing work", async () => {
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory);
	const transport = remote(); let session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); expect(session.canAnchorBaseRecord("image")).toBe(true);
		await store.saveDraft({ id: "kept", scopeId: scope, revision: 1, body: "Keep this" }); await session.close();
		store = await DiscussionStore.open(identity, factory); session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
		transport.capabilities.mockResolvedValue({ discussions: true, baseTargets: ["view", "item", "cell", "property"] });
		await session.start();
		expect(session.canAnchorBaseRecord("image")).toBe(false); expect(session.canAnchorBaseRecord("markdown")).toBe(true);
		expect((await store.getDraft("kept"))?.body).toBe("Keep this");
	} finally { await session.close(); }
});

test("read-only reviewers retain verified record navigation through an offline restart without gaining comment permission", async () => {
	const factory = new IDBFactory(), transport = remote(); let store = await DiscussionStore.open(identity, factory);
	transport.permissions.mockResolvedValue({ read: true, comment: false, edit: false, moderate: false });
	let session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const context = await session.readBaseContext(scope, id(9));
		expect(context).toMatchObject({ view_id: id(4), record_id: id(9), record_generation: id(8) });
		await expect(session.captureBaseTarget(scope, { type: "item", recordId: id(9) })).rejects.toThrow("comment permission");
		await session.close(); store = await DiscussionStore.open(identity, factory);
		for (const call of [transport.capabilities, transport.permissions, transport.baseTargetContext, transport.changes]) call.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		transport.baseTargetContext.mockClear();
		expect(await session.readBaseContext(scope, id(9))).toEqual(context);
		await expect(session.readBaseContext(scope, id(10))).rejects.toThrow("Connect to verify");
		expect(transport.baseTargetContext).not.toHaveBeenCalled();
		expect(await store.preference("baseRecordComment:" + scope + ":" + id(9))).toBeUndefined();
	} finally { await session.close(); }
});

test("an offline pane restores cached authority without waiting for a pending network refresh", async () => {
	const factory = new IDBFactory(), transport = remote(); let store = await DiscussionStore.open(identity, factory);
	let session = new DiscussionSession(store, transport as unknown as DiscussionTransport), release: (() => void) | undefined;
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh(); await session.close();
		store = await DiscussionStore.open(identity, factory);
		transport.capabilities.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		transport.permissions.mockImplementation(() => new Promise((_, reject) => { release = () => reject(new DiscussionFailure("retry", "network_unavailable")); }));
		transport.baseTargetContext.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		transport.changes.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		session = new DiscussionSession(store, transport as unknown as DiscussionTransport); await session.start();
		session.watch(scope, () => {}, "base"); await session.scopeReady(scope);
		expect(session.permission(scope)?.read).toBe(true); expect(session.knownDocumentGeneration(scope)).toBe(id(7));
		expect(release).toBeDefined();
	} finally { release?.(); await session.close(); }
});

test("a read-side record denial invalidates cached navigation and cannot become offline authority", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = remote();
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		await session.readBaseContext(scope, id(9));
		transport.baseTargetContext.mockRejectedValue(new DiscussionFailure("reject", "record_forbidden", 403));
		await expect(session.readBaseContext(scope, id(9))).rejects.toMatchObject({ code: "record_forbidden" });
		transport.baseTargetContext.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		await expect(session.readBaseContext(scope, id(9))).rejects.toThrow("Connect to verify");
	} finally { await session.close(); }
});

test("read-side navigation refuses generation changes and a reply arriving after local revocation", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = remote();
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const context = await session.readBaseContext(scope, id(9));
		transport.baseTargetContext.mockResolvedValue({ ...context, generation: id(90) });
		await expect(session.readBaseContext(scope, id(9))).rejects.toThrow("Saved view changed");
		let finish!: (value: typeof context) => void;
		transport.baseTargetContext.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
		const pending = session.readBaseContext(scope, id(9));
		const assertion = expect(pending).rejects.toThrow();
		await until(() => !!finish);
		transport.permissions.mockResolvedValue({ read: false, comment: false, edit: false, moderate: false });
		await session.refresh(); finish(context); await assertion;
		expect(session.knownDocumentGeneration(scope)).toBeUndefined();
	} finally { await session.close(); }
});

test.each(["success", "denial"])("an older window's %s cannot overwrite a newer verified record context", async result => {
	const factory = new IDBFactory(), remoteA = remote(), remoteB = remote();
	const storeA = await DiscussionStore.open(identity, factory), storeB = await DiscussionStore.open(identity, factory);
	const a = new DiscussionSession(storeA, remoteA as unknown as DiscussionTransport), b = new DiscussionSession(storeB, remoteB as unknown as DiscussionTransport);
	try {
		await a.start(); await b.start(); a.watch(scope, () => {}, "base"); b.watch(scope, () => {}, "base"); await a.refresh(); await b.refresh();
		const original = await a.readBaseContext(scope, id(9)); let finish!: () => void;
		remoteA.baseTargetContext.mockImplementation(() => new Promise((resolve, reject) => { finish = () => result === "success" ? resolve(original) : reject(new DiscussionFailure("reject", "record_forbidden", 403)); }));
		const pending = a.readBaseContext(scope, id(9)), assertion = expect(pending).rejects.toThrow(); await until(() => !!finish);
		remoteB.baseTargetContext.mockResolvedValue({ ...original, registry_revision: 2 });
		const newer = await b.readBaseContext(scope, id(9)); finish(); await assertion;
		expect(await storeA.preference("baseContext:" + scope + ":" + id(9))).toEqual(newer);
		remoteA.baseTargetContext.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		expect(await a.readBaseContext(scope, id(9))).toEqual(newer);
	} finally { await a.close(); await b.close(); }
});

test("coalesced readers cannot repopulate a record context after a remote snapshot reset", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = remote();
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const context = await session.readBaseContext(scope, id(9)); let finish!: () => void;
		transport.baseTargetContext.mockClear().mockImplementation(() => new Promise(resolve => { finish = () => resolve(context); }));
		const first = session.readBaseContext(scope, id(9)), second = session.readBaseContext(scope, id(9));
		const assertions = [expect(first).rejects.toThrow("verification changed"), expect(second).rejects.toThrow("verification changed")];
		await until(() => !!finish); expect(transport.baseTargetContext).toHaveBeenCalledTimes(1);
		await store.clearRemoteScope(scope); finish(); await Promise.all(assertions);
	} finally { await session.close(); }
});

test("an older registry response is refused without erasing the newer offline context", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = remote();
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const original = await session.readBaseContext(scope, id(9));
		transport.baseTargetContext.mockResolvedValue({ ...original, registry_revision: 3 });
		const newer = await session.readBaseContext(scope, id(9)); transport.baseTargetContext.mockResolvedValue(original);
		await expect(session.readBaseContext(scope, id(9))).rejects.toThrow("association changed");
		transport.baseTargetContext.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		expect(await session.readBaseContext(scope, id(9))).toEqual(newer);
	} finally { await session.close(); }
});

test("known record-comment denial cannot be reused for offline capture or a new send", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = remote();
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const anchor = await session.captureBaseTarget(scope, { type: "item", recordId: id(9) });
		transport.permissions.mockResolvedValue({ read: true, comment: false, edit: false, moderate: false });
		await expect(session.captureBaseTarget(scope, { type: "item", recordId: id(9) })).rejects.toMatchObject({ code: "comment_forbidden" });
		session.setForeground(false); await session.outbox.settled();
		await expect(session.queue(op(scope, anchor))).rejects.toThrow("Comment permission");
		transport.baseTargetContext.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		await expect(session.captureBaseTarget(scope, { type: "item", recordId: id(9) })).rejects.toThrow("Connect once");
		expect(await store.pending(scope)).toHaveLength(0);
	} finally { await session.close(); }
});

test("scope encoding and HTTP routing never substitute a different view or a local path", async () => {
	expect(parseDiscussionScope(scope)).toEqual({ entryId: id(3), viewId: id(4) });
	for (const value of ["base:" + id(3), scope + ":extra", "base:Notes.base:" + id(4)]) expect(parseDiscussionScope(value)).toBeUndefined();
	const anchor = { version: 1, type: "base", definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1, target: { type: "view" } };
	expect(JSON.parse(queuedEnvelope(id(2), op(scope, anchor))).entry_id).toBe(id(3));
	expect(() => queuedEnvelope(id(2), op(other, anchor))).toThrow("invalid_local_anchor");
	expect(() => queuedEnvelope(id(2), op(scope, { type: "note", version: 1 }))).toThrow("invalid_local_anchor");
	const fetcher = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ events: [], cursor: "opaque", has_more: false, view_id: id(4), filtered: true })));
	const transport = new DiscussionTransport(identity, async () => ({ accountId: id(1), accessToken: "synthetic" }), fetcher);
	await transport.changes(scope);
	expect(fetcher.mock.calls[0][0]).toContain(`/entries/${id(3)}/changes?limit=25&view_id=${id(4)}`);
	await expect(transport.changes(scope, undefined, id(5))).rejects.toMatchObject({ code: "invalid_local_target" });
});

test.each([8, 9, 10, 11, 12, 13, 14, 15, 16, 17])("schema upgrade from %i preserves earlier work and fences earlier protocol workers", async version => {
	const factory = new IDBFactory(), name = "team-relay-discussions:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]);
	await new Promise<void>((resolve, reject) => {
		const open = factory.open(name, version);
		open.onupgradeneeded = () => {
			const db = open.result;
			const drafts = db.createObjectStore("drafts", { keyPath: "id" }); drafts.createIndex("scopeId", ["scopeId", "id"]);
			drafts.add({ id: "old-note", scopeId: id(20), revision: 1, body: "Keep this" });
			const outbox = db.createObjectStore("outbox", { keyPath: "operationId" });
			outbox.createIndex("state", "state"); outbox.createIndex("scope", "scopeId");
			outbox.createIndex("scopeState", ["scopeId", "state", "createdAt", "operationId"]); outbox.createIndex("dependency", "dependsOn", { multiEntry: true });
			const entities = db.createObjectStore("entities", { keyPath: ["scopeId", "id"] }); entities.createIndex("scope", "scopeId"); entities.createIndex("ordered", ["scopeId", "collection", "position"]);
			for (const key of ["cursors", "generations", "preferences"]) db.createObjectStore(key);
			db.createObjectStore("pictureSources", { keyPath: "id" }).createIndex("scope", "scopeId");
			const refs = db.createObjectStore("pictureReferences", { keyPath: ["pictureId", "kind", "ownerId"] }); refs.createIndex("owner", ["kind", "ownerId"]); refs.createIndex("picture", "pictureId");
			const cache = db.createObjectStore("pictureCache", { keyPath: ["scopeId", "id", "variant"] }); cache.createIndex("scope", "scopeId"); cache.createIndex("usedAt", "usedAt");
		};
		open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error);
	});
	const store = await DiscussionStore.open(identity, factory);
	expect((await store.getDraft("old-note"))?.body).toBe("Keep this"); store.close();
	await expect(new Promise((resolve, reject) => { const open = factory.open(name, version); open.onsuccess = () => { open.result.close(); resolve(undefined); }; open.onerror = () => reject(open.error); }))
		.rejects.toMatchObject({ name: "VersionError" });
});

const rangeContext = () => ({ protocol_version: 1 as const, entry_id: id(3), view_id: id(4), definition_id: id(6), generation: id(7), registry_revision: 1,
	axis: { id: id(60), kind: "axis" as const, revision: 1, fingerprint: "a".repeat(64), axis: { version: 1 as const, renderer: "sabidurian-sequence" as const,
		start_property: { source: "note" as const, name: "order" }, end_property: null, time_zone: null } } });
const ordinalRange = { version: 1 as const, kind: "ordinal" as const, start: "1", end: "5", start_inclusive: true, end_inclusive: false, unit: "property-value" as const };
function rangeRemote() {
	const transport = { ...remote(), timelineAxis: jest.fn().mockResolvedValue(rangeContext()) };
	transport.capabilities.mockResolvedValue({ discussions: true, baseTargets: ["view", "timeline_range"], baseRecordTypes: ["markdown"] });
	return transport;
}

test("range capture uses verified axis identity, retains offline drafts and queues after reopen", async () => {
	const factory = new IDBFactory(), transport = rangeRemote(); let store = await DiscussionStore.open(identity, factory);
	let session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const selected = await session.readTimelineAxis(scope), captured = await session.captureTimelineRange(scope, selected, ordinalRange);
		session.setForeground(false); await session.outbox.settled();
		await store.saveDraft({ id: "range", scopeId: scope, revision: 1, body: "Kept", target: protocolJson(captured) });
		await session.close(); store = await DiscussionStore.open(identity, factory);
		for (const method of [transport.capabilities, transport.permissions, transport.baseTargetContext, transport.timelineAxis, transport.changes, transport.send]) method.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh(); session.setForeground(false); await session.outbox.settled();
		expect(await session.captureTimelineRange(scope, selected, ordinalRange)).toEqual(captured);
		await session.queue(op(scope, captured), { id: "range", revision: 1 });
		expect(await store.getDraft("range")).toBeUndefined(); expect(await store.pending(scope)).toHaveLength(1);
	} finally { await session.close(); }
});

test("axis changes and authoritative denials cannot be replaced by an old cached range context", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = rangeRemote();
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const selected = await session.readTimelineAxis(scope);
		transport.baseTargetContext.mockImplementation(async () => ({ ...rangeContext(), registry_revision: 2 }));
		transport.timelineAxis.mockResolvedValue({ ...rangeContext(), registry_revision: 2, axis: { ...rangeContext().axis, revision: 2 } });
		await expect(session.captureTimelineRange(scope, selected, ordinalRange)).rejects.toThrow("axis changed");
		transport.timelineAxis.mockRejectedValue(new DiscussionFailure("reject", "target_unavailable", 404));
		await expect(session.readTimelineAxis(scope)).rejects.toMatchObject({ code: "target_unavailable" });
		transport.timelineAxis.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		await expect(session.readTimelineAxis(scope)).rejects.toThrow("Connect to verify");
	} finally { await session.close(); }
});

function markerCatalog() {
	const { axis, ...context } = rangeContext(), content = { kind: "range", label: "Release", color: "#123abc", range: ordinalRange };
	return parseTimelineMarkerCatalog({ ...context, catalog_revision: 1, markers: [{ id: id(61), revision: 1, active: true, content,
		placement: { view_id: id(4), active: true, axis_definition_id: axis.id, axis_definition_revision: 1, axis: axis.axis },
		target: { type: "timeline_marker", marker_id: id(61), marker_revision: 1, content, axis_definition_id: axis.id, axis_definition_revision: 1, axis: axis.axis } }] }, id(3), id(4));
}
function markerRemote() {
	const transport = { ...rangeRemote(), timelineMarkers: jest.fn().mockImplementation(async () => markerCatalog()) };
	transport.capabilities.mockResolvedValue({ discussions: true, baseTargets: ["view", "timeline_range", "timeline_marker"], baseRecordTypes: ["markdown"] });
	return transport;
}

test("active discussion hints refresh changed markers without refetching unchanged axis or catalog metadata", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = markerRemote(), session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	const hint = (catalog = markerCatalog()) => { const { markers: _markers, ...version } = catalog; return version; };
	const poll = async (cursor: string, timeline_markers = hint()) => {
		transport.changes.mockResolvedValue({ events: [], cursor, has_more: false, view_id: id(4), filtered: true, timeline_markers });
		await session.refresh();
		for (let i = 0; i < 100 && await store.cursor(scope) !== cursor; i++) await new Promise(resolve => setTimeout(resolve, 1));
		expect(await store.cursor(scope)).toBe(cursor);
	};
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await poll("markers-1");
		expect((await session.readTimelineMarkerMetadata(scope)).catalog.catalog_revision).toBe(1);
		const axes = transport.timelineAxis.mock.calls.length, catalogs = transport.timelineMarkers.mock.calls.length;
		await poll("markers-same"); await session.readTimelineMarkerMetadata(scope);
		expect(transport.timelineAxis).toHaveBeenCalledTimes(axes); expect(transport.timelineMarkers).toHaveBeenCalledTimes(catalogs);
		const changed = markerCatalog(); changed.catalog_revision = 2; changed.markers[0].revision = 2; changed.markers[0].target.marker_revision = 2;
		changed.markers[0].content.label = "Moved release"; changed.markers[0].target.content.label = "Moved release";
		transport.timelineMarkers.mockResolvedValue(changed); await poll("markers-2", hint(changed));
		expect((await session.readTimelineMarkerMetadata(scope)).catalog.markers[0].content.label).toBe("Moved release");
		expect(transport.timelineAxis).toHaveBeenCalledTimes(axes); expect(transport.timelineMarkers).toHaveBeenCalledTimes(catalogs + 1);
		await poll("markers-old", hint()); await session.readTimelineMarkerMetadata(scope);
		expect(transport.timelineMarkers).toHaveBeenCalledTimes(catalogs + 1);
		await store.clearRemoteScope(scope);
		transport.timelineMarkers.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		await expect(session.readTimelineMarkerMetadata(scope)).rejects.toThrow();
	} finally { await session.close(); }
});

test("legacy marker observation reuses proof for fifteen seconds and never caches a denied replacement", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = markerRemote(), session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	const now = Date.now();
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		await session.readTimelineMarkerMetadata(scope); const calls = transport.timelineMarkers.mock.calls.length;
		await session.readTimelineMarkerMetadata(scope); expect(transport.timelineMarkers).toHaveBeenCalledTimes(calls);
		jest.spyOn(Date, "now").mockReturnValue(now + 16000);
		transport.timelineMarkers.mockRejectedValue(new DiscussionFailure("reject", "target_unavailable", 404));
		await expect(session.readTimelineMarkerMetadata(scope)).rejects.toMatchObject({ status: 404 });
		expect(await store.preference("timelineMarkers:" + scope)).toBeNull();
	} finally { jest.restoreAllMocks(); await session.close(); }
});

test("marker metadata rechecks access after its final asynchronous cache fence", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = markerRemote(), session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	let complete: (() => void) | undefined;
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh(); await session.readTimelineMarkerMetadata(scope);
		session.setForeground(false); await session.outbox.settled();
		const checkpoint = store.checkpoint.bind(store);
		jest.spyOn(store, "checkpoint").mockImplementationOnce(checkpoint).mockImplementationOnce(async id => {
			const result = await checkpoint(id); await new Promise<void>(resolve => { complete = resolve; }); return result;
		});
		const read = session.readTimelineMarkerMetadata(scope); await until(() => !!complete);
		jest.spyOn(session, "permission").mockReturnValue({ read: false, comment: false, edit: false, moderate: false });
		complete!(); await expect(read).rejects.toThrow("verification changed");
	} finally { complete?.(); jest.restoreAllMocks(); await session.close(); }
});
test("verified marker selections remain exact through offline restart, draft consumption and queued delivery", async () => {
	const factory = new IDBFactory(), transport = markerRemote(); let store = await DiscussionStore.open(identity, factory);
	let session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const selected = await session.readTimelineMarkers(scope), captured = await session.captureTimelineMarker(scope, selected, id(61));
		expect(captured.target).toMatchObject({ type: "timeline_marker", marker_id: id(61), marker_revision: 1 });
		session.setForeground(false); await session.outbox.settled();
		await store.saveDraft({ id: "marker", scopeId: scope, revision: 1, body: "Kept", target: protocolJson(captured) });
		await session.close(); store = await DiscussionStore.open(identity, factory);
		for (const method of [transport.capabilities, transport.permissions, transport.baseTargetContext, transport.timelineAxis, transport.timelineMarkers, transport.changes, transport.send]) method.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh(); session.setForeground(false); await session.outbox.settled();
		expect(await session.captureTimelineMarker(scope, selected, id(61))).toEqual(captured);
		await session.queue(op(scope, captured), { id: "marker", revision: 1 });
		expect(await store.getDraft("marker")).toBeUndefined();
		expect(JSON.parse(queuedEnvelope(identity.shareId, (await store.pending(scope))[0])).command.anchor).toEqual(captured);
		await expect(session.captureTimelineMarker(other, selected, id(61))).rejects.toThrow();
		const isolated = await DiscussionStore.open({ ...identity, accountId: id(99) }, factory);
		try { expect(await isolated.preference("timelineMarkers:" + scope)).toBeUndefined(); expect(await isolated.pending(scope)).toEqual([]); } finally { isolated.close(); }
	} finally { await session.close(); }
});

test.each(["edit", "archive", "detach", "axis"])("new marker capture refuses %s without changing saved drafts or historical targets", async change => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = markerRemote(), session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const selected = await session.readTimelineMarkers(scope), anchor = await session.captureTimelineMarker(scope, selected, id(61));
		await store.saveDraft({ id: "marker", scopeId: scope, revision: 1, body: "Original", target: protocolJson(anchor) });
		const newer = markerCatalog(), marker = newer.markers[0]; newer.catalog_revision = 2; marker.revision = 2; marker.target.marker_revision = 2;
		if (change === "edit") { marker.content.label = "Moved"; marker.target.content.label = "Moved"; }
		if (change === "archive") marker.active = false;
		if (change === "detach") marker.placement.active = false;
		if (change === "axis") transport.timelineAxis.mockResolvedValue({ ...rangeContext(), registry_revision: 2, axis: { ...rangeContext().axis, revision: 2 } });
		transport.timelineMarkers.mockResolvedValue(newer);
		await expect(session.captureTimelineMarker(scope, selected, id(61))).rejects.toThrow("changed");
		expect((await store.getDraft("marker"))?.target).toEqual(anchor);
		expect(await session.baseDefinitionStatus(scope, anchor)).toContain(change === "archive" || change === "detach" ? "archived" : "changed");
		expect(anchor.target).toMatchObject({ marker_revision: 1, content: { label: "Release" } });
	} finally { await session.close(); }
});

test("marker cache cannot mask denial or malformed responses and never grants a reader comment access", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = markerRemote(), session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		const selected = await session.readTimelineMarkers(scope);
		transport.timelineMarkers.mockRejectedValue(new DiscussionFailure("reject", "target_unavailable", 404));
		await expect(session.readTimelineMarkers(scope)).rejects.toMatchObject({ code: "target_unavailable" });
		transport.timelineMarkers.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		await expect(session.readTimelineMarkers(scope)).rejects.toThrow("Connect to verify");
		transport.timelineMarkers.mockResolvedValue(markerCatalog()); await session.readTimelineMarkers(scope);
		transport.timelineMarkers.mockResolvedValue({ ...markerCatalog(), generation: "malformed" });
		await expect(session.readTimelineMarkers(scope)).rejects.toThrow();
		transport.timelineMarkers.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		await expect(session.readTimelineMarkers(scope)).rejects.toThrow("Connect to verify");
		transport.timelineMarkers.mockResolvedValue(markerCatalog()); await session.readTimelineMarkers(scope);
		transport.timelineMarkers.mockResolvedValue({ ...markerCatalog(), generation: id(99) });
		await expect(session.readTimelineMarkers(scope)).rejects.toThrow("changed during marker verification");
		transport.timelineMarkers.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		await expect(session.readTimelineMarkers(scope)).rejects.toThrow("Connect to verify");
		transport.permissions.mockResolvedValue({ read: true, comment: false, edit: false, moderate: false }); await session.refresh();
		await expect(session.captureTimelineMarker(scope, selected, id(61))).rejects.toThrow("comment permission");
	} finally { await session.close(); }
});

test("a response arriving after remote-cache revocation cannot repopulate marker proof", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = markerRemote(), session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(scope, () => {}, "base"); await session.refresh();
		let complete!: (value: ReturnType<typeof markerCatalog>) => void;
		transport.timelineMarkers.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
		const flight = session.readTimelineMarkers(scope);
		await until(() => !!complete); await store.clearRemoteScope(scope); complete(markerCatalog());
		await expect(flight).rejects.toThrow("verification changed");
		expect(await store.preference("timelineMarkers:" + scope)).toBeUndefined();
	} finally { await session.close(); }
});
