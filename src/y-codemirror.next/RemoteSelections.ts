// Code in this file has been adapted from y-codemirror.next
// LicenseRecord
// [The MIT LicenseRecord](./LICENSE) © Kevin Jahns

import * as dom from "lib0/dom";
import * as pair from "lib0/pair";
import * as math from "lib0/math";
import { AnnotationType, Annotation, RangeSet, Range } from "@codemirror/state";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	WidgetType,
} from "@codemirror/view";

import type { PluginValue, DecorationSet } from "@codemirror/view";

import {
	ViewBindingRegistry,
	DocumentViewBinding,
	ViewBindingStateField,
} from "../ViewBindings";

import * as Y from "yjs";
import type { RelativePosition } from "yjs";
import type { Awareness } from "y-protocols/awareness.js";
import { presenceColorForUser } from "../presenceColor";

interface AwarenessCursor {
	anchor: RelativePosition;
	head: RelativePosition;
}

interface AwarenessUser {
	id?: string;
	name?: string;
	color?: string;
	colorLight?: string;
}

interface AwarenessState {
	surface?: "editor" | "reading";
	cursor?: AwarenessCursor | null;
	user?: AwarenessUser;
}
import { namedLogger } from "src/logging";
import { type TextFileView, editorInfoField } from "obsidian";
import type { Document as RelayDocument } from "../Document";

export const yRemoteSelectionsTheme = EditorView.baseTheme({
	".cm-ySelection": {},
	".cm-yLineSelection": {
		padding: 0,
		margin: "0px 2px 0px 4px",
	},
	".cm-ySelectionCaret": {
		position: "relative",
		borderLeft: "1px solid black",
		borderRight: "1px solid black",
		marginLeft: "-1px",
		marginRight: "-1px",
		boxSizing: "border-box",
		display: "inline",
	},
	".cm-ySelectionCaretDot": {
		borderRadius: "50%",
		position: "absolute",
		width: ".4em",
		height: ".4em",
		top: "-.2em",
		left: "-.2em",
		backgroundColor: "inherit",
		transition: "transform .3s ease-in-out",
		boxSizing: "border-box",
	},
	".cm-ySelectionCaret:hover > .cm-ySelectionCaretDot": {
		transformOrigin: "bottom center",
		transform: "scale(0)",
	},
	".cm-ySelectionInfo": {
		position: "absolute",
		top: "-1.05em",
		left: "-1px",
		fontSize: ".75em",
		fontFamily: "serif",
		fontStyle: "normal",
		fontWeight: "normal",
		lineHeight: "normal",
		userSelect: "none",
		color: "white",
		paddingLeft: "2px",
		paddingRight: "2px",
		zIndex: 101,
		transition: "opacity .3s ease-in-out",
		backgroundColor: "inherit",
		// these should be separate
		opacity: 0,
		transitionDelay: "0s",
		whiteSpace: "nowrap",
	},
	".cm-ySelectionCaret:hover > .cm-ySelectionInfo": {
		opacity: 1,
		transitionDelay: "0s",
	},
});

/**
 * @todo specify the users that actually changed. Currently, we recalculate positions for every user.
 */
const yRemoteSelectionsAnnotation: AnnotationType<Array<number>> =
	Annotation.define();
export class YRemoteCaretWidget extends WidgetType {
	color: string;
	name: string;
	constructor(color: string, name: string) {
		super();
		this.color = color;
		this.name = name;
	}

	toDOM(editor: EditorView): HTMLElement {
		return <HTMLElement>(
			dom.element(
				"span",
				[
					pair.create("class", "cm-ySelectionCaret"),
					pair.create(
						"style",
						`background-color: ${this.color}; border-color: ${this.color}`,
					),
				],
				[
					dom.text("\u2060"),
					dom.element("div", [pair.create("class", "cm-ySelectionCaretDot")]),
					dom.text("\u2060"),
					dom.element(
						"div",
						[pair.create("class", "cm-ySelectionInfo")],
						[dom.text(this.name)],
					),
					dom.text("\u2060"),
				],
			)
		);
	}

	eq(widget: YRemoteCaretWidget) {
		return widget.color === this.color && widget.name === this.name;
	}

	compare(widget: YRemoteCaretWidget) {
		return this.eq(widget);
	}

	updateDOM() {
		return false;
	}

	get estimatedHeight() {
		return -1;
	}

	ignoreEvent() {
		return true;
	}
}

type AwarenessChangeEvent = {
	added: number[];
	updated: number[];
	removed: number[];
};

type AwarenessChangeHandler = (
	event: AwarenessChangeEvent,
	origin: unknown, // The type of origin can be very broad, depending on what triggered the change.
	awareness: Awareness,
) => void;

// Several leaves can share one provider. An inactive leaf must never clear
// another leaf's foreground selection when it receives a remote update.
const cursorOwners = new WeakMap<Awareness, YRemoteSelectionsPluginValue>();

