// Code in this file has been adapted from y-codemirror.next
// LicenseRecord
// [The MIT LicenseRecord](./LICENSE) © Kevin Jahns

import { Facet, Annotation } from "@codemirror/state";
import type { ChangeSpec } from "@codemirror/state";
import { EditorView, ViewUpdate, ViewPlugin } from "@codemirror/view";
import type { PluginValue } from "@codemirror/view";
import {
	DocumentViewBinding,
	ViewBindingRegistry,
	ViewBindingStateField,
	type ViewBinding,
	isBoundMarkdown,
} from "../ViewBindings";
import type { Text as YText, YTextEvent, Transaction } from "yjs";
import { namedLogger } from "src/logging";
import { getPatchRegistry } from "../PatchRegistry";
import diff_match_patch from "diff-match-patch";
import { currentToggles } from "src/featureToggleState";
import { MarkdownView, editorInfoField, Notice, type TFile } from "obsidian";
import { Document } from "src/Document";
import { bindCommentEditor } from "../collaboration/EditorTextBinding";
import { EmbeddedNoticeBar } from "src/ui/EmbeddedNoticeBar";
import { ViewSurfaceBridge } from "src/viewSync/ViewSurfaceBridge";
import {
	claimInitIfUnclaimed,
	wonInitClaim,
	markInitDone,
	awaitClaimSettled,
} from "src/initContentClaim";

export const connectionManagerFacet: Facet<ViewBindingRegistry, ViewBindingRegistry> =
	Facet.define({
		combine(inputs) {
			return inputs[inputs.length - 1];
		},
	});

export const ySyncAnnotation = Annotation.define();

export class LiveCMPluginValue implements PluginValue {
	editor: EditorView;
	view?: DocumentViewBinding<MarkdownView>;
	connectionManager?: ViewBindingRegistry;
	initialSet = false;
	sourceView: Element | null;
	banner?: EmbeddedNoticeBar;
	private destroyed = false;
	_observer?: (event: YTextEvent, tr: Transaction) => void;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	_ytext?: YText;
	keyFrameCounter = 0;
	unsubscribes: Array<() => void>;
	debug: (...args: unknown[]) => void = (...args: unknown[]) => {};
	log: (...args: unknown[]) => void = (...args: unknown[]) => {};
	warn: (...args: unknown[]) => void = (...args: unknown[]) => {};
	error: (...args: unknown[]) => void = (...args: unknown[]) => {};
	document?: Document;
	embed = false;
	viewHookPlugin?: ViewSurfaceBridge;

	getDocument(): Document | undefined {
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
		this.view = this.connectionManager?.locateMarkdownView(this.editor);
		if (this.view && this.view.boundDocument instanceof Document) {
			return this.view.boundDocument;
		}
	}

	active(view?: ViewBinding) {
		const live = isBoundMarkdown(view);
		return live || (this.embed && this.document);
	}

	mergeBanner(): () => void {
		if (this.destroyed || !this.editor) {
			return () => {};
		}

		this.banner = new EmbeddedNoticeBar(
			this.sourceView,
			this.editor.dom,
			"Merge conflict -- click to fix it",
			async () => {
				if (!this.document) return true;
				let stale: boolean;
				let diskBuffer: TFile | undefined;
				try {
					stale = await this.document.refreshIfStale();
					if (stale) diskBuffer = await this.document.unsavedFile();
				} catch (e: unknown) {
					this.warn("[mergeBanner] checkStale failed:", (e as Error).message);
					new Notice(`Merge review could not continue: ${e instanceof Error ? e.message : String(e)}`);
					return false;
				}
				if (!stale) {
					return true;
				}
				if (!diskBuffer) return false;
				this.connectionManager?.launchDiffView({
					leftFile: this.document,
					rightFile: diskBuffer,
					allowMergeActions: true,
					onMergeResolved: async () => {
						if (this.destroyed || !this.editor || !this.document) {
							return Promise.resolve();
						}
						await this.document.clearUnsavedFile(diskBuffer as import("../UnsavedFile").UnsavedFile);
						await this.resync();
					},
				});
				return true;
			},
		);
		return () => {};
	}

