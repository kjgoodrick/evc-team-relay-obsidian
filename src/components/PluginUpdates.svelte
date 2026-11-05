<script lang="ts">
	import type { PluginUpdater } from "../updates/PluginUpdater";
	import { RELEASE_REPOSITORY } from "../updates/releases";
	export let updater: PluginUpdater;
	$: state = $updater;
</script>

<section class="evc-plugin-updates" aria-label="Plugin updates">
	<h3>Plugin updates</h3>
	<p>Running {state.currentVersion}. Updates come from <a href="https://github.com/{RELEASE_REPOSITORY}/releases" target="_blank" rel="noopener noreferrer">our GitHub releases</a>, including previews.</p>
	<label class="evc-update-toggle"><input type="checkbox" checked={state.automatic} disabled={state.busy} on:change={(event) => updater.setAutomatic(event.currentTarget.checked)} /> Automatically check once a day</label>
	<p role="status" aria-live="polite">{state.message}</p>
	{#if state.error}<p class="evc-update-error" role="alert">{state.error}</p>{/if}
	<div class="evc-update-actions">
		<button disabled={state.busy || !!state.installedVersion} on:click={() => updater.check()}>Check for updates</button>
		{#if state.release && !state.installedVersion}
			<a href={state.release.url} target="_blank" rel="noopener noreferrer">Release notes</a>
			<button class="mod-cta" disabled={state.busy} on:click={() => updater.install()}>Update to {state.release.version}</button>
		{/if}
	</div>
	{#if state.release && !state.installedVersion}<p class="setting-item-description">Installing keeps your current session running. Save your edits and restart Obsidian afterwards. Settings and notes are preserved.</p>{/if}
</section>

<style>
	.evc-plugin-updates { margin-bottom: 24px; padding: 16px; border: 1px solid var(--background-modifier-border); border-radius: 8px; overflow-wrap: anywhere; }
	.evc-plugin-updates h3 { margin: 0 0 8px; }
	.evc-plugin-updates p { margin: 8px 0; }
	.evc-update-toggle { display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; }
	.evc-update-toggle input { flex-shrink: 0; }
	.evc-update-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
	.evc-update-actions button, .evc-update-actions a { min-height: 44px; height: auto; white-space: normal; }
	.evc-update-actions a { display: inline-flex; align-items: center; }
	.evc-update-error { color: var(--text-error); }
</style>
