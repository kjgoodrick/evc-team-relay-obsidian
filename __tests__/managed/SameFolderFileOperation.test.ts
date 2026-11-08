import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { applyDesktopSameFolderFileOperation } from "../../src/DesktopSameFolderFileOperation";
import { parseSameFolderFileOperation, sameFolderOperationPath, type SameFolderFileOperation } from "../../src/SameFolderFileOperation";
import { sourceInstallationPath } from "../../src/SourceInstallationPlan";
import { holdNativeSourceWrites, trackNativeDocumentWrite, type NativeSourceWriteHold } from "../../src/storage/native-document-writes";

// Use the actual shared native module so fault injection surrounds real OS
// operations, not a simulated filesystem implementation.
const fs = require("fs/promises") as typeof import("node:fs/promises");
jest.mock("obsidian", () => ({ Platform: { isMobile: false }, FileSystemAdapter: class {} }));
const encode = (value: string) => new TextEncoder().encode(value).buffer;
const artifact = (value: string) => ({ bytes: encode(value).byteLength, sha256: createHash("sha256").update(value).digest("hex") });
let directory: string, vault: Vault;
const holds: NativeSourceWriteHold[] = [];
function newVault(): Vault {
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => directory;
	return { adapter } as unknown as Vault;
}
beforeEach(async () => {
	directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "relay-native-operation-")));
	Object.assign(Platform, { isMobile: false }); vault = newVault();
});
afterEach(async () => { jest.restoreAllMocks(); holds.splice(0).forEach(hold => hold.release()); await fs.rm(directory, { recursive: true, force: true }); });
async function fixture(before: string | null = "Local before restore", after: string | null = "Selected restored text") {
	const operation: SameFolderFileOperation = { format: "team-relay-native-file-operation", version: 1, id: crypto.randomUUID(),
		plan: { id: crypto.randomUUID(), sha256: "a".repeat(64) }, reviewId: crypto.randomUUID(), root: "Team", path: "Note.md",
		before: before === null ? null : artifact(before), after: after === null ? null : artifact(after) };
	await fs.mkdir(path.join(directory, "Team"));
	await fs.mkdir(path.join(directory, sourceInstallationPath(operation.plan.id)), { recursive: true });
	const target = path.join(directory, "Team", "Note.md"), control = path.join(directory, sameFolderOperationPath(operation));
	if (before !== null) await fs.writeFile(target, before);
	let hold = holdNativeSourceWrites(vault, "Team"); holds.push(hold); await hold.wait({ check: () => {} });
	const run = (check = () => {}) => applyDesktopSameFolderFileOperation(vault, operation, after === null ? null : encode(after), hold, check);
	const restart = async () => {
		hold.release(); vault = newVault(); hold = holdNativeSourceWrites(vault, "Team"); holds.push(hold); await hold.wait({ check: () => {} });
		return run();
	};
	return { operation, target, control, run, restart, hold };
}
async function missing(name: string) { await expect(fs.lstat(name)).rejects.toMatchObject({ code: "ENOENT" }); }

test("replacement keeps the original inode privately and publishes reviewed bytes at the same path", async () => {
	const f = await fixture(), before = await fs.stat(f.target); await fs.chmod(f.target, 0o660);
	const result = await f.run(), retained = path.join(f.control, "before.bin");
	expect(result).toMatchObject({ operationId: f.operation.id, resumed: false, preservedPath: `${sameFolderOperationPath(f.operation)}/before.bin` });
	expect(await fs.readFile(f.target, "utf8")).toBe("Selected restored text");
	expect(await fs.readFile(retained, "utf8")).toBe("Local before restore");
	expect((await fs.stat(retained)).ino).toBe(before.ino); expect((await fs.stat(f.target)).mode & 0o777).toBe(0o660);
	expect(await fs.readdir(path.join(directory, "Team"))).toEqual(["Note.md"]);
	expect((await fs.readdir(f.control)).sort()).toEqual(["before.bin", "intent.json", "published.json"]);
	expect(await f.restart()).toMatchObject({ resumed: true });
});

