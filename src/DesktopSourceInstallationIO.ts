import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { createSourceInstallationHostIO } from "./SourceInstallationHostIO";
import { requireRecoveryRelativePath } from "./ManagedRecoveryArchive";

/** Desktop implementation of exclusive recovery staging. No undocumented
 * Obsidian adapter internals are used. Native filesystem watching can discover
 * these local-only artifacts; verification reads their actual disk bytes. */
export function createDesktopSourceInstallationIO(vault: Vault, checkContext = () => {}) {
	if (Platform.isMobile || typeof FileSystemAdapter !== "function" || !(vault.adapter instanceof FileSystemAdapter)) {
		throw new Error("This host does not provide exclusive recovery file creation");
	}
	// Load native built-ins only after proving the desktop filesystem capability.
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- mobile must not load Node built-ins
	const fs = require("fs/promises") as typeof import("node:fs/promises");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only path operations
	const paths = require("path") as typeof import("node:path");
	const adapter = vault.adapter, base = adapter.getBasePath();
	if (!paths.isAbsolute(base)) throw new Error("The recovery vault path is not absolute");
	let realBase: string | undefined, rootIdentity: string | undefined;
	const check = () => {
		if (vault.adapter !== adapter || adapter.getBasePath() !== base) throw new Error("The recovery vault changed");
		checkContext();
	};
	const destination = async (relative: string) => {
		check(); requireRecoveryRelativePath(relative);
		const current = await fs.realpath(base); check();
		const rootStat = await fs.stat(current, { bigint: true }); check();
		const identity = `${rootStat.dev}:${rootStat.ino}`;
		if (realBase === undefined) realBase = current;
		if (rootIdentity === undefined) rootIdentity = identity;
		if (realBase !== current || rootIdentity !== identity || !rootStat.isDirectory()) throw new Error("The recovery vault location changed");
		let parent = realBase;
		const parts = relative.split("/");
		// Refuse recovery parents that are links or non-directories. This is not
		// an operating-system lock against a separate process replacing a parent;
		// native activation still requires the coordinator's writer isolation.
		for (const part of parts.slice(0, -1)) {
			parent = paths.join(parent, part);
			const stat = await fs.lstat(parent); check();
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("A recovery parent is not a regular directory");
		}
		return paths.join(realBase, ...parts);
	};
	return createSourceInstallationHostIO({ nativeWriteOwner: vault, adapter,
		createDirectoryExclusive: async relative => {
			const target = await destination(relative); check(); await fs.mkdir(target); check();
		},
		createFileExclusive: async (relative, data) => {
			const target = await destination(relative); check();
			const handle = await fs.open(target, "wx");
			try { check(); await handle.writeFile(new Uint8Array(data)); check(); await handle.sync(); check(); }
			finally { await handle.close(); }
		},
	}, check);
}
