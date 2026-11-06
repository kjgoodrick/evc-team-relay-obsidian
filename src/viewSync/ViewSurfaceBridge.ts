import type { ChangeSpec } from "@codemirror/state";
import diff_match_patch from "diff-match-patch";
import { MarkdownView } from "obsidian";
import type { Text as YText, YTextEvent, Transaction } from "yjs";
import { Loggable } from "../logging";
import { Document } from "../Document";
import { currentToggles } from "../featureToggleState";
import { getPatchRegistry } from "../PatchRegistry";
import { applyDiffToYText } from "../ytextDiff";
import { PropertiesEditorSync } from "./PropertiesEditorSync";
import { ReadingViewSync } from "./ReadingViewSync";
import type { DocumentSurfaceSync } from "./DocumentSurfaceSync";
import { bindReadingComments } from "../collaboration/ReadingTextBinding";

// Internal Obsidian APIs not exposed in the public type definitions, but
// needed to hook the preview/metadata editors' native edit pathways.
interface InternalMarkdownView {
	getMode?(): string;
	text?: string;
	editor?: {
		cm: {
			dispatch: (transaction: { changes: ChangeSpec[] }) => void;
			state: { doc: { toString(): string } };
		};
	};
	previewMode?: {
		renderer?: { set: (text: string) => void };
	};
}

/**
 * Bridges Obsidian's view-layer editing surfaces (Reading view, the metadata
 * editor, and CodeMirror) with the CRDT document: it patches a handful of
 * Obsidian's internal methods so edits made through any of those surfaces
 * get folded back into the shared `Document`, and it re-renders all of them
 * whenever the CRDT changes from elsewhere (a remote peer, or the editor).
 */
export class ViewSurfaceBridge extends Loggable {
	private hostView: MarkdownView;
	private boundDocument: Document;
	private surfaceRenderers: DocumentSurfaceSync[];
	private patchRemovers: Array<() => void> = [];
	private ytextObserver?: (event: YTextEvent, tr: Transaction) => void;
	private ytext: YText;
	private isDestroyed = false;
	private isSavingFrontmatter = false;

	constructor(view: MarkdownView, doc: Document) {
		super();
		this.hostView = view;
		this.boundDocument = doc;
		this.setLoggers(`[ViewSurfaceBridge][${doc.entryPath}]`);
		this.debug("created");

		this.surfaceRenderers = [new ReadingViewSync(view), new PropertiesEditorSync(view)];
		this.ytext = this.boundDocument.crdtText;
		this.patchRemovers.push(bindReadingComments(view, () => this.isDestroyed ? undefined : { documentId: this.boundDocument.entityGuid, text: this.ytext }));

		this.installFrontmatterSaveHook();
		this.installSaveCoordinationHook();
		this.installPreviewEditHook();
		this.observeDocumentChanges();
		this.renderAllSurfaces();
	}

	/** Initial paint once the document has finished loading, then starts live sync. */
	async initializeSync(): Promise<void> {
		await this.boundDocument.awaitFullyConnected();

		this.internalView().previewMode?.renderer?.set(this.boundDocument.content);
		this.renderAllSurfaces();

		void this.boundDocument.bringOnline();
		this.debug("ViewSurfaceBridge initialized");
	}

	teardown(): void {
		this.isDestroyed = true;
		this.debug("destroyed");

		if (this.ytextObserver) {
			this.ytext?.unobserve(this.ytextObserver);
		}

		for (const removePatch of this.patchRemovers) {
			removePatch();
		}
		this.patchRemovers.length = 0;

		for (const renderer of this.surfaceRenderers) {
			renderer.destroy();
		}
		this.surfaceRenderers.length = 0;

		this.ytext = null as unknown as YText;
		this.hostView = null as unknown as MarkdownView;
		this.boundDocument = null as unknown as Document;
	}

	private internalView(): InternalMarkdownView {
		return this.hostView as unknown as InternalMarkdownView;
	}