test.each(["create", "remove", "empty replacement"])("%s preserves exact native semantics and resumes after reopening", async kind => {
	const f = await fixture(kind === "create" ? null : "Local before restore", kind === "remove" ? null : kind === "empty replacement" ? "" : "New file");
	await f.run(); await f.restart();
	if (kind === "remove") await missing(f.target);
	else expect(await fs.readFile(f.target, "utf8")).toBe(kind === "empty replacement" ? "" : "New file");
	if (kind === "create") await missing(path.join(f.control, "before.bin"));
	else expect(await fs.readFile(path.join(f.control, "before.bin"), "utf8")).toBe("Local before restore");
});

test("a changed original is refused before moving it", async () => {
	const f = await fixture(); await fs.writeFile(f.target, "New local edit");
	await expect(f.run()).rejects.toThrow("reviewed bytes");
	expect(await fs.readFile(f.target, "utf8")).toBe("New local edit"); await missing(path.join(f.control, "before.bin"));
});

test("a newly occupied creation path is never overwritten", async () => {
	const f = await fixture(null, "New file"); await fs.writeFile(f.target, "Unrelated work");
	await expect(f.run()).rejects.toThrow("occupies"); expect(await fs.readFile(f.target, "utf8")).toBe("Unrelated work");
});

test.each(["before capture", "after capture", "after publication", "after receipt", "after staging unlink"])("restarts at %s without losing either version", async point => {
	const f = await fixture(), rename = fs.rename, link = fs.link, unlink = fs.unlink; let fired = false;
	jest.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (!fired && point === "before capture" && String(to).endsWith("/before.bin")) { fired = true; throw new Error("injected interruption"); }
		await rename(from, to);
		if (!fired && point === "after capture" && String(to).endsWith("/before.bin")) { fired = true; throw new Error("injected interruption"); }
	});
	jest.spyOn(fs, "link").mockImplementation(async (from, to) => {
		await link(from, to);
		if (!fired && (point === "after publication" && String(to) === f.target || point === "after receipt" && String(to).endsWith("/published.json"))) { fired = true; throw new Error("injected interruption"); }
	});
	jest.spyOn(fs, "unlink").mockImplementation(async name => {
		await unlink(name);
		if (!fired && point === "after staging unlink" && String(name).endsWith("/after.bin")) { fired = true; throw new Error("injected interruption"); }
	});
	await expect(f.run()).rejects.toThrow("injected interruption"); expect(fired).toBe(true); jest.restoreAllMocks();
	expect(await f.restart()).toMatchObject({ resumed: true });
	expect(await fs.readFile(f.target, "utf8")).toBe("Selected restored text");
	expect(await fs.readFile(path.join(f.control, "before.bin"), "utf8")).toBe("Local before restore");
	expect((await fs.stat(f.target)).nlink).toBe(1);
});

test("the inode that arrives at capture is retained even if an external writer races the precondition", async () => {
	const f = await fixture(), rename = fs.rename;
	jest.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => { await fs.writeFile(from, "Racing external edit"); await rename(from, to); });
	await expect(f.run()).rejects.toThrow("reviewed bytes");
	expect(await fs.readFile(path.join(f.control, "before.bin"), "utf8")).toBe("Racing external edit");
	await missing(f.target); await missing(path.join(f.control, "published.json"));
	await expect(f.restart()).rejects.toThrow("reviewed bytes");
	expect(await fs.readFile(path.join(f.control, "before.bin"), "utf8")).toBe("Racing external edit");
});

test("owned temporary publication links left by a crash can be reconciled after reopening", async () => {
	const f = await fixture(), rename = jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("before capture"));
	await expect(f.run()).rejects.toThrow("before capture"); rename.mockRestore();
	await fs.link(path.join(f.control, "intent.json"), path.join(f.control, crypto.randomUUID() + ".tmp"));
	await fs.link(path.join(f.control, "after.bin"), path.join(f.control, crypto.randomUUID() + ".tmp"));
	expect(await f.restart()).toMatchObject({ resumed: true });
	expect((await fs.readdir(f.control)).sort()).toEqual(["before.bin", "intent.json", "published.json"]);
	expect(await fs.readFile(f.target, "utf8")).toBe("Selected restored text");
});

