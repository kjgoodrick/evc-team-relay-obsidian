import { RECOVERY_FOLDER } from "./conflictCopyPath";
import { requireRecoveryRelativePath, type RecoveryArchiveReader } from "./ManagedRecoveryArchive";
import { sourceInstallationPath } from "./SourceInstallationPlan";
import type { SourceInstallationStageIO } from "./SourceInstallationStaging";
import { trackNativeSourceMutation } from "./storage/native-document-writes";

/** Explicit host capability, not a raw Obsidian Vault. Obsidian's public create
 * methods check existence separately from writing and do not provide atomic
 * exclusion. These operations must reject an existing destination atomically. */
export interface SourceInstallationHost {
	nativeWriteOwner: object;
	adapter: RecoveryArchiveReader;
	createDirectoryExclusive(path: string): Promise<void>;
	createFileExclusive(path: string, data: ArrayBuffer): Promise<void>;
}
const parent = `${RECOVERY_FOLDER}/Source installations`;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const artifact = new RegExp(`^(?:plan\\.json|inventory\\.yjs|files/${uuid}\\.bin|sources/${uuid}\\.yjs)$`);

/** Local staging I/O only. Reads stay within recovery storage; writes may only
 * create fixed artifacts beneath a staging root exclusively created by this
 * adapter instance. It cannot overwrite artifacts or write native note paths.
 * Existing staged plans remain readable after restart, but cannot be rewritten. */
export function createSourceInstallationHostIO(host: SourceInstallationHost, checkContext = () => {}): SourceInstallationStageIO {
	const adapter = host.adapter, owner = host.nativeWriteOwner, createFolder = host.createDirectoryExclusive.bind(host), createBinary = host.createFileExclusive.bind(host);
	const roots = new Set<string>();
	const check = () => { if (host.adapter !== adapter || host.nativeWriteOwner !== owner) throw new Error("The recovery vault adapter changed"); checkContext(); };
	const recoveryPath = (path: string) => {
		requireRecoveryRelativePath(path);
		if (path.includes(":") || path !== RECOVERY_FOLDER && !path.startsWith(RECOVERY_FOLDER + "/")) throw new Error("Installation I/O is outside local recovery storage");
	};
	const rootOf = (path: string) => {
		if (!path.startsWith(parent + "/")) return;
		const slash = path.indexOf("/", parent.length + 1), root = slash < 0 ? "" : path.slice(0, slash);
		return roots.has(root) ? root : undefined;
	};
	const mutate = async <T>(path: string, action: () => Promise<T>): Promise<T> => {
		check(); const result = await trackNativeSourceMutation(owner, [path], () => { check(); return action(); }); check(); return result;
	};
	const write = async (path: string, input: ArrayBuffer) => {
		check(); recoveryPath(path);
		const root = rootOf(path);
		if (!root || !artifact.test(path.slice(root.length + 1))) throw new Error("The installation artifact does not belong to this staging operation");
		if (new DataView(input).byteLength > 256 * 1024 * 1024) throw new Error("The installation artifact exceeds its size limit");
		const bytes = ArrayBuffer.prototype.slice.call(input, 0) as ArrayBuffer;
		await mutate(path, () => createBinary(path, bytes));
	};
	return {
		stat: async path => { check(); recoveryPath(path); const result = await adapter.stat(path); check(); return result; },
		readBinary: async path => { check(); recoveryPath(path); const result = await adapter.readBinary(path); check(); return result; },
		mkdir: async path => {
			check(); recoveryPath(path);
			const root = rootOf(path);
			if (path !== RECOVERY_FOLDER && path !== parent && (!root || ![`${root}/files`, `${root}/sources`].includes(path))) {
				throw new Error("The staging directory is outside this installation operation");
			}
			let current = "";
			for (const part of path.split("/")) {
				current = current ? `${current}/${part}` : part; check();
				const existing = await adapter.stat(current); check();
				if (existing) { if (existing.type !== "folder") throw new Error("A file occupies the staging directory"); continue; }
				const target = current;
				try { await mutate(target, () => createFolder(target)); }
				catch (error) {
					check(); const created = await adapter.stat(target); check();
					if (created?.type !== "folder") throw error; // Another preparation may create the common parent.
				}
			}
		},
		createDirectoryExclusive: async path => {
			check(); recoveryPath(path);
			const id = path.slice(parent.length + 1);
			if (sourceInstallationPath(id) !== path || roots.has(path)) throw new Error("Invalid or existing installation staging root");
			if ((await adapter.stat(parent))?.type !== "folder") throw new Error("The installation staging parent is unavailable");
			check(); await mutate(path, () => createFolder(path)); roots.add(path);
		},
		write: (path, text) => write(path, new TextEncoder().encode(text).buffer),
		writeBinary: write,
	};
}
