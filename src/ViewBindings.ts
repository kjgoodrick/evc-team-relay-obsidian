import type { Extension } from "@codemirror/state";
import { StateField, EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	App,
	MarkdownView,
	editorInfoField,
	Platform,
	requireApiVersion,
	TFile,
	TextFileView,
	Workspace,
	moment,
	type CachedMetadata,
	type WorkspaceLeaf,
} from "obsidian";
import EditorStatusActions from "src/components/EditorStatusActions.svelte";
import { mountComponent, type MountedComponent } from "./svelteMount";
import * as Y from "yjs";
import { Document } from "./Document";
import { type ConnectionState, type ProviderBacked } from "./ProviderBacked";
import { AuthSession } from "./AuthSession";
import ServiceHealthMonitor from "./ServiceHealthMonitor";
import { VaultShare, ShareRegistry } from "./VaultShare";
import { namedLogger, Loggable, instanceLabels } from "./logging";
import { ViewNoticeBar } from "./ui/ViewNoticeBar";
import { LiveEdit, ySyncAnnotation } from "./y-codemirror.next/LiveEditPlugin";
import {
	yRemoteSelections,
	yRemoteSelectionsTheme,
} from "./y-codemirror.next/RemoteSelections";
import { ExternalLinkPlugin } from "./editorExtensions/ExternalLinkExtension";
import * as Differ from "./fileDiff/fileDiffView";
import type { HostCanvasView } from "./HostCanvasView";
import { type CanvasDocument } from "./CanvasDocument";
import { CanvasViewPatch } from "./CanvasViewPatch";
import { LiveNode } from "./y-codemirror.next/LiveNodePlugin";
import { currentToggles } from "./featureToggleState";
import { PresenceTitleDecorator } from "./PresenceTitleDecorator";
import { TextViewPatch } from "./TextViewPatch";
import { ItemKind } from "./ItemKinds";

/**
 * This module tracks which Obsidian leaves (markdown/kanban views + canvas
 * views) currently point at a file inside a shared folder, wraps each one
 * in an `ViewBinding` (`DocumentViewBinding` / `CanvasViewBinding` / `SignedOutViewBinding` depending
 * on auth + folder-readiness), and keeps that set in sync with whatever the
 * workspace actually has open (`ViewBindingRegistry.refreshViews()` /
 * `_executeRefreshPass()`).
 *
 * The one invariant every change here must preserve: a view is only handed
 * its live-editing machinery (CodeMirror extension wiring, CanvasViewPatch's
 * requestSave/applyHistory patches, TextViewPatch) *after* its backing
 * CRDT model reports readiness (`Document.awaitFullyConnected()` /
 * `CanvasDocument.awaitFullyConnected()`) -- see `DocumentViewBinding.mountView()` /
 * `CanvasViewBinding.mountView()` / `awaitViewsReady()` below. Skipping that gate lets
 * a freshly opened view seed an empty Y.Text before the model's own
 * persisted history has replayed, duplicating content (, sibling
 * of the TransferQueue race).
 */

const BACKGROUND_CONNECTIONS = 3;

// ---------------------------------------------------------------------------
// Workspace traversal
// ---------------------------------------------------------------------------

function allOpenLeaves(workspace: Workspace): WorkspaceLeaf[] {
	const leaves: WorkspaceLeaf[] = [];
	workspace.iterateAllLeaves((leaf) => {
		leaves.push(leaf);
	});
	return leaves;
}

function allowedTextFileViewTypes(): string[] {
	return currentToggles().enableKanbanView ? ["markdown", "kanban"] : ["markdown"];
}

/** Every open leaf whose view is a canvas. */
function openCanvasViews(workspace: Workspace): HostCanvasView[] {
	return allOpenLeaves(workspace)
		.filter((leaf) => leaf.view.getViewType() === "canvas")
		.map((leaf) => leaf.view as unknown as HostCanvasView);
}

/** Every open leaf whose view is a text-file view we manage (markdown, and
 * kanban when the feature featureKey is on) -- canvases are handled separately. */
function openTextFileViews(workspace: Workspace): TextFileView[] {
	const allowed = allowedTextFileViewTypes();
	return allOpenLeaves(workspace)
		.filter((leaf): leaf is WorkspaceLeaf & { view: TextFileView } =>
			leaf.view instanceof TextFileView,
		)
		.map((leaf) => leaf.view)
		.filter((view) => {
			const viewType = view.getViewType();
			return viewType !== "canvas" && allowed.includes(viewType);
		});
}

function leafActiveTime(view: ViewBinding): number {
	return (view.hostView.leaf as unknown as Record<string, unknown>)[
		"activeTime"
	] as number;
}

/** True when two view lists refer to the same files in the same order --
 * used to decide whether a refresh changed anything observable. */
function viewSetsMatch(a: ViewBinding[], b: ViewBinding[]): boolean {
	if (a.length !== b.length) return false;
	return a.every(
		(view, i) =>
			view.hostView.file?.path === b[i].hostView.file?.path &&
			view.boundDocument?.entryPath === b[i].boundDocument?.entryPath,
	);
}

// ---------------------------------------------------------------------------
// Shared view-chrome helpers
//
// DocumentViewBinding (markdown/kanban) and CanvasViewBinding (canvas) render the same
// header button and connection-status pill against two different backing
// CRDT models (Document vs CanvasDocument). Both models extend ProviderBacked and
// expose the same state/subscribe/vaultShare surface, so the DOM wiring
// lives once here rather than twice per class.
// ---------------------------------------------------------------------------

interface HeaderButtonSpec {
	className: string;
	text: string;
	ariaLabel: string;
	onClick: () => void;
}

