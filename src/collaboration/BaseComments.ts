import { nativeGroupTargetKey, nativeGroupTargetLabel } from "./NativeBaseGroupComments";
import type { PendingBaseGroupAnchor } from "./LocalDiscussionAnchor";
import { apiVersion, Component, FileView, Menu, Notice, type Plugin } from "obsidian";
import { NativeBasesSurface, type NativeBaseHandle, type NativeBaseTarget, type NativeBaseGroupHandle, type NativeBaseGroupTarget } from "../bases/NativeBasesSurface";
import type { BaseSyncHost } from "../bases/BaseSyncHost";
import type { DiscussionHost } from "./DiscussionHost";
import type { DiscussionSession, AnchoredThread } from "./DiscussionSession";
import { baseSelectionKey, type BaseCommentContext } from "./BaseCommentContext";
import type { BaseAnchor } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";

const owned = ".relay-bases-comments, .relay-bases-comment-tools";
type Marker = { handle: NativeBaseHandle | NativeBaseGroupHandle; threads: AnchoredThread[]; hiddenProperty: boolean; mixedTargets?: boolean };
const label = (target: NativeBaseTarget | NativeBaseGroupTarget) => target.type === "group" ? "group · " + nativeGroupTargetLabel(target) : target.type === "view" ? "view" : target.type === "property" ? "property header · " + target.property.source + "." + target.property.name :
	target.type === "cell" ? "cell · " + target.property.source + "." + target.property.name : "record";

export class BaseComments extends Component {
	private panes = new Map<FileView, BaseCommentPane>();
	private stopped = false;
	constructor(private host: DiscussionHost, private plugin: Plugin, private bases?: BaseSyncHost) { super(); }
	onload(): void {
		this.register(this.host.onChange(() => this.reconcile()));
		if (this.bases) this.register(this.bases.onChange(() => { for (const pane of this.panes.values()) pane.invalidate(true, true); }));
		this.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.reconcile()));
		this.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.reconcile()));
		this.registerEvent(this.plugin.app.workspace.on("file-open", () => this.reconcile()));
		this.registerEvent(this.plugin.app.vault.on("modify", file => {
			for (const [view, pane] of this.panes) if (file === view.file) pane.invalidate(true, true);
		}));
		const moved = () => { for (const pane of this.panes.values()) pane.invalidate(true, true); };
		this.registerEvent(this.plugin.app.vault.on("rename", moved)); this.registerEvent(this.plugin.app.vault.on("delete", moved));
		this.plugin.addCommand({ id: "toggle-contextual-base-comments", name: "Toggle contextual Bases comments", callback: () => { void this.host.toggleNativeBasesComments(); } });
		this.plugin.addCommand({ id: "comment-base-selection", name: "Comment on selected Bases target", checkCallback: checking => {
			const leaf = this.plugin.app.workspace.getMostRecentLeaf(), pane = leaf?.view instanceof FileView ? this.panes.get(leaf.view) : undefined;
			if (!pane) return false; if (!checking) pane.comment(); return true;
		} });
		this.reconcile();
	}
	private reconcile(): void {
		if (this.stopped) return;
		const wanted = new Set(this.host.nativeBasesCommentsEnabled ? this.plugin.app.workspace.getLeavesOfType("bases").map(leaf => leaf.view).filter((view): view is FileView => view instanceof FileView) : []);
		for (const [view, pane] of this.panes) if (!wanted.has(view)) { pane.close(); this.panes.delete(view); }
		for (const view of wanted) {
			let pane = this.panes.get(view);
			if (!pane) { pane = new BaseCommentPane(this.host, view); this.panes.set(view, pane); }
			pane.invalidate();
		}
	}
	async reveal(session: DiscussionSession, entryId: string, anchor: BaseAnchor | PendingBaseGroupAnchor): Promise<boolean> {
		if (this.stopped || !this.host.nativeBasesCommentsEnabled) return false;
		const placement = anchor.type === "base_group_pending" ? anchor.capture : anchor;
		const scope = parseDiscussionScope(entryId), file = scope ? this.host.baseFile(session, scope.entryId) : undefined;
		if (!file || scope?.viewId !== placement.view_id || !session.permission(entryId)?.read) return false;
		const workspace = this.plugin.app.workspace;
		let leaf = workspace.getLeavesOfType("bases").find(leaf => leaf.view instanceof FileView && leaf.view.file === file);
		if (!leaf) { leaf = workspace.getLeaf("tab"); await leaf.openFile(file); }
		await workspace.revealLeaf(leaf); this.reconcile();
		const pane = leaf.view instanceof FileView ? this.panes.get(leaf.view) : undefined;
		if (!pane) return false;
		const navigating = pane.navigationGuard();
		const surface = NativeBasesSurface.inspect(leaf.view, apiVersion, this.host.nativeBasesCommentsEnabled);
		if (!surface) return false;
		const activated = await this.host.activateBaseView(surface, session, entryId, placement, navigating);
		if (activated === "unavailable") return false;
		if (activated === "changed") pane.invalidate(true, true);
		const context = await pane.ready();
		if (!navigating()) return true;
		if (!context || context.session !== session || context.baseEntryId !== scope.entryId || !context.current() ||
			context.binding.snapshot.definition_id !== placement.definition_id || context.binding.snapshot.generation !== placement.generation) return false;
		if (!context || context.entryId !== entryId || context.session !== session || !context.current()) return false;
		const target = anchor.type === "base_group_pending" || anchor.target.type === "group" ? await context.groups?.native(anchor) : context.native(anchor);
		if (!target) return false;
		try {
			if (!await this.host.verifyBaseTarget(context, anchor.type === "base_group_pending" ? undefined : anchor)) throw new Error("Target changed");
			if (!navigating()) return true;
			const result = await pane.reveal(context, target, navigating);
			if (result === "revealed") return true;
			new Notice(result === "hidden" ? (target.type === "group" ? "This group is absent from the current view. Its discussion is retained." : "This record is hidden by the saved view. Its filters were left unchanged.") : result === "property-hidden" ?
				"This property is hidden in the current layout. Its discussion remains attached to that property." : "This target is unavailable or the view changed. Its discussion is retained.");
			return true;
		} catch { new Notice("This target or its saved-view association changed. Refresh synchronization before navigating again."); return true; }
	}
	onunload(): void { this.stopped = true; for (const pane of this.panes.values()) pane.close(); this.panes.clear(); }
}

