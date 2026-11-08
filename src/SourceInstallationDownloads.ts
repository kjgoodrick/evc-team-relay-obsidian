import type { RelayCredentialCache } from "./RelayCredentialCache";
import { ResourceAddress, RemoteFolderAddress, RemoteDocumentAddress, RemoteCanvasAddress, RemoteFileAddress } from "./ResourceAddress";
import type { ManagedManifest } from "./client/ManagedIndexTransport";
import { same } from "./client/managedRecovery";
import { readManagedSource } from "./client/readManagedSource";
import { readManagedAttachment, type ManagedAttachmentReadOptions } from "./client/readManagedAttachment";
import { readManagedInventory } from "./client/readManagedInventory";
import type { InstallationEntry } from "./SourceInstallationPlan";
import type { SourcePreparationDownloads } from "./SourceInstallationPreparation";
import { sourceCacheEndpoint, sourceInventoryCacheSync, type SourceInventoryIdentity } from "./storage/source-document-cache";

/** Download adapters for the already-reviewed capture. They use fresh read-only
 * credentials, isolated source documents and bounded streams; the active native
 * folder, ordinary sync index and retained editing histories are never opened. */
export function createSourceInstallationDownloads(credentials: RelayCredentialCache, identity: SourceInventoryIdentity,
	snapshot: ManagedManifest, options: Omit<ManagedAttachmentReadOptions, "maxBytes"> = {}): SourcePreparationDownloads {
	const captured = Object.freeze({ ...identity }), descriptor = sourceInventoryCacheSync(captured);
	const parent = ResourceAddress.parse(captured.s3rn), context = credentials.captureDocumentSourceContext(captured.serverId);
	if (!(parent instanceof RemoteFolderAddress) || !context || sourceCacheEndpoint(context.controlPlaneUrl) !== captured.controlPlaneUrl
		|| captured.restoreGeneration === undefined) throw new Error("The installation source is not available on the selected server");
	const text = JSON.stringify(snapshot);
	if (!text || new TextEncoder().encode(text).byteLength > 16 * 1024 * 1024) throw new Error("The captured installation inventory is too large");
	const inventory = JSON.parse(text) as ManagedManifest;
	if (!inventory?.records || typeof inventory.records !== "object" || Array.isArray(inventory.records)
		|| Object.keys(inventory.records).length > 10_000 || inventory.restore_guard !== true || inventory.restore_generation !== captured.restoreGeneration) {
		throw new Error("The captured installation inventory belongs to another source");
	}
	const signal = options.signal, inputCheck = options.check, fetcher = options.fetcher, timeoutMs = options.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid installation download timeout");
	const check = () => {
		if (signal?.aborted) throw Object.assign(new Error("Installation download was cancelled"), { name: "AbortError" });
		context.check(); inputCheck?.();
	};
	const scope = (source: Readonly<SourceInventoryIdentity>) => {
		check(); if (sourceInventoryCacheSync(source).identity !== descriptor.identity) throw new Error("The requested installation source changed");
	};
	const entryRecord = (entry: Readonly<InstallationEntry>, source: Readonly<SourceInventoryIdentity>) => {
		scope(source);
		if (!Object.prototype.hasOwnProperty.call(inventory.records, entry.path) || !same(inventory.records[entry.path], entry.record)) {
			throw new Error("The requested installation entry differs from the captured inventory");
		}
		return inventory.records[entry.path];
	};
	check();
	return {
		source: async (entry, source, maxBytes) => {
			const record = entryRecord(entry, source);
			if (record.type !== "markdown" && record.type !== "canvas") throw new Error("This installation entry is not an editing source");
			const address = record.type === "canvas" ? new RemoteCanvasAddress(parent.relayGuid, parent.folderGuid, record.id)
				: new RemoteDocumentAddress(parent.relayGuid, parent.folderGuid, record.id);
			const preview = await readManagedSource(credentials, ResourceAddress.serialize(address), entry.path, captured.serverId, captured, { check, signal, timeoutMs, maxBytes });
			preview.check(); check(); return new Uint8Array(preview.update);
		},
		attachment: async (entry, source, maxBytes) => {
			const record = entryRecord(entry, source);
			if (["folder", "markdown", "canvas"].includes(record.type) || !record.hash) throw new Error("This installation entry is not a captured attachment revision");
			const address = ResourceAddress.serialize(new RemoteFileAddress(parent.relayGuid, parent.folderGuid, record.id));
			const preview = await readManagedAttachment(credentials, address, record.hash, captured.serverId, captured, { check, signal, timeoutMs, maxBytes, fetcher });
			preview.check(); check(); return preview.content;
		},
		revalidate: async source => {
			scope(source);
			const fresh = await readManagedInventory(credentials, captured.s3rn, captured.serverId, captured, { check, signal, timeoutMs, fetcher });
			check(); return fresh;
		},
	};
}