function insertHeaderButton(containerEl: HTMLElement, spec: HeaderButtonSpec): void {
	const headerEl = containerEl.querySelector(".view-header");
	const headerLeftEl = containerEl.querySelector(".view-header-left");
	if (!headerEl || !headerLeftEl) return;

	removeHeaderButton(containerEl, spec.className);

	const button = createEl("button", {
		cls: `view-header-left ${spec.className}`,
		text: spec.text,
		attr: {
			"aria-label": spec.ariaLabel,
			tabindex: "0",
		},
	});
	button.addEventListener("click", spec.onClick);

	headerLeftEl.insertAdjacentElement("afterend", button);
}

function removeHeaderButton(containerEl: HTMLElement, className: string): void {
	containerEl.querySelector(`.${className}`)?.remove();
}

/** Renders the "You're offline -- click to reconnect" banner used by both
 * live-view kinds. Only ever called when `shouldConnect` is true; the
 * returned unsubscribe is a static no-op (cleanup instead happens via
 * `banner.destroy()` once the network status flips), matching the
 * pre-existing `showOfflineBanner(): () => void` contract on `ViewBinding`. */
function renderOfflineBanner(
	view: TextFileView | HostCanvasView,
	shouldConnect: boolean,
	networkStatus: ServiceHealthMonitor,
	reconnect: () => void,
): () => void {
	if (shouldConnect) {
		const banner = new ViewNoticeBar(
			view,
			"You're offline -- click to reconnect",
			() => {
				void networkStatus.verifyOnline();
				reconnect();
				return Promise.resolve(networkStatus.isOnline);
			},
		);
		networkStatus.whenBackOnline(() => {
			reconnect();
			banner.destroy();
		});
	}
	return () => {};
}

/**
 * Owns the Svelte `EditorStatusActions` connection-status pill mounted into a
 * view's `.view-actions` header slot, and the state-change subscription
 * that keeps it in sync. Both `DocumentViewBinding` and `CanvasViewBinding` hold one of
 * these instead of duplicating the mount/update/teardown logic.
 */
class ViewActionsMount {
	private component?: MountedComponent<Record<string, unknown>>;
	private unsubscribe?: () => void;

	render(
		containerEl: HTMLElement,
		target: TrackedViewBinding,
		doc: ProviderBacked & { vaultShare: VaultShare },
	): void {
		const actionsEl = containerEl.querySelector(".view-actions");
		if (!actionsEl || !actionsEl.firstChild) return;

		const props = {
			liveView: target,
			isTracking: target.isTracking,
			connectionState: doc.connectionState,
			linked: doc.vaultShare.linked,
		};

		if (!this.component) {
			this.clear(containerEl);
			this.unsubscribe?.();
			this.component = mountComponent(EditorStatusActions, {
				target: actionsEl,
				anchor: actionsEl.firstChild,
				props,
			});
			this.unsubscribe = doc.subscribe(actionsEl, (state: ConnectionState) => {
				this.component?.update({
					liveView: target,
					isTracking: target.isTracking,
					connectionState: state,
					linked: doc.vaultShare.linked,
				});
			});
		}
		this.component.update(props);
	}

	clear(containerEl: HTMLElement): void {
		const actionsEl = containerEl.querySelector(".view-actions");
		if (!actionsEl || !actionsEl.firstChild) return;
		containerEl
			.querySelectorAll(".evc-relay-view-action")
			.forEach((el) => el.remove());
	}

	destroy(): void {
		this.component?.destroy();
		this.component = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}

// ---------------------------------------------------------------------------
// ViewBinding + concrete implementations
// ---------------------------------------------------------------------------

/** Common surface every view wrapper -- live markdown/canvas, or the
 * logged-out placeholder below -- exposes to `ViewBindingRegistry`. */
export interface ViewBinding {
	mountView: () => Promise<ViewBinding>;
	unmountView: () => void;
	teardown: () => void;
	boundDocument: Document | CanvasDocument | null;
	hostView: TextFileView | HostCanvasView;
	connectionAllowed: boolean;
	showOfflineBanner?: () => () => void;
}

/** The `ViewBinding` narrowed to what `EditorStatusActions.svelte`'s connection
 * pill actually reads: `isTracking`/`toggleConnectionIntent` are declared
 * independently on `DocumentViewBinding<ViewType>` and `CanvasViewBinding`,
 * not on `ViewBinding` itself -- neither is generic, so this stays a plain
 * interface both already satisfy structurally with no `implements` needed.
 * Exists so `ViewActionsMount.render()`'s `target` param (and the Svelte
 * prop it feeds) can be typed narrowly enough for `svelte-check` to catch a
 * stale member name, without narrowing away `CanvasViewBinding`, which
 * `render()` must keep serving alongside `DocumentViewBinding`. */
export interface TrackedViewBinding extends ViewBinding {
	isTracking: boolean;
	toggleConnectionIntent(): void;
}

/** Placeholder shown for a shared-folder file when the user isn't logged
 * in -- there's no CRDT document yet, so nothing here participates in the
 * awaitFullyConnected() readiness gate below. */
export class SignedOutViewBinding implements ViewBinding {
	boundDocument = null;
	connectionAllowed = false;
	loginBanner?: ViewNoticeBar;
	hostView: TextFileView | HostCanvasView;
	loginAction: () => Promise<boolean>;

	private _registry: ViewBindingRegistry;

	constructor(
		connectionManager: ViewBindingRegistry,
		hostView: TextFileView | HostCanvasView,
		loginAction: () => Promise<boolean>,
	) {
		this.hostView = hostView;
		this.loginAction = loginAction;
		this._registry = connectionManager; // for debug
	}

	showLoginButton(): void {
		insertHeaderButton(this.hostView.containerEl, {
			className: "evc-relay-login-button",
			text: "Login to enable live edits",
			ariaLabel: "Login to enable live edits",
			onClick: () => {
				void this.loginAction();
			},
		});
	}

	hideLoginButton() {
		removeHeaderButton(this.hostView.containerEl, "evc-relay-login-button");
	}

