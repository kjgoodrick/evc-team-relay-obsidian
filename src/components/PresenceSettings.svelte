<script lang="ts">
	import type TeamRelayPlugin from "../main";
	import { Notice } from "obsidian";
	export let live: TeamRelayPlugin;
	const preferences = live.presenceSettings;
	async function change(visible: boolean) {
		if (live.presence) await live.presence.setVisible(visible);
		else try { await preferences.mutateValue(current => ({ ...current, visible })); }
		catch { new Notice("The presence preference could not be saved."); }
	}
</script>

<section class="relay-presence-settings" aria-label="Presence">
	<h3>Presence</h3>
	<label><input type="checkbox" checked={$preferences?.visible !== false} on:change={event => change(event.currentTarget.checked)} /> Share my presence</label>
	<p class="setting-item-description">Show your location and selection in the shared note you are viewing. Turning this off hides your presence; sync and comments stay available.</p>
	{#if live.presence}<button on:click={() => live.presence?.openControls()}>Presence controls</button>{/if}
</section>

<style>
	.relay-presence-settings { margin-bottom: 24px; padding: 16px; border: 1px solid var(--background-modifier-border); border-radius: 8px; }
	h3 { margin: 0 0 8px; }
	label { display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; }
	button { min-height: 44px; height: auto; white-space: normal; }
</style>
