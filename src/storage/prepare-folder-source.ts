import type { Vault } from "obsidian";
import type { RelayCredentialCache } from "../RelayCredentialCache";
import type { SettingsScope } from "../SettingsPersistence";
import type { FolderSourceRequest, VaultShareSettings } from "../VaultShare";
import { AttachmentSyncSettings } from "../AttachmentSyncSettings";
import { FolderAddress, RemoteFolderAddress, ResourceAddress } from "../ResourceAddress";
import { resolveShareFolder, toSharePath } from "../vaultRootPath";
import { admitSourceStartup } from "./source-startup-admission";
import type { SourceSelectionContext } from "./source-selection-context";
import { verifySelectedSourceMapping } from "../SourceInstallationMapping";

export interface FolderPreparationHost {
	vault: Vault;
	hostAppId: string;
	credentials: Pick<RelayCredentialCache, "captureDocumentSourceContext">;
	settings: SettingsScope<VaultShareSettings[]>;
	onpremEnabled: () => boolean;
	check: () => void;
}

/** Persist source attribution while native admission is held, before any
 * provider can be constructed. Existing files and cache histories are untouched. */
export async function prepareFolderSource(host: FolderPreparationHost, request: Readonly<FolderSourceRequest>): Promise<SourceSelectionContext | undefined> {
	const input = { ...request }, enabled = host.onpremEnabled(), root = resolveShareFolder(host.vault, input.path);
	const source = enabled ? host.credentials.captureDocumentSourceContext(input.serverId) : undefined;
	const check = () => {
		host.check(); source?.check();
		if (host.onpremEnabled() !== enabled) throw new Error("The server mode changed during folder startup.");
		if (!root || toSharePath(root.path) !== input.path || resolveShareFolder(host.vault, input.path) !== root) throw new Error("The local folder moved or became unavailable during startup.");
	};
	check();
	if (enabled && !source) throw new Error("The source server is unavailable. Restore its configuration before retrying this folder.");
	const persist = async () => {
		check();
		await host.settings.mutateValue(current => {
			check();
			const previous = current.find(folder => folder.guid === input.guid);
			const next: VaultShareSettings = { ...previous, guid: input.guid, path: input.path,
				...(input.workspaceId ? { relay: input.workspaceId } : {}),
				...(source ? { onpremServerId: source.serverId } : {}),
				sync: previous?.sync ?? AttachmentSyncSettings.defaultCategoryFlags };
			return previous ? current.map(folder => folder.guid === input.guid ? next : folder) : [...current, next];
		}, true); // A previous failed disk save may already have updated memory.
		check();
	};
	if (!source) { await persist(); return; }
	const address = input.workspaceId ? new RemoteFolderAddress(input.workspaceId, input.guid) : new FolderAddress(input.guid);
	return admitSourceStartup(host.vault, input.path, { hostAppId: host.hostAppId, serverId: source.serverId,
		controlPlaneUrl: source.controlPlaneUrl, s3rn: ResourceAddress.serialize(address) }, { check }, async context => {
		if (context.choice.kind === "source") await verifySelectedSourceMapping(host.settings, context.scope, input.path, { check });
		else await persist();
	});
}
