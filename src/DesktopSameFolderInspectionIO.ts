import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { requireRecoveryRelativePath } from "./ManagedRecoveryArchive";
import { sourceInstallationNativeRoot } from "./SourceInstallationPlan";
import type { SameFolderInspectionIO } from "./SameFolderSourceInspection";

/** Desktop read-only recovery inspection. No files, ownership markers or
 * directories are created. Identity checks detect ordinary replacement; this
 * does not lock arbitrary external processes or provide a whole-tree snapshot. */
export function createDesktopSameFolderInspectionIO(vault: Vault, inputRoot: string, checkContext = () => {}): SameFolderInspectionIO {
	if (Platform.isMobile || typeof FileSystemAdapter !== "function" || !(vault.adapter instanceof FileSystemAdapter)) throw new Error("This host does not provide native recovery inspection");
	const root = sourceInstallationNativeRoot(inputRoot), adapter = vault.adapter, base = adapter.getBasePath();
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- established desktop capability
	const fs = require("fs/promises") as typeof import("node:fs/promises");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop filesystem paths
	const paths = require("path") as typeof import("node:path");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- require no-follow native reads
	const { constants } = require("fs") as typeof import("node:fs");
	if (!paths.isAbsolute(base) || !constants.O_NOFOLLOW) throw new Error("The native inspection filesystem capability is unavailable");
	const identity = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`;
	let realBase: string | undefined, vaultIdentity: string | undefined;
	const directories = new Map<string, string>();
	const check = () => {
		if (vault.adapter !== adapter || adapter.getBasePath() !== base) throw new Error("The native inspection vault changed");
		checkContext();
	};
	const rememberDirectory = (name: string, stat: import("node:fs").BigIntStats) => {
		if (!stat.isDirectory() || stat.isSymbolicLink() || directories.has(name) && directories.get(name) !== identity(stat)) throw new Error("A native inspection directory changed");
		if (!directories.has(name) && directories.size >= 100_001) throw new Error("The native inspection directory limit was exceeded");
		directories.set(name, identity(stat));
	};
	const locate = async (relative: string) => {
		requireRecoveryRelativePath(relative);
		if (relative !== root && !relative.startsWith(root + "/") || new TextEncoder().encode(relative).byteLength > 4096) throw new Error("The native path is outside the inspected folder");
		check(); const current = await fs.realpath(base); check();
		const baseStat = await fs.stat(current, { bigint: true }); check();
		if (realBase === undefined) { realBase = current; vaultIdentity = identity(baseStat); }
		if (!baseStat.isDirectory() || current !== realBase || identity(baseStat) !== vaultIdentity) throw new Error("The native inspection vault location changed");
		let parent = realBase;
		for (const part of relative.split("/").slice(0, -1)) {
			parent = paths.join(parent, part); const value = await fs.lstat(parent, { bigint: true }); check(); rememberDirectory(parent, value);
		}
		return paths.join(realBase, ...relative.split("/"));
	};
	const inspect = async (relative: string) => {
		const absolute = await locate(relative);
		let value: import("node:fs").BigIntStats;
		try { value = await fs.lstat(absolute, { bigint: true }); } catch (error) {
			check(); if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
		}
		check();
		if (value.isDirectory()) rememberDirectory(absolute, value);
		else if (!value.isFile() || value.nlink !== BigInt(1)) throw new Error("The native inspection entry is not an independent regular file");
		return { absolute, value };
	};
	return {
		root,
		stat: async relative => {
			const result = await inspect(relative);
			return result ? { type: result.value.isDirectory() ? "folder" : "file", size: Number(result.value.size) } : null;
		},
		list: async (relative, maxEntries) => {
			if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_001) throw new Error("Invalid native directory inspection limit");
			const before = await inspect(relative);
			if (!before?.value.isDirectory()) throw new Error("The native inspection directory is unavailable");
			const handle = await fs.opendir(before.absolute), result: string[] = [];
			for await (const entry of handle) {
				check(); if (result.length >= maxEntries) throw new Error("The native directory exceeds its inspection limit");
				result.push(entry.name);
			}
			const after = await inspect(relative);
			if (!after || identity(before.value) !== identity(after.value) || before.value.mtimeNs !== after.value.mtimeNs
				|| before.value.ctimeNs !== after.value.ctimeNs) throw new Error("A native directory changed while being listed");
			check(); return result;
		},
		readBinary: async (relative, maxBytes) => {
			if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 256 * 1024 * 1024) throw new Error("Invalid native file inspection limit");
			const absolute = await locate(relative), handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				check(); const before = await handle.stat({ bigint: true }); check();
				if (!before.isFile() || before.nlink !== BigInt(1) || before.size < BigInt(0) || before.size > BigInt(maxBytes)) throw new Error("The native inspection file is unsafe or too large");
				const bytes = new Uint8Array(Number(before.size)); let offset = 0;
				while (offset < bytes.byteLength) {
					const result = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.byteLength - offset), offset); check();
					if (!result.bytesRead) throw new Error("The native inspection file changed while reading");
					offset += result.bytesRead;
				}
				const after = await handle.stat({ bigint: true }), current = await inspect(relative); check();
				if (!current || !current.value.isFile() || identity(current.value) !== identity(after)
					|| before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
					|| current.value.size !== after.size || current.value.mtimeNs !== after.mtimeNs || current.value.ctimeNs !== after.ctimeNs) throw new Error("The native inspection file changed while reading");
				return bytes.buffer;
			} finally { await handle.close(); }
		},
	};
}