	constructor(editor: EditorView) {
		this.unsubscribes = [];
		this.editor = editor;
		this.sourceView = this.editor.dom.closest(".markdown-source-view");
		this.connectionManager = this.editor.state.field(
			ViewBindingStateField,
		);

		// For VaultShare documents, add the live editor class so this plugin
		// (and RemoteSelections) activates for real-time CRDT editing.
		// Without this, VaultShare docs fail the allowlist check below and
		// the Y.Text ↔ CodeMirror binding is never established.
		const fileInfo = this.editor.state.field(editorInfoField);
		const file = fileInfo?.file;
		if (file && this.connectionManager?.shareRegistry.shareFor(file.path)) {
			this.sourceView?.classList.add("relay-live-editor");
		}

		// Allowlist: Check for live editing markers
		const isLiveEditor = this.editor.dom.closest(".relay-live-editor");
		const hasIframeClass =
			this.sourceView?.classList.contains("mod-inside-iframe");

		// For embedded canvas editors, we can't always find the canvas via ConnectionManager
		// but if it has mod-inside-iframe, it's likely a legitimate embedded editor
		const isEmbeddedInCanvas = hasIframeClass;

		if (!isLiveEditor && !isEmbeddedInCanvas) {
			this.destroyed = true;
			return;
		}

		this.view = this.connectionManager?.locateMarkdownView(this.editor);
		this.document = this.getDocument();
		if (!this.document) {
			this.destroyed = true;
			return;
		}
		if (!this.view) {
			this.embed = true;
		} else {
			this.viewHookPlugin = new ViewSurfaceBridge(this.view.hostView, this.document);
		}
		this.log = namedLogger(`[LiveCMPluginValue][${this.document.entryPath}]`, "log");
		this.warn = namedLogger(`[LiveCMPluginValue][${this.document.entryPath}]`, "warn");
		this.error = namedLogger(
			`[LiveCMPluginValue][${this.document.entryPath}]`,
			"error",
		);
		this.debug = namedLogger(
			`[LiveCMPluginValue][${this.document.entryPath}]`,
			"debug",
		);
		this.debug("created");

		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed to preserve `this` reference inside getPatchRegistry callback functions where `this` is rebound
		const liveEditPlugin = this;
		let fmSave = false;

		if (this.view?.hostView) {
			type PatchTargetView = {
				setViewData: (data: string, clear: boolean) => void;
				saveFrontmatter: (data: unknown) => void;
				requestSave: () => void;
			};
			this.unsubscribes.push(
				getPatchRegistry().install(this.view.hostView as unknown as PatchTargetView, {
					setViewData(old: (this: unknown, data: string, clear: boolean) => void) {
						return function (this: unknown, data: string, clear: boolean) {
							if (clear) {
								if (isBoundMarkdown(liveEditPlugin.view)) {
									if (liveEditPlugin.view.boundDocument.content === data) {
										liveEditPlugin.view.isTracking = true;
									}
								}
								void liveEditPlugin.resync();
							} else if (fmSave) {
								const changes = liveEditPlugin.incrementalBufferChange(data);
								editor.dispatch({
									changes,
								});
								return;
							}
							return old.call(this, data, clear);
						};
					},
					saveFrontmatter(old: (this: unknown, data: unknown) => void) {
						return function (this: unknown, data: unknown) {
							fmSave = true;
							const result: unknown = old.call(this, data);
							fmSave = false;
							return result;
						};
					},
					requestSave(old: (this: unknown) => void) {
						return function (this: unknown) {
							const result: unknown = old.call(this);
							if (!liveEditPlugin.destroyed && liveEditPlugin.document) {
								try {
									(this as MarkdownView).app.metadataCache.trigger("resolve", (this as MarkdownView).file);
								} catch {
									// pass
								}
							}
							return result;
						};
					},
				}),
			);
		} else {
			void this.document.bringOnline();
		}

		if (this.document.isOnline) {
			void this.resync();
		} else {
			void this.document.onceOnline().then(() => {
				void this.resync();
			});
		}

		// Initialize ViewSurfaceBridge
		if (this.viewHookPlugin) {
			this.viewHookPlugin.initializeSync().catch((error: unknown) => {
				this.error("Error initializing ViewSurfaceBridge:", error);
			});
		}

		// Synchronous observer — MUST NOT be async to prevent interleaving.
		// Yjs calls observers synchronously; async observers cause concurrent
		// getKeyFrame() calls that overwrite each other with stale snapshots.
		this._observer = (event: YTextEvent, tr: Transaction) => {
			this.document = this.getDocument();

			if (!this.active(this.view)) {
				this.debug("Recived yjs event against a non-live view");
				return;
			}
			if (this.destroyed) {
				this.debug("Recived yjs event but editor was destroyed");
				return;
			}

			// Called when a yjs event is received. Results in updates to codemirror.
			if (tr.origin !== this) {
				let changes: ChangeSpec[];

				if (isBoundMarkdown(this.view) && !this.view.isTracking) {
					// Not tracking: editor and ytext may be out of sync.
					// Compute a synchronous keyframe (full diff) to reconcile.
					// MUST be synchronous — async getKeyFrame races with user typing.
					if (!this.document) {
						this.debug("not tracking, no document");
						return;
					}
					if (this.document.content === this.editor.state.doc.toString()) {
						// Already in sync — just set tracking
						this.view.isTracking = true;
						this.debug("not tracking but content matches, set tracking=true");
						return;
					}
					changes = this.getBufferChange(this.document.content, true);
					this.debug("dispatch (sync keyframe)");
				} else {
					// Tracking: apply Yjs delta incrementally (fast path)
					const delta = event.delta;
					changes = [];
					let pos = 0;
					for (let i = 0; i < delta.length; i++) {
						const d = delta[i];
						if (d.insert != null) {
							changes.push({
								from: pos,
								to: pos,
								insert: d.insert as string,
							});
						} else if (d.delete != null) {
							changes.push({
								from: pos,
								to: pos + d.delete,
								insert: "",
							});
							pos += d.delete;
						} else if (d.retain != null) {
							pos += d.retain;
						}
					}
					this.keyFrameCounter += 1;
					this.debug(`dispatch (incremental + ${this.keyFrameCounter})`);
				}

				if (this.active(this.view)) {
					editor.dispatch({
						changes,
						annotations: [ySyncAnnotation.of(this.editor)],
					});
					if (isBoundMarkdown(this.view)) {
						this.view.isTracking = true;
					}
				}
			}
		};

		this.observer = (event: YTextEvent, tr: Transaction) => {
			try {
				this._observer?.(event, tr);
			} catch (e: unknown) {
				if (e instanceof RangeError) {
					if (isBoundMarkdown(this.view)) {
						this.view.isTracking = false;
					}
					this.warn("[observer] RangeError, scheduling resync");
					void this.resync();
				}
			}
		};
		this._ytext = this.document.crdtText;
		this._ytext.observe(this.observer);
		this.unsubscribes.push(bindCommentEditor(this.editor, () => {
			// Canvas/embedded editors are outside this feature's scope. The tracked
			// Markdown view must have finished applying its authoritative content.
			if (this.destroyed || this.embed || !this.document || !this.view?.isTracking ||
				this._ytext !== this.document.crdtText) return undefined;
			return { documentId: this.document.entityGuid, text: this._ytext };
		}));
	}