	mountView(): Promise<ViewBinding> {
		// Login banner disabled - users should login via plugin settings
		return Promise.resolve(this);
	}

	unmountView() {
		this.loginBanner?.destroy();
		this.hideLoginButton();
	}

	teardown() {
		this.unmountView();
		this.loginBanner?.destroy();
		this.loginBanner = undefined;
		this.hideLoginButton();
		this.hostView = null as unknown as TextFileView | HostCanvasView;
	}
}

/** True once `view`'s backing document exists and has text -- i.e. its CRDT
 * model has been created, independent of markdown vs. any other TextFileView. */
function hasSyncedDocument(view: Pick<DocumentViewBinding<TextFileView>, "boundDocument">): boolean {
	return view.boundDocument !== undefined && view.boundDocument.content !== undefined;
}

export function isBoundText(view?: ViewBinding): view is DocumentViewBinding<TextFileView> {
	if (!(view instanceof DocumentViewBinding)) return false;
	return hasSyncedDocument(view);
}

export function isBoundMarkdown(view?: ViewBinding): view is DocumentViewBinding<MarkdownView> {
	if (!(view instanceof DocumentViewBinding)) return false;
	if (!(view.hostView instanceof MarkdownView)) return false;
	return hasSyncedDocument(view);
}

export function isBoundCanvas(view?: ViewBinding): view is CanvasViewBinding {
	if (!(view instanceof CanvasViewBinding)) return false;
	return view.boundDocument !== undefined;
}

export class CanvasViewBinding implements ViewBinding {
	private _actions = new ViewActionsMount();
	private _registry: ViewBindingRegistry;

	hostView: HostCanvasView;
	canvasDocument: CanvasDocument;
	boundDocument: CanvasDocument;
	isTracking: boolean;
	wantsConnection: boolean;
	connectionAllowed: boolean;
	canvasPatch?: CanvasViewPatch;

	constructor(
		connectionManager: ViewBindingRegistry,
		hostView: HostCanvasView,
		canvasDocument: CanvasDocument,
		shouldConnect = true,
		canConnect = true,
	) {
		// identity
		this._registry = connectionManager; // for debug
		this.hostView = hostView;
		this.canvasDocument = canvasDocument;
		this.boundDocument = canvasDocument;
		this.isTracking = false;

		// starting connection posture, then react to the network state we're in
		this.wantsConnection = shouldConnect;
		this.connectionAllowed = canConnect;
		if (!connectionManager.serviceHealth.isOnline) {
			this.showOfflineBanner();
		}
	}

	toggleConnectionIntent() {
		this.wantsConnection = !this.wantsConnection;
		if (!this.wantsConnection) {
			this.canvasDocument.goOffline();
			return;
		}
		void this.canvasDocument.bringOnline().then((connected) => {
			if (connected) return;
			// Connection failed -- leave the toggle off so the next click retries.
			this.wantsConnection = false;
		});
	}

	showOfflineBanner(): () => void {
		return renderOfflineBanner(
			this.hostView,
			this.wantsConnection,
			this._registry.serviceHealth,
			() => this.beginConnect(),
		);
	}

	renderActionsPill(): void {
		this._actions.render(this.hostView.containerEl, this, this.canvasDocument);
	}

	clearActionsPill() {
		this._actions.clear(this.hostView.containerEl);
	}

	mountView(): Promise<CanvasViewBinding> {
		// Re-entrant: may run again before a matching unmountView(). The lock below
		// guards against a concurrent user-initiated disconnect racing this.
		this.canvasDocument.editLock = true;

		// ToggleName the container as a live-editing surface for the CodeMirror plugins.
		this.hostView.containerEl.addClass("relay-live-editor");

		this.renderActionsPill();

		return new Promise((resolve) => {
			this.canvasDocument
				.awaitFullyConnected()
				.then((doc) => {
					// Constructing CanvasViewPatch installs patches on requestSave/applyHistory
					// that seed each text node's Y.Text from the local Obsidian view on every
					// save (see CanvasDocument.nodeText()). awaitFullyConnected() awaits
					// hasPendingCrdtUpdate(), which awaits awaitFirstSync() first -- so by the
					// time the patch is installed, the canvas's own persisted history is
					// guaranteed to have replayed, and an empty Y.Text genuinely means
					// "new node" rather than "not synced yet". Constructing it eagerly
					// (before awaitFullyConnected() resolves) reopens the same
					// empty-check-then-seed race fixed for TransferQueue.uploadDocumentViaSocket
					//.
					if (!this.canvasPatch) {
						this.canvasPatch = new CanvasViewPatch(this._registry, this);
					}
					if (
						this._registry.serviceHealth.isOnline &&
						this.canvasDocument.vaultShare.wantsConnection &&
						this.wantsConnection &&
						this.connectionAllowed
					) {
						this.beginConnect();
					} else {
						this.canvasDocument.goOffline();
					}
					resolve(this);
				})
				.catch(() => {
					this.showOfflineBanner();
				});
		});
	}

	beginConnect() {
		void this.canvasDocument.bringOnline();
	}

	unmountView() {
		// Invoked whenever the manager stops tracking this view.

		// Strip the live-editing marker class again.
		this.hostView.containerEl.removeClass("relay-live-editor");

		this.canvasPatch?.teardown();
		this.canvasPatch = undefined;
		this._actions.destroy();
		this.canvasDocument.goOffline();
		this.canvasDocument.editLock = false;
	}

