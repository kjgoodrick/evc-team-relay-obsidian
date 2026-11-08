/**
 * Inbound File Downloader (v1.9)
 *
 * Fetches sync-artifact items from the server files index and writes them
 * to the local vault. Called by InboundSyncPoller when web_content_updated_at bumps.
 */

import { normalizePath, Notice, TFile, Vault } from "obsidian";
import type { FileManager } from "obsidian";
import { dirname, join } from "path-browserify";
import { namedLogger } from "./logging";
import { isTransientRelayFailure } from "./relayRequestErrors";
import { sha256Hex } from "./contentDigest";
import { isNativeSourceWriteHeld, trackNativeDocumentWrite } from "./storage/native-document-writes";
import type { RelayOnPremShareClientManager } from "./RelayOnPremShareClientManager";
import type { WebSyncManager } from "./WebSyncManager";

const log = namedLogger("[InboundFileDownloader]");

/** A file the downloader refused to overwrite because the local content diverged
 * from what we last wrote (user edit, or unknown provenance). Surfaced by
 * `getConflicts()` for the "Team Relay: Show sync conflicts" command. */
export interface SyncConflict {
	shareId: string;
	relativePath: string;
	vaultPath: string;
	localHash: string;
	serverHash: string;
	detectedAt: number;
}

export class InboundFileDownloader {
	private vault: Vault;
	private clientManager: RelayOnPremShareClientManager;
	private webSyncManager: WebSyncManager;

	// Map<shareId, Record<relativePath, sha256>> — last sha256 we wrote per file.
	// Injectable so callers can back it with VaultScopedMap
	// (vault-scoped, persisted) instead of a bare in-memory Map — an in-memory-only
	// manifest resets to empty on every plugin reload, which made the "is this a
	// user edit?" guard below never fire right after a restart. Defaults to a plain
	// Map for callers (incl. tests) that don't need persistence.
	private lastWrittenHash: Map<string, Record<string, string>>;
	// Vault paths currently being written — echo-loop guard for vault "modify" events
	private writingPaths: Set<string> = new Set();

	// Unresolved user-edit/unknown-provenance conflicts, keyed by `${shareId}:${relativePath}`.
	// Deliberately in-memory only (not persisted like lastWrittenHash): a conflict still
	// live after a plugin reload SHOULD surface once more on the next sync pass, that's
	// not a bug. Cleared on resolution (either resolve method below) and on a successful
	// download for the same key (belt-and-braces, in case the file started matching again
	// without going through either resolve path).
	private conflicts: Map<string, SyncConflict> = new Map();

	constructor(
		vault: Vault,
		private readonly fileManager: FileManager,
		clientManager: RelayOnPremShareClientManager,
		webSyncManager: WebSyncManager,
		hashManifestStore: Map<string, Record<string, string>> = new Map(),
	) {
		this.vault = vault;
		this.clientManager = clientManager;
		this.webSyncManager = webSyncManager;
		this.lastWrittenHash = hashManifestStore;
	}

	/**
	 * Returns true while a file is being written by this downloader.
	 * main.ts checks this to suppress outbound sync echo.
	 */
	isInboundWriting(vaultPath: string): boolean {
		return this.writingPaths.has(vaultPath);
	}

	/**
	 * Main entry point — called by InboundSyncPoller when web_content_updated_at bumps.
	 * Resolves the share path, fetches the files index, diffs, and writes new/updated items.
	 * Returns "skipped" when outbound sync is in flight so the poller can retry.
	 */
	async downloadShare(shareId: string, serverId: string): Promise<"ran" | "skipped"> {
		if (this.webSyncManager.isOutboundSyncing) {
			log("Skipping — outbound sync in flight", { shareId });
			return "skipped";
		}

		// Resolve share path (cached by clientManager for 5 min)
		let sharePath: string;
		try {
			const share = await this.clientManager.getShare(serverId, shareId);
			sharePath = share.path;
		} catch (err: unknown) {
			log("Failed to resolve share path", {
				shareId,
				error: err instanceof Error ? err.message : String(err),
			});
			if (isTransientRelayFailure(err)) throw err;
			return "ran";
		}

		let items;
		try {
			items = await this.clientManager.getFilesIndex(serverId, shareId);
		} catch (err: unknown) {
			log("Failed to fetch files index", {
				shareId,
				error: err instanceof Error ? err.message : String(err),
			});
			if (isTransientRelayFailure(err)) throw err;
			return "ran";
		}

		// Filter to sync-artifact type only (server may return all types)
		const syncItems = items.filter(
			(item) => !item.type || item.type === "sync-artifact",
		);

		if (syncItems.length === 0) {
			log("No sync-artifact items in files index", { shareId });
			return "ran";
		}

		const shareManifest = { ...(this.lastWrittenHash.get(shareId) ?? {}) };

		try {
			for (const item of syncItems) {
				await this._downloadItem(item.path, item.sha256, shareId, serverId, sharePath, shareManifest);
			}
		} finally {
			// Keep completed files when a transport failure stops the batch. Its
			// watermark stays unchanged so the next pass retries unfinished files.
			this.lastWrittenHash.set(shareId, shareManifest);
		}
		return "ran";
	}

