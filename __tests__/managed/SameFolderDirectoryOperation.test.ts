import * as os from "node:os";
import * as path from "node:path";
import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { applyDesktopSameFolderDirectoryOperation } from "../../src/DesktopSameFolderDirectoryOperation";
import { parseSameFolderDirectoryOperation, sameFolderDirectoryOperationPath, type SameFolderDirectoryOperation } from "../../src/SameFolderDirectoryOperation";
import { sourceInstallationPath } from "../../src/SourceInstallationPlan";
import { holdNativeSourceWrites, trackNativeDocumentWrite, type NativeSourceWriteHold } from "../../src/storage/native-document-writes";

const fs = require("fs/promises") as typeof import("node:fs/promises");
jest.mock("obsidian", () => ({ Platform: { isMobile: false }, FileSystemAdapter: class {} }));
let directory: string, vault: Vault;
const holds: NativeSourceWriteHold[] = [];
function newVault(): Vault { const adapter = new FileSystemAdapter(); adapter.getBasePath = () => directory; return { adapter } as unknown as Vault; }
beforeEach(async () => {
	directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "relay-native-directory-")));
	Object.assign(Platform, { isMobile: false }); vault = newVault();
});
afterEach(async () => { jest.restoreAllMocks(); holds.splice(0).forEach(hold => hold.release()); await fs.rm(directory, { recursive: true, force: true }); });
async function fixture(action: "create" | "remove" = "remove") {
	const operation: SameFolderDirectoryOperation = { format: "team-relay-native-directory-operation", version: 1, id: crypto.randomUUID(),
		plan: { id: crypto.randomUUID(), sha256: "a".repeat(64) }, reviewId: crypto.randomUUID(), root: "Team", path: "Folder", action };
	await fs.mkdir(path.join(directory, "Team"));
	await fs.mkdir(path.join(directory, sourceInstallationPath(operation.plan.id)), { recursive: true });
	const target = path.join(directory, "Team", "Folder"), control = path.join(directory, sameFolderDirectoryOperationPath(operation));
	if (action === "remove") await fs.mkdir(target);
	let hold = holdNativeSourceWrites(vault, "Team"); holds.push(hold); await hold.wait({ check: () => {} });
	const run = (check = () => {}) => applyDesktopSameFolderDirectoryOperation(vault, operation, hold, check);
	const restart = async () => {
		hold.release(); vault = newVault(); hold = holdNativeSourceWrites(vault, "Team"); holds.push(hold); await hold.wait({ check: () => {} }); return run();
	};
	return { operation, target, control, run, restart, hold };
}
async function missing(name: string) { await expect(fs.lstat(name)).rejects.toMatchObject({ code: "ENOENT" }); }

test("removal retains the empty directory inode and permissions and survives restart", async () => {
	const f = await fixture(), original = await fs.stat(f.target); await fs.chmod(f.target, 0o750);
	const result = await f.run(), retained = path.join(f.control, "before.dir");
	expect(result).toMatchObject({ resumed: false, operationId: f.operation.id, preservedPath: `${sameFolderDirectoryOperationPath(f.operation)}/before.dir` });
	await missing(f.target); expect((await fs.stat(retained)).ino).toBe(original.ino); expect((await fs.stat(retained)).mode & 0o777).toBe(0o750);
	expect(await fs.readdir(retained)).toEqual([]); expect(await f.restart()).toMatchObject({ resumed: true });
});

test("creation is exclusive and its saved receipt reopens the same empty directory", async () => {
	const f = await fixture("create"), result = await f.run(), original = await fs.stat(f.target, { bigint: true });
	expect(result).toMatchObject({ resumed: false, preservedPath: null });
	expect(JSON.parse(await fs.readFile(path.join(f.control, "applied.json"), "utf8"))).toEqual({ directory: `${original.dev}:${original.ino}` });
	expect(await f.restart()).toMatchObject({ resumed: true }); expect(await fs.readdir(f.target)).toEqual([]);
});

test.each(["file", "directory", "symlink"])("an existing %s prevents directory creation without being overwritten", async kind => {
	const f = await fixture("create");
	if (kind === "file") await fs.writeFile(f.target, "Unrelated work");
	else if (kind === "directory") { await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, "Local.md"), "Unrelated work"); }
	else await fs.symlink(path.join(directory, "Elsewhere"), f.target);
	await expect(f.run()).rejects.toThrow("no receipt"); await missing(path.join(f.control, "applied.json"));
	if (kind === "file") expect(await fs.readFile(f.target, "utf8")).toBe("Unrelated work");
	else if (kind === "directory") expect(await fs.readFile(path.join(f.target, "Local.md"), "utf8")).toBe("Unrelated work");
	else expect((await fs.lstat(f.target)).isSymbolicLink()).toBe(true);
});