	teardown() {
		this.canvasPatch?.teardown();
		this.canvasPatch = null as unknown as CanvasViewPatch | undefined;
		this.unmountView();
		this.clearActionsPill();
		((this.hostView.leaf as unknown as Record<string, () => void>)["rebuildView"])?.();
		this._registry = null as unknown as ViewBindingRegistry;
		this.hostView = null as unknown as HostCanvasView;
		this.canvasDocument = null as unknown as CanvasDocument;
	}
}

export class DocumentViewBinding<ViewType extends TextFileView>
	extends Loggable
	implements ViewBinding
{
	private _actions = new ViewActionsMount();
	private _registry: ViewBindingRegistry;
	private _mergeBanner?: ViewNoticeBar;
	private _textPatch?: TextViewPatch;
	private _presenceDecorator?: PresenceTitleDecorator;

	hostView: ViewType;
	boundDocument: Document;
	_isTracking: boolean;
	wantsConnection: boolean;
	connectionAllowed: boolean;

	constructor(
		connectionManager: ViewBindingRegistry,
		hostView: ViewType,
		boundDocument: Document,
		shouldConnect = true,
		canConnect = true,
	) {
		super();
		// identity
		this._registry = connectionManager; // for debug
		this.hostView = hostView;
		this.boundDocument = boundDocument;
		this._isTracking = false;

		// starting connection posture, then react to the network state we're in
		this.wantsConnection = shouldConnect;
		this.connectionAllowed = canConnect;
		if (!connectionManager.serviceHealth.isOnline) {
			this.showOfflineBanner();
		}
	}

	toggleConnectionIntent() {
		this.wantsConnection = !this.wantsConnection;
		if (!this.wantsConnection) {
			this.boundDocument.goOffline();
			return;
		}
		void this.boundDocument.bringOnline().then((connected) => {
			if (connected) return;
			// Connection failed -- leave the toggle off so the next click retries.
			this.wantsConnection = false;
		});
	}

	public get isTracking() {
		return this._isTracking;
	}

	public set isTracking(value: boolean) {
		const old = this._isTracking;
		this._isTracking = value;
		if (this._isTracking !== old) {
			void this.mountView();
		}
	}

	public get crdtTextHandle(): Y.Text {
		return this.boundDocument.crdtText;
	}

	public get registry(): ViewBindingRegistry {
		return this._registry;
	}

	showMergeButton(): void {
		insertHeaderButton(this.hostView.containerEl, {
			className: "evc-relay-merge-button",
			text: "Merge conflict",
			ariaLabel: "Merge conflict -- click to fix it",
			onClick: () => {
				void this.resolveMergeConflict();
			},
		});
	}

	hideMergeButton() {
		removeHeaderButton(this.hostView.containerEl, "evc-relay-merge-button");
	}

	/** Shared by the header-button click handler and the desktop banner's
	 * click handler (`showMergeBanner()`) -- both open the same diff view and
	 * clear the same UI once the user resolves the conflict. */
	private async resolveMergeConflict(): Promise<boolean> {
		const diskBuffer = await this.boundDocument.unsavedFile();
		let stale: boolean;
		try {
			stale = await this.boundDocument.refreshIfStale();
		} catch (e: unknown) {
			console.warn(
				"[Relay] resolveMergeConflict checkStale failed:",
				(e as Error).message,
			);
			this.hideMergeButton();
			return true;
		}
		if (!stale) {
			this.hideMergeButton();
			return true;
		}
		this._registry.launchDiffView({
			leftFile: this.boundDocument,
			rightFile: diskBuffer,
			allowMergeActions: true,
			onMergeResolved: async () => {
				await this.boundDocument.clearUnsavedFile();
				this.hideMergeButton();
				// Re-sync the editor view with CRDT state once the diff is resolved.
				if (
					this._textPatch &&
					typeof this._textPatch.pushCRDTToView === "function"
				) {
					this._textPatch.pushCRDTToView();
				}
			},
		});
		return true;
	}

	showMergeBanner(): () => void {
		// The floating banner doesn't render well on small screens, so newer
		// mobile clients get the header button variant instead.
		if (Platform.isMobile && requireApiVersion("1.11.0")) {
			this.showMergeButton();
		} else {
			this._mergeBanner = new ViewNoticeBar(
				this.hostView,
				"Merge conflict -- click to fix it",
				() => this.resolveMergeConflict(),
			);
		}
		return () => {};
	}

	showOfflineBanner(): () => void {
		return renderOfflineBanner(
			this.hostView,
			this.wantsConnection,
			this._registry.serviceHealth,
			() => this.beginConnect(),
		);
	}

	renderActionsPill(): void {
		this._actions.render(this.hostView.containerEl, this, this.boundDocument);
	}

	clearActionsPill() {
		this._actions.clear(this.hostView.containerEl);
	}

	private clearStaleBanner(): void {
		this._mergeBanner?.destroy();
		this._mergeBanner = undefined;
	}

	async refreshStaleState() {
		const inPreviewMode =
			this.hostView instanceof MarkdownView && this.hostView.getMode() === "preview";
		if (inPreviewMode) return false;

		let stale: boolean;
		try {
			stale = await this.boundDocument.refreshIfStale();
		} catch (e: unknown) {
			// HTTP download failed (e.g., 401 with CWT tokens on relay-server).
			// Return false — rely on WS sync for CRDT state.
			console.warn("[Relay] DocumentViewBinding.refreshStaleState failed, relying on WS sync:", (e as Error).message);
			return false;
		}

		const hasConflictingDiskCopy = stale && this.boundDocument._unsavedFile?.unsavedText;
		if (hasConflictingDiskCopy) {
			this.showMergeBanner();
		} else {
			this.clearStaleBanner();
		}
		return stale;
	}

	/** Non-markdown views (kanban etc.) don't get a TextViewPatch from
	 * anywhere else, so mountView() has to lazily create one. */
	private ensureTextFileViewPlugin(): void {
		if (this.hostView instanceof MarkdownView) return;
		if (this._textPatch) return;
		this.warn("[DocumentViewBinding] no plugin yet at mountView() time, building one now:", {
			path: this.boundDocument.entryPath,
			viewType: this.hostView.getViewType?.(),
			viewFilePath: this.hostView.file?.path,
		});
		this._textPatch = new TextViewPatch(this);
	}

	/** Presence avatars are markdown-only and gated behind a feature featureKey. */
	private maybeCreateAwarenessPlugin(): void {
		const canShowPresence =
			isBoundMarkdown(this) && !this._presenceDecorator && currentToggles().enablePresenceAvatars;
		if (!canShowPresence) return;
		this._presenceDecorator = new PresenceTitleDecorator(this);
	}

	mountView(): Promise<this> {
		// Re-entrant: may run again before a matching unmountView(). The lock below
		// guards against a concurrent user-initiated disconnect racing this.
		this.boundDocument.editLock = true;

		// ToggleName the container as a live-editing surface for the CodeMirror plugins.
		if (this.hostView instanceof MarkdownView) {
			this.hostView.containerEl.addClass("relay-live-editor");
		}

		this.ensureTextFileViewPlugin();
		this.renderActionsPill();
		this.maybeCreateAwarenessPlugin();

		return new Promise((resolve) => {
			this.boundDocument
				.awaitFullyConnected()
				.then((doc) => {
					if (
						this._registry.serviceHealth.isOnline &&
						this.boundDocument.vaultShare.wantsConnection &&
						this.wantsConnection &&
						this.connectionAllowed
					) {
						this.beginConnect();
					} else {
						this.boundDocument.goOffline();
					}
					resolve(this);
				})
				.catch(() => {
					this.showOfflineBanner();
				});
		});
	}

	beginConnect() {
		void this.boundDocument.bringOnline();
	}

	unmountView() {
		// Invoked whenever the manager stops tracking this view.

		// Flush pending edits first if this view had been tracking them.
		if (this.isTracking) {
			this.boundDocument.syncToVault();
		}

		// Strip the live-editing marker class again.
		if (this.hostView instanceof MarkdownView) {
			this.hostView.containerEl.removeClass("relay-live-editor");
		}

		this._actions.destroy();
		this._mergeBanner?.destroy();
		this._mergeBanner = undefined;
		this.hideMergeButton();
		this._presenceDecorator?.dismantle();
		this._presenceDecorator = undefined;
		this._textPatch?.teardown();
		this._textPatch = undefined;
		this.boundDocument.goOffline();
		this.boundDocument.editLock = false;
	}

	teardown() {
		this.unmountView();
		this.clearActionsPill();
		this.hideMergeButton();
		((this.hostView.leaf as unknown as Record<string, () => void>)["rebuildView"])?.();
		this._registry = null as unknown as ViewBindingRegistry;
		this.hostView = null as unknown as ViewType;
		this.boundDocument = null as unknown as Document;
		this._textPatch = null as unknown as TextViewPatch | undefined;
	}
}

// ---------------------------------------------------------------------------
// ViewBindingRegistry
// ---------------------------------------------------------------------------

export class ViewBindingRegistry {
	// event-listener bookkeeping, unwound in shutdown()
	private teardownCallbacks: (() => void)[] = [];
	private folderUnsubscribers: Map<VaultShare, () => void> = new Map();
	private metadataCallbacks: Map<
		TFile,
		(data: string, cache: CachedMetadata) => void
	>;

