import { Component, Notice, TFile, TFolder, normalizePath, type Plugin } from "obsidian";
import type { AuthSession } from "../AuthSession";
import { isAttachmentFile, type AttachmentFile } from "../AttachmentFile";
import { ItemKind, type ItemRecord } from "../ItemKinds";
import type { ShareRegistry, VaultShare } from "../VaultShare";
import type { RelayOnPremSettings } from "../RelayOnPremConfig";
import type { SettingsScope } from "../SettingsPersistence";
import { RECOVERY_FOLDER } from "../conflictCopyPath";
import { baseId, encodeBaseBytes } from "./BaseContentProtocol";
import { BaseContentFailure, BaseContentTransport } from "./BaseContentTransport";
import { BaseSyncStore, type BaseSyncRecord } from "./BaseSyncStore";
import { BaseSyncRunner, type BaseConflictReview, type BaseSyncAccess } from "./BaseSyncRunner";
import { NativeBaseFile, nativeBaseLock } from "./NativeBaseFile";
import { BaseSyncModal } from "./BaseSyncModal";

export interface BaseSyncDelegate { sync(file: AttachmentFile): Promise<void>; open(): void }
export interface BaseSyncRow { entryId: string; path: string; message: string; record: BaseSyncRecord; file?: AttachmentFile }
interface EntryRun { fingerprint: string; retryAt: number; failures: number; message: string; pending?: Promise<void> }
interface Slot {
	folder: VaultShare; key: string; current(): boolean; cancelled: boolean; store?: BaseSyncStore; runner?: BaseSyncRunner;
	ready: Promise<void>; failed: boolean; entries: Map<string, EntryRun>; unsubscribe(): void; delegate: BaseSyncDelegate;
}

export function baseSyncMessage(error: unknown): string {
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
	};
	return messages[error.code] ?? (error.action === "retry" ? "Bases sync will retry when the server is available." :
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
			const slot: Slot = { folder, key, cancelled: false, failed: false, ready: Promise.resolve(), entries: new Map(),
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
			try { transport = new BaseContentTransport({ serverId: endpoint, accountId, shareId: folder.entityGuid }, async () => {
				if (!slot.current()) return undefined;
				const accessToken = await this.auth.getAuthProviderForServer(serverId)?.getValidToken();
				return slot.current() && accessToken ? { accountId, accessToken } : undefined;
			}); } catch { slot.failed = true; continue; }
			slot.ready = BaseSyncStore.open({ ...transport.identity, vaultId: this.vaultId }).then(store => {
				if (!slot.current()) { store.close(); return; }
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
				}, nativeBaseLock(store.identity)); this.scan();
			}).catch(() => { slot.failed = true; });
			const unsubscribe = folder.attachmentSettings.subscribe(() => this.scan());
			slot.unsubscribe = unsubscribe;
		}
		for (const [folder, slot] of this.slots) if (!wanted.has(folder)) { this.cancel(slot); this.slots.delete(folder); }
		this.notify(true); this.scan();
	}
	private cancel(slot: Slot): void {
		slot.cancelled = true; slot.unsubscribe(); slot.store?.close();
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
	private scan(): void {
		if (this.stopped || this.running >= 2) return;
		for (const slot of this.slots.values()) {
			if (!slot.runner || !this.enabled(slot)) continue;
			for (const file of slot.folder.trackedEntries.values()) {
				if (this.running >= 2) return;
				if (isAttachmentFile(file) && slot.folder.usesBaseSync(file.path, file.entityGuid)) void this.sync(slot, file).catch(() => {});
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
		const capability = index?.snapshot.base_content;
		if (!index || capability?.protocol_version !== 1 || capability.recovery !== true) throw new BaseContentFailure("pause", "base_content_protocol_required");
		if (!capability.enabled) throw new BaseContentFailure("pause", "base_content_disabled");
		let access = this.access(slot, file, false, true); if (!access.current()) throw new BaseContentFailure("pause", "base_context_changed");
		// Publish already-staged structural changes before content arbitration.
		await index.flush(); if (!access.current()) throw new BaseContentFailure("pause", "base_context_changed");
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
	async rows(folder: VaultShare): Promise<BaseSyncRow[]> {
		const slot = await this.requireSlot(folder), records = new Map<string, BaseSyncRecord>(); let after = "";
		for (;;) { const page = await slot.store!.list(after); for (const record of page) records.set(record.entryId, record); if (page.length < 100) break; after = page[page.length - 1].entryId; }
		for (const file of folder.trackedEntries.values()) if (isAttachmentFile(file) && folder.usesBaseSync(file.path, file.entityGuid) && !records.has(file.entityGuid)) records.set(file.entityGuid, { entryId: file.entityGuid, revision: 0 });
		return [...records.values()].map(record => {
			const entry = folder.trackedEntries.get(record.entryId), file = entry && isAttachmentFile(entry) ? entry : undefined;
			return { entryId: record.entryId, file, record, path: file?.path ?? record.pending?.expected.path ?? record.conflict?.remote.state.path ?? record.baseline?.state.path ?? record.entryId,
				message: !this.enabled(slot) ? "Bases sync is paused. Saved edits are retained." : slot.entries.get(record.entryId)?.message ||
					(record.pending ? "A saved edit is awaiting confirmed delivery." : record.conflict || record.reviewRequired ? "Both copies are retained for review." : "Up to date") };
		});
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
		new Notice(`Bases recovery copies saved to ${path}`); return path;
	}
}
