import { platformFetch, type PlatformRequestInit } from "../platformFetch";
import { RelayHttpError, parseRetryAfterMs } from "../relayRequestErrors";
import type { Json, QueuedCommand } from "./storage/DiscussionStore";
import { isId, isSequence, parseAnchor, sourceAnchor, parseChanges, parseHistory, parseMessageRead, parseThreadList, parseThreadPage, parseThreadState, type DiscussionAnchor } from "./DiscussionProtocol";

export type FailureAction = "retry" | "authenticate" | "reject" | "pause";

/** Codes are safe diagnostics; never carry the server's raw response or token. */
export class DiscussionFailure extends Error {
	constructor(readonly action: FailureAction, readonly code: string, readonly status = 0,
		readonly retryAfterMs?: number) { super(code); this.name = "DiscussionFailure"; }
}

export interface DiscussionIdentity { serverId: string; accountId: string; shareId: string }
export interface DiscussionCredential { accountId: string; accessToken: string }
export interface DiscussionPermissions { read: boolean; comment: boolean; edit: boolean; moderate: boolean }
export interface DiscussionParticipant { id: string; name: string }
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
	"too_many_mentions", "invalid_command", "command_too_large", "discussion_preview_disabled", "snapshot_required"]);
for (const code of ["anchor_dependency_not_ready", "anchor_generation_mismatch", "invalid_anchor", "text_anchors_disabled", "image_unavailable", "image_anchors_disabled"]) errorCodes.add(code);
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
	let limit = 65536;
	if (op.type === "thread.create" && object(payload.anchor) && ["text", "image"].includes(String(payload.anchor.type))) {
		try {
			const anchor = sourceAnchor(parseAnchor(payload.anchor));
			if (!anchor || anchor.document_id !== op.scopeId) throw new Error("Wrong document");
		} catch { throw new DiscussionFailure("reject", "invalid_local_anchor"); }
		limit = 256 * 1024;
	}
	if (new TextEncoder().encode(body).byteLength > limit) throw new DiscussionFailure("reject", "command_too_large");
	return body;
}

export type OnlineOperation = { operationId: string; scopeId: string; payload: Json };

function accepted(value: unknown, op: OnlineOperation): CommandResult {
	const command = op.payload as Record<string, Json>;
	const message = command.message_id !== undefined;
	if (!object(value) || value.operation_id !== op.operationId || value.thread_id !== command.thread_id ||
		value.message_id !== command.message_id || !validId(value.scope_id) || !positive(value.sequence) ||
		!positive(value.state_revision) || (message && (!positive(value.message_revision) || typeof value.message_deleted !== "boolean")) ||
		!["open", "resolved"].includes(String(value.state)) || typeof value.removed !== "boolean" ||
		typeof value.changed !== "boolean" || (!message && (value.message_revision !== undefined || value.message_deleted !== undefined))) {
		// A mutation may have committed even when a proxy returned invalid data.
		throw new DiscussionFailure("pause", "invalid_command_response");
	}
	// Whitelist fields before saving; avoid persisting arbitrary response content.
	return { operation_id: op.operationId, scope_id: value.scope_id, thread_id: value.thread_id as string,
		sequence: value.sequence, state: value.state as "open" | "resolved", state_revision: value.state_revision,
		removed: value.removed, changed: value.changed, ...(message ? { message_id: value.message_id as string,
			message_revision: value.message_revision as number, message_deleted: value.message_deleted as boolean } : {}) };
}

