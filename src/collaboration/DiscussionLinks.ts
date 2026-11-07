import { sha256Hex } from "../contentDigest";
import { isId, isRecord } from "./DiscussionProtocol";
import { baseDiscussionScope } from "./DiscussionScope";

export const DISCUSSION_LINK_ACTION = "evc-team-relay-comment";
export type DiscussionLink = Readonly<{ version: 1; server: string; shareId: string; entryId: string; threadId: string;
	kind: "note" | "image" | "base"; viewId?: string; messageId?: string }>;
const keys = ["v", "server", "share", "entry", "thread", "kind", "view", "message"];
function invalid(): never { throw new Error("This is not a supported Team Relay comment link."); }

/** Endpoint identity is portable across accounts/vaults, but never a destination
 * from which to fetch credentials or content. Resolve only configured sessions. */
export async function discussionServerKey(endpoint: string): Promise<string> {
	if (typeof endpoint !== "string" || endpoint.length > 2048) return invalid();
	const url = new URL(endpoint);
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return invalid();
	const canonical = url.toString().replace(/\/+$/, "");
	return sha256Hex(new TextEncoder().encode("team-relay-discussion-link-v1\n" + canonical).buffer);
}
export function parseDiscussionLink(input: unknown): DiscussionLink {
	let fields: Record<string, unknown>;
	if (typeof input === "string") {
		if (input.length > 2048) return invalid();
		let url: URL; try { url = new URL(input); } catch { return invalid(); }
		if (url.protocol !== "obsidian:" || url.hostname !== DISCUSSION_LINK_ACTION || url.pathname || url.username || url.password || url.port || url.hash) return invalid();
		const entries = [...url.searchParams];
		if (new Set(entries.map(([key]) => key)).size !== entries.length) return invalid();
		fields = Object.fromEntries(entries);
	} else {
		if (!isRecord(input) || Object.keys(input).length > 9 || input.action !== DISCUSSION_LINK_ACTION) return invalid();
		fields = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "action"));
	}
	if (Object.keys(fields).some(key => !keys.includes(key)) || Object.values(fields).some(value => typeof value !== "string" || value.length > 256) ||
		fields.v !== "1" || typeof fields.server !== "string" || !/^[0-9a-f]{64}$/.test(fields.server) ||
		!isId(fields.share) || !isId(fields.entry) || !isId(fields.thread) || !["note", "image", "base"].includes(String(fields.kind)) ||
		(fields.kind === "base" ? !isId(fields.view) : fields.view !== undefined) || fields.message !== undefined && !isId(fields.message)) return invalid();
	return Object.freeze({ version: 1, server: fields.server, shareId: fields.share.toLowerCase(), entryId: fields.entry.toLowerCase(), threadId: fields.thread.toLowerCase(),
		kind: fields.kind as DiscussionLink["kind"], ...(fields.view ? { viewId: (fields.view as string).toLowerCase() } : {}),
		...(fields.message ? { messageId: (fields.message as string).toLowerCase() } : {}) });
}
export function discussionLinkUrl(link: DiscussionLink): string {
	const params = { v: String(link.version), server: link.server, share: link.shareId, entry: link.entryId, thread: link.threadId, kind: link.kind,
		...(link.viewId ? { view: link.viewId } : {}), ...(link.messageId ? { message: link.messageId } : {}) };
	parseDiscussionLink({ action: DISCUSSION_LINK_ACTION, ...params });
	return `obsidian://${DISCUSSION_LINK_ACTION}?${new URLSearchParams(params)}`;
}
export const discussionLinkScope = (link: DiscussionLink): string => link.kind === "base" ? baseDiscussionScope(link.entryId, link.viewId!) : link.entryId;
