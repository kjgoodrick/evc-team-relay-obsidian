import { baseId } from "./BaseContentProtocol";
import { BaseContentFailure, BaseContentTransport } from "./BaseContentTransport";
import { BASE_REGISTRY_RESPONSE_LIMIT, baseDigest, copyBaseViewIntent, parseBaseRegistry, parseBaseViewPage, parseBaseViewRepairResult,
	type BaseRegistrySnapshot, type BaseViewPage, type BaseViewRepairIntent } from "./BaseRegistryProtocol";

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
		const value = await this.request(this.registryPath(entryId) + "/reconcile", "POST", JSON.stringify(intent.request), BASE_REGISTRY_RESPONSE_LIMIT);
		try { return parseBaseViewRepairResult(value, entryId, intent); }
		catch { throw new BaseContentFailure("pause", "invalid_base_registry_response"); }
	}
	async views(entryId: string, state: "unmatched" | "archived", after?: string): Promise<BaseViewPage> {
		if (!["unmatched", "archived"].includes(state) || after !== undefined && !baseId(after)) throw new BaseContentFailure("reject", "invalid_local_target");
		const value = await this.request(this.registryPath(entryId) + `/views?state=${state}` + (after ? `&after=${after}` : ""), "GET", undefined, BASE_REGISTRY_RESPONSE_LIMIT);
		try { return parseBaseViewPage(value, state, after); }
		catch { throw new BaseContentFailure("pause", "invalid_base_registry_response"); }
	}
}
