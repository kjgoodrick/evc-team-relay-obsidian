import { ItemKind, type ItemRecord } from "../ItemKinds";
import type { Records } from "./managedRecovery";

export type RestoreInventoryStatus = "same" | "metadata-changed" | "moved" | "local-only" | "server-only" | "ambiguous";
export interface RestoreInventoryRow { id: string; localPaths: string[]; serverPaths: string[]; status: RestoreInventoryStatus; occupiedPath: boolean }

/** This is an inventory comparison only. Matching metadata cannot prove equal
 * Markdown/Canvas text, native bytes, unsaved buffers or current permissions. */
export function compareRestoreInventory(local: Records, server: Records): RestoreInventoryRow[] {
	const collect = (records: Records) => {
		if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("The file inventory could not be compared");
		const ids = new Map<string, { path: string; record: ItemRecord }[]>();
		for (const [path, record] of Object.entries(records)) {
			if (!path || !record || typeof record.id !== "string" || !record.id || !Object.values(ItemKind).includes(record.type)) throw new Error("The file inventory contains an unsupported entry");
			const entries = ids.get(record.id) ?? []; entries.push({ path, record }); ids.set(record.id, entries);
		}
		return ids;
	};
	const left = collect(local), right = collect(server), rows: RestoreInventoryRow[] = [];
	for (const id of new Set([...left.keys(), ...right.keys()])) {
		const a = left.get(id) ?? [], b = right.get(id) ?? [];
		let status: RestoreInventoryStatus;
		if (a.length > 1 || b.length > 1 || a.length && b.length && a[0].record.type !== b[0].record.type) status = "ambiguous";
		else if (!a.length) status = "server-only";
		else if (!b.length) status = "local-only";
		else if (a[0].path !== b[0].path) status = "moved";
		else {
			const metadata = (record: ItemRecord) => JSON.stringify([record.type, record.version, record.hash, record.synctime, record.mimetype]);
			status = metadata(a[0].record) === metadata(b[0].record) ? "same" : "metadata-changed";
		}
		rows.push({ id, localPaths: a.map(entry => entry.path).sort(), serverPaths: b.map(entry => entry.path).sort(), status,
			occupiedPath: a.some(entry => Object.prototype.hasOwnProperty.call(server, entry.path) && server[entry.path].id !== id)
				|| b.some(entry => Object.prototype.hasOwnProperty.call(local, entry.path) && local[entry.path].id !== id) });
	}
	return rows.sort((a, b) => {
		const pathA = a.localPaths[0] ?? a.serverPaths[0], pathB = b.localPaths[0] ?? b.serverPaths[0];
		return pathA < pathB ? -1 : pathA > pathB ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}
