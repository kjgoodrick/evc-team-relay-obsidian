import { restoreGeneration } from "./collaboration/RestoreGeneration";
import { sourceInstallationNativeRoot, sourceInstallationPath, type InstallationArtifact, type SourceInstallationReference } from "./SourceInstallationPlan";

/** A single reviewed file mutation. This descriptor grants no authority by
 * itself: the coordinator must bind it to the prepared source and archived
 * originals, current permissions, writer isolation and the applying journal. */
export interface SameFolderFileOperation {
	format: "team-relay-native-file-operation";
	version: 1;
	id: string;
	plan: SourceInstallationReference;
	reviewId: string;
	root: string;
	path: string;
	before: InstallationArtifact | null;
	after: InstallationArtifact | null;
}
const invalid = () => new Error("Invalid same-folder file operation");
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
		|| keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw invalid();
}
function uuid(value: unknown): string {
	const result = restoreGeneration(value);
	if (!result || result !== value) throw invalid();
	return result;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid();
	return value;
}
function artifact(value: unknown): InstallationArtifact | null {
	if (value === null) return null;
	exact(value, ["bytes", "sha256"]);
	if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 256 * 1024 * 1024) throw invalid();
	return { bytes: value.bytes, sha256: digest(value.sha256) };
}
export function parseSameFolderFileOperation(value: unknown): SameFolderFileOperation {
	exact(value, ["format", "version", "id", "plan", "reviewId", "root", "path", "before", "after"]);
	if (value.format !== "team-relay-native-file-operation" || value.version !== 1) throw invalid();
	exact(value.plan, ["id", "sha256"]);
	const root = sourceInstallationNativeRoot(value.root), path = sourceInstallationNativeRoot(value.path);
	if (new TextEncoder().encode(`${root}/${path}`).byteLength > 4096) throw invalid();
	const before = artifact(value.before), after = artifact(value.after);
	if (!before && !after || before && after && before.bytes === after.bytes && before.sha256 === after.sha256) throw invalid();
	return { format: value.format, version: 1, id: uuid(value.id), plan: { id: uuid(value.plan.id), sha256: digest(value.plan.sha256) },
		reviewId: uuid(value.reviewId), root, path, before, after };
}
export function sameFolderOperationPath(input: SameFolderFileOperation): string {
	const operation = parseSameFolderFileOperation(input);
	return `${sourceInstallationPath(operation.plan.id)}/native-operations/${operation.id}`;
}
