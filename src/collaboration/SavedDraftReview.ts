import { isRecord, sourceAnchor } from "./DiscussionProtocol";
import { parseLocalDiscussionAnchor, type LocalDiscussionAnchor } from "./LocalDiscussionAnchor";
import { parseDiscussionScope } from "./DiscussionScope";
import { readCommentDraft, type CommentDraft } from "./ui/CommentDraft";
import { commentBodyText } from "./ui/CommentBody";

/** Local review must not silently drop unfamiliar content or invalid mentions. */
export function reviewedDraftBody(value: unknown): CommentDraft {
	if (typeof value !== "string" && (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.mentions) ||
		Object.keys(value).some(key => !["text", "mentions", "pictures", "rich", "undoPictures", "editBaseRevision"].includes(key)))) throw new Error("This draft format needs a newer recovery tool. The source copy is retained.");
	const body = readCommentDraft(value);
	if (isRecord(value) && JSON.stringify(value.mentions) !== JSON.stringify(body.mentions)) throw new Error("Saved mentions need review before this draft can be restored.");
	if (body.rich) body.text = commentBodyText(body.rich, () => "Member");
	return body;
}

export function reviewedDraftTarget(scopeId: string, value: unknown): LocalDiscussionAnchor {
	const target = parseLocalDiscussionAnchor(value), scope = parseDiscussionScope(scopeId);
	if (!scope || (target.type === "base_group_pending" ? target.entry_id !== scope.entryId || target.capture.view_id !== scope.viewId :
		target.type === "image_file" ? target.asset.entry_id !== scopeId : target.type === "base" ? target.view_id !== scope.viewId :
		!!sourceAnchor(target) && sourceAnchor(target)!.document_id !== scopeId)) throw new Error("The saved draft target does not match its discussion.");
	if (scope.viewId && target.type !== "base" && target.type !== "base_group_pending") throw new Error("Choose a saved-view target for this discussion.");
	return target;
}