	public incrementalBufferChange(newBuffer: string): ChangeSpec[] {
		const currentBuffer = this.editor.state.doc.toString();
		const dmp = new diff_match_patch();
		const diffs = dmp.diff_main(currentBuffer, newBuffer);
		dmp.diff_cleanupSemantic(diffs);

		const changes: ChangeSpec[] = [];
		let currentPos = 0;

		for (const [type, text] of diffs) {
			switch (type) {
				case 0: // EQUAL
					currentPos += text.length;
					break;
				case 1: // INSERT
					changes.push({
						from: currentPos,
						to: currentPos,
						insert: text,
					});
					currentPos += text.length;
					break;
				case -1: // DELETE
					changes.push({
						from: currentPos,
						to: currentPos + text.length,
						insert: "",
					});
					break;
			}
		}
		return changes;
	}

	public getBufferChange(newBuffer: string, incremental = false): ChangeSpec[] {
		if (incremental) {
			return this.incrementalBufferChange(newBuffer);
		}
		return [
			{
				from: 0,
				to: this.editor.state.doc.length,
				insert: newBuffer,
			},
		];
	}

	async resync() {
		const editor = this.editor, view = this.view;
		const bindingNeedsSync = isBoundMarkdown(view) && !view.isTracking;
		const doc = bindingNeedsSync ? view.boundDocument : this.active(view) ? this.document : undefined;
		if (this.destroyed || !editor || !doc) return;
		// Renaming/reconfiguring a view can destroy this binding while any of
		// these awaits is pending. A completed old task never owns the new view.
		const isCurrent = () => !this.destroyed && this.editor === editor && this.view === view && this.document === doc;
		await doc.awaitFirstSync();
		if (!isCurrent()) return;
		await this.waitForProviderSync();
		if (!isCurrent()) return;

		if (doc.content === "" && editor.state.doc.length > 0) {
			const ydoc = doc.crdtDoc;
			claimInitIfUnclaimed(ydoc, doc._liveProvider.awareness);
			await awaitClaimSettled(ydoc, { socket: doc._liveProvider.ws });
			if (!isCurrent()) return;
			const text = ydoc.getText("contents");
			if (wonInitClaim(ydoc, text)) {
				// Typing may have continued during the claim; seed the current buffer.
				this.warn("[resync] relay is empty but editor has content — uploading to Y.Text");
				text.insert(0, editor.state.doc.toString());
				markInitDone(ydoc);
			} else if (text.length === 0) {
				this.warn("[resync] lost the init claim to a concurrently-connecting client — skipping upload");
			}
			if (isBoundMarkdown(view) && doc.content === editor.state.doc.toString()) view.isTracking = true;
			return;
		}

		const before = editor.state;
		const keyFrame = await this.getKeyFrame();
		// A keyframe is calculated for one editor state. Applying it after a
		// keystroke would overwrite that keystroke with an earlier snapshot.
		if (isCurrent() && editor.state === before && (!bindingNeedsSync || !view!.isTracking)) {
			editor.dispatch({ changes: keyFrame, annotations: [ySyncAnnotation.of(editor)] });
		}
	}

