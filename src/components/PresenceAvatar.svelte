<script lang="ts">
	import type { CollaboratorPresence } from "./AvatarStack.svelte";
	import { safeAvatarUrl } from "../presenceAvatar";
	export let user: CollaboratorPresence;
	export let size = "2em";
	function checkCachedImage(image: HTMLImageElement) {
		if (image.complete && image.naturalWidth > 0) loaded = true;
	}
	let previousUrl: string | undefined;
	let loaded = false;
	let failed = false;
	$: imageUrl = safeAvatarUrl(user.avatarUrl);
	$: if (imageUrl !== previousUrl) {
		previousUrl = imageUrl;
		loaded = false;
		failed = false;
	}
</script>

<div class="evc-avatar-with-border" style="border-color: {user.avatarColor};">
	<div class="evc-user-avatar" style="background-color: {imageUrl && !failed ? 'var(--background-secondary)' : user.avatarColor}; width: {size}; height: {size};">
		{#if !imageUrl || failed}
			<span class="evc-user-initial" aria-hidden="true">{user.displayName.charAt(0).toUpperCase()}</span>
		{/if}
		{#if imageUrl && !failed}
			{#key imageUrl}
				<img class="evc-user-picture" src={imageUrl} alt="" aria-hidden="true"
					referrerpolicy="no-referrer" draggable="false"
					class:evc-picture-loaded={loaded}
					use:checkCachedImage
					on:load={() => loaded = true} on:error={() => failed = true} />
			{/key}
		{/if}
	</div>
</div>

<style>
	.evc-avatar-with-border {
		border-radius: 50%; border: 2px solid; display: inline-block; overflow: hidden;
		flex-shrink: 0; background: var(--background-primary); box-sizing: border-box; padding: 1px;
	}
	.evc-user-avatar {
		border-radius: 50%; overflow: hidden; display: flex; align-items: center;
		justify-content: center; flex-shrink: 0; position: relative;
	}
	.evc-user-initial { color: white; font-size: 1em; font-weight: 600; }
	.evc-user-picture {
		position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
		border-radius: inherit; visibility: hidden; pointer-events: none;
	}
	.evc-picture-loaded { visibility: visible; }
</style>
