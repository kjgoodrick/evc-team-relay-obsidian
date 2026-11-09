import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { parseSameFolderDirectoryOperation, sameFolderDirectoryOperationPath, type SameFolderDirectoryOperation } from "./SameFolderDirectoryOperation";
import type { NativeSourceWriteHold } from "./storage/native-document-writes";

const temporaryName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
const identityPattern = /^\d+:\d+$/;

/** Create an exclusive empty directory, or retain/remove a reviewed empty
 * directory. Never recursively delete native work. The applying journal and
 * external writer/editor isolation belong to the caller. An interrupted mkdir
 * without an applied receipt is ambiguous and requires review, not adoption.
 * This is not an OS lock against arbitrary parent/directory replacement. */
export async function applyDesktopSameFolderDirectoryOperation(vault: Vault, input: SameFolderDirectoryOperation,
	hold: NativeSourceWriteHold, checkContext = () => {}) {
	const operation = parseSameFolderDirectoryOperation(input);
	if (Platform.isMobile || typeof FileSystemAdapter !== "function" || !(vault.adapter instanceof FileSystemAdapter)) throw new Error("This host does not provide native directory recovery");
	const adapter = vault.adapter, base = adapter.getBasePath();
	const check = () => {
		if (vault.adapter !== adapter || adapter.getBasePath() !== base) throw new Error("The recovery vault changed");
		checkContext();
	};
	check();
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- established desktop capability
	const fs = require("fs/promises") as typeof import("node:fs/promises");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop filesystem paths
	const paths = require("path") as typeof import("node:path");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- no-follow metadata reads are required
	const { constants } = require("fs") as typeof import("node:fs");
	if (!paths.isAbsolute(base) || !constants.O_NOFOLLOW) throw new Error("Native directory recovery capability is unavailable");
	const targetName = `${operation.root}/${operation.path}`, controlName = sameFolderDirectoryOperationPath(operation);
	const id = (value: { dev: bigint; ino: bigint }) => `${value.dev}:${value.ino}`;
	const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
	const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
	const same = (a: ArrayBuffer, b: ArrayBuffer) => {
		const left = new Uint8Array(a), right = new Uint8Array(b);
		return left.length === right.length && left.every((byte, i) => byte === right[i]);
	};
	return hold.write(targetName, async () => {
		check(); const realBase = await fs.realpath(base), baseStat = await fs.stat(realBase, { bigint: true }); check();
		if (!baseStat.isDirectory()) throw new Error("The recovery vault is not a directory");
		const directoryIds = new Map<string, string>();
		const locate = async (relative: string) => {
			check(); const currentBase = await fs.realpath(base), current = await fs.stat(currentBase, { bigint: true }); check();
			if (currentBase !== realBase || !current.isDirectory() || id(current) !== id(baseStat)) throw new Error("The recovery vault location changed");
			let parent = realBase;
			for (const part of relative.split("/").slice(0, -1)) {
				parent = paths.join(parent, part); const value = await fs.lstat(parent, { bigint: true }); check();
				if (!value.isDirectory() || value.isSymbolicLink() || directoryIds.has(parent) && directoryIds.get(parent) !== id(value)) throw new Error("A recovery parent directory changed");
				directoryIds.set(parent, id(value));
			}
			return paths.join(realBase, ...relative.split("/"));
		};
		const stat = async (absolute: string) => {
			try { const result = await fs.lstat(absolute, { bigint: true }); check(); return result; }
			catch (error) { check(); if (missing(error)) return null; throw error; }
		};
		const syncDirectory = async (absolute: string) => {
			const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
			try { await handle.sync(); } finally { await handle.close(); }
		};
		const read = async (absolute: string, maxBytes: number, links = 1) => {
			const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				check(); const before = await handle.stat({ bigint: true }); check();
				if (!before.isFile() || before.nlink !== BigInt(links) || before.size < BigInt(0) || before.size > BigInt(maxBytes)) throw new Error("Unsafe recovery metadata");
				const bytes = new Uint8Array(Number(before.size)); let offset = 0;
				while (offset < bytes.length) {
					const result = await handle.read(bytes, offset, bytes.length - offset, offset); check();
					if (!result.bytesRead) throw new Error("Recovery metadata changed while reading"); offset += result.bytesRead;
				}
				const after = await handle.stat({ bigint: true }), current = await stat(absolute); check();
				if (!current?.isFile() || current.nlink !== BigInt(links) || id(current) !== id(after) || before.size !== after.size
					|| before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.size !== after.size
					|| current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) throw new Error("Recovery metadata changed while reading");
				return bytes.buffer;
			} finally { await handle.close(); }
		};
		// Test emptiness with one directory read, without recursively listing or
		// deleting any entries. Recheck identity/timestamps across the read.
		const empty = async (absolute: string, expected?: string) => {
			const before = await stat(absolute);
			if (!before?.isDirectory() || expected && id(before) !== expected) throw new Error("The reviewed directory changed");
			const handle = await fs.opendir(absolute); let first: import("node:fs").Dirent | null;
			try { first = await handle.read(); } finally { await handle.close(); }
			check(); const after = await stat(absolute);
			if (!after?.isDirectory() || id(before) !== id(after) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("The reviewed directory changed while being inspected");
			if (first) throw new Error("The reviewed directory contains unexpected work; retained contents require review");
			return before;
		};
		const target = await locate(targetName), root = await locate(operation.root), rootStat = await stat(root), parent = paths.dirname(target), parentStat = await stat(parent);
		if (!rootStat?.isDirectory() || !parentStat?.isDirectory()) throw new Error("The reviewed directory root or parent is missing");
		const operationsName = controlName.slice(0, controlName.lastIndexOf("/")), operations = await locate(operationsName);
		if (!await stat(operations)) { check(); await fs.mkdir(operations); await syncDirectory(paths.dirname(operations)); }
		const control = await locate(controlName); let controlStat = await stat(control), created = false;
		if (!controlStat) { check(); await fs.mkdir(control); await syncDirectory(paths.dirname(control)); controlStat = await stat(control); created = true; }
		if (!controlStat?.isDirectory()) throw new Error("The directory recovery control location is unavailable");
		const intent = encode({ operation, vault: id(baseStat), root: id(rootStat), parent: id(parentStat), control: id(controlStat) });
		const intentPath = paths.join(control, "intent.json"), capturedPath = paths.join(control, "captured.json"), retainedPath = paths.join(control, "before.dir"), receiptPath = paths.join(control, "applied.json");
		const writeExclusive = async (absolute: string, bytes: ArrayBuffer) => {
			const temporary = paths.join(control, crypto.randomUUID() + ".tmp"); check();
			const handle = await fs.open(temporary, "wx", 0o600);
			try {
				try { await handle.writeFile(new Uint8Array(bytes)); check(); await handle.sync(); } finally { await handle.close(); }
				check(); await fs.link(temporary, absolute); await syncDirectory(control);
			} finally { await fs.unlink(temporary); await syncDirectory(control); }
		};
		if (created) await writeExclusive(intentPath, intent);
		const readIntent = async () => {
			const value = await stat(intentPath);
			if (value?.nlink === BigInt(2)) {
				const entries = await fs.opendir(control); let found = false, count = 0;
				for await (const entry of entries) {
					if (++count > 68) throw new Error("Too many directory recovery control files");
					if (temporaryName.test(entry.name)) { const temporary = await stat(paths.join(control, entry.name)); if (temporary?.isFile() && id(temporary) === id(value)) found = true; }
				}
				if (!found) throw new Error("The directory recovery intent has an unexplained hard link");
			}
			return read(intentPath, 16 * 1024, value?.nlink === BigInt(2) ? 2 : 1);
		};
		if (!same(await readIntent(), intent)) throw new Error("The saved directory operation or native location changed");
		const guard = async () => {
			await locate(targetName); await locate(`${controlName}/intent.json`);
			const original = await stat(root), owner = await stat(control), container = await stat(parent);
			if (!original?.isDirectory() || id(original) !== id(rootStat) || !owner?.isDirectory() || id(owner) !== id(controlStat!)
				|| !container?.isDirectory() || id(container) !== id(parentStat) || !same(await readIntent(), intent)) throw new Error("The directory recovery operation location changed");
		};
		const listing = await fs.opendir(control); let count = 0;
		for await (const entry of listing) {
			if (++count > 68) throw new Error("Too many directory recovery control files");
			if (["intent.json", "captured.json", "before.dir", "applied.json"].includes(entry.name)) continue;
			if (!temporaryName.test(entry.name)) throw new Error("Unexpected directory recovery control content");
			const temporary = paths.join(control, entry.name), value = await stat(temporary);
			if (!value?.isFile() || value.nlink < BigInt(1) || value.nlink > BigInt(2) || value.size > BigInt(16 * 1024)) throw new Error("Unsafe directory recovery temporary file");
			await guard(); await fs.unlink(temporary); await syncDirectory(control);
		}
		const readIdentity = async (absolute: string) => {
			const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(absolute, 1024)));
			if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || !("directory" in value)
				|| typeof value.directory !== "string" || !identityPattern.test(value.directory)) throw new Error("Invalid directory recovery receipt");
			return value.directory;
		};
		const finish = async (identity: string, resumed: boolean) => {
			await guard();
			if (operation.action === "create") {
				if (await stat(capturedPath) || await stat(retainedPath)) throw new Error("Unexpected retained original for a directory creation");
				await empty(target, identity);
			} else {
				if (await readIdentity(capturedPath) !== identity) throw new Error("The retained directory identity changed");
				await empty(retainedPath, identity);
				if (await stat(target)) throw new Error("Another entry appeared after the reviewed directory removal");
			}
			await guard(); return { operationId: operation.id, resumed, preservedPath: operation.action === "remove" ? `${controlName}/before.dir` : null };
		};
		await guard();
		if (await stat(receiptPath)) return finish(await readIdentity(receiptPath), true);
		let identity: string;
		if (operation.action === "create") {
			if (await stat(capturedPath) || await stat(retainedPath)) throw new Error("Unexpected retained original for a directory creation");
			if (await stat(target)) throw new Error("The directory creation has no receipt; preserve this entry and review it before continuing");
			await guard(); check(); await fs.mkdir(target); await syncDirectory(parent);
			// mkdir has no inode return value. Record the first empty directory
			// observed after successful exclusive creation; caller isolation remains
			// necessary against replacement before this observation.
			identity = id(await empty(target));
		} else {
			if (await stat(capturedPath)) identity = await readIdentity(capturedPath);
			else {
				if (await stat(retainedPath)) throw new Error("The retained directory has no capture receipt");
				identity = id(await empty(target)); await guard(); await writeExclusive(capturedPath, encode({ directory: identity }));
			}
			if (!await stat(retainedPath)) {
				await guard(); await empty(target, identity); check();
				if (await stat(retainedPath)) throw new Error("A retained directory appeared during recovery");
				await fs.rename(target, retainedPath); await syncDirectory(parent); await syncDirectory(control);
			}
			// A racing writer's contents are retained here, never recursively
			// deleted. Any extra entry or substituted inode prevents completion.
			await empty(retainedPath, identity);
			if (await stat(target)) throw new Error("Another entry appeared during directory removal; all versions are retained");
		}
		await guard(); await writeExclusive(receiptPath, encode({ directory: identity }));
		return finish(identity, !created);
	});
}