	/**
	 * Wait for the provider to finish syncing with the relay server.
	 * Without this, resync() uses stale Y.Text data from IDB, sets tracking=true,
	 * and then the relay sync arrives with incremental deltas that reference
	 * different positions — causing character loss and missing newlines.
	 */
	private async waitForProviderSync(): Promise<void> {
		if (!this.document) return;
		const provider = this.document._liveProvider;
		if (!provider || provider.synced) return;
		// Only wait if the document is connected or connecting
		if (!this.document.isOnline && this.document.connectionIntent !== "connected") return;
		try {
			await Promise.race([
				new Promise<void>((resolve) => {
					provider.once("synced", () => resolve());
					// Double-check after registration
					if (provider.synced) resolve();
				}),
				new Promise<void>((resolve) => window.setTimeout(resolve, 5000)),
			]);
		} catch {
			// timeout or error — proceed with current Y.Text state
		}
	}

	async getKeyFrame(incremental = false): Promise<ChangeSpec[]> {
		// goal: sync editor state to ytext state so we can accept delta edits.
		if (!this.active(this.view) || this.destroyed) {
			return [];
		}

		if (this.document?.content === this.editor.state.doc.toString()) {
			// disk and ytext were already the same.
			if (isBoundMarkdown(this.view)) {
				this.view.isTracking = true;
			}
			return [];
		} else if (currentToggles().enableDeltaLogging) {
			this.warn(
				`|${this.document?.content}|\n|${this.editor.state.doc.toString()}|`,
			);
		}

		if (!this.document) {
			this.warn("no document");
			return [];
		}

		this.warn(`ytext and editor buffer need syncing`);
		if (!this.document.hasLocalPersistence() && this.document.content === "") {
			this.warn("local db missing, not setting buffer");
			return [];
		}

		// disk and ytext differ
		if (isBoundMarkdown(this.view) && !this.view.isTracking) {
			void this.view.refreshStaleState();
		} else if (this.document) {
			try {
				const stale = await this.document.refreshIfStale();
				if (stale && !this.destroyed && this.editor) {
					this.mergeBanner();
				}
			} catch (e: unknown) {
				this.warn("[getKeyFrame] checkStale failed, relying on WS sync:", (e as Error).message);
			}
		}

		if (this.active(this.view) && !this.destroyed) {
			return [this.getBufferChange(this.document.content, incremental)];
		}
		return [];
	}