	// collaborators, injected via the constructor below
	obsidianWorkspace: Workspace;
	shareRegistry: ShareRegistry;
	serviceHealth: ServiceHealthMonitor;
	private authSession: AuthSession;

	// managed view/extension state
	isShutDown = false;
	trackedViews: ViewBinding[];
	cmExtensions: Extension[];
	pendingRefreshQueue: (() => Promise<boolean>)[];
	private _pendingRefresh?: Promise<boolean> | null;
	_extensionCompartment: Compartment;

	logInfo: (message: string, ...args: unknown[]) => void;
	logWarn: (message: string, ...args: unknown[]) => void;

	constructor(
		public obsidianApp: App,
		shareRegistry: ShareRegistry,
		authSession: AuthSession,
		serviceHealth: ServiceHealthMonitor,
	) {
		this.logInfo = namedLogger("[View Bindings]", "log");
		this.logWarn = namedLogger("[View Bindings]", "warn");

		this.obsidianWorkspace = obsidianApp.workspace;
		this.shareRegistry = shareRegistry;
		this.authSession = authSession;
		this.serviceHealth = serviceHealth;

		this.trackedViews = [];
		this.cmExtensions = [];
		this.pendingRefreshQueue = [];
		this._pendingRefresh = null;
		this._extensionCompartment = new Compartment();
		this.metadataCallbacks = new Map();

		this.wireMetadataCache();
		this.wireLoginManager();
		this.wireShareRegistry();

		instanceLabels.set(this, "View Binding Registry");
	}

	private wireMetadataCache(): void {
		const onChanged = (tfile: TFile, data: string, cache: CachedMetadata) => {
			this.metadataCallbacks.get(tfile)?.(data, cache);
		};
		const offRef = this.obsidianApp.metadataCache.on("changed", onChanged);
		this.teardownCallbacks.push(() => {
			this.obsidianApp.metadataCache.offref(offRef);
		});
	}

	private wireLoginManager(): void {
		this.teardownCallbacks.push(
			this.authSession.on(() => {
				void this.refreshViews("[AuthSession]");
			}),
		);
	}

	/** Subscribes to one shared folder's docset changes, and -- if it isn't
	 * ready yet -- to its readiness. `folder.awaitReady()` resolving triggers
	 * a refresh (so views waiting on this folder get built); failing it
	 * degrades the already-open views for this folder to an offline banner
	 * rather than leaving them silently stuck. */
	private subscribeToFolder(folder: VaultShare): () => void {
		if (!folder.isPrepared) {
			folder
				.awaitReady()
				.then(() => {
					void this.refreshViews("[Shared Folder Ready]");
				})
				.catch((_: unknown) => {
					this.trackedViews.forEach((view) => {
						if (view.boundDocument?.vaultShare === folder) {
							view.showOfflineBanner?.();
						}
					});
				});
		}
		return folder.pathSet.on(() => {
			void this.refreshViews("[Docset]");
		});
	}

