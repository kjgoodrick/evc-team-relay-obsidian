import { platformFetch, type PlatformRequestInit } from "../platformFetch";
import { RelayHttpError, parseRetryAfterMs } from "../relayRequestErrors";
import { baseId, baseObject, copyBasePending, encodeBaseBytes, parseBaseAccepted, parseBaseSnapshot,
	type BaseAccepted, type BasePending, type BaseSnapshot, type BaseWithdrawal, type BaseCommandStatus } from "./BaseContentProtocol";

export interface BaseTransportIdentity { serverId: string; accountId: string; shareId: string }
export type BaseCredential = { accountId: string; accessToken: string } | undefined;
export class BaseContentFailure extends Error {
	constructor(readonly action: "retry" | "authenticate" | "conflict" | "reject" | "pause", readonly code: string,
		readonly status = 0, readonly retryAfterMs?: number) { super(code); this.name = "BaseContentFailure"; }
}
const codes = new Set(["base_content_conflict", "base_content_changed", "base_content_lineage_changed", "base_content_withdrawn",
	"restore_generation_changed",
	"base_content_disabled", "base_content_protocol_required", "base_content_not_synced", "base_content_unavailable",
	"base_content_busy", "base_content_too_large", "invalid_base_content", "base_editor_required", "target_unavailable", "operation_id_conflict",
	"bases_registry_disabled", "base_generation_changed", "base_inspection_busy", "base_definition_unavailable", "base_definition_too_large",
	"base_definition_not_synced", "invalid_base_definition", "base_definition_changed", "stale_base_revision", "incomplete_base_bindings",
	"base_view_unavailable", "base_registry_conflict", "base_registry_unavailable"]);

/** One authenticated attempt. Pending bytes/identity must already be committed
 * locally before publish/withdraw. A timeout never establishes non-acceptance. */
