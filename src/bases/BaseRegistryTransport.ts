import { baseId, baseObject } from "./BaseContentProtocol";
import { BaseContentFailure, BaseContentTransport } from "./BaseContentTransport";
import { BASE_REGISTRY_RESPONSE_LIMIT, baseDigest, copyBaseViewIntent, parseBaseRegistry, parseBaseViewPage, parseBaseViewRepairResult,
	type BaseRegistrySnapshot, type BaseViewPage, type BaseViewRepairIntent, type BaseViewRepairStatus } from "./BaseRegistryProtocol";

export class BaseRegistryTransport extends BaseContentTransport {
	private registryPath(entryId: string): string {
		if (!baseId(entryId)) throw new BaseContentFailure("reject", "invalid_local_target");
		return `/v1/collaboration/shares/${this.identity.shareId}/entries/${entryId}/bases`;
	}
	async inspect(entryId: string, digest: string, generation?: string): Promise<BaseRegistrySnapshot> {
		if (!baseDigest(digest) || generation !== undefined && !baseId(generation)) throw new BaseContentFailure("reject", "invalid_local_target");
		const value = await this.request(this.registryPath(entryId) + "/inspect", "POST", JSON.stringify({ content_sha256: digest }), BASE_REGISTRY_RESPONSE_LIMIT);
		try { return parseBaseRegistry(value, entryId, digest, generation); }
		catch { throw new BaseContentFailure("pause", "invalid_base_registry_response"); }
	}
	async reconcile(entryId: string, requested: BaseViewRepairIntent): Promise<BaseRegistrySnapshot> {
		const intent = copyBaseViewIntent(requested);
		const value = await this.request(this.registryPath(entryId) + "/reconcile", "POST", JSON.stringify(intent.request), BASE_REGISTRY_RESPONSE_LIMIT, intent.restoreGeneration ?? null);
		try { return parseBaseViewRepairResult(value, entryId, intent); }
		catch { throw new BaseContentFailure("pause", "invalid_base_registry_response"); }
	}
	async repairStatus(entryId: string, requested: BaseViewRepairIntent): Promise<BaseViewRepairStatus> {
		const intent = copyBaseViewIntent(requested);
		const value = await this.request(this.registryPath(entryId) + "/reconcile/status", "POST", JSON.stringify(intent.request), BASE_REGISTRY_RESPONSE_LIMIT);
		try {
			if (baseObject(value) && value.status === "accepted" && Object.keys(value).length === 2) return { status: "accepted", result: parseBaseViewRepairResult(value.result, entryId, intent) };
			if (baseObject(value) && value.status === "unknown" && Object.keys(value).length === 3 && value.operation_id === intent.request.operation_id && value.entry_id === entryId) return { status: "unknown", operation_id: value.operation_id, entry_id: entryId };
			throw new Error("Invalid saved-view receipt");
		} catch { throw new BaseContentFailure("pause", "invalid_base_registry_response"); }
	}
	async views(entryId: string, state: "unmatched" | "archived", after?: string): Promise<BaseViewPage> {
		if (!["unmatched", "archived"].includes(state) || after !== undefined && !baseId(after)) throw new BaseContentFailure("reject", "invalid_local_target");
		const value = await this.request(this.registryPath(entryId) + `/views?state=${state}` + (after ? `&after=${after}` : ""), "GET", undefined, BASE_REGISTRY_RESPONSE_LIMIT);
		try { return parseBaseViewPage(value, state, after); }
		catch { throw new BaseContentFailure("pause", "invalid_base_registry_response"); }
	}
}