	private pruneRemovedFolderListeners(): void {
		this.folderUnsubscribers.forEach((off, folder) => {
			if (!this.shareRegistry.contains(folder)) {
				off();
				this.folderUnsubscribers.delete(folder);
			}
		});
	}

	private wireShareRegistry(): void {
		this.teardownCallbacks.push(
			this.shareRegistry.subscribe(() => {
				void this.refreshViews("[Shared Folders]");
				this.pruneRemovedFolderListeners();
				this.shareRegistry.each((folder) => {
					if (!this.folderUnsubscribers.has(folder)) {
						this.folderUnsubscribers.set(folder, this.subscribeToFolder(folder));
					}
				});
			}),
		);
	}

	reconfigureExtension(editorView: EditorView) {
		editorView.dispatch({
			effects: this._extensionCompartment.reconfigure([
				ViewBindingStateField.init(() => {
					return this;
				}),
			]),
		});
	}

	subscribeMetadata(tfile: TFile, cb: (data: string, cache: CachedMetadata) => void) {
		this.metadataCallbacks.set(tfile, cb);
	}

	unsubscribeMetadata(tfile: TFile) {
		this.metadataCallbacks.delete(tfile);
	}

	launchDiffView(state: Differ.DiffViewState) {
		Differ.launchFileDiffView(this.obsidianWorkspace, state);
	}

	handleNetworkOffline() {
		this.logInfo("network status flipped offline -- disconnecting live views");
		this.trackedViews.forEach((view) => view.boundDocument?.goOffline());
		void this.refreshViews("[ServiceHealthMonitor]");
	}

	handleNetworkOnline() {
		this.logInfo("network status flipped online -- reconnecting live views");
		void this.refreshViews("[ServiceHealthMonitor]");
		this.shareRegistry.toArray().forEach((folder: VaultShare) => {
			void folder.bringOnline();
		});
		void this.mountViewsWithPool(this.trackedViews);
	}

	isDocumentOpen(doc: Document): boolean {
		return this.trackedViews.some((view) => view.boundDocument === doc);
	}

	private unmountViews(views: ViewBinding[]) {
		views.forEach((view) => {
			view.unmountView();
		});
	}

	/** Shared folders backing whatever text-file/canvas views are currently
	 * open in the workspace, regardless of whether those views have been
	 * turned into `ViewBinding`s yet. */
	private openFolders(): VaultShare[] {
		const folders = new Set<VaultShare>();
		const addIfShared = (path?: string) => {
			if (!path) return;
			const folder = this.shareRegistry.shareFor(path);
			if (folder) folders.add(folder);
		};
		openTextFileViews(this.obsidianWorkspace).forEach((view) => addIfShared(view.file?.path));
		openCanvasViews(this.obsidianWorkspace).forEach((view) => addIfShared(view.file?.path));
		return [...folders];
	}

	private findOpenFolders(): VaultShare[] {
		return this.openFolders();
	}

	private isAuthenticatedForFolder(folder: VaultShare): boolean {
		const serverId = folder.config.onpremServerId;
		return serverId ? this.authSession.isLoggedInToServer(serverId) : this.authSession.isAuthenticated;
	}

	private async awaitOpenFoldersReady(): Promise<VaultShare[]> {
		const folders = this.openFolders();
		if (folders.length === 0) return [];
		return Promise.all(folders.map((folder) => folder.awaitReady()));
	}

	/** Builds an `ViewBinding` for an open leaf, or logs+skips it: logged-out
	 * users get a `SignedOutViewBinding`; a not-yet-ready folder is skipped this
	 * pass (a later refresh, triggered by `subscribeToFolder`, retries);
	 * a construction error is caught and logged rather than aborting the
	 * whole refresh over one bad view. */
	private pushResolvedView<TView extends TextFileView | HostCanvasView>(
		views: ViewBinding[],
		folder: VaultShare,
		viewFilePath: string,
		view: TView,
		errorLabel: string,
		makeLive: (folder: VaultShare) => ViewBinding,
	): void {
		if (!this.isAuthenticatedForFolder(folder)) {
			views.push(
				new SignedOutViewBinding(this, view, () => this.authSession.presentLoginPage()),
			);
			return;
		}
		if (!folder.isPrepared) {
			this.logInfo(`skipping views for folder=${folder.path} -- not ready yet`);
			return;
		}
		try {
			views.push(makeLive(folder));
		} catch (e: unknown) {
			this.logWarn(`[Relay] Error getting ${errorLabel} for view ${viewFilePath}`, e);
		}
	}

	private collectOpenViews(): ViewBinding[] {
		const views: ViewBinding[] = [];

		for (const textView of openTextFileViews(this.obsidianWorkspace)) {
			const viewFilePath = textView.file?.path;
			if (!viewFilePath) continue;
			const folder = this.shareRegistry.shareFor(viewFilePath);
			if (!folder) continue;
			this.pushResolvedView(views, folder, viewFilePath, textView, "doc", (f) =>
				new DocumentViewBinding<typeof textView>(this, textView, f.rootRelative.docAt(viewFilePath)),
			);
		}

		for (const canvasView of openCanvasViews(this.obsidianWorkspace)) {
			const viewFilePath = canvasView.file?.path;
			if (!viewFilePath) continue;
			const folder = this.shareRegistry.shareFor(viewFilePath);
			if (!folder) continue;

			// Only connect if the folder index actually classifies this .canvas
			// file as a CanvasDocument (it may instead be tracked as a plain AttachmentFile).
			const vpath = folder.toVirtualPath(viewFilePath);
			const meta = folder.folderIndex.recordFor(vpath);
			if (meta?.type !== ItemKind.Canvas) {
				this.logInfo(
					`Skipping canvas view connection for ${viewFilePath} - folder-index type is ${meta?.type || "unknown"}`,
				);
				continue;
			}

			this.pushResolvedView(views, folder, viewFilePath, canvasView, "canvas", (f) =>
				new CanvasViewBinding(this, canvasView, f.rootRelative.canvasAt(viewFilePath)),
			);
		}

		return views;
	}

