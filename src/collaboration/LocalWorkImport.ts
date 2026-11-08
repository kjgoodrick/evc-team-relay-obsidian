import { isId, isRecord, isSequence } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";
import { isPictureHash, pictureHash, PICTURE_MAX_BYTES, PICTURE_SOURCE_QUOTA } from "./PictureProtocol";
import { LOCAL_WORK_MAX_METADATA, LOCAL_WORK_MAX_RECORDS, type LocalWorkSnapshot } from "./storage/LocalWorkRecords";

/** Implementations read selected local files only. Size checks run before and
 * after public vault reads; import never follows paths supplied by the manifest. */
export interface LocalWorkImportIO {
	stat(path: string): Promise<{ type: "file" | "folder"; size: number } | null>;
	read(path: string): Promise<string>;
	readBinary(path: string): Promise<ArrayBuffer>;
}
export type ImportPicture = LocalWorkSnapshot["pictures"][number] & { file: string };
export type InspectedLocalWork = {
	directory: string; manifestSha256: string;
	snapshot: Omit<LocalWorkSnapshot, "pictures"> & { pictures: ImportPicture[] };
	pictureBytes: number;
};
const failure = () => new Error("This recovery copy is invalid, incomplete or exceeds the supported limits.");
function requireValue(value: unknown): asserts value { if (!value) throw failure(); }
const text = (value: unknown, maximum = 1024): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
	requireValue(required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}

/** Reject duplicate decoded keys and excessive nesting before native parsing.
 * The raw byte limit is enforced by the caller; no untrusted text enters errors. */
export function parseRecoveryJson(raw: string): unknown {
	requireValue(typeof raw === "string" && raw.length <= LOCAL_WORK_MAX_METADATA && new TextEncoder().encode(raw).byteLength <= LOCAL_WORK_MAX_METADATA);
	let at = 0, nodes = 0;
	const whitespace = () => { while (at < raw.length && [" ", "\t", "\r", "\n"].includes(raw[at])) at++; };
	const string = (): string => {
		const start = at++; requireValue(raw[start] === '"');
		while (at < raw.length) {
			const char = raw[at++];
			if (char === "\\") { at++; continue; }
			if (char === '"') return JSON.parse(raw.slice(start, at)) as string;
		}
		throw failure();
	};
	const value = (depth: number): void => {
		requireValue(depth <= 48 && ++nodes <= 250_000); whitespace();
		if (raw[at] === '"') { string(); return; }
		if (raw[at] === "{" || raw[at] === "[") {
			const object = raw[at++] === "{", end = object ? "}" : "]", seen = new Set<string>(); whitespace();
			if (raw[at] === end) { at++; return; }
			for (;;) {
				if (object) { whitespace(); const key = string(); requireValue(!seen.has(key)); seen.add(key); whitespace(); requireValue(raw[at++] === ":"); }
				value(depth + 1); whitespace();
				if (raw[at] === end) { at++; return; }
				requireValue(raw[at++] === ",");
			}
		}
		const start = at;
		while (at < raw.length && ![",", "]", "}", " ", "\t", "\r", "\n"].includes(raw[at])) at++;
		requireValue(at > start);
		const primitive: unknown = JSON.parse(raw.slice(start, at));
		requireValue(primitive === null || typeof primitive === "boolean" || typeof primitive === "number" && Number.isFinite(primitive));
	};
	try { value(0); whitespace(); requireValue(at === raw.length); return JSON.parse(raw) as unknown; }
	catch { throw failure(); }
}

