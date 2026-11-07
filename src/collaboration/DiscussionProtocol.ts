import type { Json } from "./storage/DiscussionStore";
import type { PictureBlock } from "./PictureProtocol";
import { decodeBoundedBase64, type TextAnchor } from "./anchors/text";
import { BLOCK_KINDS, type BlockStructure } from "./anchors/blocks";
import type { ImageAsset, ImageBasis, ImageGeometry } from "./anchors/imageGeometry";
import { parseBaseGroupValue, type BaseGroupValue } from "./BaseGroupValue";

export const isId = (value: unknown): value is string => typeof value === "string" &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
export const isSequence = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isRevision = (value: unknown): value is number => isSequence(value) && value > 0;

export const REACTIONS = {
	thumbs_up: "👍", thumbs_down: "👎", heart: "❤️", laugh: "😄", celebrate: "🎉", eyes: "👀", question: "❓", check: "✅",
} as const;
export type ReactionKey = keyof typeof REACTIONS;
export type TextMark = "bold" | "italic" | "code" | "strike";
export type TextNode = { type: "text"; text: string; marks?: TextMark[] };
export type InlineNode = TextNode | { type: "link"; url: string; children: TextNode[] } | { type: "mention"; user_id: string };
export type Paragraph = { type: "paragraph"; children: InlineNode[] };
export type MessageBody = { version: 1; blocks: (Paragraph | { type: "code"; text: string; language?: string } |
	{ type: "list"; ordered?: boolean; items: Paragraph[] } | PictureBlock)[] };
export type ThreadSummary = {
	id: string; author_id: string | null; state: "open" | "resolved"; state_revision: number;
	anchor_revision: number; removed: boolean; created_sequence: number; activity_sequence: number; created_at: string;
};
export type DiscussionMessage = {
	id: string; author_id: string | null; revision: number; deleted: boolean; body: MessageBody | null;
	created_sequence: number; created_at: string; edited_at: string | null;
	reactions: { emoji: ReactionKey; count: number; mine: boolean }[];
};
export type NoteAnchor = { version: 1; type: "note" };
export type WireTextAnchor = { version: 1; type: "text"; document_id: string; generation: string; start: string; end: string;
	dependency: string; selected_length: number; context: TextAnchor["context"]; structure?: BlockStructure };
export type ImageAnchor = { version: 1; type: "image"; occurrence: WireTextAnchor; asset: ImageAsset; basis: ImageBasis; geometry: ImageGeometry };
export type ImageFileAnchor = { version: 1; type: "image_file"; generation: string; asset: Extract<ImageAsset, { kind: "managed" }>;
	basis: ImageBasis; geometry: ImageGeometry };
export const BASE_TARGET_KINDS = ["view", "item", "cell", "property", "formula", "summary", "formula_cell", "group"] as const;
export type BaseTargetKind = typeof BASE_TARGET_KINDS[number];
export const BASE_RECORD_TYPES = ["markdown", "image", "audio", "video", "pdf", "canvas", "file"] as const;
export type BaseRecordType = typeof BASE_RECORD_TYPES[number];
export function isBaseRecordType(value: unknown): value is BaseRecordType {
	return typeof value === "string" && (BASE_RECORD_TYPES as readonly string[]).includes(value);
}
export type BaseProperty = { source: "note" | "file"; name: string };
export type BaseDefinitionProperty = { source: "note" | "file" | "formula"; name: string };
export type BaseDefinedTarget = { type: "formula"; definition_id: string; definition_revision: number; property: { source: "formula"; name: string } } |
	{ type: "formula_cell"; definition_id: string; definition_revision: number; property: { source: "formula"; name: string }; record_id: string; record_generation: string } |
	{ type: "summary"; definition_id: string; definition_revision: number; property: BaseDefinitionProperty; summary: string } |
	{ type: "group"; definition_id: string; definition_revision: number; property: BaseDefinitionProperty; group_id: string; witness_id: string; value: BaseGroupValue };
export function isBaseDefinitionProperty(value: unknown): value is BaseDefinitionProperty {
	return isRecord(value) && typeof value.source === "string" && ["note", "file", "formula"].includes(value.source) && isBaseProperty({ ...value, source: "note" });
}
export function isBaseProperty(value: unknown): value is BaseProperty {
	return isRecord(value) && Object.keys(value).every(key => ["source", "name"].includes(key)) &&
		(value.source === "note" || value.source === "file") && typeof value.name === "string" && text(value.name, 256) &&
		![...value.name].some(char => char.charCodeAt(0) < 32 || char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff);
}
export type BaseTarget = { type: "view" } | { type: "item"; record_id: string; record_generation: string } |
	{ type: "cell"; record_id: string; record_generation: string; property: BaseProperty } | { type: "property"; property: BaseProperty } | BaseDefinedTarget;
