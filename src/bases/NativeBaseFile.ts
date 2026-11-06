import { TFile, type Vault } from "obsidian";
import { BASE_CONTENT_LIMIT, copyBaseBytes } from "./BaseContentProtocol";
import { BaseContentFailure } from "./BaseContentTransport";
import { sameBaseBytes, type BaseLocalFile, type BaseSyncLock } from "./BaseSyncRunner";
import type { BaseStoreIdentity } from "./BaseSyncStore";

/** Fatal, BOM-preserving UTF-8 decoding. Never replace malformed bytes with
 * replacement characters just to make a file eligible for native text writes. */
export function baseText(bytes: ArrayBuffer): string {
	const copy = copyBaseBytes(bytes);
	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy);
		if (!sameBaseBytes(new TextEncoder().encode(text).buffer as ArrayBuffer, copy)) throw new Error();
		return text;
	} catch { throw new BaseContentFailure("pause", "base_invalid_utf8"); }
}

/** Vault.process is the host's atomic read/modify/write API. All authorization
 * and identity checks in its callback are synchronous at the write boundary. */
export class NativeBaseFile {
	constructor(private vault: Vault, readonly path: string, private current: () => boolean) {}
	private check(): void { if (!this.current()) throw new BaseContentFailure("pause", "base_context_changed"); }
	async read(): Promise<BaseLocalFile> {
		this.check(); const file = this.vault.getAbstractFileByPath(this.path);
		if (!file) return { bytes: null, identity: null };
		if (!(file instanceof TFile)) throw new BaseContentFailure("pause", "base_path_is_folder");
		if (file.stat.size > BASE_CONTENT_LIMIT) throw new BaseContentFailure("pause", "base_local_too_large");
		const bytes = copyBaseBytes(await this.vault.readBinary(file)); this.check();
		if (file.path !== this.path || this.vault.getAbstractFileByPath(this.path) !== file) throw new BaseContentFailure("pause", "base_context_changed");
		return { bytes, identity: file };
	}
	async replace(before: BaseLocalFile, bytes: ArrayBuffer): Promise<boolean> {
		const text = baseText(bytes); this.check();
		const file = this.vault.getAbstractFileByPath(this.path);
		if (before.bytes === null) {
			if (file) return false;
			try { await this.vault.create(this.path, text); return true; }
			catch (error) { this.check(); if (this.vault.getAbstractFileByPath(this.path)) return false; throw error; }
		}
		if (!(file instanceof TFile) || file !== before.identity) return false;
		// Validate the original encoding too, including the BOM. A different
		// decoding by the host produces a conflict instead of normalization.
		const expected = baseText(before.bytes), changed = new Error("Bases local contents changed");
		try {
			await this.vault.process(file, data => {
				this.check();
				if (file.path !== this.path || this.vault.getAbstractFileByPath(this.path) !== file || data !== expected) throw changed;
				return text;
			}); return true;
		} catch (error) { if (error === changed) return false; throw error; }
	}
}

/** Web Locks coordinate windows and release automatically when their process
 * exits. Without the host primitive, retain work and report unavailable sync. */
export function nativeBaseLock(identity: BaseStoreIdentity, locks: LockManager | null | undefined = window.navigator?.locks): BaseSyncLock {
	// Accounts have separate caches, but the same on-disk file. They must not
	// obtain independent write locks during an account switch.
	const scope = JSON.stringify([identity.vaultId, identity.shareId]);
	return async (entryId, action) => {
		if (!locks) throw new BaseContentFailure("pause", "base_lock_unavailable");
		return locks.request("team-relay-bases:" + scope + ":" + entryId, { mode: "exclusive", ifAvailable: true }, lock => lock ? action() : undefined);
	};
}