	/**
	 * Wraps `MarkdownView.saveFrontmatter` purely to track whether we're
	 * currently inside a frontmatter-triggered save, which `save()` below
	 * uses to decide whether a resulting preview-text change came from us.
	 */
	private installFrontmatterSaveHook(): void {
		if (!currentToggles().enableMetadataViewHooks) {
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed so the patched method (whose own `this` is rebound by the caller) can still reach this plugin instance's state
		const plugin = this;
		this.patchRemovers.push(
			getPatchRegistry().install(this.hostView, {
				// @ts-ignore
				saveFrontmatter(original: unknown) {
					return function (this: unknown, data: unknown) {
						plugin.debug("saveFrontmatter hook triggered");
						plugin.isSavingFrontmatter = true;
						const result = (original as (...args: unknown[]) => unknown).call(this, data);
						plugin.isSavingFrontmatter = false;
						return result;
					};
				},
			}),
		);
	}

	/**
	 * Wraps `MarkdownView.save`: after Obsidian's own save runs, if it was
	 * triggered by a frontmatter edit while in Reading view, push the
	 * resulting text into the CRDT (Reading view has no CodeMirror instance
	 * to observe, so this is the only signal we get for that edit path).
	 */
	private installSaveCoordinationHook(): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed so the patched method (whose own `this` is rebound by the caller) can still reach this plugin instance's state
		const plugin = this;
		this.patchRemovers.push(
			getPatchRegistry().install(this.hostView, {
				// @ts-ignore
				save(original: unknown) {
					return function (this: unknown, data: unknown) {
						const result = (original as (...args: unknown[]) => unknown).call(this, data);
						try {
							if (plugin.internalView().getMode?.() === "preview" && plugin.isSavingFrontmatter) {
								plugin.debug("Syncing metadata changes to CRDT during save");
								applyDiffToYText(plugin.boundDocument.crdtDoc, plugin.internalView().text ?? "", plugin.boundDocument);
							}
						} catch (e: unknown) {
							plugin.error("Error syncing during save:", e);
						}
						return result;
					};
				},
			}),
		);
	}

	/**
	 * Wraps `previewMode.edit`: while in Reading view, an edit made directly
	 * in the rendered preview (e.g. checking a checkbox) is redirected into
	 * CodeMirror (if it exists) or straight into the CRDT, instead of letting
	 * Obsidian's own preview-mode editing path run.
	 */
	private installPreviewEditHook(): void {
		if (!currentToggles().enablePreviewViewHooks) {
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed so the patched method (whose own `this` is rebound by the caller) can still reach this plugin instance's state
		const plugin = this;
		this.patchRemovers.push(
			getPatchRegistry().install(this.hostView.previewMode, {
				edit(original: unknown) {
					return function (this: unknown, data: string) {
						plugin.debug("Preview edit hook triggered");
						if (plugin.internalView().getMode?.() !== "preview") {
							return (original as (...args: unknown[]) => unknown).call(this, data);
						}

						const editor = plugin.internalView().editor;
						if (editor) {
							editor.cm.dispatch({ changes: plugin.diffToChangeSpecs(data) });
							plugin.debug("Dispatched preview edit to CodeMirror");
						} else {
							applyDiffToYText(plugin.boundDocument.crdtDoc, data, plugin.boundDocument);
							plugin.debug("Synced preview edit directly to CRDT");
						}
						return undefined;
					};
				},
			}),
		);
	}

	private observeDocumentChanges(): void {
		this.ytextObserver = () => {
			if (this.isDestroyed || !this.hostView) {
				this.debug(this.isDestroyed ? "Received yjs event but plugin was destroyed" : "Received yjs event against a non-active view");
				return;
			}
			this.debug("Document changed, updating all renderers");
			this.renderAllSurfaces();
		};
		this.ytext.observe(this.ytextObserver);
	}

	private renderAllSurfaces(): void {
		// @ts-ignore
		const viewMode = this.hostView.getMode?.() || this.hostView.getViewType?.() || "unknown";
		this.debug(`Rendering all components for mode: ${viewMode}`);

		for (const renderer of this.surfaceRenderers) {
			try {
				renderer.render(this.boundDocument, viewMode);
			} catch (error: unknown) {
				this.error("Error in renderer:", error);
			}
		}
	}

	/** Turns a diff-match-patch comparison of the CodeMirror doc vs `newText` into CM6 changes. */
	private diffToChangeSpecs(newText: string): ChangeSpec[] {
		const currentText = this.internalView().editor?.cm.state.doc.toString() ?? "";
		const dmp = new diff_match_patch();
		const diffs = dmp.diff_main(currentText, newText);
		dmp.diff_cleanupSemantic(diffs);

		const EQUAL = 0;
		const INSERT = 1;
		const DELETE = -1;

		const changes: ChangeSpec[] = [];
		let cursor = 0;
		for (const [op, text] of diffs) {
			if (op === EQUAL) {
				cursor += text.length;
			} else if (op === INSERT) {
				changes.push({ from: cursor, to: cursor, insert: text });
				cursor += text.length;
			} else if (op === DELETE) {
				changes.push({ from: cursor, to: cursor + text.length, insert: "" });
			}
		}
		return changes;
	}
}
