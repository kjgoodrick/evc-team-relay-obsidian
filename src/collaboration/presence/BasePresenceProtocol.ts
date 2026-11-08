import { exactFields, locationId, type BaseLocation } from "./LocationProtocol";
import { isRecord } from "../DiscussionProtocol";
import { parseBasePresenceProperty, type BasePresenceProperty } from "./BasePositionProtocol";

export interface BasePresenceView { readonly id: string; readonly slot: number; readonly name: string; readonly type: string }
export interface BasePresenceFormulaGroup { readonly view_id: string; readonly property: BasePresenceProperty; readonly inputs: readonly BasePresenceProperty[] }
/** Current active saved views only. No configuration, archive or repair state. */
export interface BasePresenceContext {
	readonly protocol_version: 1; readonly share_id: string; readonly entry_id: string; readonly generation: string;
	readonly definition_id: string; readonly registry_revision: number; readonly content_sha256: string;
	readonly views: readonly BasePresenceView[];
	readonly formula_groups?: readonly BasePresenceFormulaGroup[];
}
function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid Bases presence context"); }
function label(value: unknown): value is string {
	if (typeof value !== "string" || !value || value.length > 512) return false;
	let count = 0;
	for (const char of value) { const point = char.codePointAt(0)!; if (++count > 256 || point < 32 || point >= 0xd800 && point <= 0xdfff) return false; }
	return true;
}
export function parseBasePresenceContext(value: unknown, shareId: string, entryId: string): BasePresenceContext {
	requireValue(isRecord(value) && exactFields(value, ["protocol_version", "share_id", "entry_id", "generation", "definition_id", "registry_revision", "content_sha256", "views", ...(value.formula_groups === undefined ? [] : ["formula_groups"])]) &&
		value.protocol_version === 1 && locationId(shareId) && value.share_id === shareId && locationId(entryId) && value.entry_id === entryId &&
		locationId(value.generation) && locationId(value.definition_id) && typeof value.registry_revision === "number" && Number.isSafeInteger(value.registry_revision) && value.registry_revision > 0 &&
		typeof value.content_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.content_sha256) && Array.isArray(value.views) && value.views.length <= 64);
	const ids = new Set<string>(), names = new Set<string>(); let lastSlot = -1;
	const views = value.views.map(view => {
		requireValue(isRecord(view) && exactFields(view, ["id", "slot", "name", "type"]) && locationId(view.id) &&
			typeof view.slot === "number" && Number.isInteger(view.slot) && view.slot > lastSlot && view.slot < 64 && label(view.name) && label(view.type) && !ids.has(view.id) && !names.has(view.name));
		lastSlot = view.slot; ids.add(view.id); names.add(view.name);
		return Object.freeze({ id: view.id, slot: view.slot, name: view.name, type: view.type });
	});
	let formulaGroups: readonly BasePresenceFormulaGroup[] | undefined;
	if (value.formula_groups !== undefined) {
		requireValue(Array.isArray(value.formula_groups) && value.formula_groups.length <= 64 && new TextEncoder().encode(JSON.stringify(value.formula_groups)).length <= 16_384);
		const formulaViews = new Set<string>(), fileInputs = new Set(["name", "basename", "fullname", "ext"]);
		formulaGroups = Object.freeze(value.formula_groups.map(plan => {
			requireValue(isRecord(plan) && exactFields(plan, ["view_id", "property", "inputs"]) && typeof plan.view_id === "string" && ids.has(plan.view_id) && !formulaViews.has(plan.view_id) && Array.isArray(plan.inputs) && plan.inputs.length <= 32);
			formulaViews.add(plan.view_id); const property = parseBasePresenceProperty(plan.property); requireValue(property.source === "formula");
			const keys = new Set<string>(), inputs = plan.inputs.map(value => {
				const input = parseBasePresenceProperty(value), key = JSON.stringify(input);
				requireValue((input.source === "note" || input.source === "file" && fileInputs.has(input.name.toLowerCase())) && !keys.has(key)); keys.add(key); return input;
			});
			return Object.freeze({ view_id: plan.view_id, property, inputs: Object.freeze(inputs) });
		}));
	}
	return Object.freeze({ protocol_version: 1, share_id: shareId, entry_id: entryId, generation: value.generation, definition_id: value.definition_id,
		registry_revision: value.registry_revision, content_sha256: value.content_sha256, views: Object.freeze(views), ...(formulaGroups === undefined ? {} : { formula_groups: formulaGroups }) });
}
export function basePresenceLocation(context: BasePresenceContext, viewId: string): BaseLocation | undefined {
	if (!context.views.some(view => view.id === viewId)) return;
	return { kind: "base", share_id: context.share_id, entry_id: context.entry_id, generation: context.generation,
		definition_id: context.definition_id, view_id: viewId, registry_revision: context.registry_revision };
}
