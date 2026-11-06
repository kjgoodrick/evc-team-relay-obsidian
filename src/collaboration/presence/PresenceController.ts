import { Component, MarkdownView, Modal, Notice, Setting, setIcon, type Plugin } from "obsidian";
import * as Y from "yjs";
import type { AuthSession } from "../../AuthSession";
import { DocumentViewBinding, type ViewBindingRegistry } from "../../ViewBindings";
import type { SettingsScope } from "../../SettingsPersistence";
import type { YSweetProvider } from "../../client/provider";
import { readingCommentBinding, onReadingBindingChange } from "../ReadingTextBinding";
import type { NotePresenceSurface, PresenceSettings } from "./PresenceSettings";

type Binding = DocumentViewBinding<MarkdownView>;
export type PresenceStatus = "hidden" | "idle" | "waiting" | "offline" | "ready" | "recovering" | "capacity" | "unavailable";
const descriptions: Record<PresenceStatus, string> = {
	hidden: "Your presence is hidden.",
	idle: "Open a shared note to share your presence.",
	waiting: "Waiting for this note’s shared view and account to be ready.",
	offline: "Presence is offline. It will return when this note reconnects.",
	ready: "Your presence is visible in this note.",
	recovering: "Reconnecting your presence…",
	capacity: "This note’s presence room is full. Retrying automatically; note sync remains available.",
	unavailable: "Presence is unavailable. You can retry; note sync remains available.",
};

/** One owner across all leaves/popout windows. It neither creates documents nor
 * opens sockets; note sync retains its existing connection lifecycle. */
export class PresenceController extends Component {
	private active?: { binding: Binding; surface: NotePresenceSurface };
	private candidate?: Binding;
	private observed?: YSweetProvider;
	private stopProvider?: () => void;
	private windows = new Map<Document, () => void>();
	private blurred = new WeakSet<Document>();
	private listeners = new Set<() => void>();
	private action?: HTMLElement;
	private actionView?: MarkdownView;
	private stopped = false;
	private refreshing = false;
	status: PresenceStatus = "idle";
	visible = true;

	constructor(private plugin: Plugin, private registry: ViewBindingRegistry, private auth: AuthSession,
		private settings: SettingsScope<PresenceSettings>) { super(); }

	onload(): void {
		const workspace = this.plugin.app.workspace;
		this.register(this.registry.onViewsChanged(() => this.refresh()));
		this.register(this.auth.on(() => this.refresh()));
		this.register(this.auth.onTokenRefreshed(() => this.refresh()));
		this.register(onReadingBindingChange(() => this.refresh()));
		this.register(this.settings.subscribe(value => { this.visible = value?.visible !== false; this.refresh(); }));
		this.registerEvent(workspace.on("active-leaf-change", () => this.refresh()));
		this.registerEvent(workspace.on("file-open", () => this.refresh()));
		this.registerEvent(workspace.on("layout-change", () => this.refresh()));
		this.registerEvent(this.plugin.app.vault.on("rename", () => this.refresh()));
		this.registerEvent(this.plugin.app.vault.on("delete", () => this.refresh()));
		this.registerEvent(workspace.on("window-open", () => this.refresh()));
		this.registerEvent(workspace.on("window-close", (_host, win) => {
			this.blurred.add(win.document); this.clearActive(win.document);
			this.windows.get(win.document)?.(); this.windows.delete(win.document); this.refresh();
		}));
		this.plugin.addCommand({ id: "presence-controls", name: "Presence controls", callback: () => this.openControls() });
		this.plugin.addCommand({ id: "toggle-presence", name: "Toggle presence visibility", callback: () => { void this.setVisible(!this.visible); } });
		this.refresh();
	}

	onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	get description(): string { return descriptions[this.status]; }
	get canRetry(): boolean { return this.visible && !!this.active && ["unavailable", "capacity"].includes(this.status); }
	async setVisible(visible: boolean): Promise<void> {
		// Apply privacy immediately, including if saving preferences fails.
		this.visible = visible; this.refresh();
		try { await this.settings.mutateValue(current => ({ ...current, visible })); }
		catch { new Notice("Presence visibility changed for this session, but the preference could not be saved."); }
	}
	retry(): void { if (this.canRetry) { this.active!.binding.boundDocument._liveProvider.presence.retry(); this.refresh(); } }
	openControls(): void { new PresenceControls(this.plugin, this).open(); }

	private clearActive(owner?: Document): void {
		if (!this.active || owner && this.active.binding.hostView?.containerEl.ownerDocument !== owner) return;
		const previous = this.active; this.active = undefined;
		previous.binding.boundDocument?.setPresenceActive();
	}
	private observe(provider?: YSweetProvider): void {
		if (provider === this.observed) return;
		this.stopProvider?.(); this.observed = provider;
		if (!provider) { this.stopProvider = undefined; return; }
		const changed = () => this.refresh();
		provider.on("status", changed); provider.on("sync", changed); provider.on("presence-status", changed);
		this.stopProvider = () => { provider.off("status", changed); provider.off("sync", changed); provider.off("presence-status", changed); };
	}
	private watchWindows(): void {
		const wanted = new Set<Document>([document]);
		for (const binding of this.registry.trackedViews) if (binding.hostView?.containerEl?.isConnected) wanted.add(binding.hostView.containerEl.ownerDocument);
		for (const [doc, stop] of this.windows) if (!wanted.has(doc)) { stop(); this.windows.delete(doc); }
		for (const doc of wanted) {
			if (this.windows.has(doc) || !doc.defaultView) continue;
			const win = doc.defaultView;
			const blur = () => { this.blurred.add(doc); this.clearActive(doc); this.refresh(); };
			const focus = () => { this.blurred.delete(doc); this.refresh(); };
			const visibility = () => { if (doc.hidden) blur(); else focus(); };
			win.addEventListener("blur", blur); win.addEventListener("pagehide", blur);
			win.addEventListener("focus", focus); win.addEventListener("pageshow", focus);
			doc.addEventListener("visibilitychange", visibility);
			this.windows.set(doc, () => {
				win.removeEventListener("blur", blur); win.removeEventListener("pagehide", blur);
				win.removeEventListener("focus", focus); win.removeEventListener("pageshow", focus);
				doc.removeEventListener("visibilitychange", visibility);
			});
		}
	}