test("an unexplained hard link to the intent cannot be treated as an owned crash artifact", async () => {
	const f = await fixture(), rename = jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("before capture"));
	await expect(f.run()).rejects.toThrow("before capture"); rename.mockRestore();
	await fs.link(path.join(f.control, "intent.json"), path.join(directory, "unrelated-link"));
	await expect(f.restart()).rejects.toThrow("unexplained hard link");
	expect(await fs.readFile(f.target, "utf8")).toBe("Local before restore");
});

test("unknown temporary-looking names are retained rather than reclaimed as owned publications", async () => {
	const f = await fixture(), rename = jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("before capture"));
	await expect(f.run()).rejects.toThrow("before capture"); rename.mockRestore();
	const unrelated = path.join(f.control, "-".repeat(36) + ".tmp"); await fs.writeFile(unrelated, "Unrecognized retained bytes");
	await expect(f.restart()).rejects.toThrow("Unexpected recovery operation content");
	expect(await fs.readFile(unrelated, "utf8")).toBe("Unrecognized retained bytes");
	expect(await fs.readFile(f.target, "utf8")).toBe("Local before restore");
});

test("a failed native publication leaves the preserved original and staged replacement available to resume", async () => {
	const f = await fixture(), link = fs.link;
	jest.spyOn(fs, "link").mockImplementation(async (from, to) => {
		if (String(to) === f.target) throw Object.assign(new Error("No space"), { code: "ENOSPC" });
		await link(from, to);
	});
	await expect(f.run()).rejects.toMatchObject({ code: "ENOSPC" }); jest.restoreAllMocks();
	expect(await fs.readFile(path.join(f.control, "before.bin"), "utf8")).toBe("Local before restore");
	expect(await fs.readFile(path.join(f.control, "after.bin"), "utf8")).toBe("Selected restored text");
	await missing(f.target); await f.restart(); expect(await fs.readFile(f.target, "utf8")).toBe("Selected restored text");
});

test("context loss after capture leaves the operation resumable without publishing stale work", async () => {
	const f = await fixture(), rename = fs.rename; let current = true;
	jest.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => { await rename(from, to); current = false; });
	await expect(f.run(() => { if (!current) throw new Error("lease expired"); })).rejects.toThrow("lease expired");
	await missing(f.target); expect(await fs.readFile(path.join(f.control, "before.bin"), "utf8")).toBe("Local before restore");
	jest.restoreAllMocks(); await f.restart(); expect(await fs.readFile(f.target, "utf8")).toBe("Selected restored text");
});

test("a competing file after capture prevents publication while retaining both versions", async () => {
	const f = await fixture(), link = fs.link;
	jest.spyOn(fs, "link").mockImplementation(async (from, to) => { if (String(to) === f.target) await fs.writeFile(f.target, "Competing native work"); await link(from, to); });
	await expect(f.run()).rejects.toMatchObject({ code: "EEXIST" }); jest.restoreAllMocks();
	expect(await fs.readFile(f.target, "utf8")).toBe("Competing native work");
	expect(await fs.readFile(path.join(f.control, "before.bin"), "utf8")).toBe("Local before restore");
	await expect(f.restart()).rejects.toThrow("occupies");
	expect(await fs.readFile(f.target, "utf8")).toBe("Competing native work");
});

test.each(["replace", "delete"])("a writer that immediately %ss the published file cannot redirect its receipt or be undone by retry", async kind => {
	const f = await fixture(), link = fs.link;
	jest.spyOn(fs, "link").mockImplementation(async (from, to) => {
		await link(from, to);
		if (String(to) === f.target) {
			if (kind === "delete") await fs.unlink(f.target);
			else { await fs.writeFile(f.target + ".new", "Immediate external replacement"); await fs.rename(f.target + ".new", f.target); }
		}
	});
	await expect(f.run()).rejects.toThrow("replaced after publication"); jest.restoreAllMocks();
	const staged = await fs.stat(path.join(f.control, "after.bin"), { bigint: true });
	expect(JSON.parse(await fs.readFile(path.join(f.control, "published.json"), "utf8"))).toEqual({ file: `${staged.dev}:${staged.ino}` });
	await expect(f.restart()).rejects.toThrow("replaced after publication");
	if (kind === "delete") await missing(f.target); else expect(await fs.readFile(f.target, "utf8")).toBe("Immediate external replacement");
	expect(await fs.readFile(path.join(f.control, "before.bin"), "utf8")).toBe("Local before restore");
});