export class BaseContentTransport {
	readonly identity: Readonly<BaseTransportIdentity>;
	constructor(identity: BaseTransportIdentity, private credential: () => Promise<BaseCredential>,
		private fetcher: (url: string, init: PlatformRequestInit) => Promise<Response> = platformFetch,
		private timeoutMs = 20_000) {
		const url = new URL(identity.serverId);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
			!baseId(identity.accountId) || !baseId(identity.shareId) || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 25_000) throw new Error("Invalid Bases transport identity");
		this.identity = Object.freeze({ ...identity, serverId: url.toString().replace(/\/+$/, "") });
	}
	private path(entryId: string): string {
		if (!baseId(entryId)) throw new BaseContentFailure("reject", "invalid_local_target");
		return `/v1/managed/shares/${this.identity.shareId}/entries/${entryId}/base-content`;
	}
	private envelope(pending: BasePending): string {
		return JSON.stringify({ operation_id: pending.operationId, expected: pending.expected, content_base64: encodeBaseBytes(pending.bytes) });
	}
	async read(entryId: string): Promise<BaseSnapshot> {
		const value = await this.request(this.path(entryId), "GET");
		try { return await parseBaseSnapshot(value, entryId); }
		catch { throw new BaseContentFailure("pause", "invalid_base_response"); }
	}
	async publish(entryId: string, pending: BasePending): Promise<BaseAccepted> {
		pending = copyBasePending(pending, entryId);
		const value = await this.request(this.path(entryId), "PUT", this.envelope(pending), undefined, pending.restoreGeneration ?? null);
		try { return await parseBaseAccepted(value, pending, entryId); }
		catch { throw new BaseContentFailure("pause", "invalid_base_response"); }
	}
	async withdraw(entryId: string, pending: BasePending): Promise<BaseWithdrawal> {
		pending = copyBasePending(pending, entryId);
		const value = await this.request(this.path(entryId) + "/withdraw", "POST", this.envelope(pending), undefined, pending.restoreGeneration ?? null);
		try {
			if (baseObject(value) && value.status === "accepted") return { status: "accepted", result: await parseBaseAccepted(value.result, pending, entryId) };
			if (!baseObject(value) || value.status !== "withdrawn" || value.operation_id !== pending.operationId || value.entry_id !== entryId) throw new Error();
			return { status: "withdrawn", operation_id: pending.operationId, entry_id: entryId };
		} catch { throw new BaseContentFailure("pause", "invalid_base_response"); }
	}
	async status(entryId: string, pending: BasePending): Promise<BaseCommandStatus> {
		pending = copyBasePending(pending, entryId);
		const value = await this.request(this.path(entryId) + "/status", "POST", this.envelope(pending));
		try {
			if (!baseObject(value)) throw new Error();
			if (value.status === "accepted" && Object.keys(value).length === 2) return { status: "accepted", result: await parseBaseAccepted(value.result, pending, entryId) };
			if ((value.status !== "unknown" && value.status !== "withdrawn") || Object.keys(value).length !== 3 || value.operation_id !== pending.operationId || value.entry_id !== entryId) throw new Error();
			return { status: value.status, operation_id: pending.operationId, entry_id: entryId };
		} catch { throw new BaseContentFailure("pause", "invalid_base_response"); }
	}
	protected async request(path: string, method: "GET" | "PUT" | "POST", body?: string, responseLimit = method === "GET" ? 360_000 : 16_384, restoreGeneration: string | null = null): Promise<unknown> {
		let timer: number | undefined, ended = false;
		const credentials = async () => {
			let value: BaseCredential;
			try { value = await this.credential(); } catch { throw new BaseContentFailure("authenticate", "credentials_unavailable"); }
			if (ended) throw new BaseContentFailure("retry", "request_timeout");
			if (!value?.accessToken || value.accountId !== this.identity.accountId) throw new BaseContentFailure("authenticate", "account_credentials_required");
			return value;
		};
		const attempt = async () => {
			const credential = await credentials();
			let response: Response;
			try { response = await this.fetcher(this.identity.serverId + path, { method, body, sensitive: true,
				headers: { Authorization: "Bearer " + credential.accessToken, "Content-Type": "application/json",
					...(restoreGeneration === null ? {} : { "X-Relay-Restore-Generation": restoreGeneration }) } }); }
			catch (error) {
				if (error instanceof RelayHttpError) throw new BaseContentFailure("retry", "server_unavailable", error.status, error.retryAfterMs);
				throw new BaseContentFailure("retry", "network_unavailable");
			}
			// Do not deliver an old-account response to a newly selected account.
			await credentials();
			if (response.status === 401) throw new BaseContentFailure("authenticate", "authentication_required", 401);
			if (response.status === 408 || response.status === 429 || response.status >= 500) throw new BaseContentFailure("retry", "server_unavailable", response.status, parseRetryAfterMs(response.headers.get("Retry-After")));
			const limit = response.ok ? responseLimit : 16_384;
			let raw: string;
			try {
				if (response.body) {
					const reader = response.body.getReader(), bytes = new Uint8Array(limit); let offset = 0;
					try {
						for (;;) {
							const part = await reader.read(); if (part.done) break;
							if (offset + part.value.byteLength > limit) throw new BaseContentFailure("pause", "invalid_base_response");
							bytes.set(part.value, offset); offset += part.value.byteLength;
						}
						raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
					} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
				} else {
					raw = await response.text();
					if (new TextEncoder().encode(raw).byteLength > limit) throw new BaseContentFailure("pause", "invalid_base_response");
				}
			} catch (error) { if (error instanceof BaseContentFailure) throw error; throw new BaseContentFailure("retry", "network_unavailable"); }
			let value: unknown;
			try { value = JSON.parse(raw); } catch { throw new BaseContentFailure("pause", "invalid_base_response"); }
			if (!response.ok) {
				const message = baseObject(value) && baseObject(value.error) ? value.error.message : baseObject(value) ? value.detail : undefined;
				const code = baseObject(message) && typeof message.code === "string" && codes.has(message.code) ? message.code : "base_request_rejected";
				if (code === "restore_generation_changed") throw new BaseContentFailure("pause", code, response.status);
				if (["base_content_changed", "base_content_not_synced", "base_content_unavailable", "base_definition_changed", "base_definition_not_synced", "base_definition_unavailable"].includes(code)) throw new BaseContentFailure("retry", code, response.status);
				if (["base_content_conflict", "stale_base_revision", "base_registry_conflict"].includes(code)) throw new BaseContentFailure("conflict", code, response.status);
				if (["base_content_disabled", "base_content_protocol_required", "bases_registry_disabled"].includes(code) || response.status === 404 && code !== "target_unavailable") throw new BaseContentFailure("pause", code, response.status);
				throw new BaseContentFailure("reject", code, response.status);
			}
			await credentials();
			return value;
		};
		try { return await Promise.race([attempt(), new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new BaseContentFailure("retry", "request_timeout")), this.timeoutMs); })]); }
		finally { ended = true; if (timer !== undefined) window.clearTimeout(timer); }
	}
}
