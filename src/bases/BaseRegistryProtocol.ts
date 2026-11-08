import { baseId, baseObject, parseBaseRestoreContext } from "./BaseContentProtocol";
import { restoreMetadata, type RestoreBinding } from "../collaboration/RestoreGeneration";

export const BASE_REGISTRY_RESPONSE_LIMIT = 512_000;
export interface BaseViewDescriptor { name: string; type: string; descriptor_sha256: string }
export interface BaseViewSlot extends BaseViewDescriptor { slot: number; id: string | null }
export interface BaseSavedView extends BaseViewDescriptor { id: string; state: "unmatched" | "archived" }
export interface BaseViewPage { views: BaseSavedView[]; has_more: boolean; next_after: string | null }
export interface BaseRegistrySnapshot {
	protocol_version: 1; definition_id: string; entry_id: string; generation: string; revision: number;
	content_sha256: string; views: BaseViewSlot[]; unmatched: BaseViewPage;
	restore_guard?: boolean; restore_generation?: string | null;
}
export interface BaseViewRepair {
	operation_id: string; content_sha256: string; expected_revision: number;
	bindings: { slot: number; view_id: string | null }[]; archive: string[];
}
export interface BaseViewRepairIntent extends RestoreBinding { definitionId: string; generation: string; request: BaseViewRepair }
export type BaseViewRepairStatus = { status: "accepted"; result: BaseRegistrySnapshot } |
	{ status: "unknown"; operation_id: string; entry_id: string };
export function baseRegistryBinding(snapshot: BaseRegistrySnapshot): RestoreBinding {
	const context = parseBaseRestoreContext(snapshot.restore_guard, snapshot.restore_generation);
	return context ? { restoreGeneration: context.generation } : {};
}

export const baseDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const boundedName = (value: unknown): value is string => {
	if (typeof value !== "string" || !value) return false;
	let length = 0;
	for (const character of value) {
		const point = character.codePointAt(0)!;
		if (++length > 256 || point < 32 || point >= 0xd800 && point <= 0xdfff) return false;
	}
	return true;
};
const sequence = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid saved-view registry response"); }
function descriptor(value: unknown): BaseViewDescriptor {
	requireValue(baseObject(value) && boundedName(value.name) && boundedName(value.type) && baseDigest(value.descriptor_sha256));
	return { name: value.name, type: value.type, descriptor_sha256: value.descriptor_sha256 };
}
export function parseBaseViewPage(value: unknown, state: "unmatched" | "archived", after?: string): BaseViewPage {
	requireValue(baseObject(value) && Array.isArray(value.views) && value.views.length <= 100 && typeof value.has_more === "boolean" &&
		(value.next_after === null || baseId(value.next_after)) && (!after || baseId(after)));
	let previous = after ?? "";
	const views = value.views.map(view => {
		requireValue(baseObject(view) && baseId(view.id) && view.state === state && view.id.toLowerCase() > previous.toLowerCase());
		previous = view.id;
		return { ...descriptor(view), id: view.id, state };
	});
	requireValue(value.next_after === (views.length ? views[views.length - 1].id : after ?? null));
	requireValue(!value.has_more || views.length === 100);
	return { views, has_more: value.has_more, next_after: value.next_after as string | null };
}
export function parseBaseRegistry(value: unknown, entryId: string, digest?: string, generation?: string): BaseRegistrySnapshot {
	requireValue(baseObject(value) && value.protocol_version === 1 && baseId(value.definition_id) && value.entry_id === entryId && baseId(entryId) &&
		baseId(value.generation) && sequence(value.revision) && value.revision > 0 && baseDigest(value.content_sha256) &&
		(!digest || value.content_sha256 === digest) && (!generation || value.generation === generation) && Array.isArray(value.views) && value.views.length <= 64);
	const ids = new Set<string>(), names = new Set<string>();
	const views = value.views.map((view, slot) => {
		requireValue(baseObject(view) && view.slot === slot && (view.id === null || baseId(view.id)));
		const details = descriptor(view); requireValue(!names.has(details.name)); names.add(details.name);
		if (view.id) { requireValue(!ids.has(view.id.toLowerCase())); ids.add(view.id.toLowerCase()); }
		return { ...details, slot, id: view.id as string | null };
	});
	const unmatched = parseBaseViewPage(value.unmatched, "unmatched");
	requireValue(unmatched.views.every(view => !ids.has(view.id.toLowerCase())));
	const context = parseBaseRestoreContext(value.restore_guard, value.restore_generation);
	return { protocol_version: 1, definition_id: value.definition_id, entry_id: entryId, generation: value.generation,
		revision: value.revision, content_sha256: value.content_sha256, views, unmatched,
		...(context ? { restore_guard: context.supported, restore_generation: context.generation } : {}) };
}
export function copyBaseViewRepair(value: BaseViewRepair): BaseViewRepair {
	requireValue(baseObject(value) && baseId(value.operation_id) && baseDigest(value.content_sha256) && sequence(value.expected_revision) &&
		Array.isArray(value.bindings) && value.bindings.length <= 64 && Array.isArray(value.archive) && value.archive.length <= 100);
	const ids = new Set<string>(), slots = new Set<number>();
	const bindings = value.bindings.map(binding => {
		requireValue(baseObject(binding) && sequence(binding.slot) && binding.slot < value.bindings.length && !slots.has(binding.slot) && (binding.view_id === null || baseId(binding.view_id)));
		slots.add(binding.slot);
		if (binding.view_id) { requireValue(!ids.has(binding.view_id.toLowerCase())); ids.add(binding.view_id.toLowerCase()); }
		return { slot: binding.slot, view_id: binding.view_id };
	}).sort((a, b) => a.slot - b.slot);
	const archive = value.archive.map(id => { requireValue(baseId(id) && !ids.has(id.toLowerCase())); ids.add(id.toLowerCase()); return id; });
	return { operation_id: value.operation_id, content_sha256: value.content_sha256, expected_revision: value.expected_revision, bindings, archive };
}
export function copyBaseViewIntent(value: BaseViewRepairIntent): BaseViewRepairIntent {
	requireValue(baseObject(value) && baseId(value.definitionId) && baseId(value.generation));
	return { definitionId: value.definitionId, generation: value.generation, request: copyBaseViewRepair(value.request), ...restoreMetadata(value) };
}
export function parseBaseViewRepairResult(value: unknown, entryId: string, intent: BaseViewRepairIntent): BaseRegistrySnapshot {
	const snapshot = parseBaseRegistry(value, entryId, intent.request.content_sha256, intent.generation);
	requireValue((baseRegistryBinding(snapshot).restoreGeneration ?? null) === (intent.restoreGeneration ?? null));
	requireValue(snapshot.definition_id === intent.definitionId && snapshot.revision === intent.request.expected_revision + 1 && snapshot.views.length === intent.request.bindings.length);
	const archived = new Set(intent.request.archive);
	for (const binding of intent.request.bindings) requireValue(snapshot.views[binding.slot]?.id &&
		(binding.view_id === null || snapshot.views[binding.slot].id === binding.view_id) && !archived.has(snapshot.views[binding.slot].id!));
	return snapshot;
}
