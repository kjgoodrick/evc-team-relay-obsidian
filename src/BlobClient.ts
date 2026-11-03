import { ItemKind } from "./ItemKinds";
import type { RelayCredentialCache } from "./RelayCredentialCache";
import type { FileGrant } from "./relay/TokenShapes";
import { ResourceAddress } from "./ResourceAddress";
import type { VaultShare } from "./VaultShare";
import type { AttachmentFile } from "./AttachmentFile";
import { platformFetch } from "./platformFetch";
import { Loggable } from "./logging";

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

	private tokenFor(
		syncFile: AttachmentFile,
		sha256: string,
		contentLength: number,
	): Promise<FileGrant> {
		return this.credentialCache.resolveFileToken(
			ResourceAddress.serialize(syncFile.s3rn),
			sha256,
			syncFile.mimeType,
			contentLength,
			// Read live, not captured at BlobClient construction time -- the
			// folder's onpremServerId can still be unset when the folder
			// (and this BlobClient alongside it) is first constructed.
			this.vaultShare.config.onpremServerId,
		);
	}

	async headFile(syncFile: AttachmentFile): Promise<boolean> {
		if (!syncFile.syncMeta) {
			throw new Error("cannot head file with missing hash");
		}
		const token = await this.tokenFor(syncFile, syncFile.syncMeta.hash, 0);
		const response = await platformFetch(token.baseUrl!, {
			method: "HEAD",
			headers: { Authorization: `Bearer ${token.token}` },
		});
		return response.status === 200;
	}

	async pullFile(syncFile: AttachmentFile): Promise<ArrayBuffer> {
		if (!syncFile.syncMeta) {
			throw new Error("cannot pull file with missing hash");
		}
		const token = await this.tokenFor(syncFile, syncFile.syncMeta.hash, 0);
		const response = await platformFetch(`${token.baseUrl}/download-url`, {
			method: "GET",
			headers: { Authorization: `Bearer ${token.token}` },
		});
		if (response.status === 404) {
			throw new Error(
				`[${this.vaultShare.path}] File is missing: ${syncFile.entityGuid} ${syncFile.syncMeta.hash} ${syncFile.syncMeta.type}`,
			);
		}
		const { downloadUrl } = (await response.json()) as DownloadUrlApiResponse;
		const downloadResponse = await platformFetch(downloadUrl);
		return downloadResponse.arrayBuffer();
	}

	async pushFile(syncFile: AttachmentFile): Promise<void> {
		const content = await syncFile.contentAddressedCache.readBytes();
		const hash = await syncFile.contentAddressedCache.resolveHash();
		this.log("writeFile", hash);
		if (!(content && hash)) {
			throw new Error("invalid caf");
		}
		await this.vaultShare.ensureManagedEntry(syncFile.entryPath, {
			id: syncFile.entityGuid, version: 0, type: ItemKind.File,
			mimetype: syncFile.mimeType, hash, synctime: Date.now(),
		});
		const token = await this.tokenFor(syncFile, hash, content.byteLength);
		const response = await platformFetch(`${token.baseUrl}/upload-url`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token.token}` },
		});
		const body = (await response.json()) as UploadUrlApiResponse;
		if (response.status !== 200) {
			throw new Error(body.error);
		}
		await platformFetch(body.uploadUrl, {
			method: "PUT",
			headers: { "Content-Type": syncFile.mimeType },
			body: content,
		});
	}

	public destroy() {
		this.credentialCache = null as unknown as RelayCredentialCache;
		this.vaultShare = null as unknown as VaultShare;
	}
}
