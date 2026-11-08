import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { parseSourceInstallationPlan, type SourceInstallationPlan } from "./SourceInstallationPlan";
import { INSTALLATION_METADATA, type SourceNativeInstallationIO } from "./SourceInstallationMaterialization";

/** Desktop new-folder installer. The hidden marker survives a process restart;
 * final files appear through exclusive hard-link publication after fsync. This
 * requires a filesystem with hard-link support. It never falls back to overwrite
 * or check-then-write, and is not an OS lock against other processes. */
export function createDesktopSourceMaterializationIO(vault: Vault, input: SourceInstallationPlan,
	checkContext = () => {}): SourceNativeInstallationIO {
	if (Platform.isMobile || typeof FileSystemAdapter !== "function" || !(vault.adapter instanceof FileSystemAdapter)) {
		throw new Error("This host does not provide exclusive native source installation");
	}
	const plan = parseSourceInstallationPlan(input), root = plan.destinationRoot;
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop capability is established before loading Node
	const fs = require("fs/promises") as typeof import("node:fs/promises");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only path operations
	const paths = require("path") as typeof import("node:path");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- no-follow opens are required for native files
	const { constants } = require("fs") as typeof import("node:fs");
	const adapter = vault.adapter, base = adapter.getBasePath();
	if (!paths.isAbsolute(base) || !constants.O_NOFOLLOW) throw new Error("The native installation filesystem capability is unavailable");
	const allowed = new Map<string, { folder: boolean; bytes?: number }>([[root, { folder: true }]]);
	for (const entry of plan.entries) {
		let current = root;
		for (const part of entry.path.split("/")) { current += "/" + part; if (!allowed.has(current)) allowed.set(current, { folder: true }); }
		allowed.set(current, { folder: !entry.file, bytes: entry.file?.bytes });
	}
	let realBase: string | undefined, vaultIdentity: string | undefined, rootIdentity: string | undefined, metadataIdentity: string | undefined;
	let marker: ArrayBuffer | undefined;
	const identity = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`;
	const check = () => {
		if (vault.adapter !== adapter || adapter.getBasePath() !== base) throw new Error("The native installation vault changed");
		checkContext();
	};
	const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
	const locate = async (relative: string) => {
		check(); const currentBase = await fs.realpath(base); check();
		const stat = await fs.stat(currentBase, { bigint: true }); check();
		if (realBase === undefined) { realBase = currentBase; vaultIdentity = identity(stat); }
		if (realBase !== currentBase || vaultIdentity !== identity(stat) || !stat.isDirectory()) throw new Error("The native installation vault location changed");
		let parent = realBase;
		for (const part of relative.split("/").slice(0, -1)) {
			parent = paths.join(parent, part); const stat = await fs.lstat(parent, { bigint: true }); check();
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("A native installation parent is not a regular directory");
		}
		return paths.join(realBase, ...relative.split("/"));
	};
	const syncDirectory = async (directory: string) => {
		const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
		try { await handle.sync(); } finally { await handle.close(); }
	};
	const read = async (absolute: string, maxBytes: number) => {
		const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			check(); const before = await handle.stat({ bigint: true }); check();
			if (!before.isFile() || before.nlink !== BigInt(1) || before.size < BigInt(0) || before.size > BigInt(maxBytes)) throw new Error("A native installation file is unsafe or too large");
			const bytes = new Uint8Array(Number(before.size)); let offset = 0;
			while (offset < bytes.byteLength) {
				const result = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.byteLength - offset), offset); check();
				if (!result.bytesRead) throw new Error("A native installation file changed while reading");
				offset += result.bytesRead;
			}
			const after = await handle.stat({ bigint: true }), current = await fs.lstat(absolute, { bigint: true }); check();
			if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
				|| !current.isFile() || current.nlink !== BigInt(1) || identity(current) !== identity(after)
				|| current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) throw new Error("A native installation file changed while reading");
			return bytes.buffer;
		} finally { await handle.close(); }
	};
	const sameBytes = (a: ArrayBuffer, b: ArrayBuffer) => {
		const left = new Uint8Array(a), right = new Uint8Array(b);
		return left.length === right.length && left.every((byte, i) => byte === right[i]);
	};
	const guard = async () => {
		if (!marker || !rootIdentity || !metadataIdentity) throw new Error("The native installation destination has not been claimed");
		const absolute = await locate(root), stat = await fs.lstat(absolute, { bigint: true }); check();
		if (!stat.isDirectory() || identity(stat) !== rootIdentity) throw new Error("The native installation destination changed");
		const metadata = paths.join(absolute, INSTALLATION_METADATA), control = await fs.lstat(metadata, { bigint: true }); check();
		if (!control.isDirectory() || identity(control) !== metadataIdentity) throw new Error("The native installation ownership directory changed");
		if (!sameBytes(await read(paths.join(metadata, "owner.json"), marker.byteLength), marker)) throw new Error("The native installation ownership marker changed");
		check(); return absolute;
	};
	const target = async (relative: string) => {
		if (!allowed.has(relative)) throw new Error("The native path is outside this installation plan");
		await guard(); return locate(relative);
	};
	return {
		root, nativeWriteOwner: vault,
		claim: async input => {
			check();
			if (new DataView(input).byteLength > 16 * 1024 || !input.byteLength) throw new Error("Invalid native installation ownership marker");
			const captured = ArrayBuffer.prototype.slice.call(input, 0) as ArrayBuffer;
			if (marker && !sameBytes(marker, captured)) throw new Error("The native installation claim changed");
			const absolute = await locate(root), metadata = paths.join(absolute, INSTALLATION_METADATA);
			let stat;
			try { stat = await fs.lstat(absolute, { bigint: true }); } catch (error) { if (!absent(error)) throw error; }
			check();
			if (!stat) {
				await fs.mkdir(absolute); check(); await fs.mkdir(metadata); check();
				const handle = await fs.open(paths.join(metadata, "owner.json"), "wx");
				try { await handle.writeFile(new Uint8Array(captured)); await handle.sync(); } finally { await handle.close(); }
				await syncDirectory(metadata); await syncDirectory(absolute); await syncDirectory(paths.dirname(absolute)); check();
				stat = await fs.lstat(absolute, { bigint: true }); check();
			}
			if (!stat.isDirectory() || rootIdentity !== undefined && rootIdentity !== identity(stat)) throw new Error("The native installation destination changed");
			let control;
			try { control = await fs.lstat(metadata, { bigint: true }); } catch (error) {
				if (absent(error)) throw new Error("The existing destination has no installation ownership marker. Preserve it and choose a new folder."); throw error;
			}
			check();
			if (!control.isDirectory() || metadataIdentity !== undefined && metadataIdentity !== identity(control)) throw new Error("The native installation ownership directory changed");
			if (!sameBytes(await read(paths.join(metadata, "owner.json"), captured.byteLength), captured)) throw new Error("The destination belongs to another installation");
			rootIdentity = identity(stat); metadataIdentity = identity(control); marker = captured; await guard();
			// A crash can leave a partial temporary file or the extra link between
			// publication and unlink. Only our UUID-named temporary entries under a
			// verified ownership directory may be reclaimed. Final bytes are then
			// checked against the plan by the coordinator before any reuse.
			const handle = await fs.opendir(metadata); let count = 0, removed = false;
			for await (const entry of handle) {
				check(); if (++count > 10_001) throw new Error("The native installation temporary directory exceeds its limit");
				if (entry.name === "owner.json") continue;
				if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(entry.name)) throw new Error("Unexpected native installation control file");
				await guard(); const temporary = paths.join(metadata, entry.name), stat = await fs.lstat(temporary); check();
				if (!stat.isFile() || stat.nlink > 2 || stat.size > 256 * 1024 * 1024) throw new Error("An installation temporary file is unsafe");
				await fs.unlink(temporary); removed = true;
			}
			if (removed) await syncDirectory(metadata); await guard();
		},
		stat: async relative => {
			const absolute = await target(relative);
			try {
				const stat = await fs.lstat(absolute); check();
				if (!stat.isDirectory() && !stat.isFile() || stat.isFile() && stat.nlink !== 1) throw new Error("A native installation path is linked or unsupported");
				return { type: stat.isDirectory() ? "folder" : "file", size: stat.size };
			} catch (error) { check(); if (absent(error)) return null; throw error; }
		},
		list: async (relative, maxEntries) => {
			if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_002) throw new Error("Invalid native installation listing limit");
			const absolute = await target(relative), stat = await fs.lstat(absolute); check();
			if (!stat.isDirectory()) throw new Error("A native installation directory changed");
			const handle = await fs.opendir(absolute), names: string[] = [];
			for await (const entry of handle) { check(); if (names.length >= maxEntries) throw new Error("The native installation directory exceeds its limit"); names.push(entry.name); }
			check(); return names;
		},
		readBinary: async (relative, maxBytes) => {
			if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 256 * 1024 * 1024) throw new Error("Invalid native installation read limit");
			const bytes = await read(await target(relative), maxBytes); await guard(); return bytes;
		},
		createDirectoryExclusive: async relative => {
			if (relative === root || !allowed.get(relative)?.folder) throw new Error("Invalid native installation directory");
			const absolute = await target(relative); check(); await fs.mkdir(absolute); await syncDirectory(paths.dirname(absolute)); await guard();
		},
		createFileExclusive: async (relative, input) => {
			const expected = allowed.get(relative);
			if (!expected || expected.folder || new DataView(input).byteLength !== expected.bytes) throw new Error("Invalid native installation file");
			const bytes = new Uint8Array(ArrayBuffer.prototype.slice.call(input, 0) as ArrayBuffer), absolute = await target(relative);
			const temporary = paths.join(realBase!, ...root.split("/"), INSTALLATION_METADATA, crypto.randomUUID() + ".tmp");
			check(); const handle = await fs.open(temporary, "wx");
			try {
				try { check(); await handle.writeFile(bytes); check(); await handle.sync(); } finally { await handle.close(); }
				await guard(); await locate(relative); check();
				await fs.link(temporary, absolute); await syncDirectory(paths.dirname(absolute));
			} finally { await fs.unlink(temporary); }
			await syncDirectory(paths.dirname(temporary)); await guard();
		},
	};
}
