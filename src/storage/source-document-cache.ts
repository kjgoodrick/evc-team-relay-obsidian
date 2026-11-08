import * as Y from "yjs";
import { ResourceAddress } from "../ResourceAddress";
import { restoreGeneration, type RestoreBinding } from "../collaboration/RestoreGeneration";
import { LocalDocumentStore } from "./local-document-store";

export interface SourceCacheIdentity extends RestoreBinding {
	hostAppId: string;
	serverId: string;
	controlPlaneUrl: string;
	s3rn: string;
}
export type SourceDocumentIdentity = SourceCacheIdentity;
export type SourceInventoryIdentity = SourceCacheIdentity;
type CacheKind = "source" | "inventory";
export interface SourceCacheDescriptor { readonly name: string; readonly identity: string }

function addressKind(s3rn: string): CacheKind {
	if (typeof s3rn !== "string" || s3rn.length > 512) throw new Error("Invalid source cache address");
	const address = ResourceAddress.parse(s3rn);
	if (!("folderGuid" in address) || "fileGuid" in address || ResourceAddress.serialize(address) !== s3rn) throw new Error("A canonical source or folder address is required for a source cache");
	return "documentGuid" in address || "canvasGuid" in address ? "source" : "inventory";
}

export function sourceCacheEndpoint(value: string): string {
	if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid source cache endpoint");
	const endpoint = new URL(value);
	if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid source cache endpoint");
	return endpoint.href.replace(/\/+$/, "");
}

/** Stored metadata must agree with the connection selected for this source.
 * A changed server configuration cannot relabel an already loaded history. */
export function assertSourceCacheBinding(metadata: string, s3rn: string, serverId: string, endpoint: string, binding: RestoreBinding): void {
	const value: unknown = JSON.parse(metadata);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid source cache identity");
	const source = value as Record<string, unknown>;
	if (source.format !== `team-relay-${addressKind(s3rn)}-cache` || source.version !== 1 || source.s3rn !== s3rn || source.serverId !== serverId
		|| source.controlPlaneUrl !== sourceCacheEndpoint(endpoint) || source.restoreGeneration !== restoreGeneration(binding.restoreGeneration)) {
		throw new Error("The source cache belongs to another server or restore generation. Local history is retained.");
	}
}

/** No token or transient login session belongs in a durable source identity.
 * Logging in again must not discard offline work. Authorization is checked by
 * the credential layer independently before this history can reach a server. */
async function sourceCache(identity: SourceCacheIdentity, kind: CacheKind): Promise<Readonly<SourceCacheDescriptor>> {
	for (const value of [identity.hostAppId, identity.serverId]) {
		if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error("Invalid source cache identity");
	}
	const endpoint = sourceCacheEndpoint(identity.controlPlaneUrl);
	if (addressKind(identity.s3rn) !== kind) throw new Error(`A canonical ${kind === "inventory" ? "folder" : "document"} address is required for a source cache`);
	const metadata = JSON.stringify({ format: `team-relay-${kind}-cache`, version: 1,
		hostAppId: identity.hostAppId, serverId: identity.serverId,
		controlPlaneUrl: endpoint, s3rn: identity.s3rn,
		restoreGeneration: restoreGeneration(identity.restoreGeneration) });
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(metadata));
	const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
	return Object.freeze({ name: `relay-${kind}-v1-${hash}`, identity: metadata });
}

export async function sourceDocumentCache(identity: SourceDocumentIdentity): Promise<Readonly<SourceCacheDescriptor & { bufferKey: string }>> {
	const descriptor = await sourceCache(identity, "source");
	return Object.freeze({ ...descriptor, bufferKey: descriptor.name });
}

/** Inventories have their own identity format and cannot alias a source history.
 * The transport must also receive this selection; an empty cache is not consent
 * to adopt whichever server generation happens to answer first. */
export async function sourceInventoryCache(identity: SourceInventoryIdentity): Promise<Readonly<SourceCacheDescriptor>> {
	return sourceCache(identity, "inventory");
}

/** Explicit opt-in only: never reads, imports or clears legacy cache/buffer
 * keys. The caller must select a reviewed lineage, not the latest manifest. */
export async function openSourceDocumentCache(identity: SourceDocumentIdentity, doc: Y.Doc): Promise<LocalDocumentStore> {
	return openCache(await sourceDocumentCache(identity), doc);
}

export async function openSourceInventoryCache(identity: SourceInventoryIdentity, doc: Y.Doc): Promise<LocalDocumentStore> {
	return openCache(await sourceInventoryCache(identity), doc);
}

async function openCache(descriptor: SourceCacheDescriptor, doc: Y.Doc): Promise<LocalDocumentStore> {
	if (doc.isDestroyed) throw new Error("Document was closed before its source cache opened");
	const store = new LocalDocumentStore(descriptor.name, doc, descriptor.identity);
	try { await store.whenSynced; return store; }
	catch (error) { await store.close().catch(() => undefined); throw error; }
}
