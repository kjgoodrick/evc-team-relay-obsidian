<script lang="ts">
	import type TeamRelayPlugin from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import type { ShareWithServer } from "../RelayOnPremShareClientManager";
	import RelayOnPremServerList from "./RelayOnPremServerList.svelte";
	import ShareListView from "./ShareListView.svelte";
	import ShareDetailView from "./ShareDetailView.svelte";
	import CreateShareView from "./CreateShareView.svelte";
	import CreateInviteView from "./CreateInviteView.svelte";
	import BillingView from "./BillingView.svelte";
	import AgentKeysView from "./AgentKeysView.svelte";
	import NavTrail from "./NavTrail.svelte";
	import evcLogo from "../assets/evc-logo.png";
	import { uiText } from "../wording/uiText";

	export let live: TeamRelayPlugin;

	// Refresh key — incremented on login/logout via serversChanged event
	let authRefreshKey = 0;

	const EVC_URL = "https://github.com/entire-vc";

	// Navigation state
	type ViewType = "servers" | "shares" | "shareDetail" | "createShare" | "createInvite" | "billing" | "agentKeys";
	let currentView: ViewType = "servers";
	let selectedServer: RelayOnPremServer | null = null;
	let selectedShare: ShareWithServer | null = null;

	// Navigation functions
	function navigateTo(view: ViewType) {
		currentView = view;
		if (view === "servers") {
			selectedServer = null;
			selectedShare = null;
		} else if (view === "shares") {
			selectedShare = null;
		}
	}

	function handleOpenShares(event: CustomEvent<{ server: RelayOnPremServer }>) {
		selectedServer = event.detail.server;
		selectedShare = null;
		currentView = "shares";
	}

	function handleOpenBilling(event: CustomEvent<{ server: RelayOnPremServer }>) {
		selectedServer = event.detail.server;
		selectedShare = null;
		currentView = "billing";
	}

	function handleSelectShare(event: CustomEvent<{ share: ShareWithServer }>) {
		selectedShare = event.detail.share;
		currentView = "shareDetail";
	}

	function handleShareCreated() {
		// Go back to shares list to see the new share
		currentView = "shares";
	}

	function handleShareDeleted() {
		selectedShare = null;
		currentView = "shares";
	}

	function handleCreateInviteDone() {
		// Go back to share detail to see the new invite
		currentView = "shareDetail";
	}

	function handleOpenAgentKeys() {
		currentView = "agentKeys";
	}

	function handleOpenServerAgentKeys(event: CustomEvent<{ server: RelayOnPremServer }>) {
		selectedServer = event.detail.server;
		selectedShare = null;
		currentView = "agentKeys";
	}

	// Breadcrumb items
	$: breadcrumbItems = getBreadcrumbs(currentView, selectedServer, selectedShare);

	function getBreadcrumbs(view: ViewType, server: RelayOnPremServer | null, share: ShareWithServer | null) {
		const items: any[] = [
			{ type: "home", onClick: () => navigateTo("servers") },
		];

		if (server && view !== "servers") {
			items.push({
				type: "text",
				text: server.name,
				onClick: () => navigateTo("shares"),
			});
		}

		if (view === "billing") {
			items.push({ type: "text", text: uiText("shell.breadcrumb.planUsage") });
		} else if (view === "createShare") {
			items.push({ type: "text", text: uiText("shared.createShareButton") });
		} else if (view === "createInvite" && share) {
			items.push({
				type: "text",
				text: share.path,
				onClick: () => navigateTo("shareDetail"),
			});
			items.push({ type: "text", text: uiText("shell.breadcrumb.createInvite") });
		} else if (view === "agentKeys") {
			if (share) {
				items.push({
					type: "text",
					text: share.path,
					onClick: () => navigateTo("shareDetail"),
				});
			}
			items.push({ type: "text", text: uiText("shell.breadcrumb.agentKeys") });
		} else if (share && (view === "shareDetail")) {
			items.push({ type: "text", text: share.path });
		}

		return items;
	}
</script>

