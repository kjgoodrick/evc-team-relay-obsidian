import type { ItemRecord } from "../ItemKinds";

export type Records = Record<string, ItemRecord>;
export interface Change { path: string; previous: ItemRecord | null; value: ItemRecord | null }
export interface StructuralConflict {
	id: string;
	createdAt: string;
	reason: string;
	paths: string[];
	ids: string[];
	local: Records;
	base: Records;
}
export const CONFLICTS = "managed_conflicts_v1";
export const same = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
	return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => same(left[key], right[key]));
};
const within = (path: string, root: string) => path.toLowerCase() === root.toLowerCase() || path.toLowerCase().startsWith(root.toLowerCase() + "/");
export const touches = (scope: Pick<StructuralConflict, "paths" | "ids">, path: string, record?: ItemRecord | null): boolean =>
	!!record && scope.ids.includes(record.id) || scope.paths.some(root => within(path, root));
export const select = (records: Records, scope: Pick<StructuralConflict, "paths" | "ids">): Records => {
	const expanded = { ...scope, paths: [...scope.paths, ...Object.entries(records).filter(([, r]) => r.type === "folder" && scope.ids.includes(r.id)).map(([p]) => p)] };
	return Object.fromEntries(Object.entries(records).filter(([path, record]) => touches(expanded, path, record)));
};
export const diff = (base: Records, local: Records): Change[] =>
	[...new Set([...Object.keys(base), ...Object.keys(local)])].filter(path => !same(base[path] ?? null, local[path] ?? null))
		.map(path => ({ path, previous: base[path] ?? null, value: local[path] ?? null }));
export function scope(changes: Change[]): Pick<StructuralConflict, "paths" | "ids"> {
	return { paths: changes.map(c => c.path), ids: [...new Set(changes.flatMap(c => [c.previous?.id, c.value?.id].filter((id): id is string => !!id)))] };
}

/** Renames, folder trees, and colliding destinations must travel together. */
export function groups(changes: Change[]): Change[][] {
	const result: Change[][] = [];
	for (const change of changes) {
		let group = [change];
		for (let i = 0; i < result.length;) {
			const a = scope(group), b = scope(result[i]);
			if (a.ids.some(id => b.ids.includes(id)) || a.paths.some(p => b.paths.some(q => within(p, q) || within(q, p)))) {
				group = [...group, ...result.splice(i, 1)[0]]; i = 0;
			} else i++;
		}
		result.push(group);
	}
	return result;
}

/** Overlay disputed local identities without exposing duplicate server paths. */
export function overlay(server: Records, conflicts: StructuralConflict[]): Records {
	const result = { ...server };
	for (const conflict of conflicts) {
		for (const path of Object.keys(select(result, conflict))) delete result[path];
		Object.assign(result, conflict.local);
	}
	return result;
}

export function makeConflict(changes: Change[], base: Records, local: Records, reason: string): StructuralConflict {
	const affected = scope(changes);
	return { ...affected, id: crypto.randomUUID(), createdAt: new Date().toISOString(), reason, base: select(base, affected), local: select(local, affected) };
}

/** A conservative three-way rebase: only unchanged entities or already achieved
 * results are automatic. Missing visibility is never treated as a safe rename. */
export function rebase(changes: Change[], base: Records, local: Records, server: Records, deleted: Record<string, string[]> = {}): "retry" | "done" | "conflict" {
	const affected = scope(changes);
	const remote = select(server, affected);
	const desired = select(local, affected);
	const deletedIds = new Set(Object.values(deleted).flat());
	const removed = Object.values(select(base, affected)).filter(r => !Object.values(desired).some(d => d.id === r.id));
	// Absence from a filtered manifest may be revocation, not deletion.
	if (same(remote, desired) && removed.every(r => deletedIds.has(r.id))) return "done";
	return same(remote, select(base, affected)) ? "retry" : "conflict";
}
