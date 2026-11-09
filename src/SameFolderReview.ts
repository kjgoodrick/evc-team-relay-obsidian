import { RECOVERY_FOLDER } from "./conflictCopyPath";
import { restoreGeneration } from "./collaboration/RestoreGeneration";
import { sha256Hex } from "./contentDigest";
import { parseSourceInstallationPlan, sourceInstallationNativeRoot, type InstallationArtifact, type SourceInstallationPlan, type SourceInstallationReference } from "./SourceInstallationPlan";
import type { RecoveryArchiveFile, RecoveryArchiveReference } from "./ManagedRecoveryArchive";
import type { SameFolderInspectionRow } from "./SameFolderSourceInspection";
import type { SourceNativeReviewReference } from "./storage/source-selection-journal";

export type NativeReviewEntry = { path: string; type: "folder" } | { path: string; type: "file"; file: InstallationArtifact };
export interface NativeReviewChoice { path: string; choice: "use-selected" | "archive-local" }
export type NativeReviewOperation = { id: string } & (
	{ kind: "file"; path: string; before: InstallationArtifact | null; after: InstallationArtifact | null; entryId?: string }
	| { kind: "directory"; path: string; action: "create" | "remove" }
);
export interface SameFolderReview {
	format: "team-relay-same-folder-review";
	version: 1;
	id: string;
	reviewId: string;
	plan: SourceInstallationReference;
	root: string;
	archive: RecoveryArchiveReference;
	before: NativeReviewEntry[];
	choices: NativeReviewChoice[];
	operations: NativeReviewOperation[];
}
export const MAX_NATIVE_REVIEW_BYTES = 16 * 1024 * 1024;
const maxEntries = 100_000, hashPattern = /^[a-f0-9]{64}$/;
const invalid = () => new Error("Invalid same-folder recovery review");
const equal = (a: InstallationArtifact | null, b: InstallationArtifact | null) => a === b || !!a && !!b && a.bytes === b.bytes && a.sha256 === b.sha256;
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
		|| keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw invalid();
}
function uuid(value: unknown): string { const id = restoreGeneration(value); if (!id || value !== id) throw invalid(); return id; }
function digest(value: unknown): string { if (typeof value !== "string" || !hashPattern.test(value)) throw invalid(); return value; }
function artifact(value: unknown): InstallationArtifact {
	exact(value, ["bytes", "sha256"]);
	if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 256 * 1024 * 1024) throw invalid();
	return { bytes: value.bytes, sha256: digest(value.sha256) };
}
function entries(input: unknown, root: string): NativeReviewEntry[] {
	if (!Array.isArray(input) || input.length > maxEntries) throw invalid();
	const seen = new Map<string, NativeReviewEntry>(), aliases = new Map<string, string>(); let bytes = 0, components = 0;
	for (const row of input) {
		exact(row, row?.type === "file" ? ["path", "type", "file"] : ["path", "type"]);
		if (row.type !== "file" && row.type !== "folder") throw invalid();
		const path = sourceInstallationNativeRoot(row.path);
		if (new TextEncoder().encode(`${root}/${path}`).byteLength > 4096 || seen.has(path)) throw invalid();
		const item: NativeReviewEntry = row.type === "file" ? { path, type: "file", file: artifact(row.file) } : { path, type: "folder" };
		if (item.type === "file") bytes += item.file.bytes;
		const parts = path.split("/"); components += parts.length;
		if (bytes > 64 * 1024 ** 3 || components > 1_000_000) throw invalid();
		let prefix = "";
		for (const part of parts) {
			prefix = prefix ? `${prefix}/${part}` : part; const key = prefix.toLowerCase();
			if (aliases.has(key) && aliases.get(key) !== prefix) throw invalid();
			if (!aliases.has(key) && aliases.size >= maxEntries) throw invalid(); aliases.set(key, prefix);
		}
		seen.set(path, item);
	}
	for (const [path] of seen) {
		const slash = path.lastIndexOf("/");
		if (slash >= 0 && seen.get(path.slice(0, slash))?.type !== "folder") throw invalid();
	}
	return [...seen.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function selected(plan: SourceInstallationPlan): NativeReviewEntry[] {
	const tree = new Map<string, NativeReviewEntry>();
	for (const entry of plan.entries) {
		let prefix = ""; const parts = entry.path.split("/");
		for (const part of parts.slice(0, -1)) { prefix = prefix ? `${prefix}/${part}` : part; tree.set(prefix, { path: prefix, type: "folder" }); }
		tree.set(entry.path, entry.file ? { path: entry.path, type: "file", file: { ...entry.file } } : { path: entry.path, type: "folder" });
	}
	return entries([...tree.values()], plan.originalRoot);
}
const sameItem = (a?: NativeReviewEntry, b?: NativeReviewEntry) => !a && !b || !!a && !!b && a.type === b.type && (a.type === "folder" || b.type === "file" && equal(a.file, b.file));
type Recipe = Omit<Extract<NativeReviewOperation, { kind: "file" }>, "id"> | Omit<Extract<NativeReviewOperation, { kind: "directory" }>, "id">;
function recipe(plan: SourceInstallationPlan, before: NativeReviewEntry[], input: unknown): { choices: NativeReviewChoice[]; operations: Recipe[] } {
	if (!Array.isArray(input) || input.length > maxEntries) throw invalid();
	const current = new Map(before.map(row => [row.path, row])), target = new Map(selected(plan).map(row => [row.path, row]));
	const choices = new Map<string, NativeReviewChoice>();
	for (const row of input) {
		exact(row, ["path", "choice"]); const path = sourceInstallationNativeRoot(row.path);
		if (row.choice !== "use-selected" && row.choice !== "archive-local" || choices.has(path)) throw invalid();
		if (sameItem(current.get(path), target.get(path)) || row.choice !== (target.has(path) ? "use-selected" : "archive-local")) throw new Error("A native choice does not match the proposed source result");
		choices.set(path, { path, choice: row.choice });
	}
	for (const path of new Set([...current.keys(), ...target.keys()])) if (!sameItem(current.get(path), target.get(path)) && !choices.has(path)) throw new Error("Every changed native path needs an explicit recovery choice");
	const operations: Recipe[] = [];
	// Remove obstructing/retired files first, then empty directories deepest
	// first. Create target parents before publishing or replacing target files.
	for (const row of before) if (row.type === "file" && target.get(row.path)?.type !== "file") operations.push({ kind: "file", path: row.path, before: { ...row.file }, after: null });
	const oldDirectories = before.filter(row => row.type === "folder" && target.get(row.path)?.type !== "folder");
	oldDirectories.sort((a, b) => b.path.split("/").length - a.path.split("/").length || (a.path < b.path ? -1 : 1));
	for (const row of oldDirectories) operations.push({ kind: "directory", path: row.path, action: "remove" });
	const newDirectories = [...target.values()].filter(row => row.type === "folder" && current.get(row.path)?.type !== "folder");
	newDirectories.sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : 1));
	for (const row of newDirectories) operations.push({ kind: "directory", path: row.path, action: "create" });
	const ids = new Map(plan.entries.map(row => [row.path, row.record.id]));
	for (const row of target.values()) if (row.type === "file" && !sameItem(current.get(row.path), row)) {
		const prior = current.get(row.path);
		operations.push({ kind: "file", path: row.path, before: prior?.type === "file" ? { ...prior.file } : null, after: { ...row.file }, entryId: ids.get(row.path)! });
	}
	if (operations.length > maxEntries) throw invalid();
	return { choices: [...choices.values()].sort((a, b) => a.path < b.path ? -1 : 1), operations };
}

