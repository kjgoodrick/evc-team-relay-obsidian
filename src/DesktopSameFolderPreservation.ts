import type { Vault } from "obsidian";
import { sha256Hex } from "./contentDigest";
import { createDesktopOperationInspectionIO } from "./DesktopSameFolderInspectionIO";
import { parseSameFolderDirectoryOperation } from "./SameFolderDirectoryOperation";
import { parseSameFolderFileOperation } from "./SameFolderFileOperation";
import type { SameFolderReview } from "./SameFolderReview";
import { sourceInstallationPath } from "./SourceInstallationPlan";

/** Recheck completed operation evidence without revisiting obsolete native
 * parent paths or replaying operations. In-flight external writes to a retained
 * inode must surface for review before activation, even if the selected tree is
 * correct. The supplied review must already be verified against source/archive. */
export async function verifyDesktopSameFolderPreservation(vault: Vault, review: SameFolderReview, check = () => {}) {
	const reader = createDesktopOperationInspectionIO(vault, review.plan.id, check), vaultId = await reader.vaultIdentity();
	const metadata = async (path: string, keys: string[]) => {
		check(); const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await reader.readBinary(path, 16 * 1024))); check();
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
			|| keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error("Invalid completed native operation evidence");
		return value as Record<string, unknown>;
	};
	for (const step of review.operations) {
		check(); const common = { version: 1 as const, id: step.id, plan: review.plan, reviewId: review.reviewId, root: review.root, path: step.path };
		const operation = step.kind === "file" ? parseSameFolderFileOperation({ ...common, format: "team-relay-native-file-operation", before: step.before, after: step.after })
			: parseSameFolderDirectoryOperation({ ...common, format: "team-relay-native-directory-operation", action: step.action });
		const control = `${sourceInstallationPath(review.plan.id)}/native-operations/${step.id}`;
		const intent = await metadata(`${control}/intent.json`, ["operation", "vault", "root", "parent", "control"]);
		if (JSON.stringify(intent.operation) !== JSON.stringify(operation) || intent.vault !== vaultId || intent.control !== await reader.identity(control)
			|| [intent.root, intent.parent].some(value => typeof value !== "string" || !/^\d+:\d+$/.test(value))) throw new Error("The completed native operation identity changed");
		const allowed = step.kind === "file" ? ["intent.json", "published.json", ...(step.before ? ["before.bin"] : [])]
			: ["intent.json", "applied.json", ...(step.action === "remove" ? ["captured.json", "before.dir"] : [])];
		const files = await reader.list(control, 5);
		if (files.length !== allowed.length || files.some(name => !allowed.includes(name))) throw new Error("Unexpected completed native operation contents");
		if (step.kind === "file") {
			const receipt = await metadata(`${control}/published.json`, ["file"]);
			if (step.after ? typeof receipt.file !== "string" || !/^\d+:\d+$/.test(receipt.file) : receipt.file !== null) throw new Error("Invalid completed file receipt");
			if (step.before) {
				const bytes = await reader.readBinary(`${control}/before.bin`, step.before.bytes); check();
				if (bytes.byteLength !== step.before.bytes || await sha256Hex(bytes) !== step.before.sha256) throw new Error("Retained native work changed after its operation; review the preserved work before activation");
			}
		} else {
			const receipt = await metadata(`${control}/applied.json`, ["directory"]);
			if (typeof receipt.directory !== "string" || !/^\d+:\d+$/.test(receipt.directory)) throw new Error("Invalid completed directory receipt");
			if (step.action === "remove") {
				const captured = await metadata(`${control}/captured.json`, ["directory"]);
				if (captured.directory !== receipt.directory || receipt.directory !== await reader.identity(`${control}/before.dir`)
					|| (await reader.list(`${control}/before.dir`, 1)).length) throw new Error("Retained directory work changed; review the preserved work before activation");
			}
		}
		check();
	}
}
