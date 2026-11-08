import { AttachmentFile } from "../src/AttachmentFile";
import { holdNativeSourceWrites, waitForNativeDocumentWrites } from "../src/storage/native-document-writes";

function deferred() {
	let resolve!: () => void, reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function fixture() {
	const write = deferred(), started = deferred(); let current = true;
	const check = () => { if (!current) throw new Error("attachment context changed"); };
	const save = jest.fn(() => { started.resolve(); return write.promise; });
	const vault = { adapter: { write: save, writeBinary: save, stat: async () => ({ mtime: 1, ctime: 1, size: 1 }) }, append: save };
	const parent = { captureAttachmentContext: () => { check(); return { check }; }, absolutePath: (path: string) => "Team/" + path,
		blobs: { pullFile: async () => new Uint8Array([1, 2]).buffer } };
	const cache = { resolveHash: jest.fn(async () => "hash"), existsOnDisk: () => false };
	const file = Object.create(AttachmentFile.prototype) as AttachmentFile;
	for (const [key, value] of Object.entries({ _parent: parent, vault, path: "image.png", obsidianFile: { path: "Team/image.png" },
		contentAddressedCache: cache, syncBase: async () => false, refreshRemoteMeta: () => {}, syncMeta: { hash: "remote" }, log: jest.fn() })) {
		Object.defineProperty(file, key, { value, writable: true, configurable: true });
	}
	return { file, vault, cache, write, started, save, invalidate: () => { current = false; } };
}

test.each(["writeContent", "appendContent"] as const)("%s waits for native completion before hashing or reporting success", async method => {
	const f = fixture(); let complete = false;
	const saving = f.file[method]("new bytes").then(() => { complete = true; }); await f.started.promise;
	expect(f.cache.resolveHash).not.toHaveBeenCalled(); expect(complete).toBe(false);
	await expect(waitForNativeDocumentWrites(f.vault, "Team/image.png", { check: () => {}, timeoutMs: 5 })).rejects.toThrow("still running");
	f.write.resolve(); await saving; expect(f.cache.resolveHash).toHaveBeenCalledTimes(1); expect(complete).toBe(true);
});

test.each(["writeContent", "appendContent"] as const)("%s reports native failure without hashing uncommitted bytes", async method => {
	const f = fixture(), saving = f.file[method]("new bytes");
	const rejected = expect(saving).rejects.toThrow("disk failed"); await f.started.promise; f.write.reject(new Error("disk failed"));
	await rejected; expect(f.cache.resolveHash).not.toHaveBeenCalled();
	await waitForNativeDocumentWrites(f.vault, "Team/image.png", { check: () => {} });
});

test.each(["writeContent", "appendContent"] as const)("a source hold denies %s before touching native bytes", async method => {
	const f = fixture(), hold = holdNativeSourceWrites(f.vault, "Team");
	try { await expect(f.file[method]("new bytes")).rejects.toThrow("paused"); expect(f.save).not.toHaveBeenCalled(); }
	finally { hold.release(); }
});

test.each([false, true])("binary download saves stay tracked through native completion and recheck context afterward (%s)", async changed => {
	const f = fixture(), saving = f.file.pullFromRemote(); await f.started.promise;
	const hold = holdNativeSourceWrites(f.vault, "Team");
	try {
		await expect(hold.wait({ check: () => {}, timeoutMs: 5 })).rejects.toThrow("still running");
		if (changed) f.invalidate(); f.write.resolve(); await saving; await hold.wait({ check: () => {} });
		expect(f.cache.resolveHash).toHaveBeenCalledTimes(changed ? 0 : 1);
	} finally { f.write.resolve(); await saving; hold.release(); }
});

test("a binary download cannot write through a recovery hold", async () => {
	const f = fixture(), hold = holdNativeSourceWrites(f.vault, "Team");
	try { await f.file.pullFromRemote(); expect(f.save).not.toHaveBeenCalled(); expect(f.cache.resolveHash).not.toHaveBeenCalled(); }
	finally { hold.release(); }
});
