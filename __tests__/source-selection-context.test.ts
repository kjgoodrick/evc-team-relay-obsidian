import "fake-indexeddb/auto";
import * as Y from "yjs";
import { Document } from "../src/Document";
import { CanvasDocument } from "../src/CanvasDocument";
import { VaultShare } from "../src/VaultShare";
import type { AuthSession } from "../src/AuthSession";
import type { RelayCredentialCache } from "../src/RelayCredentialCache";
import { UnsavedFile, UnsavedFileStore } from "../src/UnsavedFile";
import { RemoteFolderAddress, RemoteDocumentAddress, RemoteCanvasAddress, ResourceAddress } from "../src/ResourceAddress";
import { SourceSelectionContext, type SourceSelectionScope } from "../src/storage/source-selection-context";
import { SourceSelectionJournal, type SourceSelectionState } from "../src/storage/source-selection-journal";
import { assertSourceCacheBinding, sourceDocumentCache, sourceInventoryCache } from "../src/storage/source-document-cache";
import type { LocalDocumentStore } from "../src/storage/local-document-store";
import type { RestoreBinding } from "../src/collaboration/RestoreGeneration";
import { RECOVERY_FOLDER } from "../src/conflictCopyPath";

const contexts: SourceSelectionContext[] = [], journals: SourceSelectionJournal[] = [];
function scope(): SourceSelectionScope { return { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
	s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())) }; }
const folderId = (value: SourceSelectionScope) => (ResourceAddress.parse(value.s3rn) as RemoteFolderAddress).folderGuid;
const child = (value: SourceSelectionScope, id = crypto.randomUUID()) => ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", folderId(value), id));
async function open(value: SourceSelectionScope) { const context = await SourceSelectionContext.open(value); contexts.push(context); return context; }
async function journal(value: SourceSelectionScope) { const result = await SourceSelectionJournal.open(value); journals.push(result); return result; }
async function begin(store: SourceSelectionJournal, restoreGeneration: string | null = crypto.randomUUID()) {
	return store.apply({ type: "begin", operationId: crypto.randomUUID(), expectedRevision: (await store.read()).revision, reviewId: crypto.randomUUID(), restoreGeneration });
}
async function step(store: SourceSelectionJournal, state: SourceSelectionState, type: "prepare" | "start" | "commit" | "cancel") {
	const base = { operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId: state.pending!.reviewId };
	return store.apply(type === "prepare" ? { ...base, type, preparation: {
		archive: { path: `${RECOVERY_FOLDER}/test-${crypto.randomUUID()}`, manifestSha256: "a".repeat(64) }, plan: { id: crypto.randomUUID(), sha256: "b".repeat(64) },
	} } : { ...base, type });
}
async function select(value: SourceSelectionScope, generation: string | null) {
	const store = await journal(value); let state = await begin(store, generation);
	for (const type of ["prepare", "start", "commit"] as const) state = await step(store, state, type);
	return { store, state, context: await open(value) };
}
afterEach(() => { contexts.splice(0).forEach(context => context.close()); journals.splice(0).forEach(store => store.close()); jest.restoreAllMocks(); });

test("a legacy selection preserves original cache keys without opening a source cache", async () => {
	const value = scope(), context = await open(value);
	expect(context.choice).toEqual({ kind: "legacy" }); expect(context.revision).toBeNull(); expect(context.binding).toBeUndefined();
	expect(context.inventory).toBeUndefined(); expect(context.document(child(value))).toBeUndefined();
	expect(context.pendingUploadsKey).toBe(`${value.hostAppId}-evc-team-relay/folders/${folderId(value)}/pendingUploads`);
	await context.assertCurrent();
	expect((await indexedDB.databases()).some(db => db.name?.startsWith("relay-source-v1-"))).toBe(false);
});

test.each(["review", "prepared", "applying"])("a pending %s phase cannot create an active selection context", async phase => {
	const value = scope(), store = await journal(value); let state = await begin(store);
	if (phase !== "review") state = await step(store, state, "prepare");
	if (phase === "applying") await step(store, state, "start");
	await expect(open(value)).rejects.toThrow("awaiting recovery");
});

