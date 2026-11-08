import { RECOVERY_FOLDER } from "./conflictCopyPath";
import { sha256Hex } from "./contentDigest";
import { requireRecoveryRelativePath, recoveryCompletionText, verifyRecoveryArchive, type RecoveryArchiveReader } from "./ManagedRecoveryArchive";

export interface RecoveryFile { path: string; bytes: ArrayBuffer }
export interface RecoveryDocument { id: string; cacheKey?: string; update: Uint8Array; text: string; unsaved?: string | null; persistedUnsaved?: string | null; cacheMetadata?: string }
export interface RecoveryInventory { cacheKey: string; update: Uint8Array; cacheMetadata: string }
export interface RecoveryCapture { files: RecoveryFile[]; documents: RecoveryDocument[]; index: Uint8Array; inventories?: RecoveryInventory[] }
export interface RecoveryIO extends RecoveryArchiveReader {
	mkdir(path: string): Promise<void>;
	write(path: string, text: string): Promise<void>;
	writeBinary(path: string, bytes: ArrayBuffer): Promise<void>;
}
const bytes = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;
const equal = (a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array) => {
	const left = new Uint8Array(a), right = new Uint8Array(b);
	return left.length === right.length && left.every((v, i) => v === right[i]);
};
export function sameCapture(a: RecoveryCapture, b: RecoveryCapture): boolean {
	return equal(a.index, b.index) && a.files.length === b.files.length && a.documents.length === b.documents.length
		&& (a.inventories?.length ?? 0) === (b.inventories?.length ?? 0)
		&& (a.inventories ?? []).every(d => (b.inventories ?? []).some(e => d.cacheKey === e.cacheKey && d.cacheMetadata === e.cacheMetadata && equal(d.update, e.update)))
		&& a.files.every(f => b.files.some(g => f.path === g.path && equal(f.bytes, g.bytes)))
		&& a.documents.every(d => b.documents.some(e => d.id === e.id && d.cacheKey === e.cacheKey && d.text === e.text && d.unsaved === e.unsaved && d.persistedUnsaved === e.persistedUnsaved && d.cacheMetadata === e.cacheMetadata && equal(d.update, e.update)));
}

function copyCapture(value: RecoveryCapture): RecoveryCapture {
	return { files: value.files.map(file => ({ path: file.path, bytes: file.bytes.slice(0) })),
		inventories: value.inventories?.map(inventory => ({ ...inventory, update: new Uint8Array(inventory.update) })),
		documents: value.documents.map(doc => ({ ...doc, update: new Uint8Array(doc.update) })), index: new Uint8Array(value.index) };
}

interface SavedRecoveryFile { path: string; bytes: number; sha256: string }

/** Originals are never removed by this module. A complete backup and a second
 * capture must succeed before the caller may move anything out of the way. */
