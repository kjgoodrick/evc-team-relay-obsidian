<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import type { Awareness } from "y-protocols/awareness.js";
	import { derived, writable } from "svelte/store";
	import AvatarStack, { type CollaboratorPresence } from "./AvatarStack.svelte";
	import UserPopover from "./UserPopover.svelte";
	import { presenceColorForUser } from "../presenceColor";

	export let collabAwareness: Awareness;

	const VISIBLE_AVATAR_COUNT = 4;

	let showPopover = false;
	let popoverElement: HTMLElement;

	// Awareness has no store interface of its own -- it's an EventEmitter
	// ("change" fires whenever any client's state updates). This tick
	// counter is a bridge: bumping it is what makes `allUsers` below
	// recompute on every awareness change, the same way a writable store
	// update recomputes anything derived from it.
	const awarenessTick = writable(0);
	let stopListening: (() => void) | null = null;

	$: if (collabAwareness) {
		stopListening?.();
		const onChange = () => awarenessTick.update((n) => n + 1);
		collabAwareness.on("change", onChange);
		awarenessTick.set(0);
		stopListening = () => collabAwareness.off("change", onChange);
	}

	function usersFromAwarenessStates(live: Awareness): CollaboratorPresence[] {
		const seen = new Set<string>();
		const users: CollaboratorPresence[] = [];

		live.getStates().forEach((state) => {
			const user = state.user;
			if (!user?.name || !user?.id || seen.has(user.id)) return;
			seen.add(user.id);
			const { color, light } = presenceColorForUser(user);
			users.push({
				displayName: user.name,
				userId: user.id,
				avatarColor: color,
				avatarColorLight: light,
				avatarUrl: user.avatarUrl,
			});
		});

		return users;
	}

	function currentUserFirst(users: CollaboratorPresence[], localUserId?: string) {
		return [...users].sort((a, b) => {
			if (a.userId === localUserId) return -1;
			if (b.userId === localUserId) return 1;
			return 0;
		});
	}

	// Deduped by user id, ordered with the local user first.
	const allUsers = derived(awarenessTick, () => {
		if (!collabAwareness) return [];
		const localUserId = collabAwareness.getLocalState()?.user?.id;
		return currentUserFirst(usersFromAwarenessStates(collabAwareness), localUserId);
	});

	// Stack shows the local user last, capped to VISIBLE_AVATAR_COUNT total.
	const displayUsers = derived(allUsers, ($allUsers) => {
		if ($allUsers.length === 0) return [];

		const localUserId = collabAwareness?.getLocalState()?.user?.id;
		const currentUser = $allUsers.find((user) => user.userId === localUserId);
		const otherUsers = $allUsers.filter((user) => user.userId !== localUserId);

		if (!currentUser) {
			return otherUsers.slice(0, VISIBLE_AVATAR_COUNT);
		}
		const roomForOthers =
			$allUsers.length <= VISIBLE_AVATAR_COUNT ? otherUsers.length : VISIBLE_AVATAR_COUNT - 1;
		return [...otherUsers.slice(0, roomForOthers), currentUser];
	});

	function togglePopover() {
		showPopover = !showPopover;
	}

	function handleClickOutside(event: MouseEvent) {
		if (popoverElement && !popoverElement.contains(event.target as Node)) {
			showPopover = false;
		}
	}

	onMount(() => {
		activeDocument.addEventListener("click", handleClickOutside);
		return () => activeDocument.removeEventListener("click", handleClickOutside);
	});

	onDestroy(() => {
		stopListening?.();
		activeDocument.removeEventListener("click", handleClickOutside);
	});
</script>

{#if $allUsers.length > 0}
	<div class="evc-user-awareness" bind:this={popoverElement}>
		<AvatarStack
			users={$displayUsers}
			totalCount={$allUsers.length}
			visibleCount={VISIBLE_AVATAR_COUNT}
			onExpand={togglePopover}
		/>
		{#if showPopover}
			<UserPopover users={$allUsers} />
		{/if}
	</div>
{/if}

<style>
	:global(.evc-user-awareness-container) {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		margin-left: 12px;
		position: relative;
	}

	.evc-user-awareness {
		position: relative;
		display: flex;
		align-items: center;
	}
</style>
