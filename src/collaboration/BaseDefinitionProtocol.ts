import { isBaseDefinitionProperty, isBaseProperty, isId, isRecord, isRevision, parseBaseTargetContext,
	type BaseDefinitionProperty, type BaseTargetContext } from "./DiscussionProtocol";

export type BaseTargetDefinition = { id: string; kind: "formula" | "group"; revision: number; fingerprint: string; property: BaseDefinitionProperty } |
	{ id: string; kind: "summary"; revision: number; fingerprint: string; property: BaseDefinitionProperty; summary: string };
export type BaseDefinitionCatalog = BaseTargetContext & { computed_values: false; targets: BaseTargetDefinition[]; formula_group_ids?: string[] };
export type BaseDefinitionPage = BaseDefinitionCatalog & { has_more: boolean; next_after: string | null };

function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid Bases definition catalogue"); }
function definitions(value: unknown, revision: number, maximum: number): BaseTargetDefinition[] {
	requireValue(Array.isArray(value) && value.length <= maximum);
	const ids = new Set<string>();
	return value.map(item => {
		requireValue(isRecord(item) && isId(item.id) && !ids.has(item.id) && isRevision(item.revision) && item.revision <= revision &&
			typeof item.fingerprint === "string" && /^[a-f0-9]{64}$/.test(item.fingerprint) && isBaseDefinitionProperty(item.property) &&
			typeof item.kind === "string" && ["formula", "summary", "group"].includes(item.kind) && Object.keys(item).every(key =>
				["id", "kind", "revision", "fingerprint", "property", ...(item.kind === "summary" ? ["summary"] : [])].includes(key)));
		ids.add(item.id);
		requireValue(item.kind !== "formula" || item.property.source === "formula");
		const common = { id: item.id, revision: item.revision, fingerprint: item.fingerprint,
			property: { source: item.property.source, name: item.property.name } };
		if (item.kind === "summary") {
			requireValue(isBaseProperty({ source: "note", name: item.summary }));
			return { ...common, kind: "summary", summary: item.summary as string };
		}
		return { ...common, kind: item.kind as "formula" | "group" };
	});
}
export function parseBaseDefinitionCatalog(value: unknown, entryId: string, viewId: string): BaseDefinitionCatalog {
	const context = parseBaseTargetContext(value, entryId, viewId);
	requireValue(isRecord(value) && value.computed_values === false);
	const targets = definitions(value.targets, context.registry_revision, 256), formulaGroups = value.formula_group_ids;
	if (formulaGroups !== undefined) requireValue(Array.isArray(formulaGroups) && formulaGroups.length <= targets.length &&
		new Set(formulaGroups).size === formulaGroups.length && formulaGroups.every(id => isId(id) &&
			targets.some(target => target.id === id && target.kind === "group" && target.property.source === "formula")));
	return { ...context, computed_values: false, targets, ...(formulaGroups === undefined ? {} : { formula_group_ids: [...formulaGroups as string[]] }) };
}
/** Eligibility is bound to this saved view and catalog revision, never a global formula name. */
export function supportsBaseGroupDefinition(catalog: BaseDefinitionCatalog, definition: BaseTargetDefinition): boolean {
	return definition.kind === "group" && (definition.property.source !== "formula" || catalog.formula_group_ids?.includes(definition.id) === true);
}
export function parseBaseDefinitionPage(value: unknown, entryId: string, viewId: string, after?: string): BaseDefinitionPage {
	const result = parseBaseDefinitionCatalog(value, entryId, viewId);
	requireValue(isRecord(value) && typeof value.has_more === "boolean" && result.targets.length <= 100 &&
		(!value.has_more || result.targets.length > 0) && value.next_after === (result.targets.at(-1)?.id ?? null));
	let previous = after;
	for (const item of result.targets) { requireValue(!previous || item.id > previous); previous = item.id; }
	return { ...result, has_more: value.has_more, next_after: value.next_after as string | null };
}
