/** A request's server lineage is local metadata, outside its immutable wire body.
 * Missing metadata belongs to the original lineage; it must never adopt the
 * latest generation merely because delivery or a manual retry happens later. */
import { isId } from "./DiscussionProtocol";
import { DiscussionFailure } from "./DiscussionFailure";

export interface RestoreBinding { readonly restoreGeneration?: string | null }
export interface RestoreContext { supported: boolean; generation: string | null }

export function restoreGeneration(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (!isId(value)) throw new DiscussionFailure("pause", "invalid_restore_generation");
	return value.toLowerCase();
}

export function restoreMetadata(operation: RestoreBinding): RestoreBinding {
	const generation = restoreGeneration(operation.restoreGeneration);
	return operation.restoreGeneration === undefined ? {} : { restoreGeneration: generation };
}

export function restoreContext(supported: unknown, generation: unknown): RestoreContext | undefined {
	if (supported === undefined && generation === undefined) return undefined;
	if (typeof supported !== "boolean" || generation === undefined || generation !== null && !isId(generation)) {
		throw new DiscussionFailure("pause", "invalid_read_response");
	}
	return { supported, generation: restoreGeneration(generation) };
}
