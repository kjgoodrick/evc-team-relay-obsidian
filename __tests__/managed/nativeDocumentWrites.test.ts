import { holdNativeSourceWrites, trackNativeDocumentWrite, waitForNativeDocumentWrites } from "../../src/storage/native-document-writes";

function deferred() {
	let resolve!: () => void, reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const check = () => {};

test("a recovery hold closes admission before draining and keeps installation writes exclusive", async () => {
	const vault = {}, old = deferred(), install = deferred(), denied = jest.fn(async () => {});
	const saving = trackNativeDocumentWrite(vault, "Team/Old.md", () => old.promise);
	const hold = holdNativeSourceWrites(vault, "Team");
	await expect(trackNativeDocumentWrite(vault, "Team/New.md", denied)).rejects.toThrow("paused");
	await expect(hold.write("Team/New.md", denied)).rejects.toThrow("still running");
	expect(() => hold.release()).toThrow("still running"); expect(denied).not.toHaveBeenCalled();
	let drained = false; const wait = hold.wait({ check }).then(() => { drained = true; });
	await Promise.resolve(); expect(drained).toBe(false); old.resolve(); await saving; await wait;
	const installing = hold.write("Team/New.md", () => install.promise);
	await expect(hold.write("Team/Second.md", denied)).rejects.toThrow("still running");
	expect(() => hold.release()).toThrow("still running");
	await expect(trackNativeDocumentWrite(vault, "Team/Old.md", denied)).rejects.toThrow("paused");
	install.resolve(); await installing; hold.release(); hold.release();
	await trackNativeDocumentWrite(vault, "Team/New.md", denied); expect(denied).toHaveBeenCalledTimes(1);
	await expect(hold.write("Team/New.md", denied)).rejects.toThrow("released");
});

test("holds isolate vaults and folder boundaries, including conservative case and Unicode aliases", async () => {
	const vault = {}, hold = holdNativeSourceWrites(vault, "Téam");
	try {
		await expect(trackNativeDocumentWrite(vault, "te\u0301am/Note.md", async () => {})).rejects.toThrow("paused");
		await trackNativeDocumentWrite(vault, "Téammate/Note.md", async () => {});
		await trackNativeDocumentWrite({}, "Téam/Note.md", async () => {});
		expect(() => holdNativeSourceWrites(vault, "TÉAM/Subfolder")).toThrow("already");
		expect(() => holdNativeSourceWrites(vault, "")).toThrow("already");
		const sibling = holdNativeSourceWrites(vault, "Other"); sibling.release();
		await expect(hold.write("Elsewhere.md", async () => {})).rejects.toThrow("outside");
	} finally { hold.release(); }
	const root = holdNativeSourceWrites(vault, "");
	try { await expect(trackNativeDocumentWrite(vault, "Any/Note.md", async () => {})).rejects.toThrow("paused"); }
	finally { root.release(); }
});

test.each(["cancelled", "timeout"])("a %s drain leaves the hold and admitted operation intact", async mode => {
	const vault = {}, old = deferred(), controller = new AbortController();
	const save = trackNativeDocumentWrite(vault, "Team/Note.md", () => old.promise), hold = holdNativeSourceWrites(vault, "Team");
	try {
		const wait = hold.wait({ check, signal: controller.signal, timeoutMs: 5 }); if (mode === "cancelled") controller.abort();
		await expect(wait).rejects.toThrow(mode === "cancelled" ? "cancelled" : "still running");
		await expect(trackNativeDocumentWrite(vault, "Team/Other.md", async () => {})).rejects.toThrow("paused");
		expect(() => hold.release()).toThrow("still running");
	} finally { old.resolve(); await save; await hold.wait({ check }); hold.release(); }
});

test("holds survive a module reload in the same host realm", async () => {
	const vault = {}, hold = holdNativeSourceWrites(vault, "Team");
	let loaded!: typeof import("../../src/storage/native-document-writes");
	jest.isolateModules(() => { loaded = require("../../src/storage/native-document-writes"); });
	try {
		await expect(loaded.trackNativeDocumentWrite(vault, "Team/Note.md", async () => {})).rejects.toThrow("paused");
		expect(() => loaded.holdNativeSourceWrites(vault, "Team")).toThrow("already");
	} finally { hold.release(); }
	await loaded.trackNativeDocumentWrite(vault, "Team/Note.md", async () => {});
});

test("a failed private installation write remains a failure and can be drained without reopening admission", async () => {
	const vault = {}, hold = holdNativeSourceWrites(vault, "Team");
	try {
		await expect(hold.write("Team/Note.md", async () => { throw new Error("disk failed"); })).rejects.toThrow("disk failed");
		await hold.wait({ check });
		await expect(trackNativeDocumentWrite(vault, "Team/Note.md", async () => {})).rejects.toThrow("paused");
	} finally { hold.release(); }
});

test.each(["../Team", "Team/../Note.md", "/Team", "Team//Note.md", "Team\\Note.md"])("unsafe hold/write path %s cannot bypass a native namespace", async path => {
	const vault = {}, write = jest.fn(async () => {});
	expect(() => holdNativeSourceWrites(vault, path)).toThrow("Invalid");
	await expect(trackNativeDocumentWrite(vault, path, write)).rejects.toThrow("Invalid"); expect(write).not.toHaveBeenCalled();
});

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