	private async _downloadItem(
		relativePath: string,
		serverSha256: string,
		shareId: string,
		serverId: string,
		sharePath: string,
		shareManifest: Record<string, string>,
	): Promise<void> {
		const vaultPath = normalizePath(join(sharePath, relativePath));

		// Guard against path traversal: the resolved vault path must stay inside sharePath.
		// A server-supplied relativePath like "../../.obsidian/plugins/evil.js" would resolve
		// outside the share directory after join+normalize — reject it before any I/O.
		const normalizedShare = normalizePath(sharePath);
		if (normalizedShare.length === 0) {
			// sharePath is server-supplied (share.path from clientManager.getShare()); an empty
			// value would otherwise disable the containment check entirely. Fail closed.
			log("Path traversal rejected: empty sharePath", { relativePath, shareId });
			return;
		}
		const withinShare =
			vaultPath === normalizedShare || vaultPath.startsWith(normalizedShare + "/");
		if (!withinShare) {
			log("Path traversal rejected", { relativePath, vaultPath, sharePath });
			return;
		}

		const lastHash = shareManifest[relativePath];

		// Skip if sha256 unchanged since last download
		if (lastHash === serverSha256) {
			return;
		}

		// Guard against overwriting user edits:
		// If the file exists locally, check it against `lastHash` — what we last
		// wrote for this path — regardless of whether `lastHash` is defined. It
		// used to only check `if (lastHash)`, so a manifest with no recorded
		// history for this path (in-memory manifest wiped on every plugin
		// reload, or genuinely never synced before) skipped the check entirely
		// and downloaded straight over whatever was on disk. Now: known history
		// that doesn't match local content -> user edit, skip. No history at all
		// but the local file doesn't match what we're about to write -> unknown
		// provenance, ALSO skip rather than assume it's safe to overwrite.
		const abstractFile = this.vault.getAbstractFileByPath(vaultPath);
		if (abstractFile instanceof TFile) {
			// Only the read + hash computation is I/O that can legitimately fail;
			// the notify-and-skip decision below is not wrapped, so a bug there
			// surfaces as itself instead of being mislabeled a read failure.
			let localHash: string;
			try {
				const localBytes = await this.vault.readBinary(abstractFile);
				localHash = await sha256Hex(localBytes);
			} catch (err: unknown) {
				log("Could not read existing file, skipping to avoid data loss", {
					vaultPath,
					error: err instanceof Error ? err.message : String(err),
				});
				return;
			}
			const expectedHash = lastHash ?? serverSha256;
			if (localHash !== expectedHash) {
				const conflictKey = `${shareId}:${relativePath}`;
				const existing = this.conflicts.get(conflictKey);
				// Dedup: don't re-notify on every sync cycle while neither side of the
				// conflict has moved — that's the "toast stack grows forever" bug. Do
				// re-notify if the local edit changed again, or the server moved (a
				// genuinely new conflict state), so dedup can't silently swallow one.
				const isSameConflictAsLastNotified =
					existing !== undefined &&
					existing.localHash === localHash &&
					existing.serverHash === serverSha256;
				this.conflicts.set(conflictKey, {
					shareId,
					relativePath,
					vaultPath,
					localHash,
					serverHash: serverSha256,
					detectedAt: existing?.detectedAt ?? Date.now(),
				});
				if (isSameConflictAsLastNotified) {
					log("Sync conflict still unresolved, not re-notifying", { vaultPath });
					return;
				}
				log("Skipping user-edited (or unknown-provenance) file", {
					vaultPath,
					localHash,
					lastWritten: lastHash ?? "(none recorded)",
					serverHash: serverSha256,
				});
				new Notice(
					`Team Relay: skipped syncing "${relativePath}" — local changes ` +
						`would have been overwritten by the relay version. Run ` +
						`"Team Relay: Show sync conflicts" to resolve.`,
					8000,
				);
				return;
			}
		}
		// Reaching here means we're about to download: either the local file is
		// gone (deleted manually, or via resolveTakeServer()) or its content now
		// matches what we expected. Either way any previously-tracked conflict
		// for this path is stale — drop it so getConflicts() doesn't list a file
		// that's no longer actually in conflict.
		this.conflicts.delete(`${shareId}:${relativePath}`);

		// Download
		let content: ArrayBuffer;
		try {
			content = await this.clientManager.downloadFile(serverId, shareId, relativePath);
		} catch (err: unknown) {
			log("Failed to download file", {
				vaultPath,
				error: err instanceof Error ? err.message : String(err),
			});
			if (isTransientRelayFailure(err)) throw err;
			return;
		}

		// Ensure parent directory exists
		const parentDir = normalizePath(dirname(vaultPath));
		if (parentDir && parentDir !== "." && parentDir !== "/") {
			try {
				await trackNativeDocumentWrite(this.vault, parentDir, () => this.vault.adapter.mkdir(parentDir));
			} catch (error) {
				if (isNativeSourceWriteHeld(error)) throw error;
				// Directory may already exist
			}
		}

		// Write to vault with echo-loop guard
		this.writingPaths.add(vaultPath);
		try {
			await trackNativeDocumentWrite(this.vault, vaultPath, () => this.vault.adapter.writeBinary(vaultPath, content));
			shareManifest[relativePath] = serverSha256;
			log("Wrote sync-artifact to vault", { vaultPath, sha256: serverSha256 });
		} catch (err: unknown) {
			log("Failed to write file to vault", {
				vaultPath,
				error: err instanceof Error ? err.message : String(err),
			});
			// Keep the poller's watermark unchanged so recovery pauses retry.
			if (isNativeSourceWriteHeld(err)) throw err;
		} finally {
			this.writingPaths.delete(vaultPath);
		}
	}

