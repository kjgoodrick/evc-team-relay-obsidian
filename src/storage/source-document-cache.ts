import * as Y from "yjs";
import { ResourceAddress } from "../ResourceAddress";
import { restoreGeneration, type RestoreBinding } from "../collaboration/RestoreGeneration";
import { LocalDocumentStore } from "./local-document-store";

export interface SourceDocumentIdentity extends RestoreBinding {
	hostAppId: string;
	serverId: string;
	controlPlaneUrl: string;
	s3rn: string;
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
	if (source.format !== "team-relay-source-cache" || source.version !== 1 || source.s3rn !== s3rn || source.serverId !== serverId
		|| source.controlPlaneUrl !== sourceCacheEndpoint(endpoint) || source.restoreGeneration !== restoreGeneration(binding.restoreGeneration)) {
		throw new Error("The source cache belongs to another server or restore generation. Local history is retained.");
	}
}

/** No token or transient login session belongs in a durable source identity.
 * Logging in again must not discard offline work. Authorization is checked by
 * the credential layer independently before this history can reach a server. */
export async function sourceDocumentCache(identity: SourceDocumentIdentity): Promise<Readonly<{ name: string; identity: string; bufferKey: string }>> {
	for (const value of [identity.hostAppId, identity.serverId]) {
		if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error("Invalid source cache identity");
	}
	const endpoint = sourceCacheEndpoint(identity.controlPlaneUrl);
	if (typeof identity.s3rn !== "string" || identity.s3rn.length > 512) throw new Error("Invalid source cache address");
	const address = ResourceAddress.parse(identity.s3rn);
	if (!("folderGuid" in address) || !("documentGuid" in address || "canvasGuid" in address)
		|| ResourceAddress.serialize(address) !== identity.s3rn) throw new Error("A canonical document address is required for a source cache");
	const metadata = JSON.stringify({ format: "team-relay-source-cache", version: 1,
		hostAppId: identity.hostAppId, serverId: identity.serverId,
		controlPlaneUrl: endpoint, s3rn: identity.s3rn,
		restoreGeneration: restoreGeneration(identity.restoreGeneration) });
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(metadata));
	const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
	const name = `relay-source-v1-${hash}`;
	return Object.freeze({ name, identity: metadata, bufferKey: name });
}

/** Explicit opt-in only: never reads, imports or clears legacy cache/buffer
 * keys. The caller must select a reviewed lineage, not the latest manifest. */
export async function openSourceDocumentCache(identity: SourceDocumentIdentity, doc: Y.Doc): Promise<LocalDocumentStore> {
	const descriptor = await sourceDocumentCache(identity);
	if (doc.isDestroyed) throw new Error("Document was closed before its source cache opened");
	const store = new LocalDocumentStore(descriptor.name, doc, descriptor.identity);
	try { await store.whenSynced; return store; }
	catch (error) { await store.close().catch(() => undefined); throw error; }
}
