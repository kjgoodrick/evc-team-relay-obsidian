import { EditorState, NodeSelection, Plugin, Selection, TextSelection, type Command, type SelectionBookmark, type Transaction } from "prosemirror-state";
import { EditorView, type NodeView } from "prosemirror-view";
import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark } from "prosemirror-commands";
import { closeHistory, history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { liftListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import type { Node as EditorNode } from "prosemirror-model";
import { safeDiscussionUrl, type MessageBody } from "../DiscussionProtocol";
import type { PictureBlock } from "../PictureProtocol";
import type { DiscussionSession } from "../DiscussionSession";
import type { CommentDraft } from "./CommentDraft";
import { commentBodyText } from "./CommentBody";
import { CommentPicture } from "./CommentPicture";
import { bodyToCommentDoc, commentDocBody, commentSchema, readRichDraftBody } from "./RichCommentModel";

const emptyBody = (): MessageBody => ({ version: 1, blocks: [{ type: "paragraph", children: [] }] });

/** A local editor, not another collaborative document. Only the bounded message
 * body enters drafts/outbox. Mention IDs come from the authorized member picker. */
export class RichCommentEditor {
	readonly el: HTMLElement;
	readonly view: EditorView;
	private toolbar: HTMLElement;
	private controls: { button: HTMLButtonElement; command: Command; active?: () => boolean }[] = [];
	private enabled = true;
	private disposed = false;
	private original: MessageBody;
	private originalDoc: EditorNode;
	private remembered = new Map<string, PictureBlock>();
	private linkPanel: HTMLElement;
	private linkInput: HTMLInputElement;
	private linkBookmark?: SelectionBookmark;
	private language: HTMLInputElement;
	private languageLabel: HTMLElement;
	private pictureControls = new Set<() => void>();

	constructor(parent: HTMLElement, private session: DiscussionSession, private scopeId: string, body: MessageBody,
		private change: () => void, private error: (message: string) => void, private send: () => void,
		private attach: (files: File[]) => void, label: string, private localOnly = false) {
		this.original = readRichDraftBody(body); this.originalDoc = bodyToCommentDoc(body, id => this.localOnly ? "Member" : session.displayName(scopeId, id));
		this.remember(this.original);
		this.el = parent.createDiv({ cls: "relay-comment-rich" });
		this.toolbar = this.el.createDiv({ cls: "relay-comment-formatting", attr: { role: "group", "aria-label": "Comment formatting" } });
		const mount = this.el.createDiv({ cls: "relay-comment-rich-input" });
		this.linkPanel = this.el.createDiv({ cls: "relay-comment-link-editor" }); this.linkPanel.hidden = true;
		const linkLabel = this.linkPanel.createEl("label", { text: "Link address" });
		this.linkInput = linkLabel.createEl("input", { attr: { type: "url", placeholder: "https://…", maxlength: "2048" } });
		const apply = this.linkPanel.createEl("button", { text: "Apply link", attr: { type: "button" } }); apply.onclick = () => this.applyLink();
		const remove = this.linkPanel.createEl("button", { text: "Remove link", attr: { type: "button" } }); remove.onclick = () => this.applyLink(true);
		const cancel = this.linkPanel.createEl("button", { text: "Cancel link", attr: { type: "button" } }); cancel.onclick = () => this.closeLink();
		this.linkInput.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); this.applyLink(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.closeLink(); } };
		this.languageLabel = this.el.createEl("label", { cls: "relay-comment-code-language", text: "Code language" });
		this.language = this.languageLabel.createEl("input", { attr: { type: "text", maxlength: "32", placeholder: "Optional, for example: js" } });
		this.language.onchange = () => {
			if (!this.enabled || !/^[a-zA-Z0-9_+.-]{0,32}$/.test(this.language.value)) { this.error("Use a language name of up to 32 letters, numbers, underscores, plus signs, dots or hyphens."); return; }
			const { $from } = this.view.state.selection;
			if ($from.parent.type.name === "code_block") this.view.dispatch(this.view.state.tr.setNodeMarkup($from.before(), undefined, { language: this.language.value }));
		};
		this.language.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); this.language.blur(); this.view.focus(); } };
		this.view = new EditorView({ mount }, {
			state: this.state(this.originalDoc), editable: () => this.enabled,
			attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true", spellcheck: "true" },
			dispatchTransaction: transaction => this.dispatch(transaction),
			nodeViews: { picture: (node, _view, position) => this.picture(node, position) },
			handlePaste: () => !this.enabled || this.composing,
			handleDOMEvents: { paste: (_view, event) => {
				if (!this.enabled || this.composing) { event.preventDefault(); return true; }
				const data = event.clipboardData, files = Array.from(data?.files ?? []).filter(file => file.type.startsWith("image/"));
				const text = data?.getData("text/plain") ?? "";
				// Bound clipboard parsing before creating a DOM, including huge copied
				// pages and base64 image HTML. File bytes use the durable staging path.
				if (text.length > 65_536 || !files.length && (data?.getData("text/html").length ?? 0) > 262_144) {
					event.preventDefault(); this.error("This paste is too large. Paste a smaller selection; your draft is retained."); return true;
				}
				if (!files.length) return false;
				event.preventDefault(); if (text) this.view.dispatch(this.view.state.tr.insertText(text));
				this.attach(files); return true;
			}, click: (_view, event) => {
				// Editing a link never navigates away from an unsent draft.
				const target = event.target as Element | null;
				if (target?.closest?.("a")) { event.preventDefault(); return true; } return false;
			} },
			clipboardTextSerializer: slice => slice.content.textBetween(0, slice.content.size, "\n", node => node.type.name === "mention" ? "@" + node.attrs.label : node.type.name === "picture" ? "[Picture]" : ""),
		});
		for (const [mark, title] of [["bold", "Bold"], ["italic", "Italic"], ["strike", "Strikethrough"], ["code", "Inline code"]]) {
			this.control(title, toggleMark(commentSchema.marks[mark]), () => this.markActive(mark));
		}
		this.control("Bulleted list", this.list("bullet_list"), () => this.inNode("bullet_list"));
		this.control("Numbered list", this.list("ordered_list"), () => this.inNode("ordered_list"));
		this.control("Code block", this.codeBlock(), () => this.inNode("code_block"));
		const link = this.toolbar.createEl("button", { text: "Link", attr: { type: "button" } });
		link.onmousedown = event => event.preventDefault(); link.onclick = () => this.openLink();
		this.controls.push({ button: link, command: () => !this.inNode("code_block") });
		this.control("Undo", undo); this.control("Redo", redo);
		this.update();
	}
	private state(doc: EditorNode): EditorState {
		return EditorState.create({ doc, plugins: [history({ depth: 100 }), new Plugin({ filterTransaction: transaction => {
			if (!transaction.docChanged) return true;
			if (!this.enabled) return false;
			try {
				const body = commentDocBody(transaction.doc), ids = new Set(this.remembered.keys());
				for (const block of body.blocks) if (block.type === "picture") ids.add(block.picture_id);
				if (ids.size > 100) throw new Error("undo pictures");
				return true;
			} catch { this.error("This change exceeds the comment size or picture limit. Your previous text is retained."); return false; }
		}, appendTransaction: (_transactions, _old, state) => {
			let tr: Transaction | undefined;
			state.doc.descendants((node, pos) => { if (node.type.name === "mention" && node.marks.length) { tr ??= state.tr; tr.setNodeMarkup(pos, undefined, node.attrs, []); } });
			return tr;
		} }), keymap({
			"Mod-b": toggleMark(commentSchema.marks.bold), "Mod-i": toggleMark(commentSchema.marks.italic),
			"Mod-z": undo, "Mod-Shift-z": redo, "Mod-y": redo,
			"Mod-Enter": () => { if (!this.view.composing) this.send(); return true; },
			Enter: chainCommands(splitListItem(commentSchema.nodes.list_item), (state, dispatch) => state.selection.$from.parent.content.size === 0 && liftListItem(commentSchema.nodes.list_item)(state, dispatch), baseKeymap.Enter),
			"Shift-Enter": (state, dispatch) => { dispatch?.(state.tr.insertText("\n")); return true; },
			"Mod-Shift-Enter": exitCode,
		}), keymap(baseKeymap)] });
	}
	private remember(body: MessageBody): void { for (const block of body.blocks) if (block.type === "picture") this.remembered.set(block.picture_id, { ...block }); }
	private dispatch(transaction: Transaction): void {
		if (this.disposed) return;
		const next = this.view.state.applyTransaction(transaction);
		if (!next.transactions.length) return;
		if (this.linkBookmark) for (const applied of next.transactions) this.linkBookmark = this.linkBookmark.map(applied.mapping);
		this.view.updateState(next.state);
		if (transaction.docChanged) { this.remember(this.body()); this.change(); }
		this.update();
	}
	private control(label: string, command: Command, active?: () => boolean): void {
		const button = this.toolbar.createEl("button", { text: label, attr: { type: "button" } });
		button.onmousedown = event => event.preventDefault();
		button.onclick = () => { if (this.enabled && !this.view.composing) { command(this.view.state, this.view.dispatch, this.view); this.view.focus(); } };
		this.controls.push({ button, command, active });
	}
	private markActive(name: string): boolean {
		const { from, to, empty, $from } = this.view.state.selection, mark = commentSchema.marks[name];
		return empty ? !!mark.isInSet(this.view.state.storedMarks ?? $from.marks()) : this.view.state.doc.rangeHasMark(from, to, mark);
	}
	private inNode(name: string): boolean {
		const { $from } = this.view.state.selection;
		for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === name) return true;
		return false;
	}
	private list(name: "bullet_list" | "ordered_list"): Command {
		return (state, dispatch) => {
			const { $from } = state.selection;
			for (let depth = $from.depth; depth > 0; depth--) {
				const node = $from.node(depth);
				if (!["bullet_list", "ordered_list"].includes(node.type.name)) continue;
				if (node.type.name === name) return liftListItem(commentSchema.nodes.list_item)(state, dispatch);
				dispatch?.(state.tr.setNodeMarkup($from.before(depth), commentSchema.nodes[name])); return true;
			}
			return wrapInList(commentSchema.nodes[name])(state, dispatch);
		};
	}
	private codeBlock(): Command {
		return (state, dispatch) => {
			let mention = false;
			const { $from, $to } = state.selection;
			state.doc.nodesBetween($from.start(), $to.end(), node => { if (node.type.name === "mention") mention = true; });
			if (mention) return false;
			return setBlockType($from.parent.type.name === "code_block" ? commentSchema.nodes.paragraph : commentSchema.nodes.code_block)(state, dispatch);
		};
	}
	private openLink(): void {
		if (!this.enabled || this.view.composing || this.inNode("code_block")) return;
		let selection = this.view.state.selection;
		// At a caret inside a link, edit the entire contiguous link instead of
		// inserting a second URL or making Remove appear to do nothing.
		if (selection.empty && selection.$from.parent.isTextblock) {
			const { $from } = selection, parent = $from.parent, link = commentSchema.marks.link;
			const child = parent.childAfter($from.parentOffset), mark = child.node && link.isInSet(child.node.marks);
			if (mark) {
				let start = child.offset, end = start + child.node!.nodeSize, index = child.index;
				while (index > 0 && mark.isInSet(parent.child(index - 1).marks)) start -= parent.child(--index).nodeSize;
				index = child.index + 1;
				while (index < parent.childCount && mark.isInSet(parent.child(index).marks)) end += parent.child(index++).nodeSize;
				selection = TextSelection.create(this.view.state.doc, $from.start() + start, $from.start() + end);
			}
		}
		this.linkBookmark = selection.getBookmark();
		this.linkInput.value = (selection.$from.nodeAfter?.marks ?? selection.$from.marks()).find(mark => mark.type.name === "link")?.attrs.href ?? "";
		this.linkPanel.hidden = false; this.linkInput.focus();
	}
	private applyLink(remove = false): void {
		if (!this.enabled || !this.linkBookmark) return;
		const href = this.linkInput.value.trim();
		if (!remove && !safeDiscussionUrl(href)) { this.error("Use a complete HTTP or HTTPS link without a username or password."); return; }
		let selection;
		try { selection = this.linkBookmark.resolve(this.view.state.doc); } catch { this.closeLink(); return; }
		const tr = this.view.state.tr.setSelection(selection), type = commentSchema.marks.link;
		if (selection.empty && !remove) {
			tr.insertText(href); tr.addMark(selection.from, selection.from + href.length, type.create({ href }));
		} else if (remove) tr.removeMark(selection.from, selection.to, type);
		else tr.addMark(selection.from, selection.to, type.create({ href }));
		this.view.dispatch(closeHistory(tr)); this.closeLink();
	}
	private closeLink(): void { this.linkBookmark = undefined; this.linkPanel.hidden = true; if (!this.disposed) this.view.focus(); }
	update(): void {
		if (this.disposed) return;
		for (const control of this.controls) {
			control.button.disabled = !this.enabled || !control.command(this.view.state, undefined, this.view);
			if (control.active) control.button.setAttribute("aria-pressed", String(control.active()));
		}
		const code = this.view.state.selection.$from.parent;
		this.languageLabel.hidden = code.type.name !== "code_block";
		if (this.language.ownerDocument.activeElement !== this.language) this.language.value = code.type.name === "code_block" ? code.attrs.language : "";
		this.language.disabled = !this.enabled;
		for (const element of Array.from(this.linkPanel.querySelectorAll("input,button"))) (element as HTMLInputElement).disabled = !this.enabled;
		for (const update of this.pictureControls) update();
	}
	setEditable(enabled: boolean): void { if (this.enabled !== enabled) { this.enabled = enabled; this.view.setProps({ editable: () => this.enabled }); } this.update(); }
	get composing(): boolean { return this.view.composing; }
	body(): MessageBody { return this.view.state.doc.eq(this.originalDoc) ? readRichDraftBody(this.original) : commentDocBody(this.view.state.doc); }
	draft(): CommentDraft {
		return this.draftFor(this.body());
	}
	private draftFor(rich: MessageBody): CommentDraft {
		const pictures = rich.blocks.filter((block): block is PictureBlock => block.type === "picture"), active = new Set(pictures.map(picture => picture.picture_id));
		const undoPictures = [...this.remembered.values()].filter(picture => !active.has(picture.picture_id));
		return { text: commentBodyText(rich, id => this.localOnly ? "Member" : this.session.displayName(this.scopeId, id)), mentions: [], rich, pictures, ...(undoPictures.length ? { undoPictures } : {}) };
	}
	setBody(body: MessageBody = emptyBody()): void {
		this.original = readRichDraftBody(body); this.originalDoc = bodyToCommentDoc(body, id => this.localOnly ? "Member" : this.session.displayName(this.scopeId, id));
		this.remembered.clear(); this.remember(body); this.linkBookmark = undefined; this.linkPanel.hidden = true;
		this.view.updateState(this.state(this.originalDoc)); this.update();
	}
	insertMention(userId: string, label: string): void {
		if (!this.enabled || this.composing) return;
		if (this.inNode("code_block")) { this.error("Move outside the code block to mention a member."); return; }
		this.view.dispatch(this.view.state.tr.replaceSelectionWith(commentSchema.nodes.mention.create({ user_id: userId, label }), false).insertText(" "));
		this.view.focus();
	}
	/** Build the exact attachment insertion before the durable byte/reference
	 * transaction. Apply only after that transaction succeeds. */
	preparePictures(pictures: PictureBlock[]): { draft: CommentDraft; apply: () => void } {
		if (!pictures.length) throw new Error("Choose a picture to insert");
		const state = this.view.state, $from = state.selection.$to;
		let tr = state.tr.setSelection(Selection.near(state.doc.resolve(state.selection.to)));
		if ($from.depth > 1) tr = tr.insert($from.after(1), pictures.map(picture => commentSchema.nodes.picture.create(picture)));
		else tr = tr.replaceSelectionWith(commentSchema.nodes.picture.create(pictures[0]), false);
		if ($from.depth <= 1 && pictures.length > 1) tr = tr.insert(tr.selection.to, pictures.slice(1).map(picture => commentSchema.nodes.picture.create(picture)));
		const rich = commentDocBody(tr.doc), draft = this.draftFor(rich);
		return { draft, apply: () => {
			if (!this.disposed && this.view.state.doc.eq(state.doc)) { const enabled = this.enabled; this.enabled = true; try { this.view.dispatch(closeHistory(tr)); } finally { this.enabled = enabled; this.update(); } }
		} };
	}
	private picture(initial: EditorNode, position: () => number | undefined): NodeView {
		let node = initial;
		const dom = this.el.ownerDocument.createElement("div"); dom.className = "relay-comment-rich-picture"; dom.contentEditable = "false";
		const picture = new CommentPicture(dom, this.session, this.scopeId, { type: "picture", picture_id: node.attrs.picture_id, alt: node.attrs.alt }, this.localOnly ? "only" : true);
		const alt = dom.createEl("input", { attr: { type: "text", maxlength: "1024", "aria-label": "Picture description", placeholder: "Picture description" } }); alt.value = node.attrs.alt;
		alt.oninput = () => { const pos = position(); if (this.enabled && pos !== undefined) this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: alt.value })); };
		const remove = dom.createEl("button", { text: "Remove picture", attr: { type: "button" } });
		remove.onclick = () => { const pos = position(); if (this.enabled && !this.composing && pos !== undefined) this.view.dispatch(closeHistory(this.view.state.tr.delete(pos, pos + node.nodeSize))); };
		const up = dom.createEl("button", { text: "Move picture up", attr: { type: "button" } });
		const down = dom.createEl("button", { text: "Move picture down", attr: { type: "button" } });
		const move = (direction: -1 | 1) => {
			const pos = position(); if (!this.enabled || this.composing || pos === undefined) return;
			const state = this.view.state, index = state.doc.resolve(pos).index(), sibling = state.doc.maybeChild(index + direction);
			if (!sibling) return;
			const destination = pos + direction * sibling.nodeSize;
			const tr = state.tr.delete(pos, pos + node.nodeSize).insert(destination, node);
			this.view.dispatch(closeHistory(tr.setSelection(NodeSelection.create(tr.doc, destination)))); this.view.focus();
		};
		up.onclick = () => move(-1); down.onclick = () => move(1);
		const update = () => {
			alt.disabled = remove.disabled = !this.enabled;
			const pos = position(), doc = this.view?.state.doc;
			up.disabled = !this.enabled || pos === undefined || pos === 0;
			down.disabled = !this.enabled || pos === undefined || !doc || pos + node.nodeSize >= doc.content.size;
		}; this.pictureControls.add(update); update();
		return { dom, ignoreMutation: () => true, stopEvent: event => !!(event.target as Element)?.closest?.("input,button"),
			update: next => { if (next.type !== node.type || next.attrs.picture_id !== node.attrs.picture_id) return false; node = next;
				if (alt.value !== next.attrs.alt) alt.value = next.attrs.alt; picture.setAlt(next.attrs.alt); update(); return true; },
			selectNode: () => dom.classList.add("ProseMirror-selectednode"), deselectNode: () => dom.classList.remove("ProseMirror-selectednode"),
			destroy: () => { this.pictureControls.delete(update); picture.dispose(); },
		};
	}
	focus(from?: number, to = from): void {
		if (from !== undefined) {
			const locate = (offset: number, end: boolean) => {
				let used = 0, found: number | undefined;
				this.view.state.doc.descendants((node, pos) => {
					if (found !== undefined) return false;
					const length = node.isText ? node.text!.length : node.type.name === "mention" ? String(node.attrs.label).length + 1 : 0;
					if (length && offset <= used + length) found = node.isText ? pos + Math.max(0, offset - used) : pos + (end && offset > used ? 1 : 0);
					used += length;
				});
				return found ?? Math.max(1, this.view.state.doc.content.size - 1);
			};
			this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, locate(from, false), locate(to ?? from, true))));
		}
		this.view.focus();
	}
	dispose(): void { if (this.disposed) return; this.disposed = true; this.view.destroy(); this.pictureControls.clear(); this.el.remove(); }
}
