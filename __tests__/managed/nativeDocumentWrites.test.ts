import { trackNativeDocumentWrite, waitForNativeDocumentWrites } from "../../src/storage/native-document-writes";

function deferred() {
	let resolve!: () => void, reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const check = () => {};

test("inspection waits for an admitted write and writes that join before it settles", async () => {
	const vault = {}, first = deferred(), second = deferred(); let done = false;
	const save1 = trackNativeDocumentWrite(vault, "Team/Note.md", () => first.promise);
	const wait = waitForNativeDocumentWrites(vault, "Team/Note.md", { check }).then(() => { done = true; });
	const save2 = trackNativeDocumentWrite(vault, "Team/Note.md", () => second.promise);
	first.resolve(); await save1; await Promise.resolve(); expect(done).toBe(false);
	second.resolve(); await save2; await wait; expect(done).toBe(true);
});

test("another file or vault does not hold an unrelated comparison", async () => {
	const vault = {}, pending = deferred();
	const save = trackNativeDocumentWrite(vault, "A.md", () => pending.promise);
	try {
		await waitForNativeDocumentWrites(vault, "B.md", { check, timeoutMs: 5 });
		await waitForNativeDocumentWrites({}, "A.md", { check, timeoutMs: 5 });
	} finally { pending.resolve(); await save; }
});

test.each(["sync", "async"])("a %s write failure releases waiters without claiming that the write succeeded", async failure => {
	const vault = {}, pending = deferred();
	const save = trackNativeDocumentWrite(vault, "A.md", () => {
		if (failure === "sync") throw new Error("Disk failed");
		return pending.promise;
	});
	const failed = expect(save).rejects.toThrow("Disk failed");
	const wait = waitForNativeDocumentWrites(vault, "A.md", { check });
	if (failure === "async") pending.reject(new Error("Disk failed"));
	await failed; await wait;
});

test.each(["cancelled", "timeout"])("a %s comparison leaves the native write tracked until it actually finishes", async mode => {
	const vault = {}, pending = deferred(), controller = new AbortController();
	const save = trackNativeDocumentWrite(vault, "A.md", () => pending.promise);
	try {
		const wait = waitForNativeDocumentWrites(vault, "A.md", { check, signal: controller.signal, timeoutMs: 5 });
		if (mode === "cancelled") controller.abort();
		await expect(wait).rejects.toThrow(mode === "cancelled" ? "cancelled" : "still running");
		await expect(waitForNativeDocumentWrites(vault, "A.md", { check, timeoutMs: 5 })).rejects.toThrow("still running");
	} finally { pending.resolve(); await save; }
	await waitForNativeDocumentWrites(vault, "A.md", { check });
});

test("a changed restore review prevents a late save from completing the old comparison", async () => {
	const vault = {}, pending = deferred(); let valid = true;
	const save = trackNativeDocumentWrite(vault, "A.md", () => pending.promise);
	const wait = waitForNativeDocumentWrites(vault, "A.md", { check: () => { if (!valid) throw new Error("Review changed"); } });
	valid = false; pending.resolve(); await save;
	await expect(wait).rejects.toThrow("Review changed");
});

test("a module reload in the same host realm retains an earlier module's admitted writes", async () => {
	const vault = {}, pending = deferred();
	const save = trackNativeDocumentWrite(vault, "A.md", () => pending.promise);
	let reloaded!: typeof waitForNativeDocumentWrites;
	jest.isolateModules(() => { reloaded = require("../../src/storage/native-document-writes").waitForNativeDocumentWrites; });
	try { await expect(reloaded(vault, "A.md", { check, timeoutMs: 5 })).rejects.toThrow("still running"); }
	finally { pending.resolve(); await save; }
	await reloaded(vault, "A.md", { check });
});