function unique(values: string[], ids = false): void { requireValue(new Set(values.map(value => ids ? value.toLowerCase() : value)).size === values.length); }
function plainIdentity(value: unknown): void {
	requireValue(isRecord(value)); keys(value, ["serverId", "accountId", "shareId", "vaultId"]);
	requireValue(text(value.serverId, 2048) && text(value.vaultId) && isId(value.accountId) && isId(value.shareId));
	try {
		const url = new URL(value.serverId);
		requireValue(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
	} catch { throw failure(); }
}

function snapshot(value: unknown): InspectedLocalWork["snapshot"] {
	requireValue(isRecord(value));
	keys(value, ["format", "version", "storageVersion", "id", "createdAt", "identity", "drafts", "operations", "dependencies", "actions", "pictures"]);
	requireValue(value.format === "team-relay-local-comment-work" && value.version === 1 && value.storageVersion === 23 && isId(value.id) && isSequence(value.createdAt));
	plainIdentity(value.identity);
	let count = 0;
	for (const name of ["drafts", "operations", "dependencies", "actions", "pictures"]) {
		const rows = value[name]; requireValue(Array.isArray(rows)); count += rows.length; requireValue(count <= LOCAL_WORK_MAX_RECORDS);
	}
	const drafts = value.drafts as unknown[], operations = value.operations as unknown[], dependencies = value.dependencies as unknown[], actions = value.actions as unknown[], pictures = value.pictures as unknown[];
	const draftIds: string[] = [], operationIds: string[] = [], dependencyIds: string[] = [], actionKeys: string[] = [], pictureIds: string[] = [];
	for (const row of drafts) {
		requireValue(isRecord(row)); keys(row, ["id", "scopeId", "revision", "body"], ["target"]);
		requireValue(text(row.id) && parseDiscussionScope(row.scopeId) && isSequence(row.revision)); draftIds.push(row.id);
	}
	for (const row of operations) {
		requireValue(isRecord(row)); keys(row, ["operationId", "scopeId", "type", "payload", "dependsOn", "state", "createdAt", "attempt", "nextAttemptAt"], ["replacementId", "reviewDraftId", "preparedAnchor", "error", "restoreGeneration"]);
		requireValue(isId(row.operationId) && parseDiscussionScope(row.scopeId) && typeof row.type === "string" && ["thread.create", "reply.create", "message.edit", "reaction.set", "picture.upload", "base.group.create"].includes(row.type) &&
			typeof row.state === "string" && ["queued", "sending", "rejected", "review"].includes(row.state) && isSequence(row.createdAt) && isSequence(row.attempt) && isSequence(row.nextAttemptAt));
		requireValue(Array.isArray(row.dependsOn) && row.dependsOn.length <= LOCAL_WORK_MAX_RECORDS && row.dependsOn.every(isId)); unique(row.dependsOn as string[], true);
		requireValue(row.replacementId === undefined || isId(row.replacementId)); requireValue(row.reviewDraftId === undefined || text(row.reviewDraftId));
		requireValue(row.restoreGeneration === undefined || row.restoreGeneration === null || isId(row.restoreGeneration));
		requireValue(row.error === undefined || text(row.error, 512)); operationIds.push(row.operationId);
	}
	for (const row of dependencies) {
		requireValue(isRecord(row)); keys(row, ["operationId", "state"], ["replacementId"]);
		requireValue(isId(row.operationId) && typeof row.state === "string" && ["queued", "sending", "accepted", "rejected", "review", "withdrawn", "missing"].includes(row.state) &&
			(row.replacementId === undefined || isId(row.replacementId))); dependencyIds.push(row.operationId);
	}
	for (const row of actions) {
		requireValue(isRecord(row)); keys(row, ["key", "value"]);
		const key = row.key;
		requireValue(text(key, 2048) && ["online:", "recovery:", "importedDraft:", "restoredDraft:", "reattach:", "timelineMarkerCommand:"].some(prefix => key.startsWith(prefix))); actionKeys.push(key);
	}
	let pictureBytes = 0;
	for (const [index, row] of pictures.entries()) {
		requireValue(isRecord(row)); keys(row, ["id", "scopeId", "sha256", "size", "file"]);
		requireValue(isId(row.id) && parseDiscussionScope(row.scopeId) && isPictureHash(row.sha256) && isSequence(row.size) && row.size > 0 && row.size <= PICTURE_MAX_BYTES &&
			row.file === `pictures/${String(index + 1).padStart(5, "0")}.bin`);
		pictureBytes += row.size; requireValue(pictureBytes <= PICTURE_SOURCE_QUOTA); pictureIds.push(row.id);
	}
	for (const group of [draftIds, actionKeys]) unique(group);
	for (const group of [[...operationIds, ...dependencyIds], pictureIds]) unique(group, true);
	const known = new Set([...operationIds, ...dependencyIds].map(id => id.toLowerCase()));
	for (const row of operations as { operationId: string; dependsOn: string[] }[]) requireValue(row.dependsOn.every(id => known.has(id.toLowerCase()) && id.toLowerCase() !== row.operationId.toLowerCase()));
	return value as unknown as InspectedLocalWork["snapshot"];
}

function directoryPath(value: string): string {
	requireValue(text(value, 2048) && !value.startsWith("/") && !value.includes("\\") && !value.includes(":"));
	requireValue(value.split("/").every(part => part && part !== "." && part !== ".." && part.length <= 255));
	requireValue([...value].every(char => char.codePointAt(0)! >= 32)); return value;
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
	return value;
}
async function readLocal<T>(read: () => Promise<T>): Promise<T> { try { return await read(); } catch { throw failure(); } }

/** Read-only preflight. Successful integrity checks establish no server origin,
 * account authority, current delivery state or permission to send any item. */
export async function inspectLocalWorkRecovery(io: LocalWorkImportIO, directory: string, current: () => boolean,
	progress: (text: string) => void = () => {}, now: () => number = () => performance.now()): Promise<InspectedLocalWork> {
	const started = now(), root = directoryPath(directory);
	const check = () => { if (!current()) throw new Error("Recovery review stopped because its account or window changed."); requireValue(now() - started < 60_000); };
	const readText = async (file: string, maximum: number): Promise<string> => {
		check(); const info = await readLocal(() => io.stat(root + "/" + file)); check();
		requireValue(info?.type === "file" && isSequence(info.size) && info.size > 0 && info.size <= maximum);
		const raw = await readLocal(() => io.read(root + "/" + file)); check();
		requireValue(typeof raw === "string" && raw.length <= maximum && new TextEncoder().encode(raw).byteLength === info.size); return raw;
	};
	check(); const folder = await readLocal(() => io.stat(root)); check(); requireValue(folder?.type === "folder");
	const completion = await readText("COMPLETE.json", 4096), complete = parseRecoveryJson(completion);
	requireValue(isRecord(complete)); keys(complete, ["format", "version", "snapshotId", "manifest", "manifestSha256", "manifestBytes"]);
	requireValue(complete.format === "team-relay-local-comment-work-complete" && complete.version === 1 && isId(complete.snapshotId) && complete.manifest === "manifest.json" &&
		isPictureHash(complete.manifestSha256) && isSequence(complete.manifestBytes) && complete.manifestBytes > 0 && complete.manifestBytes <= LOCAL_WORK_MAX_METADATA);
	const manifest = await readText("manifest.json", LOCAL_WORK_MAX_METADATA), bytes = new TextEncoder().encode(manifest).buffer;
	requireValue(bytes.byteLength === complete.manifestBytes && await pictureHash(bytes) === complete.manifestSha256); check();
	const data = snapshot(parseRecoveryJson(manifest)); requireValue(data.id === complete.snapshotId);
	let pictureBytes = 0;
	for (const [index, picture] of data.pictures.entries()) {
		check(); progress(`Verifying original picture ${index + 1} of ${data.pictures.length}…`);
		const path = root + "/" + picture.file, info = await readLocal(() => io.stat(path)); check();
		requireValue(info?.type === "file" && info.size === picture.size);
		const content = await readLocal(() => io.readBinary(path)); check();
		requireValue(content.byteLength === picture.size && await pictureHash(content) === picture.sha256); check(); pictureBytes += picture.size;
	}
	requireValue(await readText("COMPLETE.json", 4096) === completion); check();
	return freeze({ directory: root, manifestSha256: complete.manifestSha256, snapshot: data, pictureBytes });
}