test("a competing creation at mkdir is refused atomically", async () => {
	const f = await fixture("create"), mkdir = fs.mkdir;
	jest.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
		if (String(args[0]) === f.target) await mkdir(f.target);
		return mkdir(...args);
	});
	await expect(f.run()).rejects.toMatchObject({ code: "EEXIST" }); expect(await fs.readdir(f.target)).toEqual([]);
	await missing(path.join(f.control, "applied.json"));
});

test("an interruption after mkdir without a receipt is retained for explicit review", async () => {
	const f = await fixture("create"), mkdir = fs.mkdir;
	jest.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
		const result = await mkdir(...args); if (String(args[0]) === f.target) throw new Error("after mkdir"); return result;
	});
	await expect(f.run()).rejects.toThrow("after mkdir"); jest.restoreAllMocks();
	await fs.writeFile(path.join(f.target, "Later.md"), "Local work after interruption");
	await expect(f.restart()).rejects.toThrow("no receipt");
	expect(await fs.readFile(path.join(f.target, "Later.md"), "utf8")).toBe("Local work after interruption");
});

test.each(["capture record", "before move", "after move", "applied receipt"])("removal resumes after interruption at %s", async point => {
	const f = await fixture(), rename = fs.rename, link = fs.link; let fired = false;
	jest.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (point === "before move" && !fired) { fired = true; throw new Error("interrupted"); }
		await rename(from, to); if (point === "after move" && !fired) { fired = true; throw new Error("interrupted"); }
	});
	jest.spyOn(fs, "link").mockImplementation(async (from, to) => {
		await link(from, to);
		if (!fired && (point === "capture record" && String(to).endsWith("/captured.json") || point === "applied receipt" && String(to).endsWith("/applied.json"))) { fired = true; throw new Error("interrupted"); }
	});
	await expect(f.run()).rejects.toThrow("interrupted"); expect(fired).toBe(true); jest.restoreAllMocks();
	expect(await f.restart()).toMatchObject({ resumed: true }); await missing(f.target); expect(await fs.readdir(path.join(f.control, "before.dir"))).toEqual([]);
});

test("creation resumes after a lost applied-receipt response", async () => {
	const f = await fixture("create"), link = fs.link;
	jest.spyOn(fs, "link").mockImplementation(async (from, to) => { await link(from, to); if (String(to).endsWith("/applied.json")) throw new Error("lost response"); });
	await expect(f.run()).rejects.toThrow("lost response"); jest.restoreAllMocks(); expect(await f.restart()).toMatchObject({ resumed: true });
});

test("nonempty removal does not move or recursively delete unreviewed content", async () => {
	const f = await fixture(); await fs.writeFile(path.join(f.target, ".hidden"), "Private local content");
	await expect(f.run()).rejects.toThrow("unexpected work"); expect(await fs.readFile(path.join(f.target, ".hidden"), "utf8")).toBe("Private local content");
	await missing(path.join(f.control, "before.dir")); await missing(path.join(f.control, "applied.json"));
});

test.each(["new contents", "replacement"])("a racing writer's %s at removal are retained and prevent completion", async kind => {
	const f = await fixture(), rename = fs.rename;
	jest.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
		if (kind === "replacement") { await rename(from, f.target + ".old"); await fs.mkdir(from); }
		await fs.writeFile(path.join(String(from), "Racing.md"), "Racing work"); await rename(from, to);
	});
	await expect(f.run()).rejects.toThrow(); jest.restoreAllMocks();
	expect(await fs.readFile(path.join(f.control, "before.dir", "Racing.md"), "utf8")).toBe("Racing work"); await missing(path.join(f.control, "applied.json"));
	await expect(f.restart()).rejects.toThrow(); expect(await fs.readFile(path.join(f.control, "before.dir", "Racing.md"), "utf8")).toBe("Racing work");
});

test("context loss after retaining a directory does not publish completion and can resume", async () => {
	const f = await fixture(), rename = fs.rename; let valid = true;
	jest.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => { await rename(from, to); valid = false; });
	await expect(f.run(() => { if (!valid) throw new Error("isolation expired"); })).rejects.toThrow("isolation expired");
	await missing(f.target); await missing(path.join(f.control, "applied.json")); jest.restoreAllMocks();
	expect(await f.restart()).toMatchObject({ resumed: true });
});

