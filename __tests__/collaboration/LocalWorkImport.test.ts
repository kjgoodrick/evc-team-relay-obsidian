import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { inspectLocalWorkRecovery, parseRecoveryJson, type LocalWorkImportIO } from "../../src/collaboration/LocalWorkImport";
import { saveLocalWorkRecovery, type LocalWorkIO } from "../../src/collaboration/LocalWorkRecovery";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { pictureHash, prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "import-review" }, scope = id(3);
const encode = (value: string) => new TextEncoder().encode(value).buffer;
async function fixture() {
	const texts = new Map<string, string>(), binaries = new Map<string, ArrayBuffer>(), folders = new Set<string>();
	const io: LocalWorkIO & LocalWorkImportIO = {
		mkdir: async path => { folders.add(path); }, write: async (path, text) => { texts.set(path, text); },
		writeBinary: async (path, bytes) => { binaries.set(path, bytes.slice(0)); },
		read: jest.fn(async path => { if (!texts.has(path)) throw new Error("Missing"); return texts.get(path)!; }),
		readBinary: jest.fn(async path => { if (!binaries.has(path)) throw new Error("Missing"); return binaries.get(path)!.slice(0); }),
		stat: jest.fn(async path => folders.has(path) ? { type: "folder" as const, size: 0 } : texts.has(path) ? { type: "file" as const, size: encode(texts.get(path)!).byteLength } :
			binaries.has(path) ? { type: "file" as const, size: binaries.get(path)!.byteLength } : null),
	};
	const store = await DiscussionStore.open(identity, new IDBFactory());
	const source = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
	const body = { version: 1 as const, blocks: [...bodyFromText("Private saved draft").blocks, { type: "picture" as const, picture_id: id(20), alt: "Original" }] };
	await store.saveDraft({ id: "draft", scopeId: scope, revision: 0, body: protocolJson(editableCommentDraft(body, () => "Alice")) }, null, [source]);
	await store.enqueue({ operationId: id(4), scopeId: scope, type: "thread.create", dependsOn: [], payload: {
		type: "thread.create", thread_id: id(5), message_id: id(6), anchor: { version: 1, type: "note" }, body: protocolJson(bodyFromText("Possibly delivered")) } });
	const path = await saveLocalWorkRecovery(store, io, () => true);
	jest.mocked(io.read).mockClear(); jest.mocked(io.readBinary).mockClear(); jest.mocked(io.stat).mockClear();
	const rewrite = async (change: (value: Record<string, any>) => void) => {
		const data = JSON.parse(texts.get(path + "/manifest.json")!); change(data);
		const raw = JSON.stringify(data); texts.set(path + "/manifest.json", raw);
		const complete = JSON.parse(texts.get(path + "/COMPLETE.json")!);
		complete.manifestSha256 = await pictureHash(encode(raw)); complete.manifestBytes = encode(raw).byteLength;
		texts.set(path + "/COMPLETE.json", JSON.stringify(complete));
	};
	return { store, path, texts, binaries, folders, io, rewrite, close: () => store.close() };
}

