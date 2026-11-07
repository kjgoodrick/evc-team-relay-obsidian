import type { TFile } from "obsidian";
import { NativeBaseGroupComments } from "../../src/collaboration/NativeBaseGroupComments";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import type { BaseCommentContext } from "../../src/collaboration/BaseCommentContext";
import type { NativeBaseGroupHandle } from "../../src/bases/NativeBasesSurface";
import { retainedBaseGroupSources } from "../../src/collaboration/RetainedBaseGroupSources";
import { LocalDocumentStore } from "../../src/storage/local-document-store";
import { DiscussionDelivery } from "../../src/collaboration/DiscussionDelivery";
import { prepareBaseGroupCommand } from "../../src/collaboration/LocalDiscussionAnchor";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { YSweetProvider } from "../../src/client/provider";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseRegistryTransport } from "../../src/bases/BaseRegistryTransport";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { bodyFromText, protocolJson, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import type { BaseGroupCapture } from "../../src/collaboration/BaseGroupProtocol";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
Object.assign(globalThis, { IDBKeyRange });
const run = process.env.EVC_BASE_GROUP_FIXTURE ? test : test.skip;
async function until(check: () => boolean, label: string) {
	const deadline = Date.now() + 12000;
	while (!check()) { if (Date.now() >= deadline) throw new Error("Timed out: " + label); await new Promise(resolve => setTimeout(resolve, 25)); }
}

run("actual group capture verifies delete-only dependencies, exact recovery, source permissions and relay restart", async () => {
	const f = JSON.parse(readFileSync(process.env.EVC_BASE_GROUP_FIXTURE!, "utf8"));
	for (const url of [f.base, f.relay]) expect(new URL(url).hostname).toBe("127.0.0.1");
	const identity = { serverId: f.base, accountId: f.bobId, shareId: f.share };
	const credential = async () => ({ accountId: f.bobId, accessToken: f.bobToken });
	const ownerIdentity = { ...identity, accountId: f.ownerId }, ownerCredential = async () => ({ accountId: f.ownerId, accessToken: f.ownerToken });
	const transport = new DiscussionTransport(identity, credential, fetch);
	const content = new BaseContentTransport(ownerIdentity, ownerCredential, fetch), registry = new BaseRegistryTransport(ownerIdentity, ownerCredential, fetch);
	const docs: Y.Doc[] = [], providers: YSweetProvider[] = [];
	const factory = new IDBFactory(), storeIdentity = { ...identity, vaultId: randomUUID() };
	const previousIndexedDB = globalThis.indexedDB, sourceFactory = new IDBFactory();
	Object.assign(globalThis, { indexedDB: sourceFactory });
	let store: DiscussionStore | undefined, captureSession: DiscussionSession | undefined;
	async function peer(token: string, mode: string) {
		const response = await fetch(f.base + "/v1/tokens/relay", { method: "POST", headers: {
			Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ share_id: f.share, doc_id: f.note, mode }) });
		expect(response.status).toBe(200); const auth = await response.json(), doc = new Y.Doc(); docs.push(doc);
		const provider = new YSweetProvider(auth.relay_url, f.note, doc, { connect: false, disableBc: true, params: { token: auth.token } });
		providers.push(provider); provider.connect(); await until(() => provider.synced, "peer sync");
		return { doc, provider, text: doc.getText("contents") };
	}
	try {
		const state = await content.read(f.baseEntry);
		await content.publish(f.baseEntry, { operationId: randomUUID(), expected: state.state, bytes: new TextEncoder().encode(JSON.stringify({
			views: [{ name: "Groups", type: "table", groupBy: { property: "status", direction: "ASC" } }],
		})).buffer as ArrayBuffer });
		const saved = await content.read(f.baseEntry), snapshot = await registry.inspect(f.baseEntry, saved.state.record.hash!, saved.state.generation!);
		const view = snapshot.views[0].id!, scope = baseDiscussionScope(f.baseEntry, view);
		expect((await transport.capabilities()).baseTargets).toContain("group");
		expect(await transport.permissions(scope)).toEqual({ read: true, comment: true, edit: false, moderate: false });
		const owner = await peer(f.ownerToken, "write"); owner.text.insert(0, "---\nstatus: DoneX\n---\nSynthetic body");
		const reviewer = await peer(f.bobToken, "read");
		await until(() => reviewer.text.toString() === owner.text.toString(), "reviewer receives metadata");
		const context = await transport.baseTargetContext(scope, view, f.note), catalog = await transport.baseDefinitions(scope, view);
		const definition = catalog.targets.find(item => item.kind === "group")!;
		const request = (doc: Y.Doc, value: string): BaseGroupCapture => ({ operation_id: randomUUID(), definition_id: context.definition_id,
			view_id: view, generation: context.generation, registry_revision: catalog.registry_revision,
			group_definition_id: definition.id, group_definition_revision: definition.revision,
			record_id: f.note, record_generation: context.record_generation!, time_zone: "UTC",
			dependency: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString("base64"), value: { type: "text", value } });
		const operation = (anchor: BaseAnchor): QueuedCommand => ({ operationId: randomUUID(), scopeId: scope, type: "thread.create", dependsOn: [], payload: {
			type: "thread.create", thread_id: randomUUID(), message_id: randomUUID(), anchor: protocolJson(anchor), body: protocolJson(bodyFromText("Review this group")) } });
		const first = await transport.captureBaseGroup(scope, request(reviewer.doc, "DoneX"));
		const historical = await transport.send(operation(first));
		owner.provider.disconnect(); owner.text.delete(owner.text.toString().indexOf("DoneX") + 4, 1);
		const pending = request(owner.doc, "Done");
		await expect(transport.captureBaseGroup(scope, pending)).rejects.toMatchObject({ action: "retry", code: "anchor_dependency_not_ready" });
		owner.provider.connect(); await until(() => owner.provider.synced && reviewer.text.toString() === owner.text.toString(), "deletion reaches relay");
		let lose = true;
		const lossy = new DiscussionTransport(identity, credential, async (url, options) => {
			const response = await fetch(url, options);
			if (lose && response.ok && String(url).endsWith("/group-targets")) { lose = false; await response.text(); throw new Error("Synthetic lost capture response"); }
			return response;
		});
		await expect(lossy.captureBaseGroup(scope, pending)).rejects.toMatchObject({ action: "retry", code: "network_unavailable" });
		const captured = await transport.captureBaseGroup(scope, pending);
		expect(await transport.captureBaseGroup(scope, pending)).toEqual(captured);
		if (first.target.type !== "group" || captured.target.type !== "group") throw new Error("Expected group anchors");
		expect(first.target.group_id).not.toBe(captured.target.group_id);
		store = await DiscussionStore.open(storeIdentity, factory);
		captureSession = new DiscussionSession(store, transport); await captureSession.start();
		captureSession.watch(scope, () => {}, "base"); await captureSession.refresh();
		captureSession.setForeground(false); await captureSession.outbox.settled();
		const file = { path: "Team/Note.md" } as TFile;
		const handle: NativeBaseGroupHandle = { target: { type: "group", property: definition.property, value: { type: "text", value: "Done" } },
			element: {} as HTMLElement, ambiguous: false, current: () => true, members: () => [file] };
		// Persist a read-only peer's actual relay history, close it, and capture
		// without a live document/provider. The same intent then survives both
		// capture and comment response loss through the ordinary outbox below.
		const cacheName = `retained-${randomUUID()}`, cacheDoc = new Y.Doc(), cache = new LocalDocumentStore(cacheName, cacheDoc);
		await cache.whenSynced; Y.applyUpdate(cacheDoc, Y.encodeStateAsUpdate(reviewer.doc)); await cache.rememberServerSync();
		await cache.close(); cacheDoc.destroy(); reviewer.provider.disconnect();
		const native = new NativeBaseGroupComments({ session: captureSession, entryId: scope, baseEntryId: f.baseEntry, current: () => true } as BaseCommentContext, catalog, {
			record: candidate => candidate === file ? { id: f.note, type: "markdown", path: "Note.md" } : undefined,
			file: id => id === f.note ? file : undefined, fileAtPath: path => path === file.path ? file : null,
			source: () => undefined, read: async () => owner.text.toString(), resolve: () => null,
			retained: (files, current) => retainedBaseGroupSources(files, { key: () => ({ name: cacheName, current: () => true }),
				read: async () => owner.text.toString() }, current, sourceFactory),
		});
		const localTarget = await native.capture(handle);
		expect(localTarget.capture.value).toEqual({ type: "text", value: "Done" });
		const op = operation(captured); op.type = "base.group.create";
		op.payload = { type: "base.group.create", thread_id: randomUUID(), message_id: randomUUID(),
			anchor: protocolJson(localTarget), body: protocolJson(bodyFromText("Created offline before group verification")) };
		await store.saveDraft({ id: "group", scopeId: scope, revision: 1, body: "Kept offline", target: protocolJson(localTarget) });
		await captureSession.queue(op, { id: "group", revision: 1 }); await captureSession.close(); captureSession = undefined;
		store = await DiscussionStore.open(storeIdentity, factory);
		expect(await store.getDraft("group")).toBeUndefined();
		expect((await store.pending(scope))[0].payload).toEqual(op.payload);
		let loseCapture = true, loseSend = true;
		const twoPhase = new DiscussionTransport(identity, credential, async (url, options) => {
			const response = await fetch(url, options);
			if (response.ok && (loseCapture && String(url).endsWith("/group-targets") || loseSend && String(url).endsWith("/commands"))) {
				if (String(url).endsWith("/group-targets")) loseCapture = false; else loseSend = false;
				await response.text(); throw new Error("Synthetic accepted response loss");
			}
			return response;
		});
		let intentAnchor: BaseAnchor | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			const leased = (await store.claimNext("offline-" + attempt))!;
			await expect(new DiscussionDelivery(store, twoPhase).send(leased)).rejects.toMatchObject({ action: "retry", code: "network_unavailable" });
			if (attempt) {
				intentAnchor = await transport.captureBaseGroup(scope, localTarget.capture);
				expect(intentAnchor.target).toMatchObject({ type: "group", group_id: captured.target.group_id, value: captured.target.value });
			}
			expect((await store.getOperation(op.operationId))?.preparedAnchor).toEqual(intentAnchor);
			await store.fail(op.operationId, leased.lease!, "network_unavailable", 0); store.close();
			store = await DiscussionStore.open(storeIdentity, factory);
		}
		const leased = (await store.claimNext("restarted"))!;
		const accepted = await new DiscussionDelivery(store, twoPhase).send(leased);
		if (!("thread_id" in accepted)) throw new Error("Expected discussion acceptance");
		await store.accept(op.operationId, protocolJson(accepted));
		expect((await store.getOperation(op.operationId))?.state).toBe("accepted");
		expect(await transport.send(prepareBaseGroupCommand(op, leased.preparedAnchor))).toEqual(accepted);

		expect((await transport.thread(scope, historical.thread_id)).anchor).toEqual(first);
		expect((await transport.thread(scope, accepted.thread_id)).anchor).toEqual(intentAnchor);
		await expect(transport.captureBaseGroup(scope, { ...pending, operation_id: randomUUID(), record_id: f.secret }))
			.rejects.toMatchObject({ action: "reject", code: "target_unavailable", status: 404 });
		for (const provider of providers) provider.destroy();
		writeFileSync(join(f.restartDir, "restart-request"), "restart");
		await until(() => existsSync(join(f.restartDir, "restart-done")), "relay restarts");
		const restored = await peer(f.bobToken, "read");
		expect(restored.text.toString()).toBe(owner.text.toString());
		const fresh = await transport.captureBaseGroup(scope, request(restored.doc, "Done"));
		expect(fresh.target).toEqual(captured.target);
		expect((await transport.send(operation(fresh))).message_revision).toBe(1);
		await expect(transport.captureBaseGroup(scope, { ...pending, operation_id: randomUUID(), record_generation: randomUUID() }))
			.rejects.toMatchObject({ action: "reject", code: "anchor_generation_mismatch" });

		// An attachment's file-property group has no note CRDT at all. Capture
		// only authoritative inventory evidence, then exercise the same durable
		// two-phase delivery with response loss and a reopened cache.
		const beforeFile = await content.read(f.baseEntry);
		await content.publish(f.baseEntry, { operationId: randomUUID(), expected: beforeFile.state, bytes: new TextEncoder().encode(JSON.stringify({
			views: [{ name: "Groups", type: "table", groupBy: { property: "file.ext", direction: "ASC" } }],
		})).buffer as ArrayBuffer });
		const fileState = await content.read(f.baseEntry), fileSnapshot = await registry.inspect(f.baseEntry, fileState.state.record.hash!, fileState.state.generation!);
		const fileView = fileSnapshot.views[0].id!, fileScope = baseDiscussionScope(f.baseEntry, fileView);
		captureSession = new DiscussionSession(store, transport); await captureSession.start(); captureSession.watch(fileScope, () => {}, "base");
		await captureSession.refresh(); captureSession.setForeground(false); await captureSession.outbox.settled();
		expect(captureSession.canAnchorBaseGroup({ source: "file", name: "ext" })).toBe(true);
		const fileCatalog = await captureSession.readBaseDefinitions(fileScope), imageFile = { path: "Team/chart.png" } as TFile;
		const fileHandle: NativeBaseGroupHandle = { target: { type: "group", property: { source: "file", name: "ext" }, value: { type: "text", value: "png" } },
			element: {} as HTMLElement, ambiguous: false, current: () => true, members: () => [imageFile] };
		const fileNative = new NativeBaseGroupComments({ session: captureSession, entryId: fileScope, baseEntryId: f.baseEntry, current: () => true } as BaseCommentContext, fileCatalog, {
			record: candidate => candidate === imageFile ? { id: f.image, type: "image", path: "chart.png" } : undefined,
			file: id => id === f.image ? imageFile : undefined, fileAtPath: path => path === imageFile.path ? imageFile : null,
			source: () => { throw new Error("File groups must not load a note"); }, read: async () => { throw new Error("File groups must not read content"); }, resolve: () => null,
		});
		const fileTarget = await fileNative.capture(fileHandle);
		expect(fileTarget.capture).toMatchObject({ source_kind: "file", record_id: f.image, value: { type: "text", value: "png" } });
		const fileOp: QueuedCommand = { operationId: randomUUID(), scopeId: fileScope, type: "base.group.create", dependsOn: [], payload: protocolJson({
			type: "base.group.create", thread_id: randomUUID(), message_id: randomUUID(), anchor: fileTarget, body: bodyFromText("An attachment group") }) };
		await captureSession.queue(fileOp); await captureSession.close(); captureSession = undefined;
		store = await DiscussionStore.open(storeIdentity, factory);
		let fileCaptureLoss = true, fileSendLoss = true;
		const fileTransport = new DiscussionTransport(identity, credential, async (url, options) => {
			const response = await fetch(url, options);
			if (response.ok && (fileCaptureLoss && String(url).endsWith("/group-targets") || fileSendLoss && String(url).endsWith("/commands"))) {
				if (String(url).endsWith("/group-targets")) fileCaptureLoss = false; else fileSendLoss = false;
				await response.text(); throw new Error("Lost accepted file-group response");
			}
			return response;
		});
		for (let attempt = 0; attempt < 2; attempt++) {
			const claimed = (await store.claimNext("file-" + attempt))!;
			await expect(new DiscussionDelivery(store, fileTransport).send(claimed)).rejects.toMatchObject({ action: "retry", code: "network_unavailable" });
			await store.fail(fileOp.operationId, claimed.lease!, "network_unavailable", 0); store.close(); store = await DiscussionStore.open(storeIdentity, factory);
		}
		const fileClaim = (await store.claimNext("file-reopened"))!, fileAccepted = await new DiscussionDelivery(store, fileTransport).send(fileClaim);
		if (!("thread_id" in fileAccepted)) throw new Error("Expected file group acceptance");
		await store.accept(fileOp.operationId, protocolJson(fileAccepted));
		expect((await transport.thread(fileScope, fileAccepted.thread_id)).anchor).toMatchObject({ target: {
			type: "group", property: { source: "file", name: "ext" }, value: { type: "text", value: "png" } } });
		expect(await transport.send(prepareBaseGroupCommand(fileOp, fileClaim.preparedAnchor))).toEqual(fileAccepted);
	} finally {
		await captureSession?.close(); store?.close(); for (const provider of providers) provider.destroy(); for (const doc of docs) doc.destroy();
		Object.assign(globalThis, { indexedDB: previousIndexedDB });
	}
}, 60000);
