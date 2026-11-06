<script lang="ts">
	import PluginUpdates from "./PluginUpdates.svelte";
	import PresenceSettings from "./PresenceSettings.svelte";
	import ModalBackBar from "./ModalBackBar.svelte";
	import type TeamRelayPlugin from "src/main";
	import type { VaultShare } from "src/VaultShare";
	import SyncedFolderManager from "./SyncedFolderManager.svelte";
	import type { RemoteFolderRecord } from "src/RelayModel";
	import StatusOverlay from "./StatusOverlay.svelte";
	import RelayOnPremSettings from "./RelayOnPremSettings.svelte";
	import AnnouncementBanner from "./AnnouncementBanner.svelte";
	import { onMount } from "svelte";
	import {
		resolvePath,
		popToRestorableView,
		type NavView,
	} from "./pluginSettingsNav";

	interface NavigateBackEvent extends CustomEvent {
		clear?: boolean;
	}

	// Marks the surrounding settings modal while this panel is shown, so the
	// mobile stylesheet can give Obsidian's floating (transparent) nav header
	// a solid background without touching other plugins' settings tabs.
	let contentEl: HTMLElement | undefined;
	onMount(() => {
		const modalEl = contentEl?.closest(".modal");
		modalEl?.classList.add("evc-relay-settings-open");
		return () => modalEl?.classList.remove("evc-relay-settings-open");
	});

	export let live: TeamRelayPlugin;
	export let initialPath: string | undefined = undefined;
	// `const`, not `let`: nothing in this component reads onClose anymore
	// (its only caller, handleClose, was removed, `close`
	// was one of the two unreachable svelte:component listeners). Still a
	// real, meaningful callback the caller (RelaySettingsPage.ts) passes at
	// construction to close the whole Obsidian settings tab; kept as part of
	// this component's public API rather than deleted, since removing it
	// would ripple into the caller for a question ("should there be an
	// internal close affordance") beyond this card's scope of removing PROVEN
	// unreachable listeners. Svelte's own compiler suggested this exact fix
	// (`export const` for a prop that's set once and never read internally)
	// -- confirmed safe: RelaySettingsPage.ts never $sets it after construction.
	export const onClose: () => void = () => {};

	const shareRegistry = live.shareRegistry;

	let vaultShare: VaultShare | undefined;
	let remoteFolder: RemoteFolderRecord | undefined;
	let currentComponent: typeof SyncedFolderManager | undefined;
	const history: NavView[] = [{}];

	function currentView(): NavView {
		return { vaultShare, activeRemoteFolder: remoteFolder, activeComponent: currentComponent };
	}

	function setPath(nextPath: string) {
		vaultShare = undefined;
		remoteFolder = undefined;

		const patch = resolvePath(nextPath, shareRegistry);
		vaultShare = patch.vaultShare;
		remoteFolder = patch.activeRemoteFolder;
		if (patch.activeComponent) {
			currentComponent = patch.activeComponent;
		}
	}

	$: {
		if (initialPath) {
			setPath(initialPath);
		}
	}

	function resetToRoot() {
		vaultShare = undefined;
		remoteFolder = undefined;
		currentComponent = undefined;
	}

	function handleGoBack(event: NavigateBackEvent) {
		if (event.detail.clear) {
			history.length = 0;
			resetToRoot();
			return;
		}

		const result = popToRestorableView(history, shareRegistry);
		if (result.action === "apply") {
			vaultShare = result.view.vaultShare;
			remoteFolder = result.view.activeRemoteFolder;
			currentComponent = result.view.activeComponent;
		} else if (result.action === "reset") {
			resetToRoot();
		}
		// "noop": nothing on the stack was restorable -- leave the current
		// view exactly as it is, matching the original's fallthrough.
	}

	$: {
		if (vaultShare && !shareRegistry.contains(vaultShare)) {
			vaultShare = undefined;
			remoteFolder = undefined;
			currentComponent = undefined;
		}
	}

	$: if (currentComponent || vaultShare || remoteFolder) {
		window.setTimeout(() => {
			const content = activeDocument.querySelector(".vertical-tab-content");
			if (content) {
				(content as HTMLElement).scrollTop = 0;
			}
		}, 0);
	}

	function install() {
		// Update installation via announcement banner is not supported in relay-onprem mode
	}

	// SyncedFolderManager is the only "manage" detail view left (its sibling,
	// LinkedFolderManager, was deleted as unreachable code: the
	// remote-folder-role model it rendered never had a live data source).
	// activeManageView derives which view (if any) is active as plain data,
	// and the markup below renders it through <svelte:component>.
	//
	// Three events used to be listened for on that <svelte:component> --
	// `manageSharedFolder` (removed by), `close` and
	// `manageRemoteFolder`. All three were
	// dead: SyncedFolderManager is the only component ever substituted
	// through <svelte:component> (ManageViewState's own single-variant
	// union), and it dispatches only `goBack` (SyncedFolderManager.svelte:
	// 17,28) -- confirmed by reading its dispatch() call sites, not by grep
	// absence (grep cannot prove a dynamic Svelte binding is unreachable),
	// and now enforced continuously by scripts/check-svelte-events.py's
	// static reachability graph (CI job `svelte-events`).
	//
	//'s own closing comment here previously cited "renamed the
	// listener to a bogus name, reran build/jest/lint, nothing reddened" as
	// its proof of deadness. That reasoning was retracted by: the
	// exact same experiment on `on:goBack` above -- a definitely LIVE
	// listener wired to this panel's own visible "back" button -- produces
	// the IDENTICAL all-green result, because nothing in this repo's gates
	// executes a Svelte click-to-dispatch interaction. "Nothing reddened"
	// was never evidence of deadness; it was evidence that no tool here
	// looks. The real proof is the static one stated above (read every
	// dispatch() site of the only substitutable component), which
	// check-svelte-events.py now re-derives and enforces on every push
	// instead of relying on this comment being trusted forever.
	type ManageViewState =
		| {
				component: typeof SyncedFolderManager;
				props: { live: TeamRelayPlugin; syncedFolder: VaultShare };
		  }
		| undefined;

	let activeManageView: ManageViewState;
	$: activeManageView = vaultShare
		? {
				component: SyncedFolderManager,
				props: { live, syncedFolder: vaultShare },
			}
		: undefined;
</script>

{#if activeManageView}
	<ModalBackBar on:goBack={handleGoBack}></ModalBackBar>
{:else if live.serviceHealth.lastReport}
	<AnnouncementBanner serviceStatus={live.serviceHealth.lastReport} onInstall={install} />
{/if}
<div class="vertical-tab-content" bind:this={contentEl}>
	{#if activeManageView}
		<svelte:component
			this={activeManageView.component}
			{...activeManageView.props}
			on:goBack={handleGoBack}
		/>
	{:else if live.authSession.isRelayOnPremMode()}
		<PresenceSettings {live} />
		{#if live.updater}<PluginUpdates updater={live.updater} />{/if}
		<RelayOnPremSettings {live} />
	{:else}
		<div class="setting-item-description">
			Relay-onprem mode is disabled. Re-enable it in plugin settings, or
			configure a server URL.
		</div>
	{/if}
</div>

<StatusOverlay {live} />

<style>
	.vertical-tab-content {
		max-height: var(--modal-max-height);
		position: relative;
	}
</style>