test("reads an actual completed export without changing saved work and freezes reviewed metadata", async () => {
	const f = await fixture();
	try {
		const before = await f.store.storageUsage(), op = await f.store.getOperation(id(4));
		const result = await inspectLocalWorkRecovery(f.io, f.path, () => true);
		expect(result.snapshot.identity).toMatchObject({ ...identity, serverId: new URL(identity.serverId).href });
		expect(result.snapshot.drafts[0].id).toBe("draft"); expect(result.snapshot.operations[0]).toEqual(op);
		expect(result.pictureBytes).toBe(3); expect(result.snapshot.pictures[0].file).toBe("pictures/00001.bin");
		expect(Object.isFrozen(result.snapshot.drafts[0].body)).toBe(true);
		expect(await f.store.storageUsage()).toEqual(before); expect(await f.store.getOperation(id(4))).toEqual(op);
		expect(f.io.readBinary).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});

test.each(["missing_marker", "manifest_hash", "picture_hash", "snapshot_id", "version", "traversal", "duplicate_picture", "duplicate_operation", "missing_dependency", "credentials", "active_lease", "accepted_state", "record_limit"])("rejects %s without activating anything", async change => {
	const f = await fixture();
	try {
		if (change === "missing_marker") f.texts.delete(f.path + "/COMPLETE.json");
		if (change === "manifest_hash") f.texts.set(f.path + "/manifest.json", f.texts.get(f.path + "/manifest.json")!.replace("Private", "Changed"));
		if (change === "picture_hash") f.binaries.set(f.path + "/pictures/00001.bin", new Uint8Array([3, 2, 1]).buffer);
		if (!["missing_marker", "manifest_hash", "picture_hash"].includes(change)) await f.rewrite(value => {
			if (change === "snapshot_id") value.id = id(99);
			if (change === "version") value.storageVersion++;
			if (change === "traversal") value.pictures[0].file = "../../private.bin";
			if (change === "duplicate_picture") value.pictures.push({ ...value.pictures[0], file: "pictures/00002.bin" });
			if (change === "duplicate_operation") value.operations.push({ ...value.operations[0] });
			if (change === "missing_dependency") value.operations[0].dependsOn = [id(99)];
			if (change === "credentials") value.identity.serverId = "https://user:secret@relay.test";
			if (change === "active_lease") value.operations[0].lease = { owner: "foreign", attempt: 1, expiresAt: 100 };
			if (change === "accepted_state") value.operations[0].state = "accepted";
			if (change === "record_limit") value.drafts = Array.from({ length: 5001 }, (_, n) => ({ ...value.drafts[0], id: "draft" + n }));
		});
		const result = await inspectLocalWorkRecovery(f.io, f.path, () => true).catch(error => error);
		expect(result).toBeInstanceOf(Error); expect(String(result)).not.toMatch(/Private|Possibly|secret/);
		expect((await f.store.getOperation(id(4)))?.state).toBe("queued");
		if (change === "traversal") expect(f.io.readBinary).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test.each(["/absolute", "../outside", "copy/../outside", "copy//other", "copy\\other", "copy\u0000bad"])("refuses an invalid selected folder: %p", async path => {
	const f = await fixture(); try { await expect(inspectLocalWorkRecovery(f.io, path, () => true)).rejects.toThrow(); expect(f.io.stat).not.toHaveBeenCalled(); } finally { f.close(); }
});

test.each(['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"nested":{"x":1,"x":2}}', '[1,]', '{"x":NaN}', '{"x":1e999}', '"unterminated', '['.repeat(49) + '0' + ']'.repeat(49)])("rejects ambiguous or unsupported JSON: %p", raw => {
	expect(() => parseRecoveryJson(raw)).toThrow("invalid");
});

test("accepts escaped strings and nested JSON without interpreting their contents", () => {
	const value = { text: 'Quotes " \\ braces { } [,] 😀', arrays: [null, true, false, -1.25e4, { x: "<script>" }] };
	expect(parseRecoveryJson(JSON.stringify(value))).toEqual(value);
});

test.each(["account", "deadline", "marker", "length"])("stops when %s changes during reads", async change => {
	const f = await fixture(); let current = true, tick = 0;
	try {
		const original = f.io.readBinary;
		f.io.readBinary = jest.fn(async path => {
			const bytes = await original(path);
			if (change === "account") current = false;
			if (change === "deadline") tick = 60_000;
			if (change === "marker") f.texts.set(f.path + "/COMPLETE.json", "{}");
			return change === "length" ? new ArrayBuffer(4) : bytes;
		});
		await expect(inspectLocalWorkRecovery(f.io, f.path, () => current, () => {}, () => tick)).rejects.toThrow();
		expect(await f.store.getDraft("draft")).toBeDefined();
	} finally { f.close(); }
});

test("checks declared file sizes before reading and catches a file growing after its stat", async () => {
	const f = await fixture();
	try {
		const stat = f.io.stat;
		f.io.stat = jest.fn(async path => path.endsWith("manifest.json") ? { type: "file" as const, size: 9 * 1024 * 1024 } : stat(path));
		await expect(inspectLocalWorkRecovery(f.io, f.path, () => true)).rejects.toThrow();
		expect(f.io.read).not.toHaveBeenCalledWith(f.path + "/manifest.json");
		f.io.stat = stat; const read = f.io.read;
		f.io.read = jest.fn(async path => path.endsWith("manifest.json") ? "x".repeat(9 * 1024 * 1024) : read(path));
		await expect(inspectLocalWorkRecovery(f.io, f.path, () => true)).rejects.toThrow();
	} finally { f.close(); }
});

test("local I/O failures never expose paths or arbitrary provider error text", async () => {
	const f = await fixture();
	try {
		f.io.read = jest.fn().mockRejectedValue(new Error("private path and secret adapter detail"));
		await expect(inspectLocalWorkRecovery(f.io, f.path, () => true)).rejects.toThrow("invalid");
		const error = await inspectLocalWorkRecovery(f.io, f.path, () => true).catch(value => value);
		expect(String(error)).not.toMatch(/private|secret|adapter/);
	} finally { f.close(); }
});
