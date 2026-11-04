<script context="module" lang="ts">
	export interface CollaboratorPresence {
		displayName: string;
		userId: string;
		avatarColor: string;
		avatarColorLight: string;
		avatarUrl?: string;
	}
</script>

<script lang="ts">
	import PresenceAvatar from "./PresenceAvatar.svelte";
	export let users: CollaboratorPresence[];
	export let totalCount: number;
	export let visibleCount: number;
	export let onExpand: () => void;

	// CSS handles the hover-expand animation; this only sets the resting
	// (collapsed) overlap so avatars stack tightest at the back.
	function restingOffset(index: number): string {
		return index === 0
			? "0"
			: index === 1
				? "-1em"
				: index === 2
					? "-1.4em"
					: "-1.8em";
	}
</script>

<div
	class="evc-avatar-stack"
	class:evc-multi-user={users.length > 1}
	on:click={onExpand}
	on:keydown={(e) => e.key === "Enter" && onExpand()}
	role="button"
	tabindex="0"
>
	{#each users as user, index (user.userId)}
		<div
			class="evc-stacked-avatar"
			style="z-index: {10 - index}; margin-left: {restingOffset(
				index,
			)}; transition: all 0.2s ease;"
			aria-label={user.displayName}
		>
			<PresenceAvatar {user} />
		</div>
	{/each}
	{#if totalCount > visibleCount}
		<div
			class="evc-more-indicator"
			style="z-index: 11; margin-top: 1em; margin-left: -1em; transition: all 0.2s ease;"
		>
			+{totalCount - visibleCount}
		</div>
	{/if}
</div>

<style>
	.evc-avatar-stack {
		display: flex;
		align-items: center;
		cursor: pointer;
		position: relative;
		transition: width 0.2s ease;
		overflow: visible;
	}

	.evc-stacked-avatar {
		position: relative;
	}

	.evc-avatar-stack.evc-multi-user .evc-stacked-avatar {
		transition: margin-left 0.2s ease;
	}

	/* Only enable hover expand on devices with hover capability (non-touch) */
	@media (hover: hover) and (pointer: fine) {
		.evc-avatar-stack.evc-multi-user:hover .evc-stacked-avatar {
			margin-left: -10px !important;
			margin-right: 2px;
			transition-delay: 300ms;
		}
	}

	.evc-more-indicator {
		width: 2em;
		height: 2em;
		border-radius: 50%;
		background-color: var(--background-modifier-border);
		border: 2px solid var(--text-muted);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.6em;
		font-weight: 600;
		color: var(--text-muted);
		position: relative;
	}
</style>
