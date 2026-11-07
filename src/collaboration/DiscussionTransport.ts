import { platformFetch, type PlatformRequestInit } from "../platformFetch";
import { RelayHttpError, parseRetryAfterMs } from "../relayRequestErrors";
import type { Json, QueuedCommand } from "./storage/DiscussionStore";
import { parsePictureMetadata, parsePictureRendition, parsePictureUpload, pictureHash, type PictureMetadata, type PictureRendition, type PictureUpload } from "./PictureProtocol";
import { BASE_TARGET_KINDS, BASE_RECORD_TYPES, isId, isSequence, parseAnchor, sourceAnchor, parseBaseTargetContext, parseChanges, parseHistory, parseMessageRead, parseThreadList, parseThreadPage, parseThreadState, type BaseTargetKind, type BaseRecordType, type DiscussionAnchor } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";
import { parseBaseDefinitionCatalog, parseBaseDefinitionPage, type BaseDefinitionCatalog } from "./BaseDefinitionProtocol";
import { parseTimelineAxisContext } from "./TimelineRangeProtocol";
import { parseTimelineMarkerCatalog, parseTimelineMarkerPage, type TimelineMarkerCatalog } from "./TimelineMarkerProtocol";
import { parseTimelineMarkerCommand, parseTimelineMarkerDetail, parseTimelineMarkerReceipt, parseTimelineMarkerInventoryPage, type TimelineMarkerCommand, type TimelineMarkerInventory } from "./TimelineMarkerManagementProtocol";
import { BASE_FILE_GROUP_PROPERTIES, copyBaseGroupCapture, parseBaseGroupCaptureResult, type BaseGroupCapture } from "./BaseGroupProtocol";
import { inboxCursor, parseInboxPage, parseInboxSubscription, parseInboxReadState, parseInboxChange, type InboxChange } from "./InboxProtocol";
import { parseSearchPage, searchEnvelope, searchRequest, type DiscussionSearchRequest } from "./DiscussionSearchProtocol";
import { parseAnchorHistory, reattachmentAnchor } from "./ReattachmentProtocol";

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
	anchor_revision?: number;
};
export interface DiscussionSender {
	readonly identity: Readonly<DiscussionIdentity>;
	send(operation: QueuedCommand, current?: () => boolean): Promise<CommandResult | PictureMetadata>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errorCodes = new Set(["target_unavailable", "comment_forbidden", "operation_id_conflict", "operation_withdrawn", "identifier_unavailable",
	"stale_message_revision", "stale_thread_revision", "author_required", "moderation_required", "mention_unavailable",
	"too_many_mentions", "invalid_command", "command_too_large", "discussion_preview_disabled", "snapshot_required"]);
for (const code of ["inbox_preview_disabled", "inbox_cursor_reset", "stale_subscription_version", "inbox_version_unavailable", "stale_inbox_version"]) errorCodes.add(code);
for (const code of ["discussion_search_disabled", "discussion_search_cursor_reset", "invalid_search_query"]) errorCodes.add(code);
for (const code of ["reattach_disabled", "stale_anchor_revision", "reattach_scope_changed", "reattach_readers_changed", "reattach_target_unanchored"]) errorCodes.add(code);
for (const code of ["anchor_dependency_not_ready", "anchor_generation_mismatch", "invalid_anchor", "invalid_anchor_scope", "text_anchors_disabled", "image_unavailable", "image_anchors_disabled", "image_files_disabled"]) errorCodes.add(code);
for (const code of ["base_discussions_disabled", "base_definition_not_synced", "base_view_unavailable", "base_view_required"]) errorCodes.add(code);
for (const code of ["timeline_ranges_disabled", "timeline_axis_unavailable", "timeline_axis_changed", "unsupported_timeline_time_zone"]) errorCodes.add(code);
for (const code of ["timeline_markers_disabled", "timeline_marker_catalog_changed", "timeline_marker_changed", "timeline_marker_unavailable",
	"timeline_marker_limit", "timeline_marker_placement_limit", "invalid_marker_placement", "base_editor_required", "base_generation_changed"]) errorCodes.add(code);
for (const code of ["base_definition_targets_disabled", "base_formula_cells_disabled", "base_definition_targets_limit", "base_target_definition_changed", "base_target_definition_unavailable", "stale_base_revision"]) errorCodes.add(code);
for (const code of ["base_groups_disabled", "base_group_adapter_unavailable", "base_group_value_unavailable", "base_group_value_changed", "base_group_source_changed",
	"base_group_limit", "base_group_witness_limit", "base_group_identity_conflict", "operation_conflict"]) errorCodes.add(code);
for (const code of ["pictures_disabled", "picture_identity_conflict", "picture_staging_quota", "picture_digest_mismatch", "picture_not_verified",
	"picture_expired", "picture_too_large", "picture_output_too_large", "picture_too_many_pixels", "animated_picture_unsupported", "invalid_picture", "picture_changed"]) errorCodes.add(code);
function validId(value: unknown): value is string { return typeof value === "string" && uuid.test(value); }
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

/** Local scope keys retain managed file identity and, for Bases, saved-view identity. */
export function queuedEnvelope(shareId: string, op: QueuedCommand): string {
	const payload = op.payload;
	const scope = parseDiscussionScope(op.scopeId);
	if (!validId(shareId) || !validId(op.operationId) || !scope || !object(payload) ||
		payload.type !== op.type || !validId(payload.thread_id) || !validId(payload.message_id) ||
		!["thread.create", "reply.create", "message.edit", "reaction.set"].includes(op.type)) {
		throw new DiscussionFailure("reject", "invalid_local_command");
	}
	if (op.type === "reply.create" && (payload.reopen !== undefined && payload.reopen !== false ||
		payload.expected_state_revision != null)) throw new DiscussionFailure("reject", "online_command_required");
	let body: string;
	try {
		body = JSON.stringify({ protocol_version: 1, operation_id: op.operationId, share_id: shareId,
			entry_id: scope.entryId, command: payload });
	} catch { throw new DiscussionFailure("reject", "invalid_local_command"); }
	let limit = 65536;
	if (op.type === "thread.create" && object(payload.anchor) && payload.anchor.type === "base") {
		try { const anchor = parseAnchor(payload.anchor);
			if (scope.viewId !== undefined && (anchor.type !== "base" || anchor.view_id !== scope.viewId)) throw new Error("Wrong saved view");
			if (anchor.type === "base" && (anchor.target.type === "group" || anchor.target.type === "timeline_range" && anchor.target.lane)) limit = 256 * 1024;
		} catch { throw new DiscussionFailure("reject", "invalid_local_anchor"); }
	}
	if (op.type === "thread.create" && scope.viewId !== undefined && (!object(payload.anchor) || payload.anchor.type !== "base")) throw new DiscussionFailure("reject", "invalid_local_anchor");
	if (op.type === "thread.create" && object(payload.anchor) && payload.anchor.type === "image_file") {
		try {
			const anchor = parseAnchor(payload.anchor);
			if (anchor.type !== "image_file" || anchor.asset.entry_id !== op.scopeId) throw new Error("Wrong image file");
		} catch { throw new DiscussionFailure("reject", "invalid_local_anchor"); }
	}
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
export type WithdrawalResult = { status: "withdrawn" } | { status: "accepted"; result: CommandResult };

function onlineEnvelope(shareId: string, operation: OnlineOperation): string {
	const command = operation.payload;
	const scope = parseDiscussionScope(operation.scopeId);
	if (!isId(shareId) || !isId(operation.operationId) || !scope || !object(command) || !isId(command.thread_id) ||
		!["reply.create", "thread.state", "message.delete", "thread.remove", "thread.reattach"].includes(String(command.type)) ||
		(["reply.create", "message.delete"].includes(String(command.type)) && !isId(command.message_id))) {
		throw new DiscussionFailure("reject", "invalid_local_command");
	}
	let limit = 65536;
	if (command.type === "thread.reattach") {
		try {
			const anchor = reattachmentAnchor(operation);
			if (sourceAnchor(anchor) || anchor.type === "base" && (anchor.target.type === "group" || anchor.target.type === "timeline_range" && anchor.target.lane)) limit = 256 * 1024;
		} catch { throw new DiscussionFailure("reject", "invalid_local_anchor"); }
	}
	const body = JSON.stringify({ protocol_version: 1, operation_id: operation.operationId, share_id: shareId,
		entry_id: scope.entryId, command });
	if (new TextEncoder().encode(body).byteLength > limit) throw new DiscussionFailure("reject", "command_too_large");
	return body;
}

function accepted(value: unknown, op: OnlineOperation): CommandResult {
	const command = op.payload as Record<string, Json>;
	const message = command.message_id !== undefined;
	const reattach = command.type === "thread.reattach";
	if (!object(value) || value.operation_id !== op.operationId || value.thread_id !== command.thread_id ||
		value.message_id !== command.message_id || !validId(value.scope_id) || !positive(value.sequence) ||
		!positive(value.state_revision) || (message && (!positive(value.message_revision) || typeof value.message_deleted !== "boolean")) ||
		!["open", "resolved"].includes(String(value.state)) || typeof value.removed !== "boolean" ||
		typeof value.changed !== "boolean" || (!message && (value.message_revision !== undefined || value.message_deleted !== undefined)) ||
		reattach && (!positive(value.anchor_revision) || value.anchor_revision !== Number(command.expected_anchor_revision) + (value.changed ? 1 : 0))) {
		// A mutation may have committed even when a proxy returned invalid data.
		throw new DiscussionFailure("pause", "invalid_command_response");
	}
	// Whitelist fields before saving; avoid persisting arbitrary response content.
	return { operation_id: op.operationId, scope_id: value.scope_id, thread_id: value.thread_id as string,
		sequence: value.sequence, state: value.state as "open" | "resolved", state_revision: value.state_revision,
		removed: value.removed, changed: value.changed, ...(reattach ? { anchor_revision: value.anchor_revision as number } : {}), ...(message ? { message_id: value.message_id as string,
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

	/** Resolve acceptance or fence every late send before creating a replacement. */
	async withdraw(operation: QueuedCommand, current?: () => boolean): Promise<WithdrawalResult> {
		// A timeout never proves withdrawal; validate the exact operation/scope.
		const body = queuedEnvelope(this.identity.shareId, operation);
		return this.withdrawEnvelope(operation, body, current);
	}
	async withdrawOnline(operation: OnlineOperation, current?: () => boolean): Promise<WithdrawalResult> {
		return this.withdrawEnvelope(operation, onlineEnvelope(this.identity.shareId, operation), current);
	}
	private async withdrawEnvelope(operation: OnlineOperation, body: string, current?: () => boolean): Promise<WithdrawalResult> {
		const captured = { ...operation, payload: (JSON.parse(body) as { command: Json }).command };
		const value = await this.request("/commands/withdraw", body, { current });
		if (object(value) && value.status === "accepted") return { status: "accepted", result: accepted(value.result, captured) };
		if (!object(value) || value.status !== "withdrawn" || value.operation_id !== captured.operationId || value.entry_id !== parseDiscussionScope(captured.scopeId)?.entryId) {
			throw new DiscussionFailure("pause", "invalid_withdrawal_response");
		}
		return { status: "withdrawn" };
	}

	/** One online-only attempt. Retain this operation ID for an explicit retry after an ambiguous failure. */
	async sendOnline(operation: OnlineOperation, current?: () => boolean): Promise<CommandResult> {
		const body = onlineEnvelope(this.identity.shareId, operation);
		const immutable = JSON.parse(body) as { command: Json };
		return accepted(await this.request("/commands", body, { current }), { ...operation, payload: immutable.command });
	}

	async capabilities(): Promise<{ discussions: boolean; textAnchors: boolean; blockAnchors: boolean; imageOccurrences: boolean; imageFiles: boolean; pictures: boolean; recovery: boolean; inbox?: boolean; search?: boolean; reattach?: boolean; baseTargets: BaseTargetKind[]; baseRecordTypes: BaseRecordType[]; baseFileGroupProperties?: string[] }> {
		const value = await this.request("/capabilities?share_id=" + this.identity.shareId);
		if (!object(value) || value.protocol_version !== 1 || !object(value.features) ||
			typeof value.features.discussion_commands !== "boolean") throw new DiscussionFailure("pause", "invalid_read_response");
		for (const key of ["discussion_text_anchors", "discussion_block_anchors", "discussion_image_occurrences", "discussion_image_files", "discussion_pictures", "discussion_recovery", "discussion_bases", "discussion_base_definition_catalog", "discussion_base_groups", "discussion_inbox", "discussion_search", "discussion_timeline_markers", "discussion_reattach"]) {
			if (value.features[key] !== undefined && typeof value.features[key] !== "boolean") throw new DiscussionFailure("pause", "invalid_read_response");
		}
		let baseTargets: BaseTargetKind[] = [];
		let baseRecordTypes: BaseRecordType[] = [];
		const definitionCatalog = value.features.discussion_base_definition_catalog === true;
		const groupCapture = value.features.discussion_base_groups === true;
		const markerCapture = value.features.discussion_timeline_markers === true;
		let baseFileGroupProperties: string[] | undefined;
		const fileGroups = value.discussion_base_file_group_properties;
		if (fileGroups !== undefined) {
			if (!Array.isArray(fileGroups) || fileGroups.length > 64 || fileGroups.some(name => typeof name !== "string" || !name || name.length > 128) ||
				new Set(fileGroups).size !== fileGroups.length) throw new DiscussionFailure("pause", "invalid_read_response");
			baseFileGroupProperties = groupCapture && definitionCatalog && value.features.discussion_bases === true ? BASE_FILE_GROUP_PROPERTIES.filter(name => fileGroups.includes(name)) : [];
		}
		if (value.features.discussion_bases === true) {
			if (!Array.isArray(value.discussion_base_targets) || value.discussion_base_targets.length > 32 ||
				value.discussion_base_targets.some(kind => typeof kind !== "string" || kind.length > 64) ||
				new Set(value.discussion_base_targets).size !== value.discussion_base_targets.length) throw new DiscussionFailure("pause", "invalid_read_response");
			baseTargets = BASE_TARGET_KINDS.filter(kind => (value.discussion_base_targets as unknown[]).includes(kind) &&
				(!["formula", "summary", "formula_cell", "group"].includes(kind) || definitionCatalog) &&
				(kind !== "group" || groupCapture) && (kind !== "timeline_marker" || markerCapture));
			const records = value.discussion_base_record_types;
			// The initial Bases protocol only accepted Markdown records.
			if (records === undefined) baseRecordTypes = ["markdown"];
			else {
				if (!Array.isArray(records) || records.length > 32 || records.some(kind => typeof kind !== "string" || kind.length > 64) ||
					new Set(records).size !== records.length) throw new DiscussionFailure("pause", "invalid_read_response");
				baseRecordTypes = BASE_RECORD_TYPES.filter(kind => records.includes(kind));
			}
		}
		return { discussions: value.features.discussion_commands, textAnchors: value.features.discussion_text_anchors === true,
			blockAnchors: value.features.discussion_block_anchors === true, imageOccurrences: value.features.discussion_image_occurrences === true,
			imageFiles: value.features.discussion_image_files === true, pictures: value.features.discussion_pictures === true, recovery: value.features.discussion_recovery === true, baseTargets, baseRecordTypes,
			...(baseFileGroupProperties ? { baseFileGroupProperties } : {}),
			...(value.features.discussion_reattach === undefined ? {} : { reattach: value.features.discussion_commands && value.features.discussion_reattach === true }),
			...(value.features.discussion_search === undefined ? {} : { search: value.features.discussion_commands && value.features.discussion_search === true }),
			...(value.features.discussion_inbox === undefined ? {} : { inbox: value.features.discussion_commands && value.features.discussion_inbox === true }) };
	}
	async search(input: DiscussionSearchRequest) {
		const request = searchRequest(input), envelope = searchEnvelope(request);
		return this.parse(await this.request(`/shares/${this.identity.shareId}/search`, envelope, { responseLimit: 512 * 1024 }), value => parseSearchPage(value, request));
	}

	async inbox(cursor: string | null = null) {
		if (!inboxCursor(cursor)) throw new DiscussionFailure("reject", "invalid_local_target");
		return this.parse(await this.request(`/shares/${this.identity.shareId}/inbox?limit=50&include_muted=true&include_dismissed=true` +
			(cursor ? "&cursor=" + encodeURIComponent(cursor) : "")), parseInboxPage);
	}
	async inboxSubscription(scopeId: string, threadId: string) {
		if (!isId(threadId)) throw new DiscussionFailure("reject", "invalid_local_target");
		return this.parse(await this.request(this.scopePath(scopeId) + `/threads/${threadId}/subscription`), parseInboxSubscription);
	}
	async changeInbox(scopeId: string, threadId: string, change: InboxChange) {
		if (!isId(threadId)) throw new DiscussionFailure("reject", "invalid_local_target");
		try { change = parseInboxChange(change); } catch { throw new DiscussionFailure("reject", "invalid_local_command"); }
		const { type, ...payload } = change;
		const value = await this.request(this.scopePath(scopeId) + `/threads/${threadId}/` + (type === "state" ? "inbox" : "subscription"), JSON.stringify(payload));
		if (change.type === "subscription") {
			const result = this.parse(value, parseInboxSubscription);
			if (result.version !== change.expected_version + 1 || result.following !== change.following || result.muted !== change.muted) throw new DiscussionFailure("pause", "invalid_read_response");
			return result;
		}
		const result = this.parse(value, parseInboxReadState);
		if (result.version < change.seen_version || (change.action === "unread" ? result.version !== change.seen_version || !result.unread :
			result.read_version < change.seen_version || change.action === "dismiss" && result.dismissed_version < change.seen_version)) throw new DiscussionFailure("pause", "invalid_read_response");
		return result;
	}

	async picture(entryId: string, pictureId: string): Promise<PictureMetadata> {
		if (!isId(pictureId)) throw new DiscussionFailure("reject", "invalid_local_target");
		return this.parse(await this.request(this.scopePath(entryId) + "/pictures/" + pictureId), value => parsePictureMetadata(value, pictureId));
	}
	async uploadPicture(entryId: string, upload: PictureUpload, bytes: ArrayBuffer): Promise<PictureMetadata> {
		try { upload = parsePictureUpload(upload); } catch { throw new DiscussionFailure("reject", "invalid_local_picture"); }
		bytes = bytes.slice(0);
		if (bytes.byteLength !== upload.size || await pictureHash(bytes) !== upload.sha256) throw new DiscussionFailure("reject", "picture_digest_mismatch");
		const path = this.scopePath(entryId) + "/pictures";
		const validated = (value: unknown): PictureMetadata => {
			const metadata = this.parse(value, item => parsePictureMetadata(item, upload.picture_id));
			if (metadata.source_sha256 !== upload.sha256 || metadata.source_size !== upload.size) throw new DiscussionFailure("pause", "invalid_picture_response");
			return metadata;
		};
		const staged = validated(await this.request(path, JSON.stringify({ picture_id: upload.picture_id, sha256: upload.sha256, size: upload.size })));
		if (staged.state !== "staged") return staged;
		const verified = validated(await this.request(path + "/" + upload.picture_id + "/content", bytes, { method: "PUT" }));
		if (verified.state === "staged") throw new DiscussionFailure("pause", "invalid_picture_response");
		return verified;
	}
	async pictureContent(entryId: string, pictureId: string, variant: "content" | "thumbnail", expected: PictureRendition): Promise<ArrayBuffer> {
		if (!isId(pictureId) || !["content", "thumbnail"].includes(variant)) throw new DiscussionFailure("reject", "invalid_local_target");
		try { expected = parsePictureRendition(expected, variant === "thumbnail"); } catch { throw new DiscussionFailure("reject", "invalid_local_picture"); }
		return await this.request(this.scopePath(entryId) + "/pictures/" + pictureId + "/" + variant, undefined, { binary: expected }) as ArrayBuffer;
	}
	async anchorContext(entryId: string): Promise<{ entryId: string; generation: string }> {
		const actual = parseDiscussionScope(entryId)?.entryId;
		const value = await this.request(this.scopePath(entryId) + "/anchor-context");
		if (!object(value) || value.protocol_version !== 1 || value.entry_id !== actual || !isId(value.generation)) throw new DiscussionFailure("pause", "invalid_read_response");
		return { entryId, generation: value.generation };
	}
	async baseTargetContext(entryId: string, viewId: string, recordId?: string) {
		if (!isId(viewId) || recordId !== undefined && !isId(recordId)) throw new DiscussionFailure("reject", "invalid_local_target");
		this.scopeView(entryId, viewId);
		return this.parse(await this.request(this.scopePath(entryId) + "/bases/target-context", JSON.stringify({ view_id: viewId,
			...(recordId !== undefined ? { record_id: recordId } : {}) })), value => parseBaseTargetContext(value, parseDiscussionScope(entryId)!.entryId, viewId, recordId));
	}
	async baseDefinitions(entryId: string, viewId: string): Promise<BaseDefinitionCatalog> {
		if (!isId(viewId)) throw new DiscussionFailure("reject", "invalid_local_target");
		this.scopeView(entryId, viewId);
		let result: BaseDefinitionCatalog | undefined, after: string | undefined;
		for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
			const value = await this.request(this.scopePath(entryId) + "/bases/target-definitions", JSON.stringify({ view_id: viewId,
				...(result ? { expected_revision: result.registry_revision, after } : {}) }));
			const page = this.parse(value, item => parseBaseDefinitionPage(item, parseDiscussionScope(entryId)!.entryId, viewId, after));
			if (result && (result.definition_id !== page.definition_id || result.generation !== page.generation || result.registry_revision !== page.registry_revision)) throw new DiscussionFailure("pause", "invalid_read_response");
			if (!result) result = parseBaseDefinitionCatalog(page, parseDiscussionScope(entryId)!.entryId, viewId);
			else result.targets.push(...page.targets);
			if (result.targets.length > 256) throw new DiscussionFailure("pause", "invalid_read_response");
			if (!page.has_more) return result;
			after = page.next_after!;
		}
		throw new DiscussionFailure("pause", "invalid_read_response");
	}
	async timelineAxis(entryId: string, viewId: string, expectedRevision?: number) {
		if (!isId(viewId) || expectedRevision !== undefined && !positive(expectedRevision)) throw new DiscussionFailure("reject", "invalid_local_target");
		this.scopeView(entryId, viewId);
		return this.parse(await this.request(this.scopePath(entryId) + "/bases/timeline-axis", JSON.stringify({ view_id: viewId,
			...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }) })),
			value => parseTimelineAxisContext(value, parseDiscussionScope(entryId)!.entryId, viewId));
	}
	async timelineMarkers(scopeId: string, viewId: string): Promise<TimelineMarkerCatalog> {
		if (!isId(viewId)) throw new DiscussionFailure("reject", "invalid_local_target");
		this.scopeView(scopeId, viewId);
		const entryId = parseDiscussionScope(scopeId)!.entryId;
		let result: TimelineMarkerCatalog | undefined, after: string | undefined;
		for (let count = 0; count < 6; count++) {
			const value = await this.request(this.scopePath(scopeId) + "/bases/timeline-markers/catalog", JSON.stringify({ view_id: viewId,
				include_archived: true, ...(result ? { expected_revision: result.catalog_revision, after } : {}) }), { responseLimit: 256 * 1024 });
			const page = this.parse(value, item => parseTimelineMarkerPage(item, entryId, viewId, after));
			if (result && (result.definition_id !== page.definition_id || result.generation !== page.generation ||
				result.registry_revision !== page.registry_revision || result.catalog_revision !== page.catalog_revision)) throw new DiscussionFailure("pause", "invalid_read_response");
			if (!result) result = parseTimelineMarkerCatalog(page, entryId, viewId);
			else result.markers.push(...page.markers);
			if (result.markers.length > 256) throw new DiscussionFailure("pause", "invalid_read_response");
			if (!page.has_more) return result;
			after = page.next_after!;
		}
		throw new DiscussionFailure("pause", "invalid_read_response");
	}
	async timelineMarkerInventory(scopeId: string): Promise<TimelineMarkerInventory> {
		const path = this.scopePath(scopeId) + "/bases/timeline-markers/catalog", entryId = parseDiscussionScope(scopeId)!.entryId;
		let result: TimelineMarkerInventory | undefined, after: string | undefined;
		for (let count = 0; count < 6; count++) {
			const value = await this.request(path, JSON.stringify({ include_archived: true,
				...(result ? { expected_revision: result.catalog_revision, after } : {}) }), { responseLimit: 256 * 1024 });
			const page = this.parse(value, item => parseTimelineMarkerInventoryPage(item, entryId, after));
			if (result && (result.definition_id !== page.definition_id || result.generation !== page.generation || result.registry_revision !== page.registry_revision ||
				result.catalog_revision !== page.catalog_revision)) throw new DiscussionFailure("pause", "invalid_read_response");
			if (!result) result = { protocol_version: 1, entry_id: page.entry_id, definition_id: page.definition_id, generation: page.generation,
				registry_revision: page.registry_revision, catalog_revision: page.catalog_revision, markers: page.markers };
			else result.markers.push(...page.markers);
			if (result.markers.length > 256) throw new DiscussionFailure("pause", "invalid_read_response");
			if (!page.has_more) return result;
			after = page.next_after!;
		}
		throw new DiscussionFailure("pause", "invalid_read_response");
	}
	async timelineMarker(scopeId: string, markerId: string) {
		if (!isId(markerId)) throw new DiscussionFailure("reject", "invalid_local_target");
		const path = this.scopePath(scopeId) + "/bases/timeline-markers/" + markerId.toLowerCase();
		return this.parse(await this.request(path), value => parseTimelineMarkerDetail(value, parseDiscussionScope(scopeId)!.entryId, markerId.toLowerCase()));
	}
	async manageTimelineMarker(scopeId: string, request: TimelineMarkerCommand) {
		let command: TimelineMarkerCommand;
		try { command = parseTimelineMarkerCommand(request); } catch { throw new DiscussionFailure("reject", "invalid_local_command"); }
		const body = JSON.stringify(command);
		if (new TextEncoder().encode(body).byteLength > 65536) throw new DiscussionFailure("reject", "command_too_large");
		const value = await this.request(this.scopePath(scopeId) + "/bases/timeline-markers/commands", body, { responseLimit: 256 * 1024 });
		return this.parse(value, data => parseTimelineMarkerReceipt(data, parseDiscussionScope(scopeId)!.entryId, command));
	}
	async captureBaseGroup(entryId: string, request: BaseGroupCapture) {
		let copy: BaseGroupCapture;
		try { copy = copyBaseGroupCapture(request); } catch { throw new DiscussionFailure("reject", "invalid_local_target"); }
		this.scopeView(entryId, copy.view_id);
		const body = JSON.stringify(copy);
		if (new TextEncoder().encode(body).byteLength > 256 * 1024) throw new DiscussionFailure("reject", "command_too_large");
		return this.parse(await this.request(this.scopePath(entryId) + "/bases/group-targets", body, { responseLimit: 256 * 1024 }),
			value => parseBaseGroupCaptureResult(value, parseDiscussionScope(entryId)!.entryId, copy));
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
		const scope = parseDiscussionScope(entryId);
		if (!scope) throw new DiscussionFailure("reject", "invalid_local_target");
		return `/shares/${this.identity.shareId}/entries/${scope.entryId}`;
	}
	private page(after: number, limit = 50): string {
		if (!isSequence(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DiscussionFailure("reject", "invalid_local_target");
		return `?after=${after}&limit=${limit}`;
	}
	private parse<T>(value: unknown, parser: (value: unknown) => T): T {
		try { return parser(value); } catch { throw new DiscussionFailure("pause", "invalid_read_response"); }
	}
	private scoped<T extends { anchor?: DiscussionAnchor }>(value: T, entryId: string, raw: unknown, viewId?: string): T {
		viewId = this.scopeView(entryId, viewId);
		entryId = parseDiscussionScope(entryId)!.entryId;
		const source = sourceAnchor(value.anchor);
		if (source && source.document_id !== entryId || value.anchor?.type === "image_file" && value.anchor.asset.entry_id !== entryId) throw new DiscussionFailure("pause", "invalid_read_response");
		if (value.anchor?.type === "base" && (!object(raw) || !object(raw.anchor) || raw.anchor.entry_id !== entryId) ||
			viewId !== undefined && value.anchor !== undefined && (value.anchor.type !== "base" || value.anchor.view_id !== viewId)) throw new DiscussionFailure("pause", "invalid_read_response");
		return value;
	}
	private viewQuery(viewId?: string): string {
		if (viewId !== undefined && !isId(viewId)) throw new DiscussionFailure("reject", "invalid_local_target");
		return viewId === undefined ? "" : "&view_id=" + viewId;
	}
	private scopeView(entryId: string, viewId?: string): string | undefined {
		const scope = parseDiscussionScope(entryId);
		if (!scope || scope.viewId !== undefined && viewId !== undefined && scope.viewId !== viewId) throw new DiscussionFailure("reject", "invalid_local_target");
		return scope.viewId ?? viewId;
	}
	async threads(entryId: string, after = 0, viewId?: string) {
		viewId = this.scopeView(entryId, viewId);
		return this.parse(await this.request(this.scopePath(entryId) + "/threads" + this.page(after) + this.viewQuery(viewId)), v => parseThreadList(v, after, viewId));
	}
	async thread(entryId: string, threadId: string, after = 0, viewId?: string) {
		viewId = this.scopeView(entryId, viewId);
		if (!isId(threadId)) throw new DiscussionFailure("reject", "invalid_local_target");
		this.viewQuery(viewId);
		return this.parse(await this.request(this.scopePath(entryId) + `/threads/${threadId}` + this.page(after)), v => this.scoped(parseThreadPage(v, threadId, after), entryId, v, viewId));
	}
	async message(entryId: string, threadId: string, messageId: string, viewId?: string) {
		viewId = this.scopeView(entryId, viewId);
		if (!isId(threadId) || !isId(messageId)) throw new DiscussionFailure("reject", "invalid_local_target");
		this.viewQuery(viewId);
		return this.parse(await this.request(this.scopePath(entryId) + `/threads/${threadId}/messages/${messageId}`), v => this.scoped(parseMessageRead(v, threadId, messageId), entryId, v, viewId));
	}
	async state(entryId: string, threadId: string, viewId?: string) {
		viewId = this.scopeView(entryId, viewId);
		if (!isId(threadId)) throw new DiscussionFailure("reject", "invalid_local_target");
		this.viewQuery(viewId);
		return this.parse(await this.request(this.scopePath(entryId) + `/threads/${threadId}/state`), v => this.scoped(parseThreadState(v, threadId), entryId, v, viewId));
	}
	async history(entryId: string, threadId: string, messageId: string, after = 0, limit = 50) {
		if (!isId(threadId) || !isId(messageId)) throw new DiscussionFailure("reject", "invalid_local_target");
		const query = this.page(after, limit);
		return this.parse(await this.request(this.scopePath(entryId) + `/threads/${threadId}/messages/${messageId}/history` + query), v => {
			const page = parseHistory(v, after);
			if (page.revisions.length > limit) throw new Error("Invalid history page size");
			return page;
		});
	}
	async anchorHistory(scopeId: string, threadId: string, after = 0, limit = 10) {
		if (!isId(threadId) || !positive(limit) || limit > 20) throw new DiscussionFailure("reject", "invalid_local_target");
		const query = this.page(after, limit);
		return this.parse(await this.request(this.scopePath(scopeId) + `/threads/${threadId}/anchor-history` + query),
			value => parseAnchorHistory(value, scopeId, threadId, after, limit));
	}
	async changes(entryId: string, cursor?: string, viewId?: string) {
		viewId = this.scopeView(entryId, viewId);
		if (cursor !== undefined && (typeof cursor !== "string" || !cursor.length || cursor.length > 2048)) throw new DiscussionFailure("reject", "invalid_local_target");
		return this.parse(await this.request(this.scopePath(entryId) + "/changes?limit=25" +
			(cursor === undefined ? "" : "&cursor=" + encodeURIComponent(cursor)) + this.viewQuery(viewId) + (viewId ? "&timeline_markers=true" : "")),
			v => parseChanges(v, viewId, parseDiscussionScope(entryId)!.entryId));
	}

	private async request(path: string, body?: string | ArrayBuffer, options: { method?: "PUT"; binary?: PictureRendition; responseLimit?: number; current?: () => boolean } = {}): Promise<unknown> {
		let timer: number | undefined;
		let ended = false;
		const attempt = async () => {
			if (options.current && !options.current()) throw new DiscussionFailure("pause", "action_context_changed");
			let credential: DiscussionCredential | undefined;
			try { credential = await this.credential(); }
			catch { throw new DiscussionFailure("authenticate", "credentials_unavailable", 401); }
			if (ended) throw new DiscussionFailure("retry", "request_timeout");
			if (options.current && !options.current()) throw new DiscussionFailure("pause", "action_context_changed");
			if (!credential || !credential.accessToken || credential.accountId !== this.identity.accountId) {
				throw new DiscussionFailure("authenticate", "account_credentials_required", 401);
			}
			let response: Response;
			try {
				response = await this.fetcher(this.identity.serverId + "/v1/collaboration" + path, { method: options.method ?? (body === undefined ? "GET" : "POST"), sensitive: true,
					headers: { Authorization: `Bearer ${credential.accessToken}`, "Content-Type": typeof body === "object" ? "application/octet-stream" : "application/json" }, body });
			} catch (error) {
				if (error instanceof RelayHttpError) throw new DiscussionFailure("retry", "server_unavailable", error.status, error.retryAfterMs);
				throw new DiscussionFailure("retry", "network_unavailable");
			}
			if (response.status === 401) throw new DiscussionFailure("authenticate", "authentication_required", 401);
			if (response.status === 408 || response.status === 429 || response.status >= 500) {
				throw new DiscussionFailure("retry", "server_unavailable", response.status,
					parseRetryAfterMs(response.headers.get("Retry-After")));
			}
			if (response.ok && options.binary) {
				const expected = options.binary;
				if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== expected.mime) throw new DiscussionFailure("pause", "invalid_picture_content");
				let bytes: ArrayBuffer;
				try {
					if (response.body) {
						const reader = response.body.getReader(), data = new Uint8Array(expected.size); let offset = 0;
						try {
							for (;;) {
								const chunk = await reader.read(); if (chunk.done) break;
								if (offset + chunk.value.byteLength > data.byteLength) throw new DiscussionFailure("pause", "invalid_picture_content");
								data.set(chunk.value, offset); offset += chunk.value.byteLength;
							}
							bytes = data.buffer.slice(0, offset);
						} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
					} else bytes = await response.arrayBuffer();
				} catch (error) { if (error instanceof DiscussionFailure) throw error; throw new DiscussionFailure("retry", "network_unavailable"); }
				if (bytes.byteLength !== expected.size || await pictureHash(bytes) !== expected.sha256) throw new DiscussionFailure("pause", "invalid_picture_content");
				return bytes;
			}
			// Bound parsing even when a misconfigured proxy returns a large HTML page.
			let raw: string;
			try { raw = await response.text(); } catch { throw new DiscussionFailure("retry", "network_unavailable"); }
			if (new TextEncoder().encode(raw).byteLength > (options.responseLimit ?? (body === undefined ? 512 * 1024 : 65536))) {
				if (response.ok) throw new DiscussionFailure("pause", "invalid_command_response", response.status);
				raw = "";
			}
			let value: unknown;
			try { value = JSON.parse(raw); } catch {
				if (response.ok) throw new DiscussionFailure("pause", "invalid_command_response", response.status);
			}
			if (!response.ok) {
				const message = object(value) && object(value.error) ? value.error.message : object(value) ? value.detail : undefined;
				const code = object(message) && typeof message.code === "string" && errorCodes.has(message.code) ? message.code : "command_rejected";
				if (response.status === 409 && ["anchor_dependency_not_ready", "base_definition_not_synced"].includes(code)) throw new DiscussionFailure("retry", code, 409, parseRetryAfterMs(response.headers.get("Retry-After")));
				if (response.status === 409 && ["text_anchors_disabled", "image_anchors_disabled", "image_files_disabled", "base_discussions_disabled", "base_definition_targets_disabled", "base_formula_cells_disabled", "base_groups_disabled", "reattach_disabled"].includes(code)) throw new DiscussionFailure("pause", code, 409);
				if (response.status === 404 && code !== "target_unavailable" && code !== "image_unavailable") throw new DiscussionFailure("pause", "discussion_endpoint_unavailable", 404);
				throw new DiscussionFailure([403, 404, 409, 410, 413, 415, 422].includes(response.status) ? "reject" : "pause", code, response.status);
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
