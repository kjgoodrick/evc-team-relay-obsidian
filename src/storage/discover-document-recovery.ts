import { ItemKind } from "../ItemKinds";
import { ResourceAddress, RemoteDocumentAddress, RemoteCanvasAddress, DocumentAddress, CanvasAddress, type ResourceAddressType } from "../ResourceAddress";
import { readDocumentRecoveryIdentity } from "./document-recovery-snapshot";

export interface DiscoveredRecoveryDocument {
	id: string; type: ItemKind.Document | ItemKind.Canvas; cacheName: string; appId: string; s3rn: string;
}
export interface RecoveryCacheDiscovery {
	status: "available" | "unsupported" | "unavailable";
	documents: DiscoveredRecoveryDocument[];
	unassociated: number;
	unreadable: number;
}

/** Catalog access is optional on older hosts. Only a matching host namespace
 * AND exact stored host/share/document address can add an inventory orphan.
 * Legacy cache metadata has no server ID: this is local source-copy evidence,
 * never authorization to resume, import or upload that history. */
export async function discoverDocumentRecovery(hostAppId: string, share: ResourceAddressType, check = () => {}): Promise<RecoveryCacheDiscovery> {
	const result: RecoveryCacheDiscovery = { status: "available", documents: [], unassociated: 0, unreadable: 0 };
	if (!hostAppId || !("folderGuid" in share)) throw new Error("A vault and shared folder are required for recovery discovery");
	const folderGuid = share.folderGuid;
	check();
	if (typeof indexedDB.databases !== "function") return { ...result, status: "unsupported" };
	let databases: IDBDatabaseInfo[];
	try { databases = await indexedDB.databases(); }
	catch { check(); return { ...result, status: "unavailable" }; }
	check();
	const docPrefix = `${hostAppId}-relay-doc-`, canvasPrefix = `${hostAppId}-relay-canvas-`;
	for (const name of [...new Set(databases.flatMap(db => typeof db.name === "string" ? [db.name] : []))].sort()) {
		const type = name.startsWith(docPrefix) ? ItemKind.Document : name.startsWith(canvasPrefix) ? ItemKind.Canvas : null;
		if (!type) continue;
		const id = name.slice(type === ItemKind.Canvas ? canvasPrefix.length : docPrefix.length);
		if (!ResourceAddress.isValidUUID(id)) { result.unassociated++; continue; }
		check();
		let identity;
		try { identity = await readDocumentRecoveryIdentity(name); }
		catch { check(); result.unreadable++; continue; }
		check();
		if (!identity.exists) continue;
		const address = "relayGuid" in share
			? type === ItemKind.Canvas ? new RemoteCanvasAddress(share.relayGuid, folderGuid, id) : new RemoteDocumentAddress(share.relayGuid, folderGuid, id)
			: type === ItemKind.Canvas ? new CanvasAddress(folderGuid, id) : new DocumentAddress(folderGuid, id);
		const s3rn = ResourceAddress.serialize(address);
		if (identity.appId === hostAppId && identity.s3rn === s3rn) result.documents.push({ id, type, cacheName: name, appId: hostAppId, s3rn });
		else result.unassociated++;
	}
	return result;
}
