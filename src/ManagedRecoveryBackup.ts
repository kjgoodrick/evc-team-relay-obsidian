import { RECOVERY_FOLDER } from "./conflictCopyPath";

export interface RecoveryFile { path: string; bytes: ArrayBuffer }
export interface RecoveryDocument { id: string; update: Uint8Array; text: string; unsaved?: string | null }
export interface RecoveryCapture { files: RecoveryFile[]; documents: RecoveryDocument[]; index: Uint8Array }
export interface RecoveryIO {
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
		&& a.files.every(f => b.files.some(g => f.path === g.path && equal(f.bytes, g.bytes)))
		&& a.documents.every(d => b.documents.some(e => d.id === e.id && d.text === e.text && d.unsaved === e.unsaved && equal(d.update, e.update)));
}

/** Originals are never removed by this module. A complete backup and a second
 * capture must succeed before the caller may move anything out of the way. */
export async function prepareRecoveryBackup(io: RecoveryIO, capture: () => Promise<RecoveryCapture>, metadata: unknown) {
	const path = `${RECOVERY_FOLDER}/${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
	const first = await capture();
	await io.mkdir(path);
	for (const file of first.files) {
		const target = `${path}/files/${file.path}`;
		await io.mkdir(target.slice(0, target.lastIndexOf("/")));
		await io.writeBinary(target, file.bytes);
	}
	await io.mkdir(`${path}/documents`);
	for (const doc of first.documents) {
		await io.writeBinary(`${path}/documents/${doc.id}.yjs`, bytes(doc.update));
		await io.write(`${path}/documents/${doc.id}.txt`, doc.text);
		if (doc.unsaved != null) await io.write(`${path}/documents/${doc.id}.unsaved.txt`, doc.unsaved);
	}
	await io.writeBinary(`${path}/inventory.yjs`, bytes(first.index));
	await io.write(`${path}/recovery.json`, JSON.stringify(metadata, null, 2));
	const verify = async () => {
		if (!sameCapture(first, await capture())) throw new Error("Local edits arrived while saving recovery files. Nothing was discarded; review and retry.");
	};
	await verify();
	await io.write(`${path}/BACKUP-COMPLETE.txt`, "Original file bytes, local editing history, and inventory saved. This folder stays on this device.\n");
	return { path, verify, initial: first };
}
