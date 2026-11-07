import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { prepareLocalPicture, pictureHash } from "../../src/collaboration/PictureProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { saveLocalWorkRecovery, type LocalWorkIO } from "../../src/collaboration/LocalWorkRecovery";
import { isConflictCopyPath } from "../../src/conflictCopyPath";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = id(3), identity = { serverId: "https://user:secret@relay.test/api?token=secret#secret", accountId: id(1), shareId: id(2), vaultId: "recovery-export" };
const command = (n = 4): QueuedCommand => ({ operationId: id(n), scopeId: scope, type: "thread.create", dependsOn: [],
	payload: { type: "thread.create", thread_id: id(5), message_id: id(6), body: protocolJson(bodyFromText("Waiting text")), anchor: { version: 1, type: "note" } } });
async function fixture() {
	const factory = new IDBFactory(), store = await DiscussionStore.open(identity, factory);
	const source = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
	const body = { version: 1 as const, blocks: [...bodyFromText("Saved draft").blocks, { type: "picture" as const, picture_id: source.id, alt: "Original picture" }] };
	await store.saveDraft({ id: "draft", scopeId: scope, revision: 0, body: protocolJson(editableCommentDraft(body, () => "Member")) }, null, [source]);
	return { store, source, body, factory };
}
function disk() {
	const texts = new Map<string, string>(), binaries = new Map<string, ArrayBuffer>(), folders = new Set<string>();
	const io: LocalWorkIO = { mkdir: async path => { folders.add(path); },
		write: async (path, value) => { if (texts.has(path)) throw new Error("Exists"); texts.set(path, value); },
		writeBinary: async (path, value) => { if (binaries.has(path)) throw new Error("Exists"); binaries.set(path, value.slice(0)); },
		read: async path => { if (!texts.has(path)) throw new Error("Missing file"); return texts.get(path)!; },
		readBinary: async path => { if (!binaries.has(path)) throw new Error("Missing picture"); return binaries.get(path)!.slice(0); } };
	return { io, texts, binaries, folders };
}

test("capture isolates saved work from server caches and secrets, preserving requests, review mappings and uncertain online actions", async () => {
	const { store } = await fixture();
	try {
		const accepted = await store.enqueue(command(), 1); await store.accept(accepted.operationId, { server_only: "private cache" });
		await store.enqueue({ ...command(7), dependsOn: [accepted.operationId] }, 2);
		await store.claimNext("worker-lease-must-not-export", 3);
		const saved = await store.enqueue(command(8), 4);
		const draft = await store.restoreCommandForReview(saved, protocolJson(editableCommentDraft(bodyFromText("Waiting text"), () => "Member")));
		await store.prepareOnlineDraft("draft", 0, { operationId: id(9), scopeId: scope, payload: { type: "reply.create", body: "Unconfirmed" } });
		await store.setPreference("people:" + scope, { secret: "other members" });
		await store.setPreference("permission:" + scope, { secret: "permission data" });
		await store.setPreference("timelineMarkerCommand:" + scope, { status: "pending", request: { label: "My pending marker" } });
		await store.setPreference("reattach:" + scope + ":old", { version: 1, completed: id(9), status: "accepted" });
		await store.setPreference("reattach:" + scope + ":new", { version: 1, operation: { scopeId: scope, payload: { type: "thread.reattach" } } });
		const snapshot = await store.captureLocalWork(id(30), 100);
		expect(snapshot.operations.map(op => op.state).sort()).toEqual(["review", "sending"]);
		expect(snapshot.dependencies).toEqual([{ operationId: accepted.operationId, state: "accepted" }]);
		expect(snapshot.actions.map(action => action.key)).toEqual(expect.arrayContaining(["online:draft", "recovery:" + draft.id, "timelineMarkerCommand:" + scope, "reattach:" + scope + ":new"]));
		const json = JSON.stringify(snapshot);
		for (const omitted of ["secret", "worker-lease-must-not-export", "server_only", "other members", "permission data", ":old"]) expect(json).not.toContain(omitted);
		expect(snapshot.identity.serverId).toBe("https://relay.test/api");
		expect(snapshot.pictures).toEqual([{ id: id(20), scopeId: scope, size: 3, sha256: expect.any(String) }]);
		expect(await store.localWorkSummary()).toMatchObject({ id: id(30), drafts: 2, operations: 2, actions: 4, pictures: 1, pictureBytes: 3 });
	} finally { store.close(); }
});

