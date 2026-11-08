import { TFolder, type App } from "obsidian";
import type { LocalWorkIO } from "../LocalWorkRecovery";
import { trackNativeDocumentWrite } from "../../storage/native-document-writes";

/** Obsidian's public vault API works on desktop and mobile. File creation is
 * exclusive, so an archive never overwrites an existing partial or complete one. */
export function commentArchiveIO(app: App): LocalWorkIO {
	const vault = app.vault;
	return {
		mkdir: async path => {
			let file = vault.getAbstractFileByPath(path);
			if (!file) { try { file = await trackNativeDocumentWrite(vault, path, () => vault.createFolder(path)); } catch { file = vault.getAbstractFileByPath(path); } }
			if (!(file instanceof TFolder)) throw new Error("The local recovery folder is unavailable.");
		},
		write: async (path, text) => { await trackNativeDocumentWrite(vault, path, () => vault.create(path, text)); },
		writeBinary: async (path, bytes) => { await trackNativeDocumentWrite(vault, path, () => vault.createBinary(path, bytes)); },
		read: path => vault.adapter.read(path), readBinary: path => vault.adapter.readBinary(path),
	};
}
