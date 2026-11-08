/**
 * Token refresh logic for RelayCredentialCache — relay-onprem control plane only.
 * (The cloud-backend API fallback this module used to also support was removed as
 * dead code: relayOnPremSettings always seeds at least one
 * built-in server, so by the time RelayCredentialCache is constructed a token
 * provider always resolves and the fallback never fired in the shipped
 * build.)
 */

import { namedLogger } from "./logging";
import type { DocumentGrant } from "./relay/TokenShapes";
import {
	ResourceAddress,
	RemoteDocumentAddress,
	type ResourceAddressType,
	RemoteFolderAddress,
	RemoteFileAddress,
	RemoteCanvasAddress,
} from "./ResourceAddress";
import type { RelayOnPremTokenProvider } from "./auth/RelayOnPremTokenProvider";
import type { RestoreBinding } from "./collaboration/RestoreGeneration";

/**
 * Extract relay/folder/doc information from ResourceAddress entity
 */
function extractEntityInfo(entity: ResourceAddressType): {
	relayId: string;
	folderId: string;
	docId: string;
	filePath?: string;
} | null {
	if (entity instanceof RemoteDocumentAddress) {
		return {
			relayId: entity.relayGuid,
			folderId: entity.folderGuid,
			docId: entity.documentGuid,
			// For documents, we could potentially extract filePath from entity if needed
		};
	} else if (entity instanceof RemoteCanvasAddress) {
		return {
			relayId: entity.relayGuid,
			folderId: entity.folderGuid,
			docId: entity.canvasGuid,
			// For canvas, we could potentially extract filePath from entity if needed
		};
	} else if (entity instanceof RemoteFolderAddress) {
		return {
			relayId: entity.relayGuid,
			folderId: entity.folderGuid,
			docId: entity.folderGuid,
		};
	} else if (entity instanceof RemoteFileAddress) {
		return {
			relayId: entity.relayGuid,
			folderId: entity.folderGuid,
			docId: entity.fileGuid,
			// For files, we could potentially extract filePath from entity if needed
		};
	}
	return null;
}

/**
 * Refresh token using relay-onprem control plane
 */
async function refreshRelayOnPrem(
	tokenProvider: RelayOnPremTokenProvider,
	documentId: string,
	onSuccess: (clientToken: DocumentGrant) => void,
	onError: (err: Error) => void,
	filePath?: string,
	binding: RestoreBinding = {},
	checkContext?: () => void,
) {
	const debug = namedLogger("[CredentialCache][Refresh][RelayOnPrem]", "debug");
	const error = namedLogger("[CredentialCache][Refresh][RelayOnPrem]", "error");
	debug(`${documentId}${filePath ? ` (path: ${filePath})` : ""}`);

	const entity: ResourceAddressType = ResourceAddress.parse(documentId);
	const entityInfo = extractEntityInfo(entity);

	if (!entityInfo) {
		onError(new Error("No remote to connect to"));
		return;
	}

	try {
		const clientToken = await tokenProvider.requestToken(
			entityInfo.relayId,
			entityInfo.folderId,
			entityInfo.docId,
			// Always request "write" — RelayOnPremTokenProvider.requestToken falls
			// back to "read" on a 403 (viewer-role member), so this doesn't need to
			// pre-determine the member's role client-side (U3).
			"write",
			filePath, // Pass file path for folder share validation
			binding,
			checkContext,
		);

		onSuccess(clientToken);
	} catch (reason: unknown) {
		error(reason);
		onError(reason as Error);
	}
}

/**
 * Refresh a document's token via its resolved relay-onprem server. Errors
 * clearly rather than falling back to anything else if either the plugin
 * isn't in relay-onprem mode or no token provider resolved for this
 * document -- both are configuration-error states, not alternate transports.
 */
export async function refresh(
	tokenProvider: RelayOnPremTokenProvider | null,
	isRelayOnPremMode: boolean,
	documentId: string,
	onSuccess: (clientToken: DocumentGrant) => void,
	onError: (err: Error) => void,
	filePath?: string,
	binding: RestoreBinding = {},
	checkContext?: () => void,
) {
	if (!isRelayOnPremMode || !tokenProvider) {
		onError(new Error("No relay-onprem server configured for this document"));
		return;
	}
	await refreshRelayOnPrem(tokenProvider, documentId, onSuccess, onError, filePath, binding, checkContext);
}