test("capture pins originals across acknowledgement, draft removal and reload without double accounting", async () => {
	const { store, factory, body } = await fixture();
	try {
		const queued = await store.enqueue({ ...command(), payload: { ...(command().payload as object), body: protocolJson(body) } }, 1, { id: "draft", revision: 0 });
		await store.captureLocalWork(id(30), 100);
		await store.accept(id(20), { accepted: true }); await store.accept(queued.operationId, { accepted: true });
		expect(await store.preference("pictureSourceBytes")).toBe(3);
		const reopened = await DiscussionStore.open(identity, factory);
		try {
			expect((await reopened.localWorkSnapshot(id(30)))?.operations).toHaveLength(2);
			await expect(reopened.captureLocalWork(id(31))).rejects.toThrow("retained recovery copy");
			const files = disk(), path = await saveLocalWorkRecovery(reopened, files.io, () => true, id(30));
			expect(isConflictCopyPath(path)).toBe(true);
			expect([...files.binaries.values()][0]).toEqual(new Uint8Array([1, 2, 3]).buffer);
			const complete = JSON.parse(files.texts.get(path + "/COMPLETE.json")!);
			expect(complete.manifestSha256).toBe(await pictureHash(new TextEncoder().encode(files.texts.get(path + "/manifest.json")!).buffer));
			expect(await reopened.localWorkSummary()).toBeUndefined(); expect(await reopened.preference("pictureSourceBytes")).toBe(0);
			expect((await reopened.getOperation(queued.operationId))?.state).toBe("accepted");
		} finally { reopened.close(); }
	} finally { store.close(); }
});

test("failed disk writes retain one immutable capture; retry saves that version without consuming later edits", async () => {
	const { store } = await fixture();
	try {
		const files = disk(); jest.spyOn(files.io, "writeBinary").mockRejectedValueOnce(new Error("Disk full"));
		await expect(saveLocalWorkRecovery(store, files.io, () => true)).rejects.toThrow("Disk full");
		const retained = (await store.localWorkSummary())!;
		const original = (await store.getDraft("draft"))!;
		await store.saveDraft({ ...original, revision: 1, body: protocolJson(editableCommentDraft(bodyFromText("Later text without picture"), () => "Member")) }, 0);
		const path = await saveLocalWorkRecovery(store, files.io, () => true, retained.id);
		const manifest = JSON.parse(files.texts.get(path + "/manifest.json")!);
		expect(manifest.drafts[0].revision).toBe(0); expect(JSON.stringify(manifest.drafts)).toContain("Saved draft");
		expect((await store.getDraft("draft"))?.revision).toBe(1);
		expect(await store.preference("pictureSourceBytes")).toBe(0);
		expect([...files.texts.keys()].filter(key => key.endsWith("COMPLETE.json"))).toEqual([path + "/COMPLETE.json"]);
	} finally { store.close(); }
});

test.each(["picture", "manifest", "completion"])("corrupt %s readback never releases the retained capture", async kind => {
	const { store } = await fixture();
	try {
		const files = disk();
		if (kind === "picture") jest.spyOn(files.io, "readBinary").mockResolvedValue(new Uint8Array([3, 2, 1]).buffer);
		else { const read = files.io.read; jest.spyOn(files.io, "read").mockImplementation(path => path.endsWith(kind === "manifest" ? "manifest.json" : "COMPLETE.json") ? Promise.resolve("corrupt") : read(path)); }
		await expect(saveLocalWorkRecovery(store, files.io, () => true)).rejects.toThrow("verified");
		expect(await store.localWorkSummary()).toMatchObject({ drafts: 1, pictures: 1 });
		expect(await store.pictureSource(id(20), scope)).toBeDefined(); expect(await store.getDraft("draft")).toBeDefined();
		if (kind !== "completion") expect([...files.texts.keys()].some(path => path.endsWith("COMPLETE.json"))).toBe(false);
	} finally { store.close(); }
});