test.each([null, "a3333333-3333-4333-8333-333333333333"])("a committed %s choice selects all namespaces consistently across reopen", async generation => {
	const value = scope(), { context, state } = await select(value, generation), s3rn = child(value);
	expect(context.revision).toBe(state.revision); expect(context.binding).toEqual({ restoreGeneration: generation });
	expect(context.inventory).toEqual(await sourceInventoryCache({ ...value, restoreGeneration: generation }));
	expect(context.document(s3rn)).toEqual(await sourceDocumentCache({ ...value, s3rn, restoreGeneration: generation }));
	expect(context.pendingUploadsKey).toBe(context.inventory!.name + "/pendingUploads");
	context.close(); const reopened = await open(value); expect(reopened.document(s3rn)).toEqual(await sourceDocumentCache({ ...value, s3rn, restoreGeneration: generation }));
	await reopened.assertCurrent(); expect(() => context.check()).toThrow("closed");
});

test("a changed review invalidates the old session permanently, including after cancellation", async () => {
	const value = scope(), old = await open(value), store = await journal(value), pending = await begin(store);
	await expect(old.assertCurrent()).rejects.toThrow("changed"); expect(() => old.document(child(value))).toThrow("changed");
	await step(store, pending, "cancel"); await expect(old.assertCurrent()).rejects.toThrow("changed");
	const fresh = await open(value); await fresh.assertCurrent(); expect(fresh.choice.kind).toBe("legacy"); expect(fresh.revision).not.toBeNull();
});

test("scope input is captured before asynchronous reads; descriptors reject foreign folders and servers", async () => {
	const value = scope(), original = { ...value }, opening = open(value); value.serverId = "different"; value.s3rn = scope().s3rn;
	const context = await opening; expect(context.scope).toEqual(original); expect(Object.isFrozen(context.scope)).toBe(true); expect(Object.isFrozen(context.choice)).toBe(true);
	context.assertFolder(original.hostAppId, original.serverId, original.s3rn);
	expect(() => context.assertFolder(original.hostAppId, "different", original.s3rn)).toThrow("another");
	for (const s3rn of [child(value), child(original) + ":extra:tail", original.s3rn, child(original).replace(":doc:", ":file:")]) expect(() => context.document(s3rn)).toThrow();
});

function wrapper(value: SourceSelectionScope, context: SourceSelectionContext, kind: "markdown" | "canvas", id: string) {
	let endpoint = value.controlPlaneUrl;
	const grant = { token: "synthetic", url: "wss://fixture.test/v1/doc", docId: id, folder: folderId(value), expiryTime: Date.now() + 600_000 };
	const credentials = { peekToken: () => undefined, dropFromQueue: jest.fn(), getToken: jest.fn(async (..._args: Parameters<RelayCredentialCache["getToken"]>) => grant),
		assertDocumentSourceCache: (metadata: string, s3rn: string, serverId: string, binding: RestoreBinding) => assertSourceCacheBinding(metadata, s3rn, serverId, endpoint, binding) };
	const parent = { sourceSelection: context, hostAppId: value.hostAppId, workspaceId: "relay-onprem", entityGuid: folderId(value),
		resourceAddress: ResourceAddress.parse(value.s3rn), config: { onpremServerId: value.serverId }, credentialCache: credentials,
		vaultApi: {}, unsavedStore: new UnsavedFileStore(), subscribe: () => () => {}, awaitSynced: async () => {}, docActivity: { noteLocalEdit: () => {} },
		readContents: jest.fn(async () => "older native bytes"), noteUploaded: async () => {},
		_liveProvider: { managedIndex: { snapshot: { restore_generation: context.binding?.restoreGeneration ?? null } } },
	};
	const auth = { getCurrentUserForServer: () => undefined, on: () => () => {} } as unknown as AuthSession;
	const doc = kind === "markdown" ? new Document("Note.md", id, auth, parent as unknown as VaultShare)
		: new CanvasDocument("Drawing.canvas", id, auth, parent as unknown as VaultShare);
	const persistence = (doc as unknown as { _indexeddbPersistence: LocalDocumentStore })._indexeddbPersistence;
	return { doc, parent, credentials, grant, persistence, endpoint: (url: string) => { endpoint = url; }, close: async () => { await persistence.close(); doc.dismantle(); } };
}

