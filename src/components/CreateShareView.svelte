<script lang="ts">
	import { Notice } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type TeamRelayPlugin from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import { getDefaultServer } from "../RelayOnPremConfig";
	import type { RelayOnPremShare } from "../RelayOnPremShareClient";
	import { LimitExceededApiError } from "../RelayOnPremShareClient";
	import { FolderPathPickerModal } from "../ui/FolderPathPickerModal";
	import { ResourceAddress } from "../ResourceAddress";
	import { uiText } from "../wording/uiText";
	import { toSharePath } from "../vaultRootPath";
	import { buildVaultIdentity } from "../vaultIdentity";

	export let live: TeamRelayPlugin;
	export let server: RelayOnPremServer;

	const dispatch = createEventDispatcher<{
		created: { share: RelayOnPremShare };
		cancel: void;
	}>();

	let selectedPath = "";
	let kind: "doc" | "folder" = "folder";
	let visibility: "private" | "public" | "protected" = "private";
	let password = "";
	let creating = false;

	function choosePath() {
		const modal = new FolderPathPickerModal(
			live.app,
			uiText("createShare.pickerTitle"),
			new Set(),
			live.shareRegistry,
			(folderPath: string) => {
				selectedPath = folderPath;
			},
		);
		modal.open();
	}

	async function handleCreate() {
		if (!selectedPath.trim()) {
			new Notice(uiText("createShare.pathRequiredNotice"));
			return;
		}
		if (visibility === "protected" && !password.trim()) {
			new Notice(uiText("shared.passwordRequiredNotice"));
			return;
		}

		creating = true;
		try {
			const createRequest = {
				// Obsidian reports the vault root's own path as "/" -- the
				// server's wire convention for "the whole vault" is "" (see
				// vaultRootPath.ts). selectedPath keeps showing "/" in the
				// picker button; only the value sent over the wire changes.
				path: toSharePath(selectedPath.trim()),
				kind,
				visibility,
				...(password.trim() && { password: password.trim() }),
				...buildVaultIdentity(live.instanceAppId, live.app.vault.getName()),
			};

			let share: RelayOnPremShare;
			if (live.shareClientManager) {
				share = await live.shareClientManager.createShare(server.id, createRequest);
			} else if (live.shareClient) {
				share = await live.shareClient.createShare(createRequest);
			} else {
				throw new Error(uiText("shared.noShareClientError"));
			}

			// Create local VaultShare for CRDT sync
			if (kind === "folder") {
				try {
					// freshlyCreated=true: this guid was just minted by the
					// createShare() call above, so no other client can already
					// have published a guid for anything in this folder.
					const vaultShare = await live.shareRegistry.newPrepared(share.path, share.id, "relay-onprem", false, true, server.id);
					if (vaultShare) {
						void vaultShare.bringOnline();
					}
					live.explorerDecorations?.refreshExistingRows();
				} catch (e: unknown) {
					console.error("[RelayOnPrem] Failed to create VaultShare:", e);
				}
			}

			new Notice(uiText("createShare.createdNotice", { path: share.path }));
			dispatch("created", { share });
		} catch (e: unknown) {
			if (e instanceof LimitExceededApiError) {
				const info = e.limitInfo;
				new Notice(
					uiText("createShare.limitReachedNotice", { current: info.current, max: info.max, plan: info.plan }),
					8000,
				);
			} else {
				new Notice(uiText("createShare.createFailedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
			}
		} finally {
			creating = false;
		}
	}
</script>

<div class="evc-create-share">
	<div class="evc-section-title">{uiText("createShare.title")}</div>

	<div class="evc-form-field">
		<label for="evc-path-btn">{uiText("createShare.pathLabel")}</label>
		<div class="evc-path-selector">
			<button id="evc-path-btn" class="evc-path-btn" on:click={choosePath}>
				{selectedPath || uiText("createShare.choosePlaceholder")}
			</button>
		</div>
	</div>

	<div class="evc-form-field">
		<label for="evc-kind">{uiText("createShare.typeLabel")}</label>
		<select id="evc-kind" class="dropdown" bind:value={kind}>
			<option value="doc">{uiText("createShare.docOption")}</option>
			<option value="folder">{uiText("createShare.folderOption")}</option>
		</select>
	</div>

	<div class="evc-form-field">
		<label for="evc-visibility">{uiText("createShare.visibilityLabel")}</label>
		<select id="evc-visibility" class="dropdown" bind:value={visibility}>
			<option value="private">{uiText("createShare.privateVisibilityOption")}</option>
			<option value="public">{uiText("createShare.publicVisibilityOption")}</option>
			<option value="protected">{uiText("createShare.protectedVisibilityOption")}</option>
		</select>
	</div>

	{#if visibility === "protected"}
		<div class="evc-form-field">
			<label for="evc-password">{uiText("shared.passwordLabel")}</label>
			<input
				id="evc-password"
				type="password"
				placeholder={uiText("createShare.passwordPlaceholder")}
				bind:value={password}
			/>
		</div>
	{/if}

	<div class="evc-form-actions">
		<button class="mod-cta" on:click={handleCreate} disabled={creating}>
			{creating ? uiText("shared.creatingEllipsis") : uiText("shared.createShareButton")}
		</button>
		<button on:click={() => dispatch('cancel')}>{uiText("shared.cancelButton")}</button>
	</div>
</div>

<style>
	.evc-create-share {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.evc-section-title {
		font-weight: 600;
		font-size: 1.05em;
	}

	.evc-form-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.evc-form-field label {
		font-size: 0.9em;
		color: var(--text-muted);
		font-weight: 500;
	}

	.evc-form-field input,
	.evc-form-field select {
		width: 100%;
	}

	.evc-path-selector {
		display: flex;
	}

	.evc-path-btn {
		flex: 1;
		text-align: left;
		padding: 8px 12px;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 6px;
		cursor: pointer;
		color: var(--text-normal);
	}

	.evc-path-btn:hover {
		border-color: var(--interactive-accent);
	}

	.evc-form-actions {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}
</style>
