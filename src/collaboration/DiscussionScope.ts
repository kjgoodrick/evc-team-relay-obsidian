import { isId } from "./DiscussionProtocol";

export type DiscussionScope = { entryId: string; viewId?: string };

/** Local identity includes the saved view; HTTP still addresses its managed file.
 * Encoding both IDs makes queued work routable after restart without a mutable
 * path lookup or a separately restored view-to-file mapping. */
export function parseDiscussionScope(value: unknown): DiscussionScope | undefined {
	if (isId(value)) return { entryId: value };
	if (typeof value !== "string") return undefined;
	const parts = value.split(":");
	if (parts.length !== 3 || parts[0] !== "base" || !isId(parts[1]) || !isId(parts[2]) || value !== value.toLowerCase()) return undefined;
	return { entryId: parts[1], viewId: parts[2] };
}

export function baseDiscussionScope(entryId: string, viewId: string): string {
	if (!isId(entryId) || !isId(viewId)) throw new Error("Invalid saved-view discussion identity");
	return `base:${entryId.toLowerCase()}:${viewId.toLowerCase()}`;
}