export type BaseAnchor = { version: 1; type: "base"; definition_id: string; view_id: string; generation: string;
	registry_revision: number; target: BaseTarget };
export type BaseTargetContext = { protocol_version: 1; entry_id: string; definition_id: string; view_id: string;
	generation: string; registry_revision: number; record_id?: string; record_generation?: string };
export type DiscussionAnchor = NoteAnchor | WireTextAnchor | ImageAnchor | ImageFileAnchor | BaseAnchor;
export const sourceAnchor = (anchor?: DiscussionAnchor): WireTextAnchor | undefined => anchor?.type === "image" ? anchor.occurrence : anchor?.type === "text" ? anchor : undefined;
export type ThreadPage = { thread: ThreadSummary; anchor: DiscussionAnchor; messages: DiscussionMessage[]; has_more: boolean; next_after: number };
export type MessageRead = { thread: ThreadSummary; anchor: DiscussionAnchor; message: DiscussionMessage };
export type ThreadStateRead = { thread: ThreadSummary; anchor?: DiscussionAnchor };
export type ThreadList = { threads: ThreadSummary[]; has_more: boolean; next_after: number; view_id?: string; scanned_through?: number };
export type HistoryPage = { revisions: { revision: number; body: MessageBody | null; actor_id: string | null; created_at: string; reason: string | null }[];
	has_more: boolean; next_after: number };
export type DiscussionEvent = { kind: string; sequence: number; data: {
	operation_id: string; scope_id: string; thread_id: string; actor_id: string | null; sequence: number;
	state: "open" | "resolved"; state_revision: number; removed: boolean; changed: boolean;
	message_id?: string; message_revision?: number; message_deleted?: boolean;
	view_id?: string;
} };
export type ChangesPage = { events: DiscussionEvent[]; cursor: string; has_more: boolean; view_id?: string; filtered?: true };

function requireValue(condition: unknown): asserts condition {
	if (!condition) throw new Error("Invalid discussion response");
}
const nullableId = (value: unknown) => value === null || isId(value);
const timestamp = (value: unknown) => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
const text = (value: unknown, limit: number) => typeof value === "string" && value.length > 0 && [...value].length <= limit;
const array = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length <= max;

export function safeDiscussionUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2048 || value.trim() !== value || [...value].some(c => c.charCodeAt(0) < 32)) return false;
	try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password; }
	catch { return false; }
}

function validText(value: unknown): boolean {
	return isRecord(value) && value.type === "text" && text(value.text, 8192) && (value.marks === undefined ||
		(array(value.marks, 4) && new Set(value.marks).size === value.marks.length &&
			value.marks.every(mark => ["bold", "italic", "code", "strike"].includes(String(mark)))));
}
export const safeImageUrl = (value: unknown): value is string => safeDiscussionUrl(value) && /^https?:\/\//i.test(value) && !value.includes("\\") &&
	![...value].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff);
function validParagraph(value: unknown): boolean {
	return isRecord(value) && value.type === "paragraph" && array(value.children, 100) && value.children.length > 0 &&
		value.children.every(node => validText(node) || (isRecord(node) && (
			node.type === "mention" && isId(node.user_id) ||
			node.type === "link" && safeDiscussionUrl(node.url) && array(node.children, 20) && node.children.length > 0 && node.children.every(validText))));
}
export function parseBody(value: unknown): MessageBody {
	requireValue(isRecord(value) && value.version === 1 && array(value.blocks, 100) && value.blocks.length > 0 &&
		new TextEncoder().encode(JSON.stringify(value)).length <= 32768 && value.blocks.every(block => validParagraph(block) ||
			(isRecord(block) && (block.type === "code" && text(block.text, 8192) && (block.language === undefined ||
				typeof block.language === "string" && /^[a-zA-Z0-9_+.-]{0,32}$/.test(block.language)) ||
			block.type === "picture" && isId(block.picture_id) && (block.alt === undefined || typeof block.alt === "string" && [...block.alt].length <= 1024) ||
			block.type === "list" && (block.ordered === undefined || typeof block.ordered === "boolean") &&
				array(block.items, 100) && block.items.length > 0 && block.items.every(validParagraph)))));
	requireValue(value.blocks.filter((block: unknown) => isRecord(block) && block.type === "picture").length <= 10);
	return value as MessageBody;
}

