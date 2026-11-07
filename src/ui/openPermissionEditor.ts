import { Component, Notice } from "obsidian";
import type TeamRelayPlugin from "../main";
import type { ShareWithServer } from "../RelayOnPremShareClientManager";
import type { ShareMember } from "../RelayOnPremShareClient";
import { PermissionPolicyModal } from "./PermissionPolicyModal";
import { PathPermissionsModal } from "./PathPermissionsModal";

/** Do not fall back to the active/default server when a selected server has
 * disappeared. Capture both provider/client identity and configured endpoint. */
export function permissionEditorBinding(plugin: TeamRelayPlugin, serverId: string, shareId: string) {
	const manager = plugin.shareClientManager, auth = plugin.authSession;
	const authManager = auth.getMultiServerAuthManager();
	const getClient = () => manager ? manager.getClient(serverId) : plugin.shareClient;
	const getProvider = () => authManager ? authManager.getProvider(serverId) : auth.getAuthProvider();
	const client = getClient(), provider = getProvider(), actorId = provider?.getCurrentUser()?.id;
	const endpoint = () => plugin.relayOnPremSettings.readValue().servers.find(s => s.id === serverId)?.controlPlaneUrl;
	const initialEndpoint = endpoint(); let alive = true;
	if (!client || !provider || !actorId || manager && !initialEndpoint) return undefined;
	const current = () => alive && plugin.authSession === auth && plugin.relayOnPremSettings.readValue().enabled && plugin.shareClientManager === manager && auth.getMultiServerAuthManager() === authManager && getClient() === client && getProvider() === provider && provider.getCurrentUser()?.id === actorId && endpoint() === initialEndpoint;
	return { client: client.permissionEditor(shareId, actorId, current), current, dispose: () => { alive = false; }, legacyClient: client };
}

/** A current authorized read exposes the admin entry point without treating
 * cached role metadata as authority. Owners already have their entry point. */
export async function canManagePermissionPolicy(plugin: TeamRelayPlugin, share: ShareWithServer): Promise<boolean> {
	if (!share.managed) return false;
	const binding = permissionEditorBinding(plugin, share.serverId, share.id);
	if (!binding) return false;
	try { await binding.client.read(); return binding.current(); } catch { return false; } finally { binding.dispose(); }
}

export function openPermissionEditor(plugin: TeamRelayPlugin, share: ShareWithServer, members: ShareMember[]): void {
	const binding = permissionEditorBinding(plugin, share.serverId, share.id);
	if (!binding) { new Notice("Sign in to this share’s server to manage permissions."); return; }
	let lifetime: Component | undefined;
	const modal = new PermissionPolicyModal(plugin.app, binding.client, {
		current: binding.current,
		watch: check => {
			const stop = [plugin.authSession.on(check), plugin.relayOnPremSettings.on(check)];
			lifetime = plugin.addChild(new Component()); lifetime.register(() => modal.invalidate());
			return () => { binding.dispose(); for (const unsubscribe of stop) unsubscribe(); if (lifetime) { const child = lifetime; lifetime = undefined; plugin.removeChild(child); } };
		},
		legacy: () => new PathPermissionsModal(plugin.app, binding.legacyClient, share.id, members).open(),
	});
	modal.open();
}
