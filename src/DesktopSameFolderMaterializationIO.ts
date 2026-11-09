import type { Vault } from "obsidian";
import { applyDesktopSameFolderDirectoryOperation } from "./DesktopSameFolderDirectoryOperation";
import { applyDesktopSameFolderFileOperation } from "./DesktopSameFolderFileOperation";
import { createDesktopSameFolderInspectionIO } from "./DesktopSameFolderInspectionIO";
import { verifyDesktopSameFolderPreservation } from "./DesktopSameFolderPreservation";
import type { SameFolderMaterializationIO } from "./SameFolderMaterialization";
import { sourceInstallationNativeRoot } from "./SourceInstallationPlan";

/** Root identity remains fixed through the entire session. Child inspectors are
 * fresh because reviewed directory operations legitimately change descendants. */
export function createDesktopSameFolderMaterializationIO(vault: Vault, inputRoot: string, checkContext = () => {}): SameFolderMaterializationIO {
	const root = sourceInstallationNativeRoot(inputRoot), adapter = vault.adapter;
	const check = () => { if (vault.adapter !== adapter) throw new Error("The recovery vault adapter changed"); checkContext(); };
	const rootGuard = createDesktopSameFolderInspectionIO(vault, root, check);
	return {
		root, nativeWriteOwner: vault,
		assertCurrent: async () => { check(); if ((await rootGuard.stat(root))?.type !== "folder") throw new Error("The native recovery root changed"); check(); },
		inspect: () => { check(); return createDesktopSameFolderInspectionIO(vault, root, check); },
		verifyPreserved: (review, context) => verifyDesktopSameFolderPreservation(vault, review, () => { check(); context(); }),
		applyFile: (operation, bytes, hold, context) => applyDesktopSameFolderFileOperation(vault, operation, bytes, hold, () => { check(); context(); }),
		applyDirectory: (operation, hold, context) => applyDesktopSameFolderDirectoryOperation(vault, operation, hold, () => { check(); context(); }),
	};
}