/** One visible native pane owns one scope subscription and an external overlay.
 * Scroll/DOM layout never requests network data or rescans stored discussions. */
export class BaseCommentPane {
	private layer: HTMLDivElement;
	private toolbar: HTMLDivElement;
	private marks: HTMLDivElement;
	private cleanup: (() => void)[] = [];
	private win: Window;
	private closed = false;
	private context?: BaseCommentContext;
	private chosen?: NativeBaseHandle;
	private chosenGroups: NativeBaseGroupHandle[] = [];
	private groupTargets = new Map<string, NativeBaseGroupTarget>();
	private toolsContext?: BaseCommentContext;
	private toolsChosen?: NativeBaseHandle;
	private toolsKey?: string;
	private threads: AnchoredThread[] = [];
	private markerTargets = new Set<HTMLElement>();
	private dataDirty = true;
	private version = 0;
	private action = 0;
	private bindingVersion = 0;
	private checking = false;
	private timer?: number;
	private poll?: number;
	private flight?: Promise<void>;
	private attemptedBinding = 0;
	constructor(private host: DiscussionHost, private view: FileView) {
		const root = view.contentEl, doc = root.ownerDocument; this.win = doc.defaultView ?? window;
		this.layer = doc.createElement("div"); this.layer.className = "relay-bases-comments"; this.layer.hidden = true;
		this.toolbar = doc.createElement("div"); this.toolbar.className = "relay-bases-comment-tools"; this.toolbar.hidden = true;
		this.marks = doc.createElement("div"); this.marks.className = "relay-bases-comment-marks";
		this.layer.append(this.marks); root.classList.add("relay-bases-comments-root"); root.prepend(this.toolbar); root.append(this.layer);
		const listen = (target: EventTarget, event: string, fn: EventListener, capture = false) => {
			target.addEventListener(event, fn, capture); this.cleanup.push(() => target.removeEventListener(event, fn, capture));
		};
		const select = (event: Event) => {
			const node = event.target as Node | null;
			if (!node || !Number.isInteger(node.nodeType) || this.owns(node)) return;
			this.action++; this.chosenGroups = this.context?.groups?.hit(node) ?? [];
			this.chosen = this.chosenGroups.length ? undefined : this.context?.surface.hit(node); this.renderTools();
		};
		listen(root, "pointerdown", select, true); listen(root, "focusin", select, true);
		listen(root, "wheel", () => { this.action++; }, true);
		listen(root, "keydown", event => { if (!this.owns(event.target as Node)) this.action++; }, true);
		listen(root, "scroll", () => this.invalidate(false), true); listen(this.win, "resize", () => this.invalidate(false));
		listen(doc, "visibilitychange", () => this.invalidate(true, true));
		const observer = new MutationObserver(records => {
			if (records.every(record => this.owns(record.target) || record.type === "childList" &&
				[...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].every(node => node.nodeType === 1 && (node as Element).matches(owned)))) return;
			this.invalidate(false);
		});
		observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] }); this.cleanup.push(() => observer.disconnect());
		if (typeof ResizeObserver !== "undefined") { const observer = new ResizeObserver(() => this.invalidate(false)); observer.observe(root); this.cleanup.push(() => observer.disconnect()); }
		this.poll = this.win.setInterval(() => { void this.checkAssociation(); }, 15_000);
		this.invalidate();
	}
	private owns(node: Node): boolean { return this.layer.contains(node) || this.toolbar.contains(node); }
	private visible(): boolean { return !this.closed && !this.view.contentEl.ownerDocument.hidden && this.view.contentEl.isConnected && this.view.contentEl.getClientRects().length > 0; }
	invalidate(data = true, binding = false): void {
		if (this.closed) return;
		if (data) { this.dataDirty = true; this.version++; }
		if (binding) this.bindingVersion++;
		if (binding || !this.visible() || this.context && !this.context.current()) this.detach();
		if (this.timer === undefined && this.visible()) this.timer = this.win.setTimeout(() => { this.timer = undefined; void this.refresh(); }, 50);
	}
	private async checkAssociation(): Promise<void> {
		if (this.checking || !this.visible()) return;
		const context = this.context; if (!context) { this.invalidate(); return; }
		this.checking = true;
		try { if (!await this.host.verifyBaseTarget(context) && this.context === context) this.invalidate(true, true); }
		catch { if (this.context === context) this.invalidate(true, true); }
		finally { this.checking = false; }
	}
	private detach(): void { this.context?.release(); this.context = undefined; this.chosen = undefined; this.chosenGroups = []; this.groupTargets.clear(); this.threads = []; this.layer.hidden = true; this.toolbar.classList.add("is-unavailable"); this.marks.replaceChildren(); this.updateMarkerTargets(new Set()); this.dataDirty = true; }
	private updateMarkerTargets(next: Set<HTMLElement>): void {
		for (const element of this.markerTargets) if (!next.has(element)) element.classList.remove("relay-base-comment-target");
		this.markerTargets = next;
	}
	private refresh(): Promise<void> {
		if (this.flight) return this.flight;
		this.flight = this.update().finally(() => { this.flight = undefined; }); return this.flight;
	}
	private async update(): Promise<void> {
		try {
			if (!this.visible() || !this.host.nativeBasesCommentsEnabled) { this.detach(); return; }
			if (!this.context?.current()) {
				this.detach(); const surface = NativeBasesSurface.inspect(this.view, apiVersion, this.host.nativeBasesCommentsEnabled);
				if (!surface) return;
				const bindingVersion = this.bindingVersion;
				this.attemptedBinding++;
				const context = await this.host.baseCommentContext(surface, () => this.visible() && surface.current() && this.bindingVersion === bindingVersion);
				if (!context) return;
				if (!this.visible() || !context.current()) { context.release(); return; }
				this.context = context;
			}
			const context = this.context, version = this.version;
			if (this.dataDirty) {
				const threads = await context.session.anchorThreads(context.entryId);
				if (!context.current() || this.closed || this.context !== context || version !== this.version) { this.invalidate(); return; }
				const groupTargets = new Map<string, NativeBaseGroupTarget>(), groups = new Map<string, Promise<NativeBaseGroupTarget | undefined>>();
				for (let offset = 0; offset < threads.length; offset += 8) {
					await Promise.all(threads.slice(offset, offset + 8).map(async thread => {
						if (thread.anchor?.type !== "base" || thread.anchor.target.type !== "group" || !context.groups) return;
						const id = thread.anchor.target.group_id;
						let pending = groups.get(id); if (!pending) { pending = context.groups.native(thread.anchor); groups.set(id, pending); }
						const target = await pending; if (target) groupTargets.set(thread.id, target);
					}));
					if (!context.current() || this.closed || this.context !== context || version !== this.version) { this.invalidate(); return; }
				}
				this.threads = threads; this.groupTargets = groupTargets; this.dataDirty = false;
			}
			if (!context.current()) { this.detach(); return; }
			this.layer.hidden = false; this.toolbar.hidden = false; this.toolbar.classList.remove("is-unavailable"); this.renderTools(); this.renderMarkers();
		} catch { this.detach(); }
	}
	async ready(): Promise<BaseCommentContext | undefined> {
		for (let n = 0; n < 20 && this.visible(); n++) {
			const attempt = this.attemptedBinding;
			await this.refresh(); if (this.context?.current()) return this.context;
			// Retry native loading, not a refused network/identity binding.
			if (this.attemptedBinding !== attempt) return;
			await new Promise<void>(resolve => this.win.setTimeout(resolve, 50));
		}
	}
	private button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement {
		const button = parent.ownerDocument.createElement("button"); button.type = "button"; button.textContent = text; button.setAttribute("aria-label", text);
		button.addEventListener("click", event => { event.stopPropagation(); action(); }); parent.append(button); return button;
	}
	private renderTools(): void {
		const context = this.context;
		if (!context?.current()) { this.layer.hidden = true; this.toolbar.classList.add("is-unavailable"); return; }
		const selected = this.chosen?.current() ? this.chosen : undefined;
		const view = context.surface.handles().find(handle => handle.target.type === "view");
		const selectedGroups = this.chosenGroups.filter(handle => context.groups?.canCapture(handle));
		const target = selected ?? (this.chosenGroups.length ? undefined : view);
		const selection = target && context.canComment(target.target) ? context.selection(target.target) : undefined;
		const item: NativeBaseTarget | undefined = selected?.target.type === "cell" ? { type: "item", file: selected.target.file } : undefined;
		const commentRecord = !!item && context.canComment(item);
		const key = JSON.stringify([selection && baseSelectionKey(selection), commentRecord, selectedGroups.map(handle => nativeGroupTargetKey(handle.target))]);
		// Preserve live buttons through scroll, polling and unrelated thread updates.
		// A new handle/context must still replace callbacks, even for the same label.
		if (this.toolsContext === context && this.toolsChosen === selected && this.toolsKey === key) return;
		this.toolsContext = context; this.toolsChosen = selected; this.toolsKey = key;
		const focused = this.toolbar.contains(this.toolbar.ownerDocument.activeElement) ? this.toolbar.ownerDocument.activeElement?.getAttribute("aria-label") : undefined;
		this.toolbar.replaceChildren();
		this.button(this.toolbar, "Comments · " + context.binding.name, () => { if (context.current()) void this.host.openBaseView(context); });
		if (selectedGroups.length) this.button(this.toolbar, selectedGroups.length === 1 ? "Comment on group · " + nativeGroupTargetLabel(selectedGroups[0].target) : "Choose group value to comment", () => this.commentGroup(selectedGroups));
		if (target && selection) this.button(this.toolbar, "Comment on " + label(target.target), () => { void this.host.commentBaseHandle(context, target); });
		if (selected && item && commentRecord) this.button(this.toolbar, "Comment on record", () => { void this.host.commentBaseHandle(context, selected, item); });
		if (focused) Array.from(this.toolbar.querySelectorAll("button")).find(button => button.getAttribute("aria-label") === focused)?.focus({ preventScroll: true });
	}
	private commentGroup(handles: NativeBaseGroupHandle[]): void {
		const context = this.context; if (!context?.current() || !context.groups) return;
		const valid = handles.filter(handle => context.groups!.canCapture(handle));
		if (valid.length === 1) { void this.host.commentBaseGroupHandle(context, valid[0]); return; }
		if (!valid.length) { new Notice("This group is unavailable or unsupported. The original selection is retained."); return; }
		const menu = new Menu();
		for (const handle of valid) menu.addItem(item => item.setTitle(nativeGroupTargetLabel(handle.target)).onClick(() => {
			if (context.current() && handle.current()) void this.host.commentBaseGroupHandle(context, handle);
		}));
		const rect = this.toolbar.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom });
	}
	comment(): void {
		if (this.chosenGroups.length) { this.commentGroup(this.chosenGroups); return; }
		const context = this.context, selected = this.chosen;
		if (!context?.current() || !selected?.current() || !context.canComment(selected.target)) { new Notice("Select a supported shared Bases cell or record first."); return; }
		void this.host.commentBaseHandle(context, selected);
	}
	private renderMarkers(): void {
		const active = this.marks.ownerDocument.activeElement as HTMLElement | null;
		const focused = active && this.marks.contains(active) ? active.dataset.baseMarker : undefined;
		this.marks.replaceChildren(); const context = this.context; if (!context?.current()) { this.updateMarkerTargets(new Set()); return; }
		const handles = context.surface.handles(), byKey = new Map<string, NativeBaseHandle | NativeBaseGroupHandle>();
		for (const handle of handles) { const selection = context.selection(handle.target); if (selection) byKey.set(baseSelectionKey(selection), handle); }
		const ambiguousGroups = new Set<string>();
		for (const handle of context.groups?.handles() ?? []) {
			const key = nativeGroupTargetKey(handle.target);
			if (byKey.has(key)) { byKey.delete(key); ambiguousGroups.add(key); }
			if (!ambiguousGroups.has(key)) byKey.set(key, handle);
		}
		const markers = new Map<string, Marker>();
		for (const thread of this.threads) {
			if (thread.anchor?.type !== "base") continue;
			if (thread.anchor.target.type === "group") {
				const target = this.groupTargets.get(thread.id); if (!target) continue;
				const key = nativeGroupTargetKey(target), handle = byKey.get(key); if (!handle) continue;
				const marker = markers.get(key) ?? { handle, threads: [], hiddenProperty: false };
				marker.threads.push(thread); markers.set(key, marker); continue;
			}
			const target = context.native(thread.anchor), selection = target ? context.selection(target) : undefined; if (!target || !selection) continue;
			let key = baseSelectionKey(selection), handle = byKey.get(key), hiddenProperty = false;
			if (!handle && (selection.type === "cell" || selection.type === "formula_cell")) { key = baseSelectionKey({ type: "item", recordId: selection.recordId }); handle = byKey.get(key); hiddenProperty = true; }
			if (!handle || handle.target.type === "view") continue;
			const marker = markers.get(key) ?? { handle, threads: [], hiddenProperty }; marker.threads.push(thread); marker.hiddenProperty ||= hiddenProperty; markers.set(key, marker);
		}
		const root = this.view.contentEl.getBoundingClientRect(), viewport = context.surface.viewport()?.getBoundingClientRect();
		if (!viewport) { this.updateMarkerTargets(new Set()); return; }
		const targets = new Set<HTMLElement>(), presentations = new Map<HTMLElement, { key: string; marker: Marker }>();
		for (const [key, marker] of markers) {
			const target = marker.handle.target;
			const cells = target.type === "item" && context.surface.type === "table" ? handles.filter(handle => handle.target.type === "cell" && handle.target.file === target.file) : [];
			const element = (cells[cells.length - 1] ?? marker.handle).element, existing = presentations.get(element);
			if (existing) {
				existing.marker.threads.push(...marker.threads); existing.marker.mixedTargets = true;
				existing.marker.hiddenProperty ||= marker.hiddenProperty;
			} else presentations.set(element, { key, marker });
		}
		let count = 0;
		for (const [element, { key, marker }] of presentations) {
			// Keep a trailing lane for the badge; numeric values must remain readable.
			const rect = element.getBoundingClientRect();
			if (!marker.handle.current() || rect.width <= 0 || rect.height <= 0 || rect.bottom <= Math.max(root.top, viewport.top) || rect.top >= Math.min(root.bottom, viewport.bottom) || rect.right <= Math.max(root.left, viewport.left) || rect.left >= Math.min(root.right, viewport.right)) continue;
			if (++count > 128) break;
			targets.add(element); if (!element.classList.contains("relay-base-comment-target")) element.classList.add("relay-base-comment-target");
			const button = this.button(this.marks, String(marker.threads.length), () => {
				if (!context.current() || !marker.handle.current()) return;
				if (marker.threads.length === 1) { void this.host.openBaseThread(context, marker.threads[0].id); return; }
				const menu = new Menu();
				for (const thread of marker.threads) menu.addItem(item => item.setTitle((thread.state === "resolved" ? "Resolved" : "Open") + " · " + this.host.targetLabel(context.session, context.entryId, thread.anchor!) + " · " + context.session.displayName(context.entryId, thread.author_id)).onClick(() => { if (context.current() && marker.handle.current()) void this.host.openBaseThread(context, thread.id); }));
				const box = button.getBoundingClientRect(); menu.showAtPosition({ x: box.left, y: box.bottom });
			});
			button.className = "relay-base-comment-marker"; button.dataset.baseMarker = key;
			button.setAttribute("aria-label", `${marker.threads.length} discussion(s) on ${label(marker.handle.target)}${marker.hiddenProperty ? ", including a hidden property" : ""}${marker.mixedTargets ? ", across record and property targets" : ""}`);
			button.title = button.getAttribute("aria-label")!;
			button.style.left = Math.max(0, Math.min(rect.right, viewport.right, root.right) - root.left - 24) + "px";
			button.style.top = Math.max(rect.top, viewport.top, root.top) - root.top + "px";
		}
		this.updateMarkerTargets(targets);
		if (focused) Array.from(this.marks.querySelectorAll("button")).find(button => button.dataset.baseMarker === focused)?.focus({ preventScroll: true });
	}
	navigationGuard(): () => boolean {
		const action = this.action;
		return () => !this.closed && this.visible() && this.action === action;
	}
	async reveal(context: BaseCommentContext, target: NativeBaseTarget | NativeBaseGroupTarget, navigating = this.navigationGuard()) {
		const current = () => navigating() && this.context === context && context.current();
		if (target.type === "group") return context.groups?.reveal(target, current) ?? "unavailable";
		return context.surface.reveal(target, current);
	}
	close(): void {
		if (this.closed) return; this.closed = true; this.action++;
		if (this.timer !== undefined) this.win.clearTimeout(this.timer); if (this.poll !== undefined) this.win.clearInterval(this.poll);
		this.detach(); for (const dispose of this.cleanup) dispose(); this.cleanup = [];
		this.layer.remove(); this.toolbar.remove(); this.view.contentEl.classList.remove("relay-bases-comments-root");
	}
}