	locateMarkdownView(cmEditor: EditorView): DocumentViewBinding<MarkdownView> | undefined {
		return this.trackedViews.filter(isBoundMarkdown).find((view) => {
			const editor = view.hostView.editor as unknown as Record<string, unknown>; // editor is unknown at runtime (Obsidian internal)
			const cm = editor["cm"] as EditorView;
			return cm === cmEditor;
		});
	}

	locateCanvasView(cmEditor: EditorView): CanvasViewBinding | undefined {
		const stateFields = (cmEditor.state as unknown as { values: unknown[] }).values;
		const canvasField = stateFields.find(
			(field): field is { node: Record<string, unknown> } =>
				field != null && (field as Record<string, unknown>).node != null,
		);
		if (!canvasField) return;
		return this.trackedViews
			.filter(isBoundCanvas)
			.find((view) => view.hostView.canvas === canvasField.node["canvas"]);
	}

	/** Filters to the views whose backing model has confirmed readiness --
	 * this is the gate: every view here has had its
	 * `awaitFullyConnected()` (which awaits `awaitFirstSync()` first) resolve before
	 * `_executeRefreshPass()` proceeds to attach it. Each view's readiness is
	 * awaited independently and in parallel -- one slow/unready view must
	 * not block the others from attaching. */
	private async awaitViewsReady(views: ViewBinding[]): Promise<DocumentViewBinding<TextFileView>[]> {
		return await Promise.all(
			views
				.filter(isBoundText)
				.map(async (view) => view.boundDocument.awaitFullyConnected().then((_) => view)),
		);
	}

	private async mountViewsWithPool(
		views: ViewBinding[],
		backgroundConnections: number = BACKGROUND_CONNECTIONS,
	): Promise<ViewBinding[]> {
		const activeView =
			this.obsidianWorkspace.getActiveViewOfType<TextFileView>(TextFileView);

		// Sorts in place (deliberately -- see below) by most-recently-active
		// leaf first, so the connection pool below prefers the views the user
		// was most recently looking at.
		views.sort((a, b) => leafActiveTime(b) - leafActiveTime(a));

		const connectedDocuments = new Set<Document>();
		let poolSlotsUsed = 0;

		for (const view of views) {
			if (!(view instanceof DocumentViewBinding)) continue;
			if (view.hostView === activeView || connectedDocuments.has(view.boundDocument)) {
				view.connectionAllowed = true;
				connectedDocuments.add(view.boundDocument);
			} else if (poolSlotsUsed < backgroundConnections) {
				view.connectionAllowed = true;
				connectedDocuments.add(view.boundDocument);
				poolSlotsUsed++;
			} else {
				view.connectionAllowed = false;
			}
		}

		if (poolSlotsUsed > backgroundConnections) {
			this.logWarn(
				`background connection pool overflowed its cap of ${backgroundConnections} -- ${
					poolSlotsUsed - backgroundConnections
				} view(s) denied a slot`,
			);
		}

		// views was sorted in place above, so this attaches in the same
		// most-recently-active-first order.
		return this.mountAllViews(views);
	}

	private async mountAllViews(views: ViewBinding[]): Promise<ViewBinding[]> {
		return await Promise.all(
			views.map(async (view) => {
				return view.mountView();
			}),
		);
	}

	/** Splits the manager's previously-tracked views against a freshly
	 * computed view list: `matching` keeps the OLD `ViewBinding` instance for any
	 * (document, view) pair still present in `freshViews` (so per-view
	 * mounted state -- banners, the actions pill -- survives an unrelated
	 * refresh), appended by any genuinely new views; `stale` is whatever
	 * from the old set has no counterpart anymore and should be released. */
	private reconcileViewSets(freshViews: ViewBinding[]): [ViewBinding[], ViewBinding[]] {
		const unclaimed = [...freshViews];
		const matching: ViewBinding[] = [];
		const stale: ViewBinding[] = [];

		for (const oldView of this.trackedViews) {
			const idx = unclaimed.findIndex(
				(fresh) => fresh.boundDocument === oldView.boundDocument && fresh.hostView === oldView.hostView,
			);
			if (idx === -1) {
				stale.push(oldView);
			} else {
				matching.push(oldView);
				unclaimed.splice(idx, 1);
			}
		}

		matching.push(...unclaimed);
		return [matching, stale];
	}

	private logViewSummary(ctx: string, message: string, views: ViewBinding[]): void {
		namedLogger(ctx, "debug")(
			message,
			views.map((view) => ({
				type: view.constructor.name,
				file: view.boundDocument?.entryPath,
				connectionAllowed: view.connectionAllowed,
			})),
		);
	}

