<script lang="ts">
	import { Layers, Satellite } from "lucide-svelte";
	import type { TrackedViewBinding } from "../ViewBindings";
	import type { ConnectionState } from "../ProviderBacked";
	import type { RemoteFolderRecord } from "src/RelayModel";

	export let liveView: TrackedViewBinding;
	// The binding object keeps its identity while this field changes. Pass the
	// primitive separately so the Svelte 5 mount adapter can invalidate it.
	export let isTracking: boolean;
	export let connectionState: ConnectionState;
	export let linked: RemoteFolderRecord | undefined;
	export let signedOut = false;
	export let onSignIn: (() => Promise<boolean>) | undefined = undefined;

	const TRACKING_LABELS: Record<"synced" | "unsynced", string> = {
		synced: "Tracking changes: local file and update log are in sync",
		unsynced: "Not tracking changes: local file and update log are not in sync",
	};

	$: trackingClass = isTracking ? "evc-notebook-synced" : "notebook";
	$: trackingLabel = TRACKING_LABELS[isTracking ? "synced" : "unsynced"];

	function onRelayClick() {
		if (signedOut) {
			void onSignIn?.();
		} else {
			liveView.toggleConnectionIntent();
		}
	}

	function onRelayKeyPress(event: KeyboardEvent) {
		if (event.key === "Enter") onRelayClick();
	}
</script>

{#if !signedOut}
	<button
		aria-label={trackingLabel}
		class="clickable-icon view-action evc-relay-view-action {trackingClass}"
		data-filename={liveView.hostView.file?.name}
		tabindex="0"
	>
		<Layers class="svg-icon evc-inline-icon" />
	</button>
	{#if linked}
		<button
			aria-label={`${linked.workspace.displayName} (${connectionState.status})`}
			class="evc-relay-{connectionState.status} clickable-icon view-action evc-relay-view-action"
			on:click={onRelayClick}
			on:keypress={onRelayKeyPress}
			tabindex="0"
		>
			<Satellite class="svg-icon evc-inline-icon" />
		</button>
	{/if}
{/if}

<style>
	button.notebook {
		background-color: transparent;
		color: var(--color-base-40);
	}

	button.evc-notebook-synced {
		color: var(--color-accent);
	}

	button.evc-relay-connected {
		color: var(--color-accent);
	}

	button.evc-relay-disconnected {
		color: var(--color-base-40);
	}
</style>