export async function prepareRecoveryBackup(io: RecoveryIO, capture: () => Promise<RecoveryCapture>, metadata: unknown) {
	const path = `${RECOVERY_FOLDER}/${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
	// Freeze the review metadata and captured bytes before the first archive
	// write. A caller reusing mutable buffers cannot change our comparison base.
	const metadataText = JSON.stringify(metadata, null, 2);
	if (metadataText === undefined) throw new Error("Recovery metadata is missing");
	const first = copyCapture(await capture());
	const artifacts: { path: string; bytes: ArrayBuffer; text?: string }[] = [];
	const addText = (path: string, text: string) => artifacts.push({ path, text, bytes: new TextEncoder().encode(text).buffer });
	for (const file of first.files) {
		requireRecoveryRelativePath(file.path);
		artifacts.push({ path: `files/${file.path}`, bytes: file.bytes });
	}
	for (const doc of first.documents) {
		if (typeof doc.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(doc.id)) throw new Error("Recovery document has an unsafe identity");
		if (doc.cacheKey !== undefined && (typeof doc.cacheKey !== "string" || !/^relay-source-v1-[a-f0-9]{64}$/.test(doc.cacheKey))) throw new Error("Recovery document has an unsafe cache key");
		const prefix = `documents/${doc.id}${doc.cacheKey ? "/" + doc.cacheKey : ""}`;
		artifacts.push({ path: `${prefix}.yjs`, bytes: bytes(doc.update) });
		addText(`${prefix}.txt`, doc.text);
		if (doc.unsaved != null) addText(`${prefix}.unsaved.txt`, doc.unsaved);
		if (doc.persistedUnsaved != null) addText(`${prefix}.stored-unsaved.txt`, doc.persistedUnsaved);
		if (doc.cacheMetadata !== undefined) addText(`${prefix}.cache.json`, doc.cacheMetadata);
	}
	for (const inventory of first.inventories ?? []) {
		if (typeof inventory.cacheKey !== "string" || !/^relay-inventory-v1-[a-f0-9]{64}$/.test(inventory.cacheKey)) throw new Error("Recovery inventory has an unsafe cache key");
		const prefix = `inventories/${inventory.cacheKey}`;
		artifacts.push({ path: `${prefix}.yjs`, bytes: bytes(inventory.update) });
		addText(`${prefix}.cache.json`, inventory.cacheMetadata);
	}
	artifacts.push({ path: "inventory.yjs", bytes: bytes(first.index) });
	addText("recovery.json", metadataText);
	const names = new Set<string>();
	for (const artifact of artifacts) {
		const key = artifact.path.normalize("NFC").toLowerCase();
		if (names.has(key)) throw new Error("Recovery capture contains colliding paths or identities");
		names.add(key);
	}
	for (const name of names) {
		for (let slash = name.indexOf("/"); slash >= 0; slash = name.indexOf("/", slash + 1)) {
			if (names.has(name.slice(0, slash))) throw new Error("Recovery capture contains a file/directory collision");
		}
	}
	const saved: SavedRecoveryFile[] = [];
	await io.mkdir(path);
	for (const artifact of artifacts) {
		const target = `${path}/${artifact.path}`, sha256 = await sha256Hex(artifact.bytes);
		await io.mkdir(target.slice(0, target.lastIndexOf("/")));
		if (artifact.text !== undefined) await io.write(target, artifact.text);
		else await io.writeBinary(target, artifact.bytes.slice(0));
		saved.push({ path: artifact.path, bytes: artifact.bytes.byteLength, sha256 });
	}
	const manifest = JSON.stringify({ format: "team-relay-local-recovery", version: 1, files: saved }, null, 2);
	const manifestBytes = new TextEncoder().encode(manifest).buffer;
	const manifestEntry = { path: "manifest.json", bytes: manifestBytes.byteLength, sha256: await sha256Hex(manifestBytes) };
	await io.write(`${path}/manifest.json`, manifest);
	const verifyFile = async (file: SavedRecoveryFile) => {
		const actual = await io.readBinary(`${path}/${file.path}`);
		if (actual.byteLength !== file.bytes || await sha256Hex(actual) !== file.sha256) throw new Error(`Recovery file verification failed: ${file.path}. Originals were retained.`);
	};
	const reference = Object.freeze({ path, manifestSha256: manifestEntry.sha256 });
	const message = recoveryCompletionText(reference.manifestSha256);
	const completionBytes = new TextEncoder().encode(message).buffer;
	const completion = { path: "BACKUP-COMPLETE.txt", bytes: completionBytes.byteLength, sha256: await sha256Hex(completionBytes) };
	let completed = false;
	const verify = async () => {
		if (completed) await verifyRecoveryArchive(io, reference);
		else { for (const file of saved) await verifyFile(file); await verifyFile(manifestEntry); }
		if (!sameCapture(first, await capture())) throw new Error("Local edits arrived while saving recovery files. Nothing was discarded; review and retry.");
	};
	await verify();
	await io.write(`${path}/${completion.path}`, message); await verifyFile(completion);
	completed = true;
	return { path, reference, verify, initial: copyCapture(first) };
}
