import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { sha256Hex } from "./contentDigest";
import { parseSameFolderFileOperation, sameFolderOperationPath, type SameFolderFileOperation } from "./SameFolderFileOperation";
import type { InstallationArtifact } from "./SourceInstallationPlan";
import type { NativeSourceWriteHold } from "./storage/native-document-writes";

const temporaryName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;

/** Apply one file operation under an already-drained native write hold. The
 * caller must keep its durable source journal applying and isolate untracked
 * writers. This never changes mappings/caches or activates synchronization.
 * The old inode is retained before exclusive publication, so publication never
 * overwrites a new arrival. A temporary path gap needs host/editor coordination.
 * Filesystem checks are not an OS lock against arbitrary parent replacement. */
export async function applyDesktopSameFolderFileOperation(vault: Vault, input: SameFolderFileOperation,
	afterInput: ArrayBuffer | null, hold: NativeSourceWriteHold, checkContext = () => {}) {
	const operation = parseSameFolderFileOperation(input);
	if (Platform.isMobile || typeof FileSystemAdapter !== "function" || !(vault.adapter instanceof FileSystemAdapter)) throw new Error("This host does not provide native file recovery");
	const adapter = vault.adapter, base = adapter.getBasePath();
	const check = () => {
		if (vault.adapter !== adapter || adapter.getBasePath() !== base) throw new Error("The recovery vault changed");
		checkContext();
	};
	check();
	if (operation.after ? afterInput === null || new DataView(afterInput).byteLength !== operation.after.bytes : afterInput !== null) throw new Error("The replacement bytes do not match the reviewed operation");
	const afterBytes = afterInput === null ? null : ArrayBuffer.prototype.slice.call(afterInput, 0) as ArrayBuffer;
	if (afterBytes !== null && await sha256Hex(afterBytes) !== operation.after!.sha256) throw new Error("The replacement digest does not match the reviewed operation");
	check();
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop capability established before loading Node
	const fs = require("fs/promises") as typeof import("node:fs/promises");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only filesystem paths
	const paths = require("path") as typeof import("node:path");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- no-follow file handles are mandatory
	const { constants } = require("fs") as typeof import("node:fs");
	if (!paths.isAbsolute(base) || !constants.O_NOFOLLOW) throw new Error("Native file recovery capability is unavailable");
	const targetName = `${operation.root}/${operation.path}`, controlName = sameFolderOperationPath(operation);
	const id = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`;
	const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
	const same = (a: ArrayBuffer, b: ArrayBuffer) => {
		const left = new Uint8Array(a), right = new Uint8Array(b);
		return left.length === right.length && left.every((byte, i) => byte === right[i]);
	};
	check();
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
			try { const value = await fs.lstat(absolute, { bigint: true }); check(); return value; }
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
				if (!before.isFile() || before.nlink !== BigInt(links) || before.size < BigInt(0) || before.size > BigInt(maxBytes)) throw new Error("A recovery file is unsafe or too large");
				const bytes = new Uint8Array(Number(before.size)); let offset = 0;
				while (offset < bytes.length) {
					const result = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset); check();
					if (!result.bytesRead) throw new Error("A recovery file changed while being read"); offset += result.bytesRead;
				}
				const after = await handle.stat({ bigint: true }), current = await stat(absolute); check();
				if (!current || !current.isFile() || current.nlink !== BigInt(links) || id(current) !== id(after)
					|| before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
					|| current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) throw new Error("A recovery file changed while being read");
				return { bytes: bytes.buffer, stat: after };
			} finally { await handle.close(); }
		};
		const verify = async (absolute: string, expected: InstallationArtifact, links = 1) => {
			const result = await read(absolute, expected.bytes, links);
			if (result.bytes.byteLength !== expected.bytes || await sha256Hex(result.bytes) !== expected.sha256) throw new Error("A recovery file no longer matches its reviewed bytes");
			check(); return result.stat;
		};
		const target = await locate(targetName), root = await locate(operation.root), rootStat = await stat(root);
		if (!rootStat?.isDirectory()) throw new Error("The original working folder is missing");
		const parent = paths.dirname(target), parentStat = await stat(parent);
		if (!parentStat?.isDirectory()) throw new Error("The reviewed file parent is missing");
		const operationsName = controlName.slice(0, controlName.lastIndexOf("/")), operations = await locate(operationsName);
		if (!await stat(operations)) { check(); await fs.mkdir(operations); await syncDirectory(paths.dirname(operations)); }
		const control = await locate(controlName); let controlStat = await stat(control), created = false;
		if (!controlStat) { check(); await fs.mkdir(control); await syncDirectory(paths.dirname(control)); controlStat = await stat(control); created = true; }
		if (!controlStat?.isDirectory()) throw new Error("The recovery operation directory is unavailable");
		const intent = new TextEncoder().encode(JSON.stringify({ operation, vault: id(baseStat), root: id(rootStat), parent: id(parentStat), control: id(controlStat) })).buffer;
		const intentPath = paths.join(control, "intent.json"), beforePath = paths.join(control, "before.bin"), afterPath = paths.join(control, "after.bin"), receiptPath = paths.join(control, "published.json");
		const writeExclusive = async (absolute: string, bytes: ArrayBuffer, mode = 0o600) => {
			const temporary = paths.join(control, crypto.randomUUID() + ".tmp");
			check(); const handle = await fs.open(temporary, "wx", mode);
			try {
				try { await handle.chmod(mode); await handle.writeFile(new Uint8Array(bytes)); check(); await handle.sync(); } finally { await handle.close(); }
				check(); await fs.link(temporary, absolute); await syncDirectory(control);
			} finally { await fs.unlink(temporary); await syncDirectory(control); }
		};
		if (created) await writeExclusive(intentPath, intent);
		const readIntent = async () => {
			const value = await stat(intentPath);
			if (value?.nlink === BigInt(2)) {
				const entries = await fs.opendir(control); let found = false, count = 0;
				for await (const entry of entries) {
					if (++count > 68) throw new Error("The recovery operation has too many control files");
					if (temporaryName.test(entry.name)) {
						const temporary = await stat(paths.join(control, entry.name)); if (temporary?.isFile() && id(temporary) === id(value)) found = true;
					}
				}
				if (!found) throw new Error("The recovery intent has an unexplained hard link");
			}
			return (await read(intentPath, 16 * 1024, value?.nlink === BigInt(2) ? 2 : 1)).bytes;
		};
		if (!same(await readIntent(), intent)) throw new Error("The saved recovery operation or native location changed");
		const guard = async () => {
			await locate(targetName); await locate(`${controlName}/intent.json`);
			const original = await stat(root), owner = await stat(control), container = await stat(parent);
			if (!original?.isDirectory() || id(original) !== id(rootStat) || !owner?.isDirectory() || id(owner) !== id(controlStat!)
				|| !container?.isDirectory() || id(container) !== id(parentStat)) throw new Error("The recovery operation location changed");
			if (!same(await readIntent(), intent)) throw new Error("The saved recovery operation changed");
		};
		// Only private temporary publications in this verified operation directory
		// may be removed. Unrecognized files and links are retained for review.
		const directory = await fs.opendir(control); let count = 0;
		for await (const entry of directory) {
			if (++count > 68) throw new Error("The recovery operation has too many control files");
			if (["intent.json", "before.bin", "after.bin", "published.json"].includes(entry.name)) continue;
			if (!temporaryName.test(entry.name)) throw new Error("Unexpected recovery operation content");
			const temporary = paths.join(control, entry.name), value = await stat(temporary);
			if (!value?.isFile() || value.nlink < BigInt(1) || value.nlink > BigInt(2) || value.size > BigInt(256 * 1024 * 1024)) throw new Error("Unsafe recovery temporary file");
			await guard(); await fs.unlink(temporary); await syncDirectory(control);
		}
		await guard();
		const finish = async (receipt: { file: string | null }, resumed: boolean) => {
			await guard(); const current = await stat(target);
			if (operation.after) {
				if (!current || id(current) !== receipt.file) throw new Error("The recovered file was replaced after publication");
				const staged = await stat(afterPath), linked = staged && id(staged) === id(current);
				await verify(target, operation.after, linked ? 2 : 1);
				if (staged) {
					if (!linked) throw new Error("The recovery staging file changed after publication");
					await fs.unlink(afterPath); await syncDirectory(control);
				}
			} else if (current || receipt.file !== null) throw new Error("A file appeared after the reviewed removal");
			if (operation.before) await verify(beforePath, operation.before);
			await guard();
			return { operationId: operation.id, resumed, preservedPath: operation.before ? `${controlName}/before.bin` : null };
		};
		if (await stat(receiptPath)) {
			const receipt: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode((await read(receiptPath, 1024)).bytes));
			if (!receipt || typeof receipt !== "object" || Object.keys(receipt).length !== 1 || !("file" in receipt)
				|| receipt.file !== null && (typeof receipt.file !== "string" || !/^\d+:\d+$/.test(receipt.file))) throw new Error("Invalid recovery publication receipt");
			return finish(receipt as { file: string | null }, true);
		}
		let retained = await stat(beforePath), existing = await stat(target), staged = await stat(afterPath);
		if (operation.before) {
			if (retained) await verify(beforePath, operation.before);
			else {
				if (!existing) throw new Error("The original file disappeared before it was preserved");
				await verify(target, operation.before);
			}
		} else if (retained) throw new Error("Unexpected preserved original for a new file");
		if (operation.after) {
			if (!staged) { await guard(); await writeExclusive(afterPath, afterBytes!, Number((retained ?? existing)?.mode ?? BigInt(0o600)) & 0o777); staged = await stat(afterPath); }
			const linked = !!existing && !!staged && id(existing) === id(staged);
			await verify(afterPath, operation.after, linked ? 2 : 1);
		} else if (staged) throw new Error("Unexpected replacement bytes for a removal");
		if (operation.before && !retained) {
			await guard(); await verify(target, operation.before); check();
			if (await stat(beforePath)) throw new Error("A preserved original appeared during recovery; review the operation");
			await fs.rename(target, beforePath); await syncDirectory(parent); await syncDirectory(control);
			// Rename retains the actual inode at the boundary. If an untracked
			// writer swapped it after the check, preserve it and stop; never publish
			// the selected bytes over that newly observed work.
			await verify(beforePath, operation.before); retained = await stat(beforePath);
		}
		await guard(); existing = await stat(target);
		if (operation.after) {
			staged = await stat(afterPath);
			if (existing) {
				if (!staged || id(existing) !== id(staged)) throw new Error("Another file occupies the recovery destination; all versions are retained");
				await verify(target, operation.after, 2);
			} else {
				await verify(afterPath, operation.after); await guard(); check();
				await fs.link(afterPath, target); await syncDirectory(parent);
			}
		} else if (existing) throw new Error("Another file appeared during recovery removal; all versions are retained");
		// Bind the inode we published, not whichever inode is observed at the
		// destination later. An immediate external replacement/deletion must be
		// recognized on retry instead of being adopted or silently recreated.
		const receipt = { file: operation.after ? id(staged!) : null };
		await guard(); await writeExclusive(receiptPath, new TextEncoder().encode(JSON.stringify(receipt)).buffer);
		return finish(receipt, !created);
	});
}