export class YRemoteSelectionsPluginValue implements PluginValue {
	editor: EditorView;
	connectionManager?: ViewBindingRegistry;
	view?: DocumentViewBinding<TextFileView>;
	decorations: DecorationSet;
	_awareness?: Awareness;
	_listener?: AwarenessChangeHandler;
	document?: RelayDocument;
	private destroyed = false;
	private renderDirty = true;
	private ownerDocument: Document;
	private clearOnBlur = () => this.clearOwnedCursor();
	private clearOnHidden = () => {
		if (this.ownerDocument.visibilityState === "hidden") this.clearOwnedCursor();
	};

	constructor(editor: EditorView) {
		this.editor = editor;
		this.ownerDocument = editor.dom.ownerDocument;
		this.decorations = RangeSet.of([]);
		this.connectionManager = this.editor.state.field(
			ViewBindingStateField,
		);

		// Allowlist: Check for live editing markers (same as LiveEditPlugin)
		const sourceView = this.editor.dom.closest(".markdown-source-view");
		const isLiveEditor = this.editor.dom.closest(".relay-live-editor");
		const hasIframeClass = sourceView?.classList.contains("mod-inside-iframe");

		// For embedded canvas editors, we can't always find the canvas via ConnectionManager
		// but if it has mod-inside-iframe, it's likely a legitimate embedded editor
		const isEmbeddedInCanvas = hasIframeClass;

		if (!isLiveEditor && !isEmbeddedInCanvas) {
			this.destroyed = true;
			return;
		}

		this._listener = ({ added, updated, removed }) => {
			const clients = added.concat(updated).concat(removed);
			if (
				!this.destroyed &&
				clients.findIndex((id) => id !== this._awareness?.clientID) >= 0
			) {
				this.renderDirty = true;
				editor.dispatch({
					annotations: [yRemoteSelectionsAnnotation.of([])],
				});
			}
		};
		this.view = this.connectionManager?.locateMarkdownView(editor);
		if (this.view instanceof DocumentViewBinding) this.bindAwareness(this.view.boundDocument?._liveProvider?.awareness);
		this.ownerDocument.defaultView?.addEventListener("blur", this.clearOnBlur);
		this.ownerDocument.defaultView?.addEventListener("pagehide", this.clearOnBlur);
		this.ownerDocument.addEventListener("visibilitychange", this.clearOnHidden);
	}

	private clearOwnedCursor() {
		const awareness = this._awareness;
		if (awareness && cursorOwners.get(awareness) === this) {
			cursorOwners.delete(awareness);
			if (awareness.getLocalState()?.cursor != null) awareness.setLocalStateField("cursor", null);
		}
	}

	private bindAwareness(awareness?: Awareness) {
		if (this._awareness === awareness) return;
		this.clearOwnedCursor();
		if (this._listener) this._awareness?.off("change", this._listener);
		this._awareness = awareness;
		if (this._listener) awareness?.on("change", this._listener);
		this.renderDirty = true;
	}

	getDocument(): RelayDocument | undefined {
		const fileInfo = this.editor.state.field(editorInfoField);
		const file = fileInfo.file;
		
		if (file) {
			if (this.document?._obsidianFile === file) {
				return this.document;
			}
			const folder = this.connectionManager?.shareRegistry.shareFor(file.path);
			if (folder) {
				this.document = folder.rootRelative.docAt(file.path);
				return this.document;
			}
		}
		
		// Fallback to using view
		this.view = this.connectionManager?.locateMarkdownView(this.editor);
		return this.view?.boundDocument;
	}

	destroy() {
		this.destroyed = true;
		this.bindAwareness(undefined);
		this._listener = undefined;
		this.ownerDocument.defaultView?.removeEventListener("blur", this.clearOnBlur);
		this.ownerDocument.defaultView?.removeEventListener("pagehide", this.clearOnBlur);
		this.ownerDocument.removeEventListener("visibilitychange", this.clearOnHidden);
		this.connectionManager = null as unknown as ViewBindingRegistry | undefined;
		this.view = null as unknown as DocumentViewBinding<TextFileView> | undefined;
		this.editor = null as unknown as EditorView;
	}