/** Fingerprint the native observation shown to the user, including the selected
 * plan and location. It is not authority to write or an atomic tree snapshot. */
export async function sameFolderComparisonDigest(comparison: { plan: SourceInstallationReference; root: string; rows: Pick<SameFolderInspectionRow, "path" | "current">[] }) {
	const root = sourceInstallationNativeRoot(comparison.root), plan = { id: uuid(comparison.plan.id), sha256: digest(comparison.plan.sha256) };
	const before = entries(comparison.rows.filter(row => row.current).map(row => ({ path: row.path, ...row.current! })), root);
	const bytes = new TextEncoder().encode(JSON.stringify({ plan, root, before })).buffer;
	if (bytes.byteLength > MAX_NATIVE_REVIEW_BYTES) throw invalid();
	return sha256Hex(bytes);
}

export function createSameFolderReview(planInput: SourceInstallationPlan, reference: SourceInstallationReference,
	beforeInput: NativeReviewEntry[], choices: NativeReviewChoice[]): SameFolderReview {
	const plan = parseSourceInstallationPlan(planInput);
	if (plan.mode !== "existing-folder" || plan.id !== reference.id) throw invalid();
	const before = entries(beforeInput, plan.originalRoot), generated = recipe(plan, before, choices);
	return { format: "team-relay-same-folder-review", version: 1, id: crypto.randomUUID(), reviewId: plan.reviewId,
		plan: { id: uuid(reference.id), sha256: digest(reference.sha256) }, root: plan.originalRoot, archive: { ...plan.archive }, before,
		choices: generated.choices, operations: generated.operations.map(row => ({ id: crypto.randomUUID(), ...row })) };
}

