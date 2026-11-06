import { Component, Notice, TFile, TFolder, normalizePath, type Plugin } from "obsidian";
import type { AuthSession } from "../AuthSession";
import { isAttachmentFile, type AttachmentFile } from "../AttachmentFile";
import { ItemKind, type ItemRecord } from "../ItemKinds";
import type { ShareRegistry, VaultShare } from "../VaultShare";
import type { RelayOnPremSettings } from "../RelayOnPremConfig";
import type { SettingsScope } from "../SettingsPersistence";
import { RECOVERY_FOLDER, isConflictCopyPath } from "../conflictCopyPath";
import { baseId, basePath, encodeBaseBytes, retiredBaseEntries } from "./BaseContentProtocol";
import { BaseContentFailure, BaseContentTransport } from "./BaseContentTransport";
import { BaseSyncStore, type BaseSyncRecord, type BaseStoreIdentity } from "./BaseSyncStore";
import { BaseSyncRunner, sameBaseBytes, type BaseConflictReview, type BaseSyncAccess } from "./BaseSyncRunner";
import { NativeBaseFile, nativeBaseLock } from "./NativeBaseFile";
import { BaseSyncModal } from "./BaseSyncModal";
import { BaseRetirementController, type BaseRetirementReview } from "./BaseRetirement";
import { BaseRestorationController, type BaseRestoreReview } from "./BaseRestoration";
import { BaseRegistryTransport } from "./BaseRegistryTransport";
import { BaseRegistryStore } from "./BaseRegistryStore";
import { BaseViewsController, type BaseViewsAccess, type BaseViewsSource } from "./BaseViewsController";
import { BaseViewsModal } from "./BaseViewsModal";
import type { BaseRegistrySnapshot, BaseViewRepair } from "./BaseRegistryProtocol";

export interface BaseSyncDelegate { sync(file: AttachmentFile): Promise<void>; open(): void }
export interface BaseSyncRow { entryId: string; path: string; message: string; record: BaseSyncRecord; file?: AttachmentFile }
interface EntryRun { fingerprint: string; retryAt: number; failures: number; message: string; pending?: Promise<void> }
interface Slot {
	folder: VaultShare; key: string; current(): boolean; cancelled: boolean; store?: BaseSyncStore; runner?: BaseSyncRunner;
	ready: Promise<void>; failed: boolean; entries: Map<string, EntryRun>; unsubscribe(): void; delegate: BaseSyncDelegate;
	retirements?: BaseRetirementController; retirementRuns: Map<string, { retryAt: number; message: string }>;
	restorations?: BaseRestorationController;
	viewTransport?: BaseRegistryTransport; views?: BaseViewsController; viewsReady?: Promise<void>;
}

export function baseSyncMessage(error: unknown, retryMessage = "Bases sync will retry when the server is available."): string {
	if (!(error instanceof BaseContentFailure)) return error instanceof Error ? error.message : "Bases sync could not finish. Local edits are retained.";
	const messages: Record<string, string> = {
		base_context_changed: "Bases sync paused because the account, file or permissions changed.",
		base_review_changed: "A copy changed after you opened this review. Refresh the review before choosing.",
		base_editor_required: "Editing permission is required to publish this Bases file. Local edits are retained.",
		base_content_disabled: "Bases sync is not enabled on this server.",
		base_content_protocol_required: "This server needs an update before it can sync Bases safely.",
		base_lock_unavailable: "This version of Obsidian cannot coordinate Bases writes. Local edits are retained.",
		base_invalid_utf8: "This Bases file is not valid UTF-8. Export the retained copies before repairing it.",
		base_local_too_large: "This Bases file exceeds the 256 KiB sync limit. Local edits are retained.",
		base_content_too_large: "This Bases file exceeds the 256 KiB sync limit. Local edits are retained.",
		base_entry_retired: "This Bases file was removed on the server. Review its retained local copies.",
		bases_registry_disabled: "Saved-view associations are not enabled on this server.",
		base_definition_not_synced: "Synchronize this Bases definition before reviewing saved-view associations.",
		invalid_base_definition: "This Bases definition cannot be inspected. Review its syntax and supported configuration limits.",
		stale_base_revision: "Saved-view associations changed. Refresh before choosing a repair.",
		invalid_base_registry_response: "The server returned an unsupported saved-view mapping. Existing mappings and pending work are retained.",
	};
	return messages[error.code] ?? (error.action === "retry" ? retryMessage :
		error.action === "authenticate" ? "Sign in to this shared folder’s server to resume Bases sync." : "Bases sync needs review. Local edits are retained.");
}

