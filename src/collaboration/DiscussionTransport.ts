import { platformFetch, type PlatformRequestInit } from "../platformFetch";
import { RelayHttpError, parseRetryAfterMs } from "../relayRequestErrors";
import type { Json, QueuedCommand } from "./storage/DiscussionStore";

export type FailureAction = "retry" | "authenticate" | "reject" | "pause";

/** Codes are safe diagnostics; never carry the server's raw response or token. */
export class DiscussionFailure extends Error {
	constructor(readonly action: FailureAction, readonly code: string, readonly status = 0,
		readonly retryAfterMs?: number) { super(code); this.name = "DiscussionFailure"; }
}

export interface DiscussionIdentity { serverId: string; accountId: string; shareId: string }
export interface DiscussionCredential { accountId: string; accessToken: string }
export type CommandResult = {
	operation_id: string; scope_id: string; thread_id: string; sequence: number;
	state: "open" | "resolved"; state_revision: number; removed: boolean; changed: boolean;
	message_id?: string; message_revision?: number; message_deleted?: boolean;
};
export interface DiscussionSender {
	readonly identity: Readonly<DiscussionIdentity>;
	send(operation: QueuedCommand): Promise<CommandResult>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errorCodes = new Set(["target_unavailable", "comment_forbidden", "operation_id_conflict", "identifier_unavailable",
	"stale_message_revision", "stale_thread_revision", "author_required", "moderation_required", "mention_unavailable",
	"too_many_mentions", "invalid_command", "command_too_large", "discussion_preview_disabled"]);
function validId(value: unknown): value is string { return typeof value === "string" && uuid.test(value); }
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

/** Scope IDs in the local queue are managed entry UUIDs, available while offline. */
export function queuedEnvelope(shareId: string, op: QueuedCommand): string {
	const payload = op.payload;
	if (!validId(shareId) || !validId(op.operationId) || !validId(op.scopeId) || !object(payload) ||
		payload.type !== op.type || !validId(payload.thread_id) || !validId(payload.message_id) ||
		!["thread.create", "reply.create", "message.edit", "reaction.set"].includes(op.type)) {
		throw new DiscussionFailure("reject", "invalid_local_command");
	}
	if (op.type === "reply.create" && (payload.reopen !== undefined && payload.reopen !== false ||
		payload.expected_state_revision != null)) throw new DiscussionFailure("reject", "online_command_required");
	let body: string;
	try {
		body = JSON.stringify({ protocol_version: 1, operation_id: op.operationId, share_id: shareId,
			entry_id: op.scopeId, command: payload });
	} catch { throw new DiscussionFailure("reject", "invalid_local_command"); }
	if (new TextEncoder().encode(body).byteLength > 65536) throw new DiscussionFailure("reject", "command_too_large");
	return body;
}

function accepted(value: unknown, op: QueuedCommand): CommandResult {
	const command = op.payload as Record<string, Json>;
	if (!object(value) || value.operation_id !== op.operationId || value.thread_id !== command.thread_id ||
		value.message_id !== command.message_id || !validId(value.scope_id) || !positive(value.sequence) ||
		!positive(value.state_revision) || !positive(value.message_revision) ||
		!["open", "resolved"].includes(String(value.state)) || typeof value.removed !== "boolean" ||
		typeof value.changed !== "boolean" || typeof value.message_deleted !== "boolean") {
		// A mutation may have committed even when a proxy returned invalid data.
		throw new DiscussionFailure("pause", "invalid_command_response");
	}
	// Whitelist fields before saving; avoid persisting arbitrary response content.
	return { operation_id: op.operationId, scope_id: value.scope_id, thread_id: value.thread_id as string,
		sequence: value.sequence, state: value.state as "open" | "resolved", state_revision: value.state_revision,
		removed: value.removed, changed: value.changed, message_id: value.message_id as string,
		message_revision: value.message_revision, message_deleted: value.message_deleted };
}

/** One HTTP attempt. Retry/auth scheduling belongs to the durable outbox worker. */
export class DiscussionTransport implements DiscussionSender {
	readonly identity: Readonly<DiscussionIdentity>;
	private readonly endpoint: string;
	constructor(identity: DiscussionIdentity, private credential: () => Promise<DiscussionCredential | undefined>,
		private fetcher: (url: string, init: PlatformRequestInit) => Promise<Response> = platformFetch,
		private timeoutMs = 20_000) {
		const url = new URL(identity.serverId);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
			!validId(identity.accountId) || !validId(identity.shareId) || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 25_000) {
			throw new Error("Invalid discussion transport configuration");
		}
		const serverId = url.toString().replace(/\/+$/, "");
		this.identity = Object.freeze({ ...identity, serverId });
		this.endpoint = serverId + "/v1/collaboration/commands";
	}

	async send(operation: QueuedCommand): Promise<CommandResult> {
		// Capture the exact request before awaiting token refresh.
		const body = queuedEnvelope(this.identity.shareId, operation);
		const immutable = JSON.parse(body) as { command: Json };
		const op = { ...operation, payload: immutable.command };
		let timer: number | undefined;
		let ended = false;
		const attempt = async () => {
			let credential: DiscussionCredential | undefined;
			try { credential = await this.credential(); }
			catch { throw new DiscussionFailure("authenticate", "credentials_unavailable", 401); }
			if (ended) throw new DiscussionFailure("retry", "request_timeout");
			if (!credential || !credential.accessToken || credential.accountId !== this.identity.accountId) {
				throw new DiscussionFailure("authenticate", "account_credentials_required", 401);
			}
			let response: Response;
			try {
				response = await this.fetcher(this.endpoint, { method: "POST", sensitive: true,
					headers: { Authorization: `Bearer ${credential.accessToken}`, "Content-Type": "application/json" }, body });
			} catch (error) {
				if (error instanceof RelayHttpError) throw new DiscussionFailure("retry", "server_unavailable", error.status, error.retryAfterMs);
				throw new DiscussionFailure("retry", "network_unavailable");
			}
			if (response.status === 401) throw new DiscussionFailure("authenticate", "authentication_required", 401);
			if (response.status === 408 || response.status === 429 || response.status >= 500) {
				throw new DiscussionFailure("retry", "server_unavailable", response.status,
					parseRetryAfterMs(response.headers.get("Retry-After")));
			}
			// Bound parsing even when a misconfigured proxy returns a large HTML page.
			let raw: string;
			try { raw = await response.text(); } catch { throw new DiscussionFailure("retry", "network_unavailable"); }
			if (new TextEncoder().encode(raw).byteLength > 65536) {
				if (response.ok) throw new DiscussionFailure("pause", "invalid_command_response", response.status);
				raw = "";
			}
			let value: unknown;
			try { value = JSON.parse(raw); } catch {
				if (response.ok) throw new DiscussionFailure("pause", "invalid_command_response", response.status);
			}
			if (!response.ok) {
				const message = object(value) && object(value.error) ? value.error.message : undefined;
				const code = object(message) && typeof message.code === "string" && errorCodes.has(message.code) ? message.code : "command_rejected";
				if (response.status === 404 && code !== "target_unavailable") throw new DiscussionFailure("pause", "discussion_endpoint_unavailable", 404);
				throw new DiscussionFailure([403, 404, 409, 413, 422].includes(response.status) ? "reject" : "pause", code, response.status);
			}
			return accepted(value, op);
		};
		try {
			return await Promise.race([attempt(), new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(new DiscussionFailure("retry", "request_timeout")), this.timeoutMs);
			})]);
		} finally { ended = true; if (timer !== undefined) window.clearTimeout(timer); }
	}
}
