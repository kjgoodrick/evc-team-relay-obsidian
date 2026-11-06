import { isId, isRecord, parseBody, type InlineNode, type MessageBody } from "../DiscussionProtocol";
import { pictureIds, type PictureBlock } from "../PictureProtocol";

export type MentionSpan = { start: number; end: number; userId: string };
export type CommentDraft = { text: string; mentions: MentionSpan[]; pictures?: PictureBlock[] };

export function readCommentDraft(value: unknown): CommentDraft {
	if (typeof value === "string") return { text: value, mentions: [] };
	if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.mentions)) {
		if (isRecord(value) && value.pictures !== undefined) throw new Error("Saved picture draft could not be read");
		return { text: "", mentions: [] };
	}
	const text = value.text;
	const mentions = value.mentions.filter((m): m is MentionSpan => isRecord(m) && Number.isInteger(m.start) && Number.isInteger(m.end) &&
		typeof m.start === "number" && typeof m.end === "number" && m.start >= 0 && m.end > m.start && m.end <= text.length && isId(m.userId))
		.map(m => ({ start: m.start, end: m.end, userId: m.userId })).sort((a, b) => a.start - b.start);
	let end = 0;
	pictureIds(value, true);
	const pictures = (value.pictures as PictureBlock[] | undefined)?.map(picture => ({ type: "picture" as const, picture_id: picture.picture_id, alt: picture.alt ?? "" }));
	return { text, mentions: mentions.filter(m => { if (m.start < end) return false; end = m.end; return true; }), ...(pictures?.length ? { pictures } : {}) };
}

/** Maintain stable mention identities around ordinary textarea/IME edits. Editing
 * any part of a mention label turns that label back into unlinked plain text.
 */
export function updateMentionSpans(before: string, after: string, spans: MentionSpan[]): MentionSpan[] {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let oldEnd = before.length, newEnd = after.length;
	while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
	const delta = newEnd - oldEnd;
	return spans.flatMap(span => span.end <= start ? [{ ...span }] : span.start >= oldEnd ?
		[{ ...span, start: span.start + delta, end: span.end + delta }] : []);
}

export function commentDraftBody(draft: CommentDraft): MessageBody {
	const children: InlineNode[] = [], parsed = readCommentDraft(draft), spans = parsed.mentions;
	const append = (text: string) => {
		const points = [...text];
		for (let i = 0; i < points.length; i += 8192) children.push({ type: "text", text: points.slice(i, i + 8192).join("") });
	};
	let position = 0;
	for (const span of spans) { append(draft.text.slice(position, span.start)); children.push({ type: "mention", user_id: span.userId }); position = span.end; }
	append(draft.text.slice(position));
	if (!draft.text.trim() && !parsed.pictures?.length) throw new Error("Write a comment before sending.");
	return parseBody({ version: 1, blocks: [...(draft.text.trim() ? [{ type: "paragraph", children }] : []), ...(parsed.pictures ?? [])] });
}
