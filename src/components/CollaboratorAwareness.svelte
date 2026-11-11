<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import type { Awareness } from "y-protocols/awareness.js";
	import { derived, writable } from "svelte/store";
	import AvatarStack, { type CollaboratorPresence } from "./AvatarStack.svelte";
	import UserPopover from "./UserPopover.svelte";
	import { presenceColorForUser } from "../presenceColor";

	export let collabAwareness: Awareness;
	export let authorized = true;
	export let fallbackSelf: { id: string; name: string; avatarUrl?: string } | undefined = undefined;

	const VISIBLE_AVATAR_COUNT = 4;

	let showPopover = false;
	let popoverElement: HTMLElement;

	let stopListening: (() => void) | null = null;
	const allUsers = writable<CollaboratorPresence[]>([]);
	function bindAwareness(observed: Awareness, fallback: typeof fallbackSelf) {
		stopListening?.();
		const onChange = () => allUsers.set(currentUserFirst(usersFromAwarenessStates(observed, fallback), observed.getLocalState()?.user?.id ?? fallback?.id));
		observed.on("change", onChange);
		stopListening = () => observed.off("change", onChange);
		onChange();
	}
	$: bindAwareness(collabAwareness, fallbackSelf);

	function usersFromAwarenessStates(live: Awareness, fallback: typeof fallbackSelf): CollaboratorPresence[] {
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

		if (fallback && !seen.has(fallback.id)) {
			const { color, light } = presenceColorForUser(fallback);
			users.push({ userId: fallback.id, displayName: fallback.name, avatarUrl: fallback.avatarUrl, avatarColor: color, avatarColorLight: light });
		}
		return users;
	}

	function currentUserFirst(users: CollaboratorPresence[], localUserId?: string) {
		return [...users].sort((a, b) => {
			if (a.userId === localUserId) return -1;
			if (b.userId === localUserId) return 1;
			return 0;
		});
	}

	// Stack shows the local user last, capped to VISIBLE_AVATAR_COUNT total.
	const displayUsers = derived(allUsers, ($allUsers) => {
		if ($allUsers.length === 0) return [];

		const localUserId = collabAwareness?.getLocalState()?.user?.id ?? fallbackSelf?.id;
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

{#if authorized && $allUsers.length > 0}
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
