import { commentDraftBody, readCommentDraft, updateMentionSpans } from "../../src/collaboration/ui/CommentDraft";
const userId = "00000000-0000-4000-8000-000000000001";
test("mentions retain stable identity when surrounding text changes and unlink when their label is edited", () => {
	const mention = { start: 3, end: 9, userId };
	expect(updateMentionSpans("Hi @Alice!", "Hello @Alice!", [mention])).toEqual([{ start: 6, end: 12, userId }]);
	expect(updateMentionSpans("Hi @Alice!", "Hi @Alix!", [mention])).toEqual([]);
	expect(updateMentionSpans("Hi @Alice!", "Hi @Alice!!", [mention])).toEqual([mention]);
});
test("typed lookalike labels remain plain text; only explicit mentions become user references", () => {
	const body = commentDraftBody({ text: "Hi @Alice and @Alice", mentions: [{ start: 3, end: 9, userId }] });
	expect(body.blocks[0]).toEqual({ type: "paragraph", children: [
		{ type: "text", text: "Hi " }, { type: "mention", user_id: userId }, { type: "text", text: " and @Alice" },
	] });
	expect(readCommentDraft("Existing draft")).toEqual({ text: "Existing draft", mentions: [] });
	expect(readCommentDraft({ text: "short", mentions: [{ start: 0, end: 99, userId }] }).mentions).toEqual([]);
});
