import { ItemKind } from "./ItemKinds";
import { sha256Hex } from "./contentDigest";
import { restoreGeneration } from "./collaboration/RestoreGeneration";
import type { RelayCredentialCache } from "./RelayCredentialCache";
import type { FileGrant } from "./relay/TokenShapes";
import { ResourceAddress } from "./ResourceAddress";
import type { VaultShare } from "./VaultShare";
import type { AttachmentFile } from "./AttachmentFile";
import { platformFetch } from "./platformFetch";
import { Loggable } from "./logging";

export interface AttachmentUpload { readonly hash: string; readonly mtime: number; check: () => void }

interface DownloadUrlApiResponse {
	downloadUrl: string;
}
interface UploadUrlApiResponse {
	uploadUrl: string;
	error?: string;
}

/**
 * Talks to the relay's content-addressed blob storage for a shared folder's
 * files: HEAD to check presence, GET a presigned download URL, or POST a
 * presigned upload URL and PUT the bytes there. Every real network call goes
 * through `platformFetch` against the token's `baseUrl` — this class never
 * talks to PocketBase directly.
 */
export class BlobClient extends Loggable {
	private credentialCache: RelayCredentialCache;

	constructor(private vaultShare: VaultShare) {
		super();
		// this class never actually calls PocketBase (every real request
		// below goes through platformFetch against token.baseUrl) — it used to
		// construct one anyway (unconditionally, unguarded by relayOnPrem mode)
		// just to call cancelAllRequests() in destroy(), which is a no-op on a
		// client that never issued a request. Removed rather than gated: unlike
		// AuthSession's PocketBase usage, there was no live behavior here to
		// preserve, just an unused construction that hit the same
		// resolveAuthUrl()==="" trap this task was filed to fix.
		this.credentialCache = vaultShare.credentialCache;
	}

	private capture(syncFile: AttachmentFile) {
		const share = this.vaultShare, cache = this.credentialCache;
		const context = share.captureAttachmentContext(syncFile);
		const address = ResourceAddress.serialize(syncFile.s3rn), mime = syncFile.mimeType;
		const server = share.config.onpremServerId;
		const checkAuth = cache.captureFileContext(address, server);
		const check = () => {
			if (this.vaultShare !== share || this.credentialCache !== cache
				|| ResourceAddress.serialize(syncFile.s3rn) !== address || syncFile.mimeType !== mime) {
				throw new Error("Attachment context changed. Local content is retained.");
			}
			context.check(); checkAuth();
		};
		check();
		return { check, mime, token: async (hash: string, length: number): Promise<FileGrant> => {
			check();
			const token = await cache.resolveFileToken(address, hash, mime, length, server, context.binding);
			check();
			if (context.managed && (restoreGeneration(token.restoreGeneration) !== restoreGeneration(context.binding.restoreGeneration)
				|| (context.binding.restoreGeneration && token.restoreGuard !== true))) {
				throw new Error("This share's restore context changed. Attachment synchronization is paused; local content is retained.");
			}
			return token;
		} };
	}

	async headFile(syncFile: AttachmentFile): Promise<boolean> {
		const transfer = this.capture(syncFile), hash = syncFile.syncMeta?.hash;
		if (!hash) throw new Error("cannot head file with missing hash");
		const token = await transfer.token(hash, 0);
		const response = await platformFetch(token.baseUrl!, { method: "HEAD", headers: { Authorization: `Bearer ${token.token}` } });
		transfer.check();
		if (syncFile.syncMeta?.hash !== hash) throw new Error("Attachment revision changed");
		if (response.status === 404 || response.status === 409) return false;
		if (!response.ok) throw new Error(`Attachment verification failed (${response.status})`);
		return true;
	}

	async pullFile(syncFile: AttachmentFile): Promise<ArrayBuffer> {
		const transfer = this.capture(syncFile), hash = syncFile.syncMeta?.hash;
		if (!hash) throw new Error("cannot pull file with missing hash");
		const check = () => { transfer.check(); if (syncFile.syncMeta?.hash !== hash) throw new Error("Attachment revision changed"); };
		const token = await transfer.token(hash, 0);
		check();
		const response = await platformFetch(`${token.baseUrl}/download-url`, { method: "GET", headers: { Authorization: `Bearer ${token.token}` } });
		check();
		if (!response.ok) throw new Error(`Attachment download unavailable (${response.status})`);
		const { downloadUrl } = (await response.json()) as DownloadUrlApiResponse;
		check();
		if (typeof downloadUrl !== "string" || !downloadUrl) throw new Error("Invalid attachment download response");
		const download = await platformFetch(downloadUrl);
		check();
		if (!download.ok) throw new Error(`Attachment download failed (${download.status})`);
		const bytes = await download.arrayBuffer();
		if (await sha256Hex(bytes) !== hash) throw new Error("Attachment download did not match the requested revision. Local content is retained.");
		check();
		return bytes;
	}

	async pushFile(syncFile: AttachmentFile): Promise<AttachmentUpload> {
		const transfer = this.capture(syncFile), { mtime, ctime, size } = syncFile.stat;
		const check = () => {
			transfer.check();
			const stat = syncFile.stat;
			if (stat.mtime !== mtime || stat.ctime !== ctime || stat.size !== size) throw new Error("Attachment changed during upload. Retry to send the newer content.");
		};
		const { content, hash } = await syncFile.contentAddressedCache.readSnapshot();
		check();
		await this.vaultShare.ensureManagedEntry(syncFile.entryPath, {
			id: syncFile.entityGuid, version: 0, type: ItemKind.File,
			mimetype: transfer.mime, hash, synctime: mtime,
		});
		check();
		const token = await transfer.token(hash, content.byteLength);
		check();
		const response = await platformFetch(`${token.baseUrl}/upload-url`, { method: "POST", headers: { Authorization: `Bearer ${token.token}` } });
		check();
		if (!response.ok) throw new Error(`Attachment upload refused (${response.status})`);
		const body = (await response.json()) as UploadUrlApiResponse;
		check();
		if (typeof body.uploadUrl !== "string" || !body.uploadUrl) throw new Error("Invalid attachment upload response");
		const uploaded = await platformFetch(body.uploadUrl, { method: "PUT", headers: { "Content-Type": transfer.mime }, body: content });
		check();
		if (!uploaded.ok) throw new Error(`Attachment upload failed (${uploaded.status}). Local content is retained.`);
		return { hash, mtime, check };
	}

	public destroy() {
		this.credentialCache = null as unknown as RelayCredentialCache;
		this.vaultShare = null as unknown as VaultShare;
	}
}