test.each(["markdown", "canvas"] as const)("the actual %s constructor opens the selected history and checks its journal before tokens", async kind => {
	const value = scope(), generation = crypto.randomUUID(), { context, store } = await select(value, generation), id = crypto.randomUUID();
	const s = wrapper(value, context, kind, id);
	try {
		await s.doc.awaitFirstSync(); await s.doc.assertNoRestoreReview(); expect(s.doc.restoreReviewRequired).toBe(false);
		const address = ResourceAddress.serialize(kind === "markdown" ? new RemoteDocumentAddress("relay-onprem", folderId(value), id) : new RemoteCanvasAddress("relay-onprem", folderId(value), id));
		const descriptor = context.document(address)!;
		expect(s.persistence.name).toBe(descriptor.name); expect(s.persistence.cacheIdentity).toBe(descriptor.identity);
		await s.doc.requestProviderToken(); expect(s.credentials.getToken).toHaveBeenCalledTimes(1);
		await begin(store); await expect(s.doc.requestProviderToken()).rejects.toThrow("changed"); expect(s.credentials.getToken).toHaveBeenCalledTimes(1);
	} finally { await s.close(); }
});

test.each(["legacy", "selected"])("%s wrapper rejects changed server configuration before requesting tokens", async mode => {
	const value = scope(), context = mode === "legacy" ? await open(value) : (await select(value, crypto.randomUUID())).context;
	const s = wrapper(value, context, "markdown", crypto.randomUUID());
	try {
		await s.doc.awaitFirstSync(); s.endpoint("https://different.test");
		await expect(s.doc.requestProviderToken()).rejects.toThrow("another server"); expect(s.credentials.getToken).not.toHaveBeenCalled();
	} finally { await s.close(); }
});

test("a journal change during token acquisition disconnects the selected wrapper and rejects the late grant", async () => {
	const value = scope(), { context, store } = await select(value, crypto.randomUUID()), s = wrapper(value, context, "markdown", crypto.randomUUID());
	try {
		await s.doc.awaitFirstSync(); const disconnect = jest.spyOn(s.doc._liveProvider, "disconnect");
		s.credentials.getToken.mockImplementationOnce(async () => { await begin(store); return { ...s.grant, token: "late" }; });
		await expect(s.doc.requestProviderToken()).rejects.toThrow("changed"); expect(disconnect).toHaveBeenCalled();
		expect(s.doc.hasFreshProviderToken()).toBe(false);
	} finally { await s.close(); }
});

test.each(["direct", "retained"])("%s renewal callbacks recheck the journal before applying selected tokens", async mode => {
	const value = scope(), { context, store } = await select(value, crypto.randomUUID()), s = wrapper(value, context, "markdown", crypto.randomUUID());
	try {
		await s.doc.awaitFirstSync(); await s.doc.requestProviderToken();
		const refresh = jest.spyOn(s.doc._liveProvider, "refreshToken"), disconnect = jest.spyOn(s.doc._liveProvider, "disconnect");
		await begin(store);
		if (mode === "direct") await s.doc.applyRefreshedToken({ ...s.grant, token: "renewed-after-review" });
		else {
			s.credentials.getToken.mock.calls[0][2]({ ...s.grant, token: "renewed-after-review" });
			// The cache retains a void callback; wait for its first durable check.
			for (let attempts = 0; attempts < 100 && !disconnect.mock.calls.length; attempts++) await new Promise(resolve => setTimeout(resolve, 0));
		}
		expect(refresh).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalled();
	} finally { await s.close(); }
});

