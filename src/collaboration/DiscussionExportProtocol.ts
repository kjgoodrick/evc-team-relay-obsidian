import { isId, isRecord, isRevision, isSequence, parseAnchor, parseBody, parseThread, REACTIONS, sourceAnchor,
	type DiscussionAnchor, type MessageBody, type ThreadSummary, type ReactionKey } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";
import { parsePictureMetadata, pictureIds, type PictureMetadata } from "./PictureProtocol";

export const DISCUSSION_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
export const DISCUSSION_EXPORT_MAX_RECORDS = 5000;
export type ExportRecord = ({ type: "thread" } & ThreadSummary) |
	{ type: "anchor_revision"; thread_id: string; revision: number; actor_id: string | null; created_at: string; anchor: DiscussionAnchor | null; unavailable: boolean } |
	{ type: "message"; id: string; thread_id: string; author_id: string | null; revision: number; deleted: boolean; created_sequence: number; created_at: string; edited_at: string | null } |
	{ type: "message_revision"; message_id: string; revision: number; body: MessageBody | null; actor_id: string | null; created_at: string } |
	{ type: "reaction"; message_id: string; emoji: ReactionKey; count: number; mine: boolean } |
	{ type: "picture"; picture_id: string; available: boolean; metadata: PictureMetadata | null } |
	{ type: "identity"; id: string };
export type DiscussionExport = {
	format: "team-relay-discussion-export"; version: 1; export_id: string; captured_at: string; exporter_id: string; share_id: string;
	scope_id: string | null; entry: { id: string; path: string; kind: "note" | "image" | "base"; generation: string | null };
	view_id: string | null; collaboration_epoch: string | null; sequence: number;
	includes: { message_history: true; anchor_history: true; picture_bytes: false; removed_content: false }; records: ExportRecord[];
};
export type ExportRequestIdentity = { accountId: string; shareId: string; scopeId: string };
function need(value: unknown): asserts value { if (!value) throw new Error("Invalid discussion export"); }
const nullableId = (value: unknown) => value === null || isId(value);
const time = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));

/** Existing rich-body validation plus an explicit copy of supported fields.
 * Unknown server properties never become portable metadata. All text stays data. */
function body(value: unknown): MessageBody | null {
	if (value === null) return null;
	const parsed = parseBody(value);
	const text = (node: { type: "text"; text: string; marks?: ("bold" | "italic" | "code" | "strike")[] }) => ({ type: node.type, text: node.text, ...(node.marks ? { marks: [...node.marks] } : {}) });
	const paragraph = (p: Extract<MessageBody["blocks"][number], { type: "paragraph" }>) => ({ type: p.type, children: p.children.map(node =>
		node.type === "text" ? text(node) : node.type === "mention" ? { type: node.type, user_id: node.user_id } : { type: node.type, url: node.url, children: node.children.map(text) }) });
	return { version: 1, blocks: parsed.blocks.map(block => {
		if (block.type === "paragraph") return paragraph(block);
		if (block.type === "list") return { type: block.type, ...(block.ordered === undefined ? {} : { ordered: block.ordered }), items: block.items.map(paragraph) };
		if (block.type === "picture") return { type: block.type, picture_id: block.picture_id, ...(block.alt === undefined ? {} : { alt: block.alt }) };
		return { type: block.type, text: block.text, ...(block.language === undefined ? {} : { language: block.language }) };
	}) };
}

/** Reject mixed scopes, missing dependencies, removed bodies, duplicate records
 * and unsupported formats before creating any archive files. */