	refresh(): void {
		if (this.stopped || this.refreshing) return;
		this.refreshing = true;
		try {
			this.watchWindows();
			const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
			const candidate = !this.registry.isShutDown && this.registry.trackedViews.find((item): item is Binding =>
				item instanceof DocumentViewBinding && item.hostView === view && !!item.boundDocument &&
				view?.file?.extension === "md" && item.boundDocument._obsidianFile === view.file &&
				this.plugin.app.vault.getFileByPath(view.file.path) === view.file &&
				this.registry.shareRegistry.shareFor(view.file.path) === item.boundDocument.vaultShare);
			this.candidate = candidate || undefined;
			this.observe(this.candidate?.boundDocument._liveProvider);
			const surface: NotePresenceSurface = view?.getMode() === "preview" ? "reading" : "editor";
			const owner = view?.containerEl.ownerDocument;
			const reading = surface === "reading" && view ? readingCommentBinding(view) : undefined;
			const bound = !!candidate && (surface === "editor" ? candidate.isTracking :
				reading?.documentId === candidate.boundDocument.entityGuid && reading.text === candidate.boundDocument.crdtText);
			const currentAccount = candidate && this.auth.getCurrentUserForServer(candidate.boundDocument.vaultShare.config.onpremServerId);
			const allowed = this.visible && candidate && bound && currentAccount && candidate.connectionAllowed && candidate.wantsConnection &&
				candidate.boundDocument.vaultShare.wantsConnection && view?.containerEl.isConnected && owner?.hasFocus() &&
				!owner.hidden && !this.blurred.has(owner);
			const changed = this.active?.binding !== candidate || this.active?.surface !== surface;
			if (!allowed || changed) this.clearActive();
			if (allowed) {
				this.active = { binding: candidate, surface };
				candidate.boundDocument.setPresenceActive(surface);
				// Activation may happen after the editor's focus transaction. Capture
				// its actual selection once; Reading never invents an editor caret.
				if (changed && surface === "editor" && view!.editor.hasFocus()) this.captureEditor(candidate);
			}
			const provider = this.observed;
			this.status = !this.visible ? "hidden" : !candidate || !owner?.hasFocus() || this.blurred.has(owner) || owner.hidden ? "idle" :
				!bound || !currentAccount ? "waiting" : !provider?.wsconnected ? "offline" :
				!this.active || provider.awareness.getLocalState() === null ? "waiting" : provider.presence.availability;
			this.updateAction(this.candidate?.hostView);
			for (const listener of this.listeners) { try { listener(); } catch { /* Isolate UI. */ } }
		} finally { this.refreshing = false; }
	}

	private captureEditor(binding: Binding): void {
		const editor = binding.hostView.editor, doc = binding.boundDocument, text = doc.crdtText;
		if (editor.getValue() !== text.toString()) return;
		const selection = editor.listSelections()[0]; if (!selection) return;
		doc._liveProvider.awareness.setLocalStateField("cursor", {
			anchor: Y.createRelativePositionFromTypeIndex(text, editor.posToOffset(selection.anchor)),
			head: Y.createRelativePositionFromTypeIndex(text, editor.posToOffset(selection.head)),
		});
	}
	private updateAction(view?: MarkdownView): void {
		if (view !== this.actionView) {
			this.action?.remove(); this.action = undefined; this.actionView = view;
			if (view) { this.action = view.addAction("users", "Presence controls", () => this.openControls()); this.action.classList.add("relay-presence-action"); }
		}
		if (this.action) {
			setIcon(this.action, this.visible ? "users" : "eye-off");
			this.action.setAttribute("aria-label", "Presence controls. " + this.description);
			this.action.setAttribute("data-presence-status", this.status);
		}
	}
	onunload(): void {
		this.stopped = true; this.clearActive(); this.observe();
		for (const stop of this.windows.values()) stop(); this.windows.clear();
		this.action?.remove(); this.action = undefined; this.actionView = undefined;
		this.listeners.clear(); this.candidate = undefined;
	}
}

class PresenceControls extends Modal {
	constructor(plugin: Plugin, private presence: PresenceController) { super(plugin.app); }
	private stop?: () => void;
	onOpen(): void {
		this.titleEl.setText("Presence");
		const status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		let toggle!: import("obsidian").ToggleComponent;
		new Setting(this.contentEl).setName("Share my presence").setDesc("Show your location and selection in the shared note you are viewing. Turning this off hides your presence; sync and comments stay available.")
			.addToggle(control => { toggle = control; control.setValue(this.presence.visible).onChange(value => { void this.presence.setVisible(value); }); });
		const retry = this.contentEl.createEl("button", { text: "Retry presence" });
		retry.addEventListener("click", () => this.presence.retry());
		const refresh = () => {
			status.setText(this.presence.description); toggle.setValue(this.presence.visible);
			// Obsidian themes can override the browser's [hidden] display rule.
			retry.style.display = this.presence.canRetry ? "" : "none"; retry.disabled = !this.presence.canRetry;
		};
		this.stop = this.presence.onChange(refresh); refresh();
	}
	onClose(): void { this.stop?.(); this.stop = undefined; this.contentEl.empty(); }
}