test("account change during a file write stops later writes and preserves the capture for that account", async () => {
	const { store, factory } = await fixture();
	try {
		const files = disk(); let current = true;
		const write = files.io.writeBinary; jest.spyOn(files.io, "writeBinary").mockImplementation(async (path, bytes) => { await write(path, bytes); current = false; });
		await expect(saveLocalWorkRecovery(store, files.io, () => current)).rejects.toThrow("account or window changed");
		expect(files.texts.size).toBe(0); expect(await store.localWorkSummary()).toBeDefined();
		const other = await DiscussionStore.open({ ...identity, accountId: id(99) }, factory);
		try { expect(await other.localWorkSummary()).toBeUndefined(); expect(await other.pictureSource(id(20), scope)).toBeUndefined(); }
		finally { other.close(); }
	} finally { store.close(); }
});

test("two windows cannot replace an existing snapshot and stale release cannot remove a newer capture", async () => {
	const { store, factory } = await fixture(), other = await DiscussionStore.open(identity, factory);
	try {
		const result = await Promise.allSettled([store.captureLocalWork(id(30)), other.captureLocalWork(id(31))]);
		expect(result.filter(item => item.status === "fulfilled")).toHaveLength(1);
		const saved = (await store.localWorkSummary())!;
		expect(await other.releaseLocalWork(id(99))).toBe(false);
		await other.releaseLocalWork(saved.id); expect(await store.getDraft("draft")).toBeDefined();
		expect(await store.preference("pictureSourceBytes")).toBe(3);
		await other.captureLocalWork(id(32)); expect(await store.releaseLocalWork(saved.id)).toBe(false);
		expect(await other.localWorkSummary()).toMatchObject({ id: id(32) });
	} finally { store.close(); other.close(); }
});

test("metadata limits abort the whole capture, leaving no pins or partial snapshot", async () => {
	const { store } = await fixture();
	try {
		for (let i = 0; i < 9; i++) await store.saveDraft({ id: "large" + i, scopeId: scope, revision: 0, body: "x".repeat(1000000) });
		await expect(store.captureLocalWork(id(30))).rejects.toThrow("limit");
		expect(await store.localWorkSummary()).toBeUndefined();
		await store.removeDraft("draft", 0); expect(await store.pictureSource(id(20), scope)).toBeUndefined();
		expect((await store.storageUsage()).drafts).toBe(9);
	} finally { store.close(); }
});

test("export ownership preserves bytes but does not keep removed picture uploads queued", async () => {
	const { store, body } = await fixture();
	try {
		const original = await store.enqueue({ ...command(), payload: { ...(command().payload as object), body: protocolJson(body) } }, 1, { id: "draft", revision: 0 });
		await store.captureLocalWork(id(30));
		const draft = await store.restoreCommandForReview(original, protocolJson(editableCommentDraft(body, () => "Member")));
		await store.enqueue(command(10), 2, draft);
		expect((await store.getOperation(id(20)))?.state).toBe("withdrawn");
		expect(await store.pictureSource(id(20), scope)).toBeDefined();
		await store.releaseLocalWork(id(30)); expect(await store.pictureSource(id(20), scope)).toBeUndefined();
	} finally { store.close(); }
});

test("version-22 upgrade preserves budget/work, fences older cleanup, and explicit account cleanup removes captures", async () => {
	const factory = new IDBFactory();
	const opening = jest.spyOn(factory, "open").mockImplementationOnce(name => IDBFactory.prototype.open.call(factory, name, 22));
	const old = await DiscussionStore.open(identity, factory); opening.mockRestore();
	await old.setPictureCacheLimit(25 * 1024 * 1024); await old.enqueue(command(), 1);
	const store = await DiscussionStore.open(identity, factory);
	try {
		expect(await store.pictureCachePolicy()).toMatchObject({ limit: 25 * 1024 * 1024 });
		await expect(old.clearAll()).rejects.toThrow();
		await store.captureLocalWork(id(30)); expect(await store.localWorkSummary()).toMatchObject({ operations: 1 });
		await store.clearAll(); expect(await store.localWorkSummary()).toBeUndefined(); expect(await store.localWorkSnapshot(id(30))).toBeUndefined();
	} finally { old.close(); store.close(); }
});