	async _executeRefreshPass(
		context: string,
		queuedAt: moment.Moment,
	): Promise<boolean> {
		const ctx = `[View Bindings][${context}]`;
		const log = namedLogger(ctx, "debug");
		log("Refresh");

		if (this.isShutDown) return false;

		await this.awaitOpenFoldersReady();

		let views: ViewBinding[] = [];
		try {
			views = this.collectOpenViews();
		} catch (e: unknown) {
			this.logWarn("view collection failed, aborting this refresh pass", e);
			return false;
		}
		const activeDocumentFolders = this.findOpenFolders();
		if (activeDocumentFolders.length === 0 && views.length === 0) {
			if (this.cmExtensions.length !== 0) {
				log("no live views open but extensions were still installed, wiping");
				this.clearExtensions();
			}
			this.logViewSummary(ctx, "Releasing Views", this.trackedViews);
			this.unmountViews(this.trackedViews);
			this.trackedViews = [];
			return true; // no live views open
		}

		// The default server can be signed out while this share's server has
		// a valid session. Use the same per-share auth as its token provider.
		this.shareRegistry.each((folder) => {
			if (!this.isAuthenticatedForFolder(folder) || !this.serviceHealth.isOnline) {
				folder.goOffline();
			} else if (activeDocumentFolders.includes(folder)) {
				void folder.bringOnline();
			}
		});

		const [matching, stale] = this.reconcileViewSets(views);
		this.logViewSummary(ctx, "Releasing Views", stale);
		this.unmountViews(stale);

		const viewsAlreadyMatch =
			stale.length === 0 && viewSetsMatch(matching, this.trackedViews);
		const attachedViews = await this.attachMatchingOrReadyViews(
			ctx,
			matching,
			viewsAlreadyMatch,
		);
		this.logViewSummary(ctx, "Attached Views", attachedViews);
		if (!viewsAlreadyMatch) {
			this.trackedViews = matching;
		}

		log("installing live-editing extensions");
		this.installExtensions();
		const now = moment.utc();
		log(`refresh pass finished, took ${now.diff(queuedAt)}ms`, ctx);
		return true;
	}

	/** The attach half of the refresh cycle: reuses the currently-attached
	 * views as-is when nothing changed, otherwise waits for the new set's
	 * readiness gate (`awaitViewsReady`, the gate) before attaching. */
	private async attachMatchingOrReadyViews(
		ctx: string,
		matching: ViewBinding[],
		viewsAlreadyMatch: boolean,
	): Promise<ViewBinding[]> {
		if (viewsAlreadyMatch) {
			// Nothing changed since the last pass, so readiness was already proven.
			return this.mountViewsWithPool(this.trackedViews);
		}
		const readyViews = await this.awaitViewsReady(matching);
		this.logViewSummary(ctx, "Ready Views", readyViews);
		return this.mountViewsWithPool(readyViews);
	}

	async refreshViews(context: string) {
		if (this.isShutDown) return false;
		const log = namedLogger(context, "warn");
		const queuedAt = moment.utc();
		this.pendingRefreshQueue.push(() => this._executeRefreshPass(context, queuedAt));
		if (this._pendingRefresh !== null) {
			return false;
		}
		return this.drainRefreshQueue(log);
	}

	/** Coalescing queue: while a refresh is running, further requests just
	 * replace the queue with the latest one -- only the freshest pending
	 * call actually runs once the in-flight one finishes. */
	private async drainRefreshQueue(
		log: (message: string, ...args: unknown[]) => void,
	): Promise<boolean> {
		while (this.pendingRefreshQueue.length > 0) {
			if (this.isShutDown) return false;
			if (this.pendingRefreshQueue.length > 2) {
				log("pending refresh requests backed up to:", this.pendingRefreshQueue.length);
			}
			const next = this.pendingRefreshQueue.pop()!;
			this.pendingRefreshQueue.length = 0;
			this._pendingRefresh = next().finally(() => {
				this._pendingRefresh = null;
			});
			await this._pendingRefresh;
		}
		return true;
	}

	clearExtensions() {
		this.cmExtensions.length = 0;
		this.obsidianWorkspace.updateOptions();
	}

	/** The CodeMirror extension set installed while at least one live view
	 * is open -- kept as one array so `installExtensions()` can swap it in/out atomically
	 * via `clearExtensions()` + `updateOptions()`. */
	private buildLiveExtensions(): Extension {
		return [
			EditorState.transactionFilter.of(transaction => {
				if (!transaction.docChanged || transaction.annotation(ySyncAnnotation)) return transaction;
				const file = transaction.startState.field(editorInfoField, false)?.file;
				const folder = file && this.shareRegistry.shareFor(file.path);
				if (folder && !folder.canWriteManagedPath(folder.toVirtualPath(file.path))) return [];
				return transaction;
			}),
			this._extensionCompartment.of(ViewBindingStateField.init(() => this)),
			LiveEdit,
			LiveNode,
			yRemoteSelectionsTheme,
			yRemoteSelections,
			ExternalLinkPlugin,
		];
	}

	installExtensions() {
		this.clearExtensions();
		if (this.trackedViews.length === 0) return;
		this.cmExtensions.push(this.buildLiveExtensions());
		this.obsidianWorkspace.updateOptions();
	}

	public shutdown() {
		this.isShutDown = true;
		this.unmountViews(this.trackedViews);
		this.teardownCallbacks.forEach((off) => off());
		this.teardownCallbacks.length = 0;
		this.metadataCallbacks.clear();
		this.metadataCallbacks = null as unknown as Map<TFile, (data: string, cache: CachedMetadata) => void>;
		this.folderUnsubscribers.forEach((off) => off());
		this.folderUnsubscribers.clear();
		this.folderUnsubscribers = null as unknown as Map<VaultShare, () => void>;
		this.trackedViews.forEach((view) => view.teardown());
		this.trackedViews = [];
		this.clearExtensions();
		this.shareRegistry = null as unknown as ShareRegistry;
		this.pendingRefreshQueue = null as unknown as (() => Promise<boolean>)[];
		this.serviceHealth = null as unknown as ServiceHealthMonitor;
		this._pendingRefresh = null;
		this.authSession = null as unknown as AuthSession;
		this.obsidianApp = null as unknown as App;
		this.obsidianWorkspace = null as unknown as Workspace;
	}
}

export const ViewBindingStateField = StateField.define<
	ViewBindingRegistry | undefined
>({
	create(state: EditorState) {
		return undefined;
	},
	update(currentManager, transaction) {
		return currentManager;
	},
});