/** Reconstruct the complete operation recipe rather than trusting an arbitrary
 * serialized operation list. This represents an explicitly reviewed restore of
 * selected source bytes; recovered local edits require their separate workflow. */
export function parseSameFolderReview(value: unknown, planInput: SourceInstallationPlan, reference: SourceInstallationReference): SameFolderReview {
	const plan = parseSourceInstallationPlan(planInput);
	exact(value, ["format", "version", "id", "reviewId", "plan", "root", "archive", "before", "choices", "operations"]);
	exact(value.plan, ["id", "sha256"]); exact(value.archive, ["path", "manifestSha256"]);
	if (plan.mode !== "existing-folder" || value.format !== "team-relay-same-folder-review" || value.version !== 1
		|| value.reviewId !== plan.reviewId || value.root !== plan.originalRoot || value.plan.id !== plan.id || value.plan.id !== reference.id
		|| value.plan.sha256 !== reference.sha256 || value.archive.path !== plan.archive.path || value.archive.manifestSha256 !== plan.archive.manifestSha256
		|| !Array.isArray(value.operations) || value.operations.length > maxEntries) throw invalid();
	const before = entries(value.before, plan.originalRoot), generated = recipe(plan, before, value.choices);
	if (generated.operations.length !== value.operations.length) throw new Error("The reviewed operation list is incomplete");
	const seen = new Set<string>(), operations = value.operations.map((row, index): NativeReviewOperation => {
		const expected = generated.operations[index]; exact(row, ["id", ...Object.keys(expected)]);
		const id = uuid(row.id); if (seen.has(id)) throw invalid(); seen.add(id);
		for (const key of Object.keys(expected)) {
			const actual = row[key], wanted = (expected as unknown as Record<string, unknown>)[key];
			if (key === "before" || key === "after") { if (wanted === null ? actual !== null : !equal(artifact(actual), wanted as InstallationArtifact)) throw invalid(); }
			else if (actual !== wanted) throw invalid();
		}
		return { id, ...expected };
	});
	return { format: value.format, version: 1, id: uuid(value.id), reviewId: plan.reviewId, plan: { id: plan.id, sha256: digest(reference.sha256) },
		root: plan.originalRoot, archive: { ...plan.archive }, before, choices: generated.choices, operations };
}
export function verifyNativeReviewBackup(review: SameFolderReview, files: readonly Readonly<RecoveryArchiveFile>[]): void {
	const saved = new Map(files.map(row => [row.path, row]));
	for (const row of review.before) if (row.type === "file" && !equal(saved.get(`files/${review.root}/${row.path}`) ?? null, row.file)) throw new Error("Current native work is not in the verified backup. Save a fresh recovery copy before approving it.");
}
export function sameFolderReviewPath(id: string): string { return `${RECOVERY_FOLDER}/Source reviews/${uuid(id)}`; }
export async function encodeSameFolderReview(input: SameFolderReview, plan: SourceInstallationPlan, reference: SourceInstallationReference) {
	const review = parseSameFolderReview(input, plan, reference), bytes = new TextEncoder().encode(JSON.stringify(review)).buffer;
	if (bytes.byteLength > MAX_NATIVE_REVIEW_BYTES) throw new Error("The native review exceeds its size limit");
	const saved: SourceNativeReviewReference = { id: review.id, sha256: await sha256Hex(bytes), operations: review.operations.length };
	return { review, bytes, reference: Object.freeze(saved) };
}
