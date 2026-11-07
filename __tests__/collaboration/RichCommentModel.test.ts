/** @jest-environment jsdom */
import { TextEncoder } from "node:util";
import { DOMParser, DOMSerializer } from "prosemirror-model";
import { bodyToCommentDoc, commentDocBody, commentSchema, readRichDraftBody, richCommentBody } from "../../src/collaboration/ui/RichCommentModel";
import { commentDraftBody, editableCommentDraft, readCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { pictureIds } from "../../src/collaboration/PictureProtocol";
import { type MessageBody, type Paragraph } from "../../src/collaboration/DiscussionProtocol";

Object.assign(globalThis, { TextEncoder });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const paragraph = (text: string): Paragraph => ({ type: "paragraph", children: [{ type: "text", text }] });

test("round trips every wire node, mixed marks, stable mentions and pictures between blocks", () => {
	const body: MessageBody = { version: 1, blocks: [paragraph("Before"), { type: "picture", picture_id: id(1), alt: "Diagram" },
		{ type: "paragraph", children: [{ type: "text", text: "formatted", marks: ["bold", "italic", "code", "strike"] }, { type: "mention", user_id: id(2) },
			{ type: "link", url: "https://example.com/a", children: [{ type: "text", text: "label", marks: ["bold"] }, { type: "text", text: " end" }] }] },
		{ type: "list", ordered: true, items: [paragraph("First"), paragraph("Second")] }, { type: "list", ordered: false, items: [paragraph("Bullet")] },
		{ type: "code", text: "const x = 1;\n", language: "js" }, paragraph("After")] };
	expect(commentDocBody(bodyToCommentDoc(body, () => "Renamed member"))).toEqual(body);
	expect(commentDraftBody(editableCommentDraft(body, () => "Alice"))).toEqual(body);
});

test("drafts preserve empty blocks and blank lines, while a completely empty draft cannot send", () => {
	const blank: MessageBody = { version: 1, blocks: [{ type: "paragraph", children: [] }, { type: "code", text: "", language: "" }] };
	expect(commentDocBody(bodyToCommentDoc(blank, () => "Member"))).toEqual(blank);
	expect(() => richCommentBody(blank)).toThrow("Write a comment");
	expect(richCommentBody({ version: 1, blocks: [...blank.blocks, paragraph("Keep empty blocks")] }).blocks.slice(0, 2)).toEqual([
		paragraph("\n"), { type: "code", text: "\n", language: "" },
	]);
});

test("HTML paste accepts supported formatting without importing private IDs, scripts or unsafe links", () => {
	const root = document.createElement("div");
	root.innerHTML = `<p><strong>Bold</strong> <em>italic</em> <span data-user-id="${id(1)}" class="relay-comment-mention">@Alice</span><a href="javascript:alert(1)">bad</a><a href="https://example.com">safe</a></p><div data-picture-id="${id(2)}">Picture</div><script>alert(1)</script><img src="https://example.com/pixel" onerror="alert(1)"><ul><li>First<ul><li>Nested</li></ul></li></ul>`;
	const parsed = DOMParser.fromSchema(commentSchema).parse(root), body = commentDocBody(parsed);
	expect(JSON.stringify(body)).not.toContain(id(1)); expect(JSON.stringify(body)).not.toContain(id(2));
	expect(JSON.stringify(body)).not.toContain("alert(1)"); expect(pictureIds(body)).toEqual([]);
	expect(parsed.textContent).toContain("@Alice"); expect(parsed.textContent).toContain("Nested");
	expect(root.querySelectorAll("a")).toHaveLength(2);
	const output = document.createElement("div"); output.append(DOMSerializer.fromSchema(commentSchema).serializeFragment(parsed.content));
	expect(output.querySelector("strong")?.textContent).toBe("Bold"); expect(output.querySelectorAll("a")).toHaveLength(1);
	expect(output.querySelector("a")?.href).toBe("https://example.com/");
});

test("copied rich DOM never exports member or private picture IDs", () => {
	const doc = bodyToCommentDoc({ version: 1, blocks: [{ type: "paragraph", children: [{ type: "mention", user_id: id(1) }] }, { type: "picture", picture_id: id(2), alt: "Diagram" }] }, () => "Alice");
	const output = document.createElement("div"); output.append(DOMSerializer.fromSchema(commentSchema).serializeFragment(doc.content));
	expect(output.textContent).toBe("@AliceDiagram"); expect(output.innerHTML).not.toContain(id(1)); expect(output.innerHTML).not.toContain(id(2));
});

test("long adjacent editor text splits at protocol code-point boundaries and enforces total size", () => {
	const text = "a".repeat(8191) + "😀" + "after";
	const doc = commentSchema.nodes.doc.create(null, commentSchema.nodes.paragraph.create(null, commentSchema.text(text)));
	const body = commentDocBody(doc), children = (body.blocks[0] as Paragraph).children;
	expect(children).toEqual([{ type: "text", text: "a".repeat(8191) + "😀" }, { type: "text", text: "after" }]);
	expect(() => commentDocBody(commentSchema.nodes.doc.create(null, commentSchema.nodes.paragraph.create(null, commentSchema.text("x".repeat(40_000)))))).toThrow();
	expect(() => readRichDraftBody({ version: 1, blocks: [null] })).toThrow();
	expect(() => readRichDraftBody({ version: 1, blocks: [{ type: "code", text: "ok", language: "<script>" }] })).toThrow();
});

test("rich drafts require exact active references; undo references are bounded and cannot enter a sent body", () => {
	const body: MessageBody = { version: 1, blocks: [paragraph("Body"), { type: "picture", picture_id: id(1), alt: "Active" }] };
	const draft = { ...editableCommentDraft(body, () => "Member"), editBaseRevision: 4, undoPictures: [{ type: "picture" as const, picture_id: id(2), alt: "Removed" }] };
	expect(pictureIds(draft, true)).toEqual([id(1), id(2)]);
	expect(readCommentDraft(draft).editBaseRevision).toBe(4); expect(pictureIds(commentDraftBody(draft))).toEqual([id(1)]);
	expect(() => readCommentDraft({ ...draft, pictures: [] })).toThrow("do not match");
	expect(() => readCommentDraft({ ...draft, editBaseRevision: -1 })).toThrow();
	expect(() => pictureIds({ ...draft, undoPictures: Array.from({ length: 100 }, (_, i) => ({ type: "picture", picture_id: id(i + 2) })) }, true)).toThrow("limit");
});