export function parseDiscussionExport(value: unknown, identity: ExportRequestIdentity): DiscussionExport {
	const scope = parseDiscussionScope(identity.scopeId);
	need(scope && isId(identity.accountId) && isId(identity.shareId) && isRecord(value));
	need(new TextEncoder().encode(JSON.stringify(value)).byteLength <= DISCUSSION_EXPORT_MAX_BYTES);
	need(value.format === "team-relay-discussion-export" && value.version === 1 && isId(value.export_id) && time(value.captured_at) &&
		value.exporter_id === identity.accountId && value.share_id === identity.shareId && nullableId(value.scope_id) &&
		nullableId(value.collaboration_epoch) && isSequence(value.sequence) && value.view_id === (scope.viewId ?? null));
	need(isRecord(value.entry) && value.entry.id === scope.entryId && typeof value.entry.path === "string" && value.entry.path.length > 0 &&
		value.entry.path.length <= 4096 && ["note", "image", "base"].includes(String(value.entry.kind)) && nullableId(value.entry.generation) &&
		(value.entry.kind === "base") === !!scope.viewId);
	need(isRecord(value.includes) && value.includes.message_history === true && value.includes.anchor_history === true &&
		value.includes.picture_bytes === false && value.includes.removed_content === false && Array.isArray(value.records) && value.records.length <= DISCUSSION_EXPORT_MAX_RECORDS);
	const kind = value.entry.kind;
	const sequence = value.sequence;
	const records: ExportRecord[] = value.records.map((row: unknown): ExportRecord => {
		need(isRecord(row));
		switch (row.type) {
			case "thread": { const thread = parseThread(row); need(!thread.removed && thread.activity_sequence <= sequence);
				return { type: "thread", ...thread }; }
			case "anchor_revision": {
				need(isId(row.thread_id) && isRevision(row.revision) && nullableId(row.actor_id) && time(row.created_at) && typeof row.unavailable === "boolean");
				need(row.unavailable === (row.anchor === null));
				const anchor = row.anchor === null ? null : parseAnchor(row.anchor), source = anchor && sourceAnchor(anchor);
				need(!source || source.document_id === scope.entryId);
				need(!anchor || (kind === "base" ? anchor.type === "base" && anchor.view_id === scope.viewId : anchor.type !== "base"));
				need(!anchor || (kind === "image" ? anchor.type === "image_file" && anchor.asset.entry_id === scope.entryId : anchor.type !== "image_file"));
				return { type: row.type, thread_id: row.thread_id, revision: row.revision, actor_id: row.actor_id as string | null, created_at: row.created_at, anchor, unavailable: row.unavailable };
			}
			case "message":
				need(isId(row.id) && isId(row.thread_id) && nullableId(row.author_id) && isRevision(row.revision) && typeof row.deleted === "boolean" &&
					isRevision(row.created_sequence) && row.created_sequence <= sequence && time(row.created_at) && (row.edited_at === null || time(row.edited_at)));
				return { type: row.type, id: row.id, thread_id: row.thread_id, author_id: row.author_id as string | null, revision: row.revision, deleted: row.deleted,
					created_sequence: row.created_sequence, created_at: row.created_at, edited_at: row.edited_at as string | null };
			case "message_revision":
				need(isId(row.message_id) && isRevision(row.revision) && nullableId(row.actor_id) && time(row.created_at));
				return { type: row.type, message_id: row.message_id, revision: row.revision, body: body(row.body), actor_id: row.actor_id as string | null, created_at: row.created_at };
			case "reaction":
				need(isId(row.message_id) && typeof row.emoji === "string" && Object.prototype.hasOwnProperty.call(REACTIONS, row.emoji) && isRevision(row.count) && typeof row.mine === "boolean");
				return { type: row.type, message_id: row.message_id, emoji: row.emoji as ReactionKey, count: row.count, mine: row.mine };
			case "picture": {
				need(isId(row.picture_id) && typeof row.available === "boolean" && row.available === (row.metadata !== null));
				const metadata = row.available ? parsePictureMetadata(row.metadata, row.picture_id) : null;
				need(!metadata || metadata.state === "attached");
				return { type: row.type, picture_id: row.picture_id, available: row.available, metadata };
			}
			case "identity": need(isId(row.id)); return { type: row.type, id: row.id };
			default: throw new Error("Unsupported discussion export record");
		}
	});
	const threads = new Map<string, Extract<ExportRecord, { type: "thread" }>>(), messages = new Map<string, Extract<ExportRecord, { type: "message" }>>();
	const keys = new Set<string>(), pictures = new Set<string>(), requiredPictures = new Set<string>();
	for (const row of records) {
		const key = row.type + ":" + (row.type === "anchor_revision" ? row.thread_id + ":" + row.revision : row.type === "message_revision" ? row.message_id + ":" + row.revision :
			row.type === "reaction" ? row.message_id + ":" + row.emoji : row.type === "picture" ? row.picture_id : row.id);
		need(!keys.has(key)); keys.add(key);
		if (row.type === "thread") threads.set(row.id, row);
		if (row.type === "message") messages.set(row.id, row);
		if (row.type === "picture") pictures.add(row.picture_id);
	}
	for (const row of records) {
		if (row.type === "thread") need(keys.has(`anchor_revision:${row.id}:${row.anchor_revision}`));
		if (row.type === "anchor_revision") need(threads.has(row.thread_id) && row.revision <= threads.get(row.thread_id)!.anchor_revision);
		if (row.type === "message") need(threads.has(row.thread_id) && (row.deleted || keys.has(`message_revision:${row.id}:${row.revision}`)));
		if (row.type === "message_revision" || row.type === "reaction") {
			const message = messages.get(row.message_id); need(message && !message.deleted);
			if (row.type === "message_revision") { need(row.revision <= message.revision); for (const id of pictureIds(row.body)) requiredPictures.add(id); }
		}
	}
	need(pictures.size === requiredPictures.size && [...requiredPictures].every(id => pictures.has(id)) && (value.scope_id !== null || !records.length));
	return { format: "team-relay-discussion-export", version: 1, export_id: value.export_id, captured_at: value.captured_at, exporter_id: identity.accountId,
		share_id: identity.shareId, scope_id: value.scope_id as string | null, entry: { id: scope.entryId, path: value.entry.path, kind: value.entry.kind as DiscussionExport["entry"]["kind"], generation: value.entry.generation as string | null },
		view_id: scope.viewId ?? null, collaboration_epoch: value.collaboration_epoch as string | null, sequence: value.sequence,
		includes: { message_history: true, anchor_history: true, picture_bytes: false, removed_content: false }, records };
}