	update(update: ViewUpdate) {
		if (this.destroyed) {
			return;
		}
		this.document = this.getDocument();
		const ytext = this.document?.crdtText;
		if (!(this.document && ytext && ytext.doc)) {
			this.bindAwareness(undefined);
			this.decorations = Decoration.none;
			return;
		}
		const provider = this.document._liveProvider;
		if (!provider) {
			this.bindAwareness(undefined);
			this.decorations = Decoration.none;
			return;
		}
		this.bindAwareness(provider.awareness);
		const awareness = provider.awareness;

		const ydoc: Y.Doc = ytext.doc;
		const decorations: Array<Range<Decoration>> = [];
		const localAwarenessState = awareness.getLocalState() as AwarenessState | null;

		// set local awareness state (update cursors)
		if (localAwarenessState != null) {
			const hasFocus =
				localAwarenessState.surface !== "reading" && update.view.hasFocus && this.ownerDocument.hasFocus() && this.ownerDocument.visibilityState !== "hidden";
			const sel = hasFocus ? update.state.selection.main : null;
			const currentAnchor =
				localAwarenessState.cursor == null
					? null
					: Y.createRelativePositionFromJSON(
							localAwarenessState.cursor.anchor,

						);
			const currentHead =
				localAwarenessState.cursor == null
					? null
					: Y.createRelativePositionFromJSON(
							localAwarenessState.cursor.head,

						);

			if (sel != null) {
				cursorOwners.set(awareness, this);
				const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
				const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
				if (
					localAwarenessState.cursor == null ||
					!Y.compareRelativePositions(currentAnchor, anchor) ||
					!Y.compareRelativePositions(currentHead, head)
				) {
					awareness.setLocalStateField("cursor", {
						anchor,
						head,
					});
				}
			} else {
				this.clearOwnedCursor();
			}
		}
		if (!this.renderDirty && !update.docChanged && !update.viewportChanged) return;
		this.renderDirty = false;

		// update decorations (remote selections)
		awareness.getStates().forEach((rawState, clientid) => {
			if (!rawState || typeof rawState !== "object") return;
			const state = rawState as AwarenessState;
			if (clientid === awareness.clientID) {
				return;
			}
			const cursor = state.cursor;
			if (cursor == null || cursor.anchor == null || cursor.head == null) {
				return;
			}
			let anchor: Y.AbsolutePosition | null, head: Y.AbsolutePosition | null;
			try {
				anchor = Y.createAbsolutePositionFromRelativePosition(
					cursor.anchor,
					ydoc,
				);
				head = Y.createAbsolutePositionFromRelativePosition(
					cursor.head,
					ydoc,
				);
			} catch { return; }
			if (
				anchor == null ||
				head == null ||
				anchor.type !== ytext ||
				head.type !== ytext
			) {
				return;
			}
			if (
				anchor.index > update.state.doc.length ||
				head.index > update.state.doc.length
			) {
				namedLogger(
					"[RemoteSelections]",
					"warn",
				)(
					`cursor positions (${anchor.index}, ${head.index}) out of range of document length: ${update.state.doc.length}`,
				);
				this.decorations = Decoration.none;
				return;
			}
			const user: AwarenessUser = state.user ?? {};
			const { name = "Anonymous" } = user;
			const { color, light: colorLight } = presenceColorForUser(user);
			const start = math.min(anchor.index, head.index);
			const end = math.max(anchor.index, head.index);
			for (const visible of update.view.visibleRanges) {
				const visibleStart = Math.max(start, visible.from), visibleEnd = Math.min(end, visible.to);
				if (visibleStart >= visibleEnd) continue;
				const startLine = update.view.state.doc.lineAt(visibleStart);
				const endLine = update.view.state.doc.lineAt(visibleEnd);
				if (startLine.number === endLine.number) {
					// selected content in a single line.
					decorations.push({
						from: visibleStart,
						to: visibleEnd,
						value: Decoration.mark({
							attributes: {
								style: `background-color: ${colorLight}`,
							},
							class: "cm-ySelection",
						}),
					});
				} else {
					// selected content in multiple lines
					// first, render text-selection in the first line
					decorations.push({
						from: visibleStart,
						to: startLine.from + startLine.length,
						value: Decoration.mark({
							attributes: {
								style: `background-color: ${colorLight}`,
							},
							class: "cm-ySelection",
						}),
					});
					// render text-selection in the last line
					decorations.push({
						from: endLine.from,
						to: visibleEnd,
						value: Decoration.mark({
							attributes: {
								style: `background-color: ${colorLight}`,
							},
							class: "cm-ySelection",
						}),
					});
					for (let i = startLine.number + 1; i < endLine.number; i++) {
						const linePos = update.view.state.doc.line(i).from;
						decorations.push({
							from: linePos,
							to: linePos,
							value: Decoration.line({
								attributes: {
									style: `background-color: ${colorLight}`,
									class: "cm-yLineSelection",
								},
							}),
						});
					}
				}
			}
			if (update.view.visibleRanges.some(range => head!.index >= range.from && head!.index <= range.to)) {
				decorations.push({
					from: head.index,
					to: head.index,
					value: Decoration.widget({
						side: head.index - anchor.index > 0 ? -1 : 1, // the local cursor should be rendered outside the remote selection
						block: false,
						widget: new YRemoteCaretWidget(color, name),
					}),
				});
			}
		});
		this.decorations = Decoration.set(decorations, true);
	}
}

export const yRemoteSelections = ViewPlugin.fromClass(
	YRemoteSelectionsPluginValue,
	{
		decorations: (v) => v.decorations,
	},
);