<div class="evc-relay-settings">
	<!-- Direction B — Native toolbar header -->
	<div class="evc-settings-header">
		<!-- Top row: logo + title/desc + ghost icon buttons -->
		<div class="evc-header-top">
			<img src={evcLogo} alt="EVC Logo" class="evc-header-logo" />
			<div class="evc-header-text">
				<div class="evc-header-title">Team Relay permissions preview</div>
				<div class="evc-header-desc">Experimental self-hosted fork of EVC Team Relay</div>
			</div>
			<div class="evc-header-actions">
				<a class="evc-ghost-btn" href="https://github.com/kjgoodrick/evc-team-relay-obsidian" target="_blank" rel="noopener">Fork source</a>
				<a class="evc-ghost-btn" href="https://github.com/kjgoodrick/evc-team-relay-obsidian/issues" target="_blank" rel="noopener">Report an issue</a>
			</div>
		</div>
		<div class="evc-header-ctas">
			<a class="evc-prim-btn" href="https://github.com/kjgoodrick/evc-team-relay/blob/main/docs/permissions-preview.md" target="_blank" rel="noopener">Permissions preview setup</a>
		</div>
	</div>

	<!-- Breadcrumb Navigation -->
	{#if currentView !== "servers"}
		<div class="evc-breadcrumb-bar">
			<NavTrail waypoints={breadcrumbItems} />
		</div>
	{/if}

	<!-- Content Area -->
	<div class="evc-settings-content">
		{#if currentView === "servers"}
			<div class="evc-server-section">
				<div class="evc-section-heading">
					<div class="evc-section-heading-title">{uiText("shell.servers.heading")}</div>
					<div class="evc-section-heading-desc">
						{uiText("shell.servers.desc")}
					</div>
				</div>
				<RelayOnPremServerList {live} on:openShares={handleOpenShares} on:openBilling={handleOpenBilling} on:openAgentKeys={handleOpenServerAgentKeys} on:serversChanged={() => { authRefreshKey++; }} />
			</div>
		{:else if currentView === "shares" && selectedServer}
			<ShareListView
				{live}
				server={selectedServer}
				on:selectShare={handleSelectShare}
				on:createShare={() => { currentView = "createShare"; }}
			/>
		{:else if currentView === "shareDetail" && selectedServer && selectedShare}
			<ShareDetailView
				{live}
				server={selectedServer}
				share={selectedShare}
				on:createInvite={() => { currentView = "createInvite"; }}
				on:deleted={handleShareDeleted}
				on:agentKeys={handleOpenAgentKeys}
				on:updated={(e) => { selectedShare = e.detail; }}
			/>
		{:else if currentView === "createShare" && selectedServer}
			<CreateShareView
				{live}
				server={selectedServer}
				on:created={handleShareCreated}
				on:cancel={() => navigateTo("shares")}
			/>
		{:else if currentView === "createInvite" && selectedServer && selectedShare}
			<CreateInviteView
				{live}
				share={selectedShare}
				on:created={handleCreateInviteDone}
				on:cancel={() => navigateTo("shareDetail")}
			/>
		{:else if currentView === "billing" && selectedServer}
			<BillingView
				{live}
				server={selectedServer}
			/>
		{:else if currentView === "agentKeys" && selectedServer}
			<AgentKeysView
				{live}
				server={selectedServer}
				initialShare={selectedShare}
			/>
		{/if}
	</div>
</div>

<style>
	.evc-relay-settings {
		padding: 0;
	}

	/* Header — Direction B (native toolbar) */
	.evc-settings-header {
		padding: 16px 20px;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.evc-header-top {
		display: flex;
		align-items: center;
		gap: 14px;
		/* At narrow widths (Obsidian mobile settings, ~233px inner row on a
		   393px viewport) the fixed-size logo (32px) + ghost-icon actions
		   (126px, flex:none) alone leave ~47px for the title/desc column,
		   which pushed the wrap down to one word per line. Letting the row
		   wrap moves the actions onto their own line instead, so the title
		   column keeps a real floor (see .evc-header-text below). */
		flex-wrap: wrap;
	}

	.evc-header-logo {
		width: 32px;
		height: 32px;
		border-radius: 7px;
		flex: none;
	}

	.evc-header-text {
		/* Floor of 160px so the title/desc wrap by word instead of being
		   squeezed to the width of "self-hosted"'s longest fragment once
		   .evc-header-actions no longer fits on the same line. */
		flex: 1 1 160px;
		min-width: 160px;
	}

	.evc-header-title {
		font-size: 17px;
		font-weight: 700;
		color: var(--text-normal);
		letter-spacing: -0.2px;
		line-height: 1.2;
	}

	.evc-header-desc {
		font-size: 13px;
		color: var(--text-muted);
		margin-top: 1px;
	}

	.evc-header-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		flex: 0 1 auto;
	}

	.evc-ghost-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		padding: 8px;
		white-space: nowrap;
		border-radius: var(--radius-s, 6px);
		color: var(--text-faint);
		text-decoration: none;
		transition: background 0.15s, color 0.15s;
	}

	.evc-ghost-btn:hover {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	.evc-ghost-btn svg {
		width: 16px;
		height: 16px;
	}

	/* CTA row */
	.evc-header-ctas {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--background-modifier-border);
		flex-wrap: wrap;
	}

	.evc-prim-btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 34px;
		padding: 0 14px;
		border-radius: var(--radius-s, 6px);
		background: rgba(124, 92, 255, 0.1);
		color: var(--interactive-accent);
		border: 1px solid rgba(124, 92, 255, 0.2);
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
		transition: background 0.15s;
	}

	.evc-prim-btn:hover {
		background: rgba(124, 92, 255, 0.18);
	}

	.evc-prim-btn svg {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}

	.evc-mesh-btn {
		background: rgba(0, 105, 106, 0.1);
		color: #00696a;
		border-color: rgba(0, 105, 106, 0.2);
	}

	.evc-mesh-btn:hover {
		background: rgba(0, 105, 106, 0.18);
	}

	/* NavTrail */
	.evc-breadcrumb-bar {
		padding: 10px 20px;
		border-bottom: 1px solid var(--background-modifier-border);
		font-size: 0.9em;
	}

	/* Content */
	.evc-settings-content {
		padding: 16px 20px;
	}

	/* Server section heading */
	.evc-server-section {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.evc-section-heading {
		margin-bottom: 4px;
	}

	.evc-section-heading-title {
		font-weight: 600;
		font-size: 1.1em;
	}

	.evc-section-heading-desc {
		color: var(--text-muted);
		font-size: 0.9em;
		margin-top: 4px;
	}
</style>