test.each(["edit", "replace", "remove"])("a post-publication %s cannot be undone by retry", async kind => {
	const f = await fixture(); await f.run();
	if (kind === "remove") await fs.unlink(f.target);
	else if (kind === "replace") { await fs.writeFile(f.target + ".new", "Later work"); await fs.rename(f.target + ".new", f.target); }
	else await fs.writeFile(f.target, "Later work");
	await expect(f.restart()).rejects.toThrow();
	if (kind === "remove") await missing(f.target); else expect(await fs.readFile(f.target, "utf8")).toBe("Later work");
});

test("the restore hold continues blocking ordinary plugin writers through preservation and publication", async () => {
	const f = await fixture(), link = fs.link; let blocked = false;
	jest.spyOn(fs, "link").mockImplementation(async (from, to) => {
		if (String(to) === f.target) { await expect(trackNativeDocumentWrite(vault, "Team/Note.md", () => fs.writeFile(f.target, "Unsafe write"))).rejects.toMatchObject({ code: "native_source_write_held" }); blocked = true; }
		await link(from, to);
	});
	await f.run(); expect(blocked).toBe(true);
});

test.each(["symlink", "hard link", "directory"])("an original that is a %s is retained without publication", async kind => {
	const f = await fixture();
	if (kind === "hard link") await fs.link(f.target, path.join(directory, "Other.md"));
	else { await fs.unlink(f.target); if (kind === "directory") await fs.mkdir(f.target); else await fs.symlink(path.join(directory, "Outside"), f.target); }
	await expect(f.run()).rejects.toThrow(); await missing(path.join(f.control, "published.json"));
	expect(await fs.lstat(f.target)).toBeDefined();
});

test("changed review/plan, replaced root and corrupt receipts never authorize a second application", async () => {
	const f = await fixture(); await f.run();
	f.operation.reviewId = crypto.randomUUID(); await expect(f.run()).rejects.toThrow("saved recovery operation");
	const saved = JSON.parse(await fs.readFile(path.join(f.control, "intent.json"), "utf8")); f.operation.reviewId = saved.operation.reviewId;
	await fs.writeFile(path.join(f.control, "published.json"), '{"file":null,"extra":true}'); await expect(f.run()).rejects.toThrow("receipt");
	await fs.rename(path.join(directory, "Team"), path.join(directory, "Moved")); await fs.mkdir(path.join(directory, "Team"));
	await expect(f.run()).rejects.toThrow("native location changed");
	expect(await fs.readFile(path.join(directory, "Moved", "Note.md"), "utf8")).toBe("Selected restored text");
});

test("invalid replacement bytes, mobile hosts and changed context fail before native changes", async () => {
	const f = await fixture();
	await expect(applyDesktopSameFolderFileOperation(vault, f.operation, encode("Wrong"), f.hold)).rejects.toThrow("replacement bytes");
	await expect(f.run(() => { throw new Error("context changed"); })).rejects.toThrow("context changed");
	Object.assign(Platform, { isMobile: true }); await expect(f.run()).rejects.toThrow("host");
	expect(await fs.readFile(f.target, "utf8")).toBe("Local before restore"); await missing(f.control);
});

test.each(["equal content", "both absent", "bad path", "nested escape", "unknown field", "invalid digest"])("operation validation rejects %s", async kind => {
	const f = await fixture(), input: Record<string, unknown> = { ...f.operation };
	if (kind === "equal content") input.after = input.before;
	if (kind === "both absent") { input.before = null; input.after = null; }
	if (kind === "bad path") input.path = ".private/Note.md";
	if (kind === "nested escape") input.path = "../Other/Note.md";
	if (kind === "unknown field") input.extra = true;
	if (kind === "invalid digest") input.plan = { ...f.operation.plan, sha256: "wrong" };
	expect(() => parseSameFolderFileOperation(input)).toThrow();
});
