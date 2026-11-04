<script lang="ts">
	import type { CollaboratorPresence } from "./AvatarStack.svelte";
	import PresenceAvatar from "./PresenceAvatar.svelte";

	export let users: CollaboratorPresence[];
</script>

<div class="evc-user-popover">
	<div class="evc-popover-header">
		Active Users ({users.length})
	</div>
	<div class="evc-user-list">
		{#each users as user, index (user.userId)}
			<div class="evc-user-item" class:evc-current-user={index === 0}>
				<PresenceAvatar {user} size="20px" />
				<span class="evc-user-name"
					>{user.displayName}{index === 0 ? " (You)" : ""}</span
				>
			</div>
		{/each}
	</div>
</div>

<style>
	.evc-user-popover {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 8px;
		background: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 8px;
		box-shadow: var(--shadow-s);
		min-width: 200px;
		max-width: 300px;
		z-index: 1000;
	}

	.evc-user-popover::before {
		content: "";
		position: absolute;
		top: -8px;
		right: 20px;
		width: 0;
		height: 0;
		border-left: 8px solid transparent;
		border-right: 8px solid transparent;
		border-bottom: 8px solid var(--background-modifier-border);
	}

	.evc-user-popover::after {
		content: "";
		position: absolute;
		top: -7px;
		right: 20px;
		width: 0;
		height: 0;
		border-left: 8px solid transparent;
		border-right: 8px solid transparent;
		border-bottom: 8px solid var(--background-secondary);
	}

	.evc-popover-header {
		padding: 12px 16px 8px 16px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
		border-bottom: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		border-radius: 8px 8px 0 0;
	}

	.evc-user-list {
		padding: 8px 0;
		max-height: 200px;
		overflow-y: auto;
	}

	.evc-user-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 6px 16px;
		cursor: default;
	}

	.evc-user-item:hover {
		background-color: var(--background-modifier-hover);
	}

	.evc-user-name {
		font-size: 14px;
		color: var(--text-normal);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