/** Native lifecycle owner. The regular attachment entry points delegate here;
 * no guarded file uses timestamp arbitration or the generic blob upload path. */
export class BaseSyncHost extends Component {
	private slots = new Map<VaultShare, Slot>();
	private stopped = false;
	private running = 0;
	private listeners = new Set<(reset: boolean) => void>();
	onChange(listener: (reset: boolean) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private notify(reset = false): void { for (const listener of this.listeners) { try { listener(reset); } catch { /* Isolate UI failures. */ } } }
	constructor(private plugin: Plugin, private auth: AuthSession, private shares: ShareRegistry,
		private settings: SettingsScope<RelayOnPremSettings>, private vaultId: string) { super(); }
	onload(): void {
		this.register(this.auth.on(() => this.reconcile()));
		this.register(this.auth.onTokenRefreshed(() => { this.reconcile(); this.wake(); }));
		this.register(this.shares.on(() => this.reconcile()));
		this.register(this.settings.subscribe(() => this.reconcile()));
		this.registerInterval(window.setInterval(() => this.scan(), 1000));
		this.registerDomEvent(window, "online", () => this.wake());
		this.registerEvent(this.plugin.app.vault.on("modify", file => this.changed(file.path)));
		this.registerEvent(this.plugin.app.vault.on("create", file => this.changed(file.path)));
		this.registerEvent(this.plugin.app.vault.on("rename", (file, old) => { this.changed(old); this.changed(file.path); }));
		this.registerEvent(this.plugin.app.workspace.on("file-menu", (menu, file) => {
			const folder = this.shares.shareFor(file.path);
			if (file instanceof TFile && folder?.usesBaseSync(folder.toVirtualPath(file.path), folder.folderIndex.guidFor(folder.toVirtualPath(file.path)))) {
				menu.addItem(item => item.setTitle("Review Bases sync").setIcon("table").onClick(() => folder.basesSync?.open()));
				const entry = folder.trackedEntries.get(folder.folderIndex.guidFor(folder.toVirtualPath(file.path)) ?? "");
				if (file.extension.toLowerCase() === "base" && entry && isAttachmentFile(entry)) menu.addItem(item => item.setTitle("Review Bases views").setIcon("list").onClick(() => new BaseViewsModal(this.plugin.app, this, folder, entry).open()));
			}
		}));
		this.reconcile();
	}
	private reconcile(): void {
		if (this.stopped) return;
		const configuration = this.settings.readValue(), wanted = new Set<VaultShare>();
		for (const folder of this.shares.toArray()) {
			wanted.add(folder);
			const server = configuration.enabled ? configuration.servers.find(s => s.id === folder.config.onpremServerId) : undefined;
			const provider = server ? this.auth.getAuthProviderForServer(server.id) : undefined;
			const account = provider?.isLoggedIn() ? provider.getCurrentUser() : undefined;
			const key = JSON.stringify([server?.id, server?.controlPlaneUrl, account?.id]);
			if (this.slots.get(folder)?.key === key) continue;
			const old = this.slots.get(folder); if (old) this.cancel(old);
			const slot: Slot = { folder, key, cancelled: false, failed: false, ready: Promise.resolve(), entries: new Map(), retirementRuns: new Map(),
				current: () => false, unsubscribe: () => {}, delegate: { sync: file => this.sync(slot, file), open: () => new BaseSyncModal(this.plugin.app, this, folder).open() } };
			this.slots.set(folder, slot); folder.basesSync = slot.delegate;
			if (!server || !account || !baseId(account.id) || !baseId(folder.entityGuid)) continue;
			const serverId = server.id, accountId = account.id, endpoint = server.controlPlaneUrl;
			slot.current = () => {
				try { return !this.stopped && !slot.cancelled && this.shares.toArray().includes(folder) && folder.config.onpremServerId === serverId &&
					this.settings.readValue().enabled && this.settings.readValue().servers.some(s => s.id === serverId && s.controlPlaneUrl === endpoint) &&
					!!this.auth.getAuthProviderForServer(serverId)?.isLoggedIn() && this.auth.getAuthProviderForServer(serverId)?.getCurrentUser()?.id === accountId;
				} catch { return false; }
			};
			let transport: BaseContentTransport;
			const credential = async () => {
				if (!slot.current()) return undefined;
				const accessToken = await this.auth.getAuthProviderForServer(serverId)?.getValidToken();
				return slot.current() && accessToken ? { accountId, accessToken } : undefined;
			};
			try {
				transport = new BaseContentTransport({ serverId: endpoint, accountId, shareId: folder.entityGuid }, credential);
				slot.viewTransport = new BaseRegistryTransport(transport.identity, credential);
			} catch { slot.failed = true; continue; }
			slot.ready = BaseSyncStore.open({ ...transport.identity, vaultId: this.vaultId }).then(store => {
				if (!slot.current()) { store.close(); return; }
				const lock = nativeBaseLock(store.identity);
				slot.retirements = new BaseRetirementController(store, this.plugin.app.vault, {
					current: (entryId, path) => this.retiredCurrent(slot, entryId, path),
					absolute: path => folder.absolutePath(path),
					refresh: async () => { if (!slot.current()) throw new BaseContentFailure("pause", "base_context_changed"); await folder._liveProvider?.managedIndex?.flush(); },
				}, lock);
				slot.restorations = new BaseRestorationController(store, this.plugin.app.vault, {
					current: (entryId, path) => this.retiredVisible(slot, entryId, path),
					absolute: path => folder.absolutePath(path),
					localSource: record => record.retirement?.move?.state === "complete" ? record.retirement.move.path :
						record.retirement && this.retiredCurrent(slot, record.entryId, record.retirement.path) ? folder.absolutePath(record.retirement.path) : undefined,
					refresh: async () => { if (!slot.current()) throw new BaseContentFailure("pause", "base_context_changed"); await folder._liveProvider?.managedIndex?.flush(); },
					destination: path => this.restoreDestination(slot, path),
				}, lock);
				slot.store = store; slot.runner = new BaseSyncRunner(store, {
					read: entryId => transport.read(entryId),
					publish: async (entryId, pending) => {
						const accepted = await transport.publish(entryId, pending);
						if (slot.current()) await folder._liveProvider?.managedIndex?.acknowledgeBaseContent(pending.expected, accepted.state);
						return accepted;
					},
					withdraw: async (entryId, pending) => {
						const receipt = await transport.withdraw(entryId, pending);
						if (receipt.status === "accepted" && slot.current()) await folder._liveProvider?.managedIndex?.acknowledgeBaseContent(pending.expected, receipt.result.state);
						return receipt;
					},
				}, lock); this.scan();
			}).catch(() => { slot.failed = true; });
			const unsubscribe = folder.attachmentSettings.subscribe(() => this.scan());
			slot.unsubscribe = unsubscribe;
		}
		for (const [folder, slot] of this.slots) if (!wanted.has(folder)) { this.cancel(slot); this.slots.delete(folder); }
		this.notify(true); this.scan();
	}
	private cancel(slot: Slot): void {
		slot.cancelled = true; slot.unsubscribe(); slot.store?.close(); slot.views?.store.close();
		if (slot.folder.basesSync === slot.delegate) slot.folder.basesSync = undefined;
	}
	onunload(): void { this.stopped = true; for (const slot of this.slots.values()) this.cancel(slot); this.slots.clear(); this.notify(true); this.listeners.clear(); }
	private wake(): void { for (const slot of this.slots.values()) for (const entry of slot.entries.values()) entry.retryAt = 0; this.scan(); }
	private changed(path: string): void {
		const folder = this.shares.shareFor(path), slot = folder ? this.slots.get(folder) : undefined;
		if (!folder || !slot) return;
		const id = folder.folderIndex.guidFor(folder.toVirtualPath(path)), state = id ? slot.entries.get(id) : undefined;
		if (state) state.fingerprint = "";
		this.scan();
	}
	private enabled(slot: Slot): boolean {
		return slot.current() && slot.folder.wantsConnection && slot.folder.isOnline && slot.folder.attachmentSettings.readValue().bases === true;
	}
	private retiredCurrent(slot: Slot, entryId: string, path: string): boolean {
		const folder = slot.folder, index = folder._liveProvider?.managedIndex, localId = folder.folderIndex.guidFor(path);
		return this.enabled(slot) && !!index && index.snapshot.base_content?.protocol_version === 1 && index.snapshot.base_content.recovery === true &&
			retiredBaseEntries(index.snapshot).some(([id, oldPath]) => id === entryId && oldPath === path) && !index.snapshot.records[path] &&
			!Object.values(index.snapshot.records).some(record => record.id === entryId) && (!localId || localId === entryId) &&
			!folder.isRecoveringStructure && !folder.isDeletePending(path) && !index.isBlocked(path, entryId);
	}
	private retiredVisible(slot: Slot, entryId: string, path: string): boolean {
		const manifest = slot.folder._liveProvider?.managedIndex?.snapshot;
		return this.enabled(slot) && manifest?.base_content?.protocol_version === 1 && manifest.base_content.recovery === true &&
			retiredBaseEntries(manifest).some(([id, former]) => id === entryId && former === path) &&
			!Object.values(manifest.records).some(record => record.id === entryId);
	}
	private async restoreDestination(slot: Slot, path: string): Promise<void> {
		const folder = slot.folder, index = folder._liveProvider?.managedIndex;
		const check = () => {
			if (!basePath(path) || !path.toLowerCase().endsWith(".base") || isConflictCopyPath(folder.absolutePath(path))) throw new Error("Choose a new .base path inside the shared folder.");
			if (!this.enabled(slot) || !index || folder._liveProvider?.managedIndex !== index || folder.isRecoveringStructure ||
				index.snapshot.base_content?.enabled !== true || index.isBlocked(path) || folder.isDeletePending(path)) throw new BaseContentFailure("pause", "base_context_changed");
			const folded = path.toLowerCase();
			if (folder.folderIndex.guidFor(path) || Object.entries(index.snapshot.records).some(([name, record]) => {
				const existing = name.toLowerCase();
				return existing === folded || existing.startsWith(folded + "/") || record.type !== ItemKind.Folder && folded.startsWith(existing + "/");
			})) throw new Error("That destination is already tracked or occupied. Choose another name.");
		};
		check(); await index!.flush(); check();
		const allowed = await index!.publishablePaths([path]); check();
		if (!allowed.has(path)) throw new BaseContentFailure("pause", "base_editor_required");
	}
	private scanRetired(slot: Slot): void {
		if (!slot.retirements || this.running >= 2) return;
		const candidate = retiredBaseEntries(slot.folder._liveProvider?.managedIndex?.snapshot ?? {}).find(([id, path]) =>
			this.retiredCurrent(slot, id, path) && (slot.retirementRuns.get(id)?.retryAt ?? 0) <= Date.now());
		if (!candidate) return;
		const [id, path] = candidate, state = { retryAt: Infinity, message: "" };
		slot.retirementRuns.set(id, state); this.running++;
		void slot.retirements.observe(id, path).then(changed => {
			if (changed === undefined) state.retryAt = Date.now() + 2000;
			if (changed && slot.current()) this.notify();
		}).catch(error => {
			state.message = baseSyncMessage(error); state.retryAt = Date.now() + 30_000;
		}).finally(() => { this.running--; });
	}
	private scan(): void {
		if (this.stopped || this.running >= 2) return;
		for (const slot of this.slots.values()) {
			if (!slot.runner || !this.enabled(slot)) continue;
			this.scanRetired(slot);
			const retired = new Set(retiredBaseEntries(slot.folder._liveProvider?.managedIndex?.snapshot ?? {}).map(([id]) => id));
			for (const file of slot.folder.trackedEntries.values()) {
				if (this.running >= 2) return;
				if (isAttachmentFile(file) && !retired.has(file.entityGuid) && slot.folder.usesBaseSync(file.path, file.entityGuid)) void this.sync(slot, file).catch(() => {});
			}
		}
	}
	private fingerprint(slot: Slot, file: AttachmentFile): string {
		const local = this.plugin.app.vault.getAbstractFileByPath(slot.folder.absolutePath(file.path));
		const manifest = slot.folder._liveProvider?.managedIndex?.snapshot;
		const capability = manifest?.base_content;
		return JSON.stringify([file.path, local instanceof TFile ? local.stat : null, manifest?.records[file.path],
			capability?.protocol_version, capability?.enabled, capability?.recovery, capability?.versions?.[file.entityGuid],
			manifest?.permissions[file.path], manifest?.owner, slot.folder.isRecoveringStructure, slot.folder._liveProvider?.managedIndex?.isBlocked(file.path, file.entityGuid)]);
	}
	private async sync(slot: Slot, file: AttachmentFile): Promise<void> {
		if (!this.enabled(slot)) { file.lastUploadError = "Bases sync is paused. Enable it in this shared folder’s settings and connect to its server."; return; }
		await slot.ready;
		if (!slot.current()) return;
		if (!slot.runner) throw new Error("Bases local storage could not open. Restart the plugin after checking available storage.");
		const fingerprint = this.fingerprint(slot, file), previous = slot.entries.get(file.entityGuid);
		if (previous?.pending) return previous.pending;
		if (previous?.fingerprint === fingerprint && previous.retryAt > Date.now()) return;
		if (this.running >= 2) return;
		const state: EntryRun = previous ?? { fingerprint: "", retryAt: 0, failures: 0, message: "" };
		slot.entries.set(file.entityGuid, state); state.fingerprint = fingerprint; this.running++;
		state.pending = this.perform(slot, file).then(result => {
			state.failures = 0; state.retryAt = result === "busy" || result === "waiting" ? Date.now() + 2000 : Infinity;
			state.message = result === "conflict" ? "Bases edits need review. Both copies are retained." : result === "busy" ? "Bases sync is waiting for another window." : "";
		}).catch(error => {
			state.failures++; state.message = baseSyncMessage(error);
			state.retryAt = error instanceof BaseContentFailure && (error.action === "retry" || error.code === "base_context_changed")
				? Date.now() + Math.max(error.retryAfterMs ?? 0, Math.min(60_000, 1000 * 2 ** Math.min(state.failures, 6))) : Infinity;
		}).finally(() => {
			if (slot.current() && slot.entries.get(file.entityGuid) === state) { file.lastUploadError = state.message || undefined; file.notifySubscribers(); }
			state.pending = undefined; this.running--; this.notify();
		});
		return state.pending;
	}
	private access(slot: Slot, file: AttachmentFile, recovery = false, allowUnclaimed = false): BaseSyncAccess {
		const folder = slot.folder, path = file.path, entryId = file.entityGuid, absolute = normalizePath(folder.absolutePath(path));
		const current = () => slot.current() && folder.wantsConnection && folder.isOnline && !!folder._liveProvider?.managedIndex &&
			(recovery || folder.attachmentSettings.readValue().bases === true) && !folder.isRecoveringStructure && !folder.isDeletePending(path) &&
			file.vaultShare === folder && file.path === path && file.entityGuid === entryId && normalizePath(folder.absolutePath(path)) === absolute &&
			folder.trackedEntries.get(entryId) === file && folder.folderIndex.guidFor(path) === entryId && !folder._liveProvider?.managedIndex?.isBlocked(path, entryId) &&
			(allowUnclaimed && !folder._liveProvider.managedIndex.snapshot.records[path] || folder._liveProvider.managedIndex.registered(path, entryId) &&
				(folder._liveProvider.managedIndex.snapshot.owner || ["read", "write"].includes(folder._liveProvider.managedIndex.snapshot.permissions[path])));
		const native = new NativeBaseFile(this.plugin.app.vault, absolute, current);
		return { path, current, writable: () => current() && folder.canWriteManagedPath(path), canInitialize: false,
			read: () => native.read(), replace: (before, bytes) => native.replace(before, bytes) };
	}
	private async perform(slot: Slot, file: AttachmentFile) {
		file.guardedBase = true;
		const folder = slot.folder, index = folder._liveProvider?.managedIndex;
		const retired = () => !!index && retiredBaseEntries(index.snapshot).some(([id]) => id === file.entityGuid);
		if (retired()) throw new BaseContentFailure("pause", "base_entry_retired");
		const capability = index?.snapshot.base_content;
		if (!index || capability?.protocol_version !== 1 || capability.recovery !== true) throw new BaseContentFailure("pause", "base_content_protocol_required");
		if (!capability.enabled) throw new BaseContentFailure("pause", "base_content_disabled");
		let access = this.access(slot, file, false, true); if (!access.current()) throw new BaseContentFailure("pause", "base_context_changed");
		// Publish already-staged structural changes before content arbitration.
		await index.flush();
		if (retired()) throw new BaseContentFailure("pause", "base_entry_retired");
		if (!access.current()) throw new BaseContentFailure("pause", "base_context_changed");
		let initialized = false;
		if (!index.registered(file.path, file.entityGuid) || !index.snapshot.records[file.path]?.hash && access.writable()) {
			const record = { id: file.entityGuid, version: 0, type: ItemKind.File } as ItemRecord;
			if (!await index.claim(file.path, record)) throw new BaseContentFailure("pause", "base_context_changed");
			initialized = true;
		}
		access = this.access(slot, file); access.canInitialize = initialized;
		const result = await slot.runner!.sync(file.entityGuid, access);
		if (slot.current()) await index.flush();
		return result;
	}
	private async requireSlot(folder: VaultShare): Promise<Slot> {
		const slot = this.slots.get(folder); if (!slot?.current()) throw new Error("Sign in to this shared folder’s server to review Bases sync.");
		await slot.ready; if (!slot.current() || !slot.store || !slot.runner) throw new Error("Bases local storage is unavailable."); return slot;
	}
	private async requireViews(folder: VaultShare): Promise<Slot & { views: BaseViewsController }> {
		const slot = await this.requireSlot(folder);
		if (!slot.viewsReady) slot.viewsReady = BaseRegistryStore.open(slot.store!.identity).then(store => {
			if (!slot.current()) { store.close(); throw new BaseContentFailure("pause", "base_context_changed"); }
			slot.views = new BaseViewsController(store, slot.viewTransport!, nativeBaseLock(store.identity));
		}).catch(error => { slot.viewsReady = undefined; throw error; });
		await slot.viewsReady;
		if (!slot.current() || !slot.views) throw new BaseContentFailure("pause", "base_context_changed");
		return slot as Slot & { views: BaseViewsController };
	}
	private viewAccess(slot: Slot, file: AttachmentFile): BaseViewsAccess {
		const folder = slot.folder, access = this.access(slot, file, true);
		let captured: { source: BaseViewsSource; file: TFile; mtime: number; size: number } | undefined;
		const current = (source: BaseViewsSource) => access.current() && !!captured && captured.source === source &&
			file.path.toLowerCase().endsWith(".base") && file.path === source.path &&
			folder._liveProvider?.managedIndex?.snapshot.records[source.path]?.hash === source.sha256 &&
			this.plugin.app.vault.getAbstractFileByPath(folder.absolutePath(source.path)) === captured.file &&
			captured.file.stat.mtime === captured.mtime && captured.file.stat.size === captured.size;
		return { current, writable: source => current(source) && access.writable(), read: async () => {
			await folder._liveProvider?.managedIndex?.flush();
			if (!access.current() || !file.path.toLowerCase().endsWith(".base")) throw new BaseContentFailure("pause", "base_context_changed");
			const record = await slot.store!.get(file.entityGuid), baseline = record.baseline;
			if (!baseline?.bytes || !baseline.state.record.hash || record.pending || record.download || record.conflict || record.reviewRequired || record.retirement) throw new Error("Finish synchronizing or reviewing this Bases file before inspecting its saved views.");
			const node = this.plugin.app.vault.getAbstractFileByPath(folder.absolutePath(file.path)), stat = node instanceof TFile ? { ...node.stat } : undefined;
			const local = await access.read();
			if (!sameBaseBytes(local.bytes, baseline.bytes) || !(local.identity instanceof TFile) || local.identity !== node ||
				local.identity.stat.mtime !== stat?.mtime || local.identity.stat.size !== stat.size) throw new Error("The Bases file has local changes. Synchronize them before reviewing saved views.");
			const source = { path: file.path, sha256: baseline.state.record.hash, generation: baseline.state.generation ?? undefined };
			captured = { source, file: local.identity, mtime: local.identity.stat.mtime, size: local.identity.stat.size };
			if (!current(source)) throw new BaseContentFailure("pause", "base_context_changed"); return source;
		} };
	}
	async cachedViews(folder: VaultShare, file: AttachmentFile, offline?: { identity: Readonly<BaseStoreIdentity>; readable(): boolean }) {
		const slot = await this.requireViews(folder);
		const readable = () => {
			const index = folder._liveProvider?.managedIndex;
			if (!slot.current()) return false;
			// An existing inventory's denial always wins. Before an offline folder
			// has a provider, a discussion session may supply its retained read
			// grant, bound to this exact account/server/vault/share cache.
			if (index) return index.registered(file.path, file.entityGuid) && (index.snapshot.owner || ["read", "write"].includes(index.snapshot.permissions[file.path]));
			return !!offline && (["serverId", "accountId", "vaultId", "shareId"] as const).every(key => offline.identity[key] === slot.store!.identity[key]) &&
				folder.folderIndex.guidFor(file.path) === file.entityGuid && offline.readable();
		};
		if (!readable()) throw new BaseContentFailure("pause", "base_context_changed");
		const record = await slot.views.store.get(file.entityGuid);
		if (!readable()) throw new BaseContentFailure("pause", "base_context_changed"); return record;
	}
	async refreshViews(folder: VaultShare, file: AttachmentFile) {
		const slot = await this.requireViews(folder), result = await slot.views.refresh(file.entityGuid, this.viewAccess(slot, file));
		if (!result) throw new Error("Another window is syncing this file. Try again shortly."); return result;
	}
	async savedViewPage(folder: VaultShare, file: AttachmentFile, reviewed: BaseRegistrySnapshot, state: "unmatched" | "archived", after?: string) {
		const slot = await this.requireViews(folder), result = await slot.views.page(file.entityGuid, this.viewAccess(slot, file), reviewed, state, after);
		if (!result) throw new Error("Another window is syncing this file. Try again shortly."); return result;
	}
	async repairViews(folder: VaultShare, file: AttachmentFile, reviewed: BaseRegistrySnapshot, bindings: BaseViewRepair["bindings"], archive: string[]) {
		const slot = await this.requireViews(folder), result = await slot.views.repair(file.entityGuid, this.viewAccess(slot, file), reviewed, bindings, archive);
		if (!result) throw new Error("Another window is syncing this file. Try again shortly."); return result;
	}
	async checkViewRepair(folder: VaultShare, file: AttachmentFile) {
		const slot = await this.requireViews(folder), result = await slot.views.checkDelivery(file.entityGuid, this.viewAccess(slot, file));
		if (!result) throw new Error("Another window is syncing this file. Try again shortly."); return result;
	}
	async rows(folder: VaultShare): Promise<BaseSyncRow[]> {
		const slot = await this.requireSlot(folder), records = new Map<string, BaseSyncRecord>(); let after = "";
		for (;;) { const page = await slot.store!.list(after); for (const record of page) records.set(record.entryId, record); if (page.length < 100) break; after = page[page.length - 1].entryId; }
		for (const file of folder.trackedEntries.values()) if (isAttachmentFile(file) && folder.usesBaseSync(file.path, file.entityGuid) && !records.has(file.entityGuid)) records.set(file.entityGuid, { entryId: file.entityGuid, revision: 0 });
		return [...records.values()].map(record => {
			const entry = folder.trackedEntries.get(record.entryId), file = entry && isAttachmentFile(entry) ? entry : undefined;
			return { entryId: record.entryId, file, record, path: record.retirement?.path ?? file?.path ?? record.pending?.expected.path ?? record.conflict?.remote.state.path ?? record.baseline?.state.path ?? record.entryId,
				message: record.restore ? record.restore.state === "created" ? `Local copy created at ${record.restore.path}. Check that file’s sync status; originals remain retained.` : `Restoration to ${record.restore.path} needs a delivery check. Retained copies are safe.` :
					record.retirement ? record.retirement.move?.state === "complete" ? `Removed from sync. Local recovery: ${record.retirement.move.path}` : "Removed on the server. Review the local file and retain it outside sync." :
					!this.enabled(slot) ? "Bases sync is paused. Saved edits are retained." : slot.retirementRuns.get(record.entryId)?.message || slot.entries.get(record.entryId)?.message ||
					(record.pending ? "A saved edit is awaiting confirmed delivery." : record.conflict || record.reviewRequired ? "Both copies are retained for review." : record.baseline ? "Up to date" : "Waiting for first Bases sync") };
		});
	}
	async reviewRemoval(folder: VaultShare, entryId: string): Promise<BaseRetirementReview> {
		const slot = await this.requireSlot(folder), review = await slot.retirements!.review(entryId);
		if (!review) throw new Error("Another window is syncing this file. Try again shortly."); return review;
	}
	async moveRemoved(folder: VaultShare, entryId: string, reviewed: BaseRetirementReview): Promise<void> {
		const slot = await this.requireSlot(folder), path = await slot.retirements!.move(entryId, reviewed);
		if (!path) throw new Error("Another window is syncing this file. Try again shortly.");
		new Notice(`Removed Bases file retained at ${path}`); this.notify();
	}
	async reviewRestore(folder: VaultShare, entryId: string): Promise<BaseRestoreReview> {
		const slot = await this.requireSlot(folder), review = await slot.restorations!.review(entryId);
		if (!review) throw new Error("Another window is syncing this file. Try again shortly."); return review;
	}
	async restore(folder: VaultShare, entryId: string, review: BaseRestoreReview, key: string, path: string): Promise<void> {
		const slot = await this.requireSlot(folder), restored = await slot.restorations!.restore(entryId, review, key, path);
		if (!restored) throw new Error("Another window is syncing this file. Try again shortly.");
		new Notice(`Local Bases copy created at ${restored}. Check its sync status before sharing.`); this.notify();
	}
	async resumeRestore(folder: VaultShare, entryId: string): Promise<void> {
		const slot = await this.requireSlot(folder), restored = await slot.restorations!.resume(entryId);
		if (!restored) throw new Error("Another window is syncing this file. Try again shortly.");
		new Notice(`Bases copy is present at ${restored}. Check its sync status before sharing.`); this.notify();
	}
	async cancelRestore(folder: VaultShare, entryId: string, revision: number): Promise<void> {
		const slot = await this.requireSlot(folder);
		if (!await slot.restorations!.cancel(entryId, revision)) throw new Error("Another window is syncing this file. Try again shortly.");
		new Notice("Restoration stopped. Existing files and the saved restore copy are retained."); this.notify();
	}
	async retry(folder: VaultShare, file: AttachmentFile): Promise<void> {
		const slot = await this.requireSlot(folder); await slot.entries.get(file.entityGuid)?.pending;
		slot.entries.delete(file.entityGuid); await this.sync(slot, file);
	}
	async review(folder: VaultShare, file: AttachmentFile): Promise<BaseConflictReview> {
		const slot = await this.requireSlot(folder), result = await slot.runner!.review(file.entityGuid, this.access(slot, file, true));
		if (!result) throw new Error("Another window is syncing this file. Try again shortly."); return result;
	}
	async resolve(folder: VaultShare, file: AttachmentFile, reviewed: BaseConflictReview, choice: "local" | "server"): Promise<void> {
		const slot = await this.requireSlot(folder), result = await slot.runner!.resolve(file.entityGuid, this.access(slot, file), reviewed, choice);
		if (result === "busy") throw new Error("Another window is syncing this file. Try again shortly.");
		slot.entries.delete(file.entityGuid); await folder._liveProvider.managedIndex?.flush();
	}
	async withdraw(folder: VaultShare, file: AttachmentFile): Promise<void> {
		const slot = await this.requireSlot(folder), result = await slot.runner!.withdraw(file.entityGuid, this.access(slot, file, true));
		if (result === "busy") throw new Error("Another window is syncing this file. Try again shortly."); slot.entries.delete(file.entityGuid);
	}
	async export(folder: VaultShare, entryId: string): Promise<string> {
		const slot = await this.requireSlot(folder), vault = this.plugin.app.vault;
		let root = vault.getAbstractFileByPath(RECOVERY_FOLDER);
		if (!root) { try { root = await vault.createFolder(RECOVERY_FOLDER); } catch { root = vault.getAbstractFileByPath(RECOVERY_FOLDER); } }
		if (!(root instanceof TFolder)) throw new Error("The local recovery folder is unavailable.");
		const path = `${RECOVERY_FOLDER}/Bases-${crypto.randomUUID()}`; await vault.createFolder(path);
		const write = async (name: string, record: unknown) => {
			if (!slot.current()) throw new Error("Account changed. Export stopped; completed recovery files are retained.");
			await vault.create(`${path}/${name}.json`, JSON.stringify({ format: "team-relay-bases-recovery", version: 1, identity: slot.store!.identity, record },
				(_key, value: unknown) => Object.prototype.toString.call(value) === "[object ArrayBuffer]" ? { encoding: "base64", bytes: encodeBaseBytes(value as ArrayBuffer) } : value, 2));
		};
		// Recovery records are immutable. Revisions select the history that
		// already existed at this captured current record, even if another
		// window appends archives while paginated export is in progress.
		const captured = await slot.store!.get(entryId);
		await write("current", captured); let after = "";
		for (;;) {
			const page = await slot.store!.recoveries(entryId, after, 8);
			for (const recovery of page) if (recovery.record.revision < captured.revision) await write(recovery.id, recovery);
			if (page.length < 8) break; after = page[page.length - 1].id;
		}
		const views = await (await this.requireViews(folder)).views.store.exportRecord(entryId);
		if (views.record.revision) await write("saved-views", views);
		new Notice(`Bases recovery copies saved to ${path}`); return path;
	}
}