	update(update: ViewUpdate): void {
		// When updates were made to the local editor. Forwarded to the ydoc.
		if (
			!update.docChanged ||
			(update.transactions.length > 0 &&
				update.transactions[0].annotation(ySyncAnnotation) === this.editor) ||
			this.destroyed
		) {
			return;
		}
		const previous = this.document;
		const doc = this.getDocument(), ytext = doc?.crdtText;
		// A reused editor can deliver its file-loading transaction before the old
		// plugin has been torn down. Never send it to either document's Y.Text.
		if (!doc || !ytext || doc !== previous || ytext !== this._ytext) return;
		const before = update.startState.doc.toString(), after = update.state.doc.toString();
		if (before !== ytext.toString()) {
			// Loading an already-synced file is not an insertion at offset zero.
			if (after === ytext.toString()) return;
			// Real edits on a divergent buffer must remain recoverable, but applying
			// offsets against a different base corrupts or duplicates remote text.
			if (isBoundMarkdown(this.view)) this.view.isTracking = false;
			void doc.setUnsavedFile(after).then(() => {
				if (!this.destroyed && this.document === doc && !this.banner) this.mergeBanner();
			}).catch(error => {
				this.warn("Could not persist divergent editor buffer", error);
				new Notice("Your edit is still in this editor but could not be saved for merge review. Copy it before closing the note.");
			});
			return;
		}
		try {
			ytext.doc?.transact(() => {
				/**
				 * This variable adjusts the fromA position to the current position in the Y.Text type.
				 */
				let adj = 0;
				update.changes.iterChanges((fromA, toA, fromB, toB, insert) => {
					const insertText = insert.sliceString(0, insert.length, "\n");
					if (fromA !== toA) {
						ytext.delete(fromA + adj, toA - fromA);
					}
					if (insertText.length > 0) {
						ytext.insert(fromA + adj, insertText);
					}
					adj += insertText.length - (toA - fromA);
				});
			}, this);
		} catch (e: unknown) {
			// Yjs internal error (e.g., ydoc destroyed while editor still active).
			// Skip Yjs update — local edit is preserved, sync resumes on reconnect.
			this.warn("[update] Yjs transact failed:", (e as Error).message);
		}

		if (this.embed && this.document) {
			this.document.scheduleSave();
		}
	}

	destroy() {
		this.destroyed = true;
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.unsubscribes.length = 0;
		this.viewHookPlugin?.teardown();
		// Remove class we may have added for VaultShare documents
		if (this.embed && this.sourceView) {
			this.sourceView.classList.remove("relay-live-editor");
		}
		this.connectionManager = null as unknown as ViewBindingRegistry | undefined;
		this.view = undefined;
		this._ytext = undefined;
		this.editor = null as unknown as EditorView;
	}
}

export const LiveEdit = ViewPlugin.fromClass(LiveCMPluginValue);