test("token requests await an initial subscription callback without applying its grant twice", async () => {
	const value = scope(), { context } = await select(value, crypto.randomUUID()), s = wrapper(value, context, "markdown", crypto.randomUUID());
	try {
		await s.doc.awaitFirstSync(); const refresh = jest.spyOn(s.doc._liveProvider, "refreshToken");
		s.credentials.getToken.mockImplementationOnce(async (...args) => { args[2](s.grant); return s.grant; });
		await s.doc.requestProviderToken(); expect(refresh).toHaveBeenCalledTimes(1);
		expect(s.doc.issuedToken).toEqual(s.grant);
	} finally { await s.close(); }
});

test("selected native wrappers preserve an empty saved buffer and never clear the legacy buffer", async () => {
	const value = scope(), { context } = await select(value, crypto.randomUUID()), id = crypto.randomUUID(), s = wrapper(value, context, "markdown", id);
	try {
		const doc = s.doc as Document; await doc.awaitFirstSync(); const key = context.document(child(value, id))!.bufferKey;
		await s.parent.unsavedStore.persistUnsaved(id, "legacy offline edit"); await s.parent.unsavedStore.persistUnsaved(key, "");
		expect((await doc.unsavedFile(true) as UnsavedFile).unsavedText).toBe(""); expect(s.parent.readContents).not.toHaveBeenCalled();
		await doc.clearUnsavedFile(); expect(await s.parent.unsavedStore.readUnsaved(key)).toBeNull(); expect(await s.parent.unsavedStore.readUnsaved(id)).toBe("legacy offline edit");
		jest.spyOn(s.parent.unsavedStore, "readUnsaved").mockRejectedValueOnce(new Error("cache unavailable"));
		await expect(doc.unsavedFile(true)).rejects.toThrow("cache unavailable"); expect(s.parent.readContents).not.toHaveBeenCalled();
	} finally { await s.close(); }
});

test("the folder persistence path uses the same selected inventory as its child context", async () => {
	const value = scope(), { context } = await select(value, crypto.randomUUID()), doc = new Y.Doc();
	const folder = Object.create(VaultShare.prototype) as VaultShare;
	Object.assign(folder, { sourceSelection: context, entityGuid: folderId(value), crdtDoc: doc });
	const persistence = (folder as unknown as { _openPersistence(): LocalDocumentStore })._openPersistence();
	try { await persistence.whenSynced; expect(persistence.name).toBe(context.inventory!.name); expect(persistence.cacheIdentity).toBe(context.inventory!.identity); }
	finally { await persistence.close(); doc.destroy(); }
});

test.each(["markdown", "canvas"] as const)("actual %s wrappers retain independent legacy and selected histories across reopen and a later restore", async kind => {
	const value = scope(), id = crypto.randomUUID(), legacy = await open(value);
	const original = wrapper(value, legacy, kind, id);
	await original.doc.awaitFirstSync(); original.doc.crdtDoc.getMap("fixture").set("edit", "original offline edit"); await original.close();
	const first = await select(value, crypto.randomUUID()), selected = wrapper(value, first.context, kind, id);
	await selected.doc.awaitFirstSync(); expect(selected.doc.crdtDoc.getMap("fixture").size).toBe(0);
	selected.doc.crdtDoc.getMap("fixture").set("edit", "first selected edit"); await selected.close();
	const reopened = wrapper(value, await open(value), kind, id);
	try {
		await reopened.doc.awaitFirstSync(); expect(reopened.doc.crdtDoc.getMap("fixture").get("edit")).toBe("first selected edit");
		let state = await begin(first.store); for (const type of ["prepare", "start", "commit"] as const) state = await step(first.store, state, type);
		await expect(reopened.doc.assertNoRestoreReview()).rejects.toThrow("changed");
		const next = wrapper(value, await open(value), kind, id);
		try { await next.doc.awaitFirstSync(); expect(next.doc.crdtDoc.getMap("fixture").size).toBe(0); }
		finally { await next.close(); }
		expect(reopened.doc.crdtDoc.getMap("fixture").get("edit")).toBe("first selected edit");
	} finally { await reopened.close(); }
});