/** One HTTP attempt. Retry/auth scheduling belongs to the durable outbox worker. */
export class DiscussionTransport implements DiscussionSender {
	readonly identity: Readonly<DiscussionIdentity>;
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
	}

	async send(operation: QueuedCommand): Promise<CommandResult> {
		// Capture the exact request before awaiting token refresh.
		const body = queuedEnvelope(this.identity.shareId, operation);
		const immutable = JSON.parse(body) as { command: Json };
		const op = { ...operation, payload: immutable.command };
		return accepted(await this.request("/commands", body), op);
	}

	/** One online-only attempt. Retain this operation ID for an explicit retry after an ambiguous failure. */
	async sendOnline(operation: OnlineOperation): Promise<CommandResult> {
		const command = operation.payload;
		if (!isId(operation.operationId) || !isId(operation.scopeId) || !object(command) || !isId(command.thread_id) ||
			!["reply.create", "thread.state", "message.delete", "thread.remove"].includes(String(command.type)) ||
			(["reply.create", "message.delete"].includes(String(command.type)) && !isId(command.message_id))) {
			throw new DiscussionFailure("reject", "invalid_local_command");
		}
		const body = JSON.stringify({ protocol_version: 1, operation_id: operation.operationId, share_id: this.identity.shareId,
			entry_id: operation.scopeId, command });
		if (new TextEncoder().encode(body).byteLength > 65536) throw new DiscussionFailure("reject", "command_too_large");
		const immutable = JSON.parse(body) as { command: Json };
		return accepted(await this.request("/commands", body), { ...operation, payload: immutable.command });
	}

	async capabilities(): Promise<{ discussions: boolean; textAnchors: boolean; blockAnchors: boolean; imageOccurrences: boolean }> {
		const value = await this.request("/capabilities?share_id=" + this.identity.shareId);
		if (!object(value) || value.protocol_version !== 1 || !object(value.features) ||
			typeof value.features.discussion_commands !== "boolean") throw new DiscussionFailure("pause", "invalid_read_response");
		for (const key of ["discussion_text_anchors", "discussion_block_anchors", "discussion_image_occurrences"]) {
			if (value.features[key] !== undefined && typeof value.features[key] !== "boolean") throw new DiscussionFailure("pause", "invalid_read_response");
		}
		return { discussions: value.features.discussion_commands, textAnchors: value.features.discussion_text_anchors === true,
			blockAnchors: value.features.discussion_block_anchors === true, imageOccurrences: value.features.discussion_image_occurrences === true };
	}
	async anchorContext(entryId: string): Promise<{ entryId: string; generation: string }> {
		const value = await this.request(this.scopePath(entryId) + "/anchor-context");
		if (!object(value) || value.protocol_version !== 1 || value.entry_id !== entryId || !isId(value.generation)) throw new DiscussionFailure("pause", "invalid_read_response");
		return { entryId, generation: value.generation };
	}

	async permissions(entryId: string): Promise<DiscussionPermissions> {
		const value = await this.request(this.scopePath(entryId) + "/capabilities");
		if (!object(value) || ["read", "comment", "edit", "moderate"].some(key => typeof value[key] !== "boolean")) {
			throw new DiscussionFailure("pause", "invalid_read_response");
		}
		return { read: value.read as boolean, comment: value.comment as boolean, edit: value.edit as boolean, moderate: value.moderate as boolean };
	}
	async participants(entryId: string, after?: string): Promise<{ participants: DiscussionParticipant[]; hasMore: boolean; nextAfter?: string }> {
		if (after !== undefined && !isId(after)) throw new DiscussionFailure("reject", "invalid_local_target");
		const value = await this.request(this.scopePath(entryId) + "/participants?limit=50" + (after ? "&after=" + after : ""));
		if (!object(value) || !Array.isArray(value.participants) || value.participants.length > 100 ||
			typeof value.has_more !== "boolean" || !(value.next_after === null || isId(value.next_after))) throw new DiscussionFailure("pause", "invalid_read_response");
		let previous = after ?? "";
		const participants = value.participants.map(person => {
			if (!object(person) || !isId(person.id) || person.id <= previous || typeof person.name !== "string" || !person.name || person.name.length > 320) throw new DiscussionFailure("pause", "invalid_read_response");
			previous = person.id; return { id: person.id, name: person.name };
		});
		if (value.next_after !== (previous || null) || value.has_more && !participants.length) throw new DiscussionFailure("pause", "invalid_read_response");
		return { participants, hasMore: value.has_more, nextAfter: previous || undefined };
	}

	private scopePath(entryId: string): string {
		if (!isId(entryId)) throw new DiscussionFailure("reject", "invalid_local_target");
		return `/shares/${this.identity.shareId}/entries/${entryId}`;
	}
	private page(after: number): string {
		if (!isSequence(after)) throw new DiscussionFailure("reject", "invalid_local_target");
		return `?after=${after}&limit=50`;
	}
	private parse<T>(value: unknown, parser: (value: unknown) => T): T {
		try { return parser(value); } catch { throw new DiscussionFailure("pause", "invalid_read_response"); }
	}
	private scoped<T extends { anchor?: DiscussionAnchor }>(value: T, entryId: string): T {
		if (value.anchor?.type === "text" && value.anchor.document_id !== entryId) throw new DiscussionFailure("pause", "invalid_read_response");
		return value;
	}
	async threads(entryId: string, after = 0) {
		return this.parse(await this.request(this.scopePath(entryId) + "/threads" + this.page(after)), v => parseThreadList(v, after));
	}
	async thread(entryId: string, threadId: string, after = 0) {
		if (!isId(threadId)) throw new DiscussionFailure("reject", "invalid_local_target");
		return this.scoped(this.parse(await this.request(this.scopePath(entryId) + `/threads/${threadId}` + this.page(after)), v => parseThreadPage(v, threadId, after)), entryId);
	}
	async message(entryId: string, threadId: string, messageId: string) {
		if (!isId(threadId) || !isId(messageId)) throw new DiscussionFailure("reject", "invalid_local_target");
		return this.scoped(this.parse(await this.request(this.scopePath(entryId) + `/threads/${threadId}/messages/${messageId}`), v => parseMessageRead(v, threadId, messageId)), entryId);
	}
	async state(entryId: string, threadId: string) {
		if (!isId(threadId)) throw new DiscussionFailure("reject", "invalid_local_target");
		return this.scoped(this.parse(await this.request(this.scopePath(entryId) + `/threads/${threadId}/state`), v => parseThreadState(v, threadId)), entryId);
	}
	async history(entryId: string, threadId: string, messageId: string, after = 0) {
		if (!isId(threadId) || !isId(messageId)) throw new DiscussionFailure("reject", "invalid_local_target");
		return this.parse(await this.request(this.scopePath(entryId) + `/threads/${threadId}/messages/${messageId}/history` + this.page(after)), v => parseHistory(v, after));
	}
	async changes(entryId: string, cursor?: string) {
		if (cursor !== undefined && (typeof cursor !== "string" || !cursor.length || cursor.length > 2048)) throw new DiscussionFailure("reject", "invalid_local_target");
		return this.parse(await this.request(this.scopePath(entryId) + "/changes?limit=25" +
			(cursor === undefined ? "" : "&cursor=" + encodeURIComponent(cursor))), parseChanges);
	}

	private async request(path: string, body?: string): Promise<unknown> {
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
				response = await this.fetcher(this.identity.serverId + "/v1/collaboration" + path, { method: body === undefined ? "GET" : "POST", sensitive: true,
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
			if (new TextEncoder().encode(raw).byteLength > (body === undefined ? 512 * 1024 : 65536)) {
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
				if (response.status === 409 && code === "anchor_dependency_not_ready") throw new DiscussionFailure("retry", code, 409, parseRetryAfterMs(response.headers.get("Retry-After")));
				if (response.status === 409 && (code === "text_anchors_disabled" || code === "image_anchors_disabled")) throw new DiscussionFailure("pause", code, 409);
				if (response.status === 404 && code !== "target_unavailable" && code !== "image_unavailable") throw new DiscussionFailure("pause", "discussion_endpoint_unavailable", 404);
				throw new DiscussionFailure([403, 404, 409, 413, 422].includes(response.status) ? "reject" : "pause", code, response.status);
			}
			return value;
		};
		try {
			return await Promise.race([attempt(), new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(new DiscussionFailure("retry", "request_timeout")), this.timeoutMs);
			})]);
		} finally { ended = true; if (timer !== undefined) window.clearTimeout(timer); }
	}
}