	/** All currently-unresolved sync conflicts, for the "Show sync conflicts" command. */
	getConflicts(): SyncConflict[] {
		return Array.from(this.conflicts.values());
	}

	/**
	 * Resolve a conflict by taking the server version: trash the local file so the
	 * next `downloadShare()` pass finds no local content to guard and writes the
	 * server copy fresh. Mirrors the manual recipe this bug's report used to fix
	 * the one already-live conflict by hand.
	 */
	async resolveTakeServer(shareId: string, relativePath: string): Promise<void> {
		const key = `${shareId}:${relativePath}`;
		const conflict = this.conflicts.get(key);
		if (!conflict) return;
		const abstractFile = this.vault.getAbstractFileByPath(conflict.vaultPath);
		if (abstractFile instanceof TFile) {
			await trackNativeDocumentWrite(this.vault, abstractFile.path, () => this.fileManager.trashFile(abstractFile));
		}
		this.conflicts.delete(key);
	}

	/**
	 * Resolve a conflict by keeping the local version: record the server's hash as
	 * if we'd already written it, WITHOUT touching the local file. The guard above
	 * short-circuits on `lastHash === serverSha256` before it ever reads the file
	 * again, so this stops the nagging without overwriting anything — and because
	 * it only acknowledges today's server hash, a later server-side change is a
	 * new mismatch and correctly re-surfaces as a fresh conflict.
	 */
	resolveKeepLocal(shareId: string, relativePath: string): void {
		const key = `${shareId}:${relativePath}`;
		const conflict = this.conflicts.get(key);
		if (!conflict) return;
		const shareManifest = this.lastWrittenHash.get(shareId) ?? {};
		shareManifest[relativePath] = conflict.serverHash;
		this.lastWrittenHash.set(shareId, shareManifest);
		this.conflicts.delete(key);
	}

	destroy(): void {
		// Deliberately does NOT clear lastWrittenHash: when
		// backed by a persisted store, wiping it here on every plugin
		// unload/reload would defeat the entire point of persisting it. Only
		// transient in-flight-write tracking is reset.
		this.writingPaths.clear();
		log("InboundFileDownloader destroyed");
	}
}