export function parseThread(value: unknown): ThreadSummary {
	requireValue(isRecord(value) && isId(value.id) && nullableId(value.author_id) &&
		["open", "resolved"].includes(String(value.state)) && isRevision(value.state_revision) && isRevision(value.anchor_revision) &&
		typeof value.removed === "boolean" && isRevision(value.created_sequence) && isRevision(value.activity_sequence) &&
		value.activity_sequence >= value.created_sequence && timestamp(value.created_at));
	return { id: value.id, author_id: value.author_id as string | null, state: value.state as "open" | "resolved",
		state_revision: value.state_revision, anchor_revision: value.anchor_revision, removed: value.removed,
		created_sequence: value.created_sequence, activity_sequence: value.activity_sequence, created_at: value.created_at as string };
}
export function parseMessage(value: unknown): DiscussionMessage {
	requireValue(isRecord(value) && isId(value.id) && nullableId(value.author_id) && isRevision(value.revision) &&
		typeof value.deleted === "boolean" && isRevision(value.created_sequence) && timestamp(value.created_at) &&
		(value.edited_at === null || timestamp(value.edited_at)) && array(value.reactions, 8));
	const reactions = value.reactions.map(r => {
		requireValue(isRecord(r) && typeof r.emoji === "string" && Object.prototype.hasOwnProperty.call(REACTIONS, r.emoji) && isRevision(r.count) && typeof r.mine === "boolean");
		return { emoji: r.emoji as ReactionKey, count: r.count, mine: r.mine };
	});
	requireValue(new Set(reactions.map(r => r.emoji)).size === reactions.length);
	requireValue(!value.deleted || value.body === null && reactions.length === 0);
	return { id: value.id, author_id: value.author_id as string | null, revision: value.revision, deleted: value.deleted,
		body: value.deleted ? null : parseBody(value.body), created_sequence: value.created_sequence, created_at: value.created_at as string,
		edited_at: value.edited_at as string | null, reactions };
}
export function parseAnchor(value: unknown): DiscussionAnchor {
	requireValue(isRecord(value) && value.version === 1);
	if (value.type === "note") return { version: 1, type: "note" };
	if (value.type === "image") return parseImageAnchor(value);
	if (value.type === "base") return parseBaseAnchor(value);
	if (value.type === "image_file") {
		requireValue(isId(value.generation));
		const fields = parseImageFields(value);
		requireValue(fields.asset.kind === "managed");
		return { version: 1, type: "image_file", generation: value.generation, ...fields, asset: fields.asset };
	}
	requireValue(value.type === "text" && isId(value.document_id) && isId(value.generation) &&
		isSequence(value.selected_length) && value.selected_length <= 4294967295 && isRecord(value.context) &&
		typeof value.context.truncated === "boolean");
	const context = value.context;
	for (const [key, limit] of [["quote", 512], ["prefix", 64], ["suffix", 64]] as const) {
		const text = context[key];
		requireValue(typeof text === "string" && [...text].length <= limit &&
			![...text].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff));
	}
	for (const [key, limit] of [["dependency", 65536], ["start", 256], ["end", 256]] as const) {
		requireValue(typeof value[key] === "string" && decodeBoundedBase64(value[key], limit).length > 0);
	}
	let structure: BlockStructure | undefined;
	if (value.structure !== undefined && value.structure !== null) {
		const candidate = value.structure;
		requireValue(isRecord(candidate) && candidate.kind === "blocks" && array(candidate.blocks, 32) && candidate.blocks.length > 0);
		structure = { kind: "blocks", blocks: candidate.blocks.map(block => {
			requireValue(isRecord(block) && BLOCK_KINDS.includes(block.kind as BlockStructure["blocks"][number]["kind"]) &&
				(block.explicit_id === undefined || typeof block.explicit_id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(block.explicit_id)));
			return { kind: block.kind as BlockStructure["blocks"][number]["kind"], ...(typeof block.explicit_id === "string" ? { explicit_id: block.explicit_id } : {}) };
		}) };
	}
	return { version: 1, type: "text", document_id: value.document_id, generation: value.generation,
		start: value.start as string, end: value.end as string, dependency: value.dependency as string,
		selected_length: value.selected_length, context: { quote: context.quote as string, prefix: context.prefix as string,
			suffix: context.suffix as string, truncated: context.truncated as boolean }, ...(structure ? { structure } : {}) };
}
function parseBaseAnchor(value: Record<string, unknown>): BaseAnchor {
	requireValue(isId(value.definition_id) && isId(value.view_id) && isId(value.generation) && isRevision(value.registry_revision));
	requireValue(Object.keys(value).every(key => ["version", "type", "definition_id", "view_id", "generation", "registry_revision", "target", "entry_id"].includes(key)));
	const target = value.target;
	requireValue(isRecord(target));
	let parsed: BaseTarget;
	if (target.type === "view") {
		requireValue(Object.keys(target).length === 1);
		parsed = { type: "view" };
	} else if (target.type === "formula" || target.type === "summary" || target.type === "formula_cell" || target.type === "group") {
		requireValue(isId(target.definition_id) && isRevision(target.definition_revision) && target.definition_revision <= value.registry_revision &&
			isBaseDefinitionProperty(target.property) && Object.keys(target).every(key =>
				["type", "definition_id", "definition_revision", "property", ...(target.type === "summary" ? ["summary"] : []),
					...(target.type === "formula_cell" ? ["record_id", "record_generation"] : []),
					...(target.type === "group" ? ["group_id", "witness_id", "value"] : [])].includes(key)));
		const property = { source: target.property.source, name: target.property.name };
		if (target.type === "formula" || target.type === "formula_cell") {
			requireValue(property.source === "formula");
			const common = { definition_id: target.definition_id, definition_revision: target.definition_revision, property: { source: "formula" as const, name: property.name } };
			if (target.type === "formula_cell") {
				requireValue(isId(target.record_id) && isId(target.record_generation));
				parsed = { ...common, type: "formula_cell", record_id: target.record_id, record_generation: target.record_generation };
			} else parsed = { ...common, type: "formula" };
		} else if (target.type === "group") {
			requireValue(isId(target.group_id) && isId(target.witness_id));
			parsed = { type: "group", definition_id: target.definition_id, definition_revision: target.definition_revision, property,
				group_id: target.group_id, witness_id: target.witness_id, value: parseBaseGroupValue(target.value) };
		} else {
			requireValue(isBaseProperty({ source: "note", name: target.summary }));
			parsed = { type: "summary", definition_id: target.definition_id, definition_revision: target.definition_revision, property, summary: target.summary as string };
		}
	} else {
		requireValue(target.type === "item" || target.type === "cell" || target.type === "property");
		let property: BaseProperty | undefined;
		if (target.type !== "item") {
			const p = target.property;
			requireValue(isBaseProperty(p));
			property = { source: p.source, name: p.name };
		}
		if (target.type === "property") {
			requireValue(Object.keys(target).every(key => ["type", "property"].includes(key)));
			parsed = { type: "property", property: property! };
		} else {
			requireValue(isId(target.record_id) && isId(target.record_generation) && Object.keys(target).every(key =>
				["type", "record_id", "record_generation", ...(target.type === "cell" ? ["property"] : [])].includes(key)));
			parsed = target.type === "cell" ? { type: "cell", record_id: target.record_id, record_generation: target.record_generation, property: property! } :
				{ type: "item", record_id: target.record_id, record_generation: target.record_generation };
		}
	}
	return { version: 1, type: "base", definition_id: value.definition_id, view_id: value.view_id, generation: value.generation,
		registry_revision: value.registry_revision, target: parsed };
}
export function parseBaseTargetContext(value: unknown, entryId: string, viewId: string, recordId?: string): BaseTargetContext {
	requireValue(isRecord(value) && value.protocol_version === 1 && value.entry_id === entryId && value.view_id === viewId &&
		isId(value.definition_id) && isId(value.generation) && isRevision(value.registry_revision));
	requireValue(recordId === undefined ? value.record_id === undefined && value.record_generation === undefined :
		value.record_id === recordId && isId(value.record_generation));
	return { protocol_version: 1, entry_id: entryId, definition_id: value.definition_id, view_id: viewId, generation: value.generation,
		registry_revision: value.registry_revision, ...(recordId !== undefined ? { record_id: recordId, record_generation: value.record_generation as string } : {}) };
}
function parseImageAnchor(value: Record<string, unknown>): ImageAnchor {
	// Check before recursing so malformed image nesting cannot consume the stack.
	requireValue(isRecord(value.occurrence) && value.occurrence.type === "text");
	const occurrence = parseAnchor(value.occurrence);
	requireValue(occurrence.type === "text" && occurrence.selected_length > 0 && !occurrence.structure);
	return { version: 1, type: "image", occurrence, ...parseImageFields(value) };
}
function parseImageFields(value: Record<string, unknown>): Pick<ImageAnchor, "asset" | "basis" | "geometry"> {
	const a = value.asset, b = value.basis, g = value.geometry;
	requireValue(isRecord(a) && isRecord(b) && isRecord(g));
	let asset: ImageAsset;
	if (a.kind === "managed") {
		requireValue(isId(a.entry_id) && typeof a.sha256 === "string" && /^[0-9a-f]{64}$/.test(a.sha256));
		asset = { kind: "managed", entry_id: a.entry_id, sha256: a.sha256 };
	} else {
		requireValue(a.kind === "external" && a.version_evidence === "unknown" && safeImageUrl(a.url));
		asset = { kind: "external", url: a.url, version_evidence: "unknown" };
	}
	requireValue(isRevision(b.width) && b.width <= 100000 && isRevision(b.height) && b.height <= 100000 && b.orientation === "display");
	let geometry: ImageGeometry;
	const coordinate = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
	if (g.type === "whole") geometry = { type: "whole" };
	else {
		requireValue(coordinate(g.x) && coordinate(g.y));
		if (g.type === "pin") geometry = { type: "pin", x: g.x, y: g.y };
		else {
			requireValue(g.type === "region" && coordinate(g.width) && coordinate(g.height) && g.width > 0 && g.height > 0 && g.x + g.width <= 1 && g.y + g.height <= 1);
			geometry = { type: "region", x: g.x, y: g.y, width: g.width, height: g.height };
		}
	}
	return { asset, basis: { width: b.width, height: b.height, orientation: "display" }, geometry };
}
export function wireTextAnchor(value: TextAnchor): WireTextAnchor {
	return parseAnchor({ version: value.version, type: value.type, document_id: value.documentId, generation: value.generation,
		start: value.start, end: value.end, dependency: value.dependency, selected_length: value.selectedLength, context: value.context,
		...(value.structure ? { structure: value.structure } : {}) }) as WireTextAnchor;
}
export function localTextAnchor(value: WireTextAnchor): TextAnchor {
	return { version: value.version, type: value.type, documentId: value.document_id, generation: value.generation,
		start: value.start, end: value.end, dependency: value.dependency, selectedLength: value.selected_length, context: { ...value.context },
		...(value.structure ? { structure: value.structure } : {}) };
}
function pagination(value: Record<string, unknown>, positions: number[], after: number) {
	requireValue(typeof value.has_more === "boolean" && isSequence(value.next_after));
	let last = after;
	for (const position of positions) { requireValue(position > last); last = position; }
	requireValue(value.next_after === last && (!value.has_more || positions.length > 0));
	return { has_more: value.has_more, next_after: value.next_after };
}
export function parseThreadList(value: unknown, after: number, viewId?: string): ThreadList {
	requireValue(isRecord(value) && array(value.threads, 100));
	const threads = value.threads.map(parseThread);
	requireValue(new Set(threads.map(t => t.id)).size === threads.length);
	if (viewId !== undefined) {
		requireValue(isId(viewId) && value.view_id === viewId && isSequence(value.scanned_through) && value.next_after === value.scanned_through &&
			typeof value.has_more === "boolean" && value.scanned_through >= after && (!value.has_more || value.scanned_through > after));
		let previous = after;
		for (const thread of threads) { requireValue(thread.created_sequence > previous && thread.created_sequence <= value.scanned_through); previous = thread.created_sequence; }
		return { threads, has_more: value.has_more, next_after: value.scanned_through, view_id: viewId, scanned_through: value.scanned_through };
	}
	requireValue(value.view_id === undefined && value.scanned_through === undefined);
	return { threads, ...pagination(value, threads.map(t => t.created_sequence), after) };
}
export function parseThreadPage(value: unknown, threadId: string, after: number): ThreadPage {
	requireValue(isRecord(value) && array(value.messages, 100));
	const thread = parseThread(value.thread), messages = value.messages.map(parseMessage);
	requireValue(thread.id === threadId && new Set(messages.map(m => m.id)).size === messages.length);
	return { thread, anchor: parseAnchor(value.anchor), messages, ...pagination(value, messages.map(m => m.created_sequence), after) };
}
export function parseMessageRead(value: unknown, threadId: string, messageId: string): MessageRead {
	requireValue(isRecord(value));
	const thread = parseThread(value.thread), message = parseMessage(value.message);
	requireValue(thread.id === threadId && message.id === messageId);
	return { thread, anchor: parseAnchor(value.anchor), message };
}
export function parseThreadState(value: unknown, threadId: string): ThreadStateRead {
	requireValue(isRecord(value));
	const thread = parseThread(value.thread);
	requireValue(thread.id === threadId);
	return thread.removed ? { thread } : { thread, anchor: parseAnchor(value.anchor) };
}
export function parseHistory(value: unknown, after: number): HistoryPage {
	requireValue(isRecord(value) && array(value.revisions, 100));
	const revisions = value.revisions.map(r => {
		requireValue(isRecord(r) && isRevision(r.revision) && nullableId(r.actor_id) && timestamp(r.created_at) &&
			(r.reason === null || typeof r.reason === "string" && r.reason.length <= 512));
		return { revision: r.revision, body: r.body === null ? null : parseBody(r.body), actor_id: r.actor_id as string | null,
			created_at: r.created_at as string, reason: r.reason as string | null };
	});
	return { revisions, ...pagination(value, revisions.map(r => r.revision), after) };
}
const eventKinds = new Set(["thread.create", "reply.create", "message.edit", "message.delete", "reaction.set", "thread.state", "thread.remove"]);
export function parseChanges(value: unknown, viewId?: string): ChangesPage {
	requireValue(isRecord(value) && array(value.events, 100) && typeof value.cursor === "string" &&
		value.cursor.length > 0 && value.cursor.length <= 2048 && typeof value.has_more === "boolean");
	requireValue(viewId === undefined ? value.view_id === undefined && value.filtered === undefined && (!value.has_more || value.events.length > 0) :
		isId(viewId) && value.view_id === viewId && value.filtered === true);
	let previous = 0;
	const events = value.events.map(event => {
		requireValue(isRecord(event) && typeof event.kind === "string" && eventKinds.has(event.kind) &&
			isRevision(event.sequence) && event.sequence > previous && isRecord(event.data));
		previous = event.sequence;
		const d = event.data;
		requireValue(viewId === undefined ? d.view_id === undefined : d.view_id === viewId);
		requireValue(d.sequence === event.sequence && isId(d.operation_id) && isId(d.scope_id) && isId(d.thread_id) &&
			nullableId(d.actor_id) && ["open", "resolved"].includes(String(d.state)) && isRevision(d.state_revision) &&
			typeof d.removed === "boolean" && typeof d.changed === "boolean");
		const messageEvent = !["thread.state", "thread.remove"].includes(event.kind);
		requireValue(messageEvent ? isId(d.message_id) && isRevision(d.message_revision) && typeof d.message_deleted === "boolean" :
			d.message_id === undefined && d.message_revision === undefined && d.message_deleted === undefined);
		return { kind: event.kind, sequence: event.sequence, data: { operation_id: d.operation_id, scope_id: d.scope_id,
			thread_id: d.thread_id, actor_id: d.actor_id as string | null, sequence: event.sequence,
			state: d.state as "open" | "resolved", state_revision: d.state_revision, removed: d.removed, changed: d.changed, ...(viewId !== undefined ? { view_id: viewId } : {}),
			...(messageEvent ? { message_id: d.message_id as string, message_revision: d.message_revision as number, message_deleted: d.message_deleted as boolean } : {}) } };
	});
	return { events, cursor: value.cursor, has_more: value.has_more, ...(viewId !== undefined ? { view_id: viewId, filtered: true as const } : {}) };
}

export function bodyFromText(text: string): MessageBody {
	const children: TextNode[] = [];
	// Split by code point so a boundary cannot bisect an emoji surrogate pair.
	const points = [...text];
	for (let i = 0; i < points.length; i += 8192) children.push({ type: "text", text: points.slice(i, i + 8192).join("") });
	if (!text.trim()) throw new Error("Write a comment before sending.");
	return parseBody({ version: 1, blocks: [{ type: "paragraph", children }] });
}

/** Typed protocol values are JSON; copy at the storage boundary to isolate UI mutations. */
export const protocolJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