export type ExportCatalogScope = { scope_id: string; entry_id: string; path: string; kind: "note" | "image" | "base";
	view_id: string | null; view_name: string | null; view_state: "active" | "archived" | null };
export type DiscussionExportCatalog = { format: "team-relay-discussion-export-catalog"; version: 1; catalog_id: string;
	captured_at: string; exporter_id: string; share_id: string; collaboration_epoch: string | null; sequence: number; scopes: ExportCatalogScope[] };
export const DISCUSSION_EXPORT_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
export function parseExportCatalog(value: unknown, identity: { accountId: string; shareId: string }): DiscussionExportCatalog {
	need(isRecord(value) && value.format === "team-relay-discussion-export-catalog" && value.version === 1 && isId(value.catalog_id) &&
		time(value.captured_at) && value.exporter_id === identity.accountId && isId(identity.accountId) && value.share_id === identity.shareId && isId(identity.shareId) &&
		nullableId(value.collaboration_epoch) && isSequence(value.sequence) && Array.isArray(value.scopes) && value.scopes.length <= 256 &&
		new TextEncoder().encode(JSON.stringify(value)).byteLength <= DISCUSSION_EXPORT_CATALOG_MAX_BYTES);
	let previous = ""; const identities = new Map<string, string>();
	const scopes = value.scopes.map((row: unknown): ExportCatalogScope => {
		need(isRecord(row) && isId(row.scope_id) && isId(row.entry_id) && typeof row.path === "string" && row.path.length > 0 && row.path.length <= 4096 &&
			["note", "image", "base"].includes(String(row.kind)));
		need(row.kind === "base" ? isId(row.view_id) && typeof row.view_name === "string" && row.view_name.length > 0 && row.view_name.length <= 512 &&
			["active", "archived"].includes(String(row.view_state)) : row.view_id === null && row.view_name === null && row.view_state === null);
		const key = row.entry_id + ":" + (row.view_id ?? ""); need(key > previous); previous = key;
		need(!identities.has(row.scope_id) || identities.get(row.scope_id) === row.entry_id); identities.set(row.scope_id, row.entry_id);
		return { scope_id: row.scope_id, entry_id: row.entry_id, path: row.path, kind: row.kind as ExportCatalogScope["kind"],
			view_id: row.view_id as string | null, view_name: row.view_name as string | null, view_state: row.view_state as ExportCatalogScope["view_state"] };
	});
	return { format: "team-relay-discussion-export-catalog", version: 1, catalog_id: value.catalog_id, captured_at: value.captured_at,
		exporter_id: identity.accountId, share_id: identity.shareId, collaboration_epoch: value.collaboration_epoch as string | null, sequence: value.sequence, scopes };
}