test.each(["create", "remove"] as const)("later work after %s cannot be removed or adopted by retry", async action => {
	const f = await fixture(action); await f.run();
	if (action === "remove") await fs.mkdir(f.target);
	await fs.writeFile(path.join(f.target, "Later.md"), "New work");
	await expect(f.restart()).rejects.toThrow(); expect(await fs.readFile(path.join(f.target, "Later.md"), "utf8")).toBe("New work");
});

test("replacement or deletion after directory creation cannot be silently repaired by retry", async () => {
	const f = await fixture("create"); await f.run(); await fs.rename(f.target, f.target + ".original"); await fs.mkdir(f.target);
	await expect(f.restart()).rejects.toThrow("directory changed"); await fs.rmdir(f.target);
	await expect(f.restart()).rejects.toThrow("directory changed"); await missing(f.target);
});

test("owned temporary receipt links are reclaimed only beneath the verified control directory", async () => {
	const f = await fixture(), rename = jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("before move"));
	await expect(f.run()).rejects.toThrow("before move"); rename.mockRestore();
	for (const name of ["intent.json", "captured.json"]) await fs.link(path.join(f.control, name), path.join(f.control, crypto.randomUUID() + ".tmp"));
	expect(await f.restart()).toMatchObject({ resumed: true });
	expect((await fs.readdir(f.control)).sort()).toEqual(["applied.json", "before.dir", "captured.json", "intent.json"]);
});

test("corrupt control metadata and unrecognized files cannot authorize a directory operation", async () => {
	const f = await fixture(), rename = jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("before move"));
	await expect(f.run()).rejects.toThrow("before move"); rename.mockRestore();
	const unknown = path.join(f.control, "unknown.tmp"); await fs.writeFile(unknown, "Retained data");
	await expect(f.restart()).rejects.toThrow("Unexpected"); expect(await fs.readFile(unknown, "utf8")).toBe("Retained data"); await fs.unlink(unknown);
	await fs.writeFile(path.join(f.control, "captured.json"), '{"directory":"1:2","extra":true}');
	await expect(f.restart()).rejects.toThrow("receipt"); expect((await fs.stat(f.target)).isDirectory()).toBe(true);
});

test("registered writers remain fenced during directory removal", async () => {
	const f = await fixture(), rename = fs.rename; let blocked = false;
	jest.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		await expect(trackNativeDocumentWrite(vault, "Team/Folder/New.md", () => fs.writeFile(path.join(f.target, "New.md"), "Unsafe"))).rejects.toMatchObject({ code: "native_source_write_held" });
		blocked = true; await rename(from, to);
	});
	await f.run(); expect(blocked).toBe(true);
});

test.each(["symlink", "file"])("a %s is never removed as a directory", async kind => {
	const f = await fixture(); await fs.rmdir(f.target);
	if (kind === "file") await fs.writeFile(f.target, "Local work"); else await fs.symlink(path.join(directory, "Elsewhere"), f.target);
	await expect(f.run()).rejects.toThrow("directory changed"); expect(await fs.lstat(f.target)).toBeDefined(); await missing(path.join(f.control, "before.dir"));
});

test("a changed operation or root cannot reuse a directory receipt", async () => {
	const f = await fixture(); await f.run(); const original = f.operation.reviewId;
	f.operation.reviewId = crypto.randomUUID(); await expect(f.restart()).rejects.toThrow("native location changed"); f.operation.reviewId = original;
	await fs.rename(path.join(directory, "Team"), path.join(directory, "Old Team")); await fs.mkdir(path.join(directory, "Team"));
	await expect(f.restart()).rejects.toThrow("native location changed");
});

test("invalid descriptors, mobile hosts and released holds fail before native changes", async () => {
	const f = await fixture(); expect(() => parseSameFolderDirectoryOperation({ ...f.operation, path: "../Outside" })).toThrow();
	expect(() => parseSameFolderDirectoryOperation({ ...f.operation, action: "recursive-remove" })).toThrow();
	Object.assign(Platform, { isMobile: true }); await expect(f.run()).rejects.toThrow("host"); Object.assign(Platform, { isMobile: false });
	f.hold.release(); await expect(f.run()).rejects.toThrow("released"); expect((await fs.stat(f.target)).isDirectory()).toBe(true);
});
