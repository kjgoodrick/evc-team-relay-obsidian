import { ItemKind } from "../ItemKinds";
import { ResourceAddress, type ResourceAddressType } from "../ResourceAddress";
import { sourceCacheEndpoint, sourceDocumentCache, type SourceDocumentIdentity } from "./source-document-cache";
import { readSourceDocumentRecoveryIdentity } from "./document-recovery-snapshot";

export interface SourceRecoveryScope { hostAppId: string; serverId: string; controlPlaneUrl: string; share: ResourceAddressType }
export interface DiscoveredSourceRecovery { id: string; type: ItemKind.Document | ItemKind.Canvas; cacheName: string; sourceIdentity: string }
export interface SourceRecoveryDiscovery {
	status: "available" | "unsupported" | "unavailable";
	documents: DiscoveredSourceRecovery[];
	unassociated: number;
	unreadable: number;
}

/** Keep every matching generation separate. A catalog without exact identity
 * evidence cannot associate history, and cannot authorize uploading any of it. */
export async function discoverSourceRecovery(scope: SourceRecoveryScope, check = () => {}): Promise<SourceRecoveryDiscovery> {
	const result: SourceRecoveryDiscovery = { status: "available", documents: [], unassociated: 0, unreadable: 0 };
	if (!scope.hostAppId || !scope.serverId || !("folderGuid" in scope.share)) throw new Error("A source recovery scope is required");
	const endpoint = sourceCacheEndpoint(scope.controlPlaneUrl), folder = scope.share.folderGuid;
	check();
	if (typeof indexedDB.databases !== "function") return { ...result, status: "unsupported" };
	let databases: IDBDatabaseInfo[];
	try { databases = await indexedDB.databases(); } catch { check(); return { ...result, status: "unavailable" }; }
	check();
	for (const name of [...new Set(databases.flatMap(db => typeof db.name === "string" && /^relay-source-v1-[a-f0-9]{64}$/.test(db.name) ? [db.name] : []))].sort()) {
		check();
		let stored;
		try { stored = await readSourceDocumentRecoveryIdentity(name); } catch { check(); result.unreadable++; continue; }
		check();
		if (!stored.exists) continue;
		try {
			if (typeof stored.identity !== "string") throw new Error("Missing source identity");
			const value = JSON.parse(stored.identity) as SourceDocumentIdentity & { format: string; version: number };
			if (value?.format !== "team-relay-source-cache" || value.version !== 1 || value.hostAppId !== scope.hostAppId
				|| value.serverId !== scope.serverId || value.controlPlaneUrl !== endpoint) throw new Error("Different source scope");
			const address = ResourceAddress.parse(value.s3rn);
			if (!("folderGuid" in address) || address.folderGuid !== folder
				|| ("relayGuid" in address ? address.relayGuid : undefined) !== ("relayGuid" in scope.share ? scope.share.relayGuid : undefined)) throw new Error("Different shared folder");
			const descriptor = await sourceDocumentCache(value);
			if (descriptor.name !== name || descriptor.identity !== stored.identity) throw new Error("Unverified source identity");
			const id = "documentGuid" in address ? address.documentGuid : "canvasGuid" in address ? address.canvasGuid : undefined;
			if (!id) throw new Error("Not a source document");
			result.documents.push({ id, type: "canvasGuid" in address ? ItemKind.Canvas : ItemKind.Document, cacheName: name, sourceIdentity: stored.identity });
		} catch { result.unassociated++; }
		check();
	}
	return result;
}
