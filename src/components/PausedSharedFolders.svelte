<script lang="ts">
	import { onMount } from "svelte";
	import type TeamRelayPlugin from "../main";
	export let live: TeamRelayPlugin;
	const registry = live.shareRegistry;
	let failures = registry.startupFailures;
	let retrying: string | undefined;
	let error = "";
	onMount(() => registry.on(() => { failures = registry.startupFailures; }));
	async function retry(guid: string) {
		if (retrying) return;
		retrying = guid; error = "";
		try { await live.retrySharedFolderStartup(guid); }
		catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		finally { failures = registry.startupFailures; retrying = undefined; }
	}
</script>

{#if failures.length || error}
	<section aria-label="Paused shared folders">
		<h3>Paused shared folders</h3>
		<p class="setting-item-description">These folders could not start safely. Their local files and cached history are retained. Retry checks the current recovery state; it does not discard work or approve a restore.</p>
		{#each failures as failure (failure.guid)}
			<div class="setting-item">
				<div class="setting-item-info">
					<div class="setting-item-name">{failure.path || "Vault root"}</div>
					<div class="setting-item-description">{failure.message}</div>
				</div>
				<div class="setting-item-control">
					<button disabled={retrying !== undefined} aria-label={`Retry startup for ${failure.path || "vault root"}`} on:click={() => retry(failure.guid)}>{retrying === failure.guid ? "Checking…" : "Retry"}</button>
				</div>
			</div>
		{/each}
		{#if error}<p role="status">{error}</p>{/if}
	</section>
{/if}
