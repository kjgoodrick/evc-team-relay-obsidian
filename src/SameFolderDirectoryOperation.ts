import { restoreGeneration } from "./collaboration/RestoreGeneration";
import { sourceInstallationNativeRoot, sourceInstallationPath, type SourceInstallationReference } from "./SourceInstallationPlan";

/** One directory step from the verified whole-folder review. The coordinator
 * supplies source/archive/access verification and an already-drained write hold. */
export interface SameFolderDirectoryOperation {
	format: "team-relay-native-directory-operation";
	version: 1;
	id: string;
	plan: SourceInstallationReference;
	reviewId: string;
	root: string;
	path: string;
	action: "create" | "remove";
}
const invalid = () => new Error("Invalid same-folder directory operation");
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
		|| keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw invalid();
}
function uuid(value: unknown): string { const id = restoreGeneration(value); if (!id || value !== id) throw invalid(); return id; }
export function parseSameFolderDirectoryOperation(value: unknown): SameFolderDirectoryOperation {
	exact(value, ["format", "version", "id", "plan", "reviewId", "root", "path", "action"]); exact(value.plan, ["id", "sha256"]);
	if (value.format !== "team-relay-native-directory-operation" || value.version !== 1 || !["create", "remove"].includes(value.action as string)
		|| typeof value.plan.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.plan.sha256)) throw invalid();
	const root = sourceInstallationNativeRoot(value.root), path = sourceInstallationNativeRoot(value.path);
	if (new TextEncoder().encode(`${root}/${path}`).byteLength > 4096) throw invalid();
	return { format: value.format, version: 1, id: uuid(value.id), plan: { id: uuid(value.plan.id), sha256: value.plan.sha256 },
		reviewId: uuid(value.reviewId), root, path, action: value.action as "create" | "remove" };
}
export function sameFolderDirectoryOperationPath(input: SameFolderDirectoryOperation): string {
	const operation = parseSameFolderDirectoryOperation(input);
	return `${sourceInstallationPath(operation.plan.id)}/native-operations/${operation.id}`;
}
