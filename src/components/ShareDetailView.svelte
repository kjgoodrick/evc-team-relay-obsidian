<script lang="ts">
	import { copyToClipboard } from "../utils/clipboard";
	import { onMount, onDestroy } from "svelte";
	import { Notice, Setting, TFile } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type TeamRelayPlugin from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import type { ShareMember, Invite, WebFolderEntry } from "../RelayOnPremShareClient";
	import { LimitExceededApiError, VisibilityNotAllowedApiError } from "../RelayOnPremShareClient";
	import type { ShareWithServer } from "../RelayOnPremShareClientManager";
	import { canManagePermissionPolicy, openPermissionEditor } from "../ui/openPermissionEditor";
	import { FolderPathPickerModal } from "../ui/FolderPathPickerModal";
	import { confirmDialog, promptDialog, choiceDialog } from "../ui/dialogs";
	import { withOutboundSyncGuard } from "../WebSyncManager";
	import { pushFolderContentToServer as pushFolderContentToServerCore } from "../webPublish/pushFolderContentToServer";
	import { uiText } from "../wording/uiText";
	import { collectWebFolderItems, joinFolderPath, resolveShareFolder, toSharePath } from "../vaultRootPath";

	export let live: TeamRelayPlugin;
	export let server: RelayOnPremServer;
	export let share: ShareWithServer;

	const dispatch = createEventDispatcher<{
		createInvite: void;
		deleted: void;
		back: void;
		agentKeys: void;
		updated: ShareWithServer;
	}>();

	let members: ShareMember[] = [];
	let invites: Invite[] = [];
	let isOwner = false;
	let canManagePermissions = false;
	let disposed = false;
	onDestroy(() => { disposed = true; });
	let loading = true;
	let webPublishEnabled = false;
	let webPublishDomain: string | null = null;
	let currentShare = share;
	let publishCheckboxEl: HTMLInputElement | undefined;

	// currentShare is a local working copy, mutated in place by
	// changeVisibility/toggleWebPublishing/renameSlug. The parent
	// (RelayOnPremSettings) holds its own `selectedShare` reference used as
	// this component's `share` prop, and never learns about those local
	// mutations. Create Invite/cancel round-trips currentView away from
	// "shareDetail" and back, which destroys and recreates this component --
	// the fresh instance re-seeds `currentShare = share` from the parent's
	// now-stale copy, visually reverting a visibility/publish change that was
	// never actually undone server-side. Push every local update back up so
	// the parent's copy never falls behind.
	$: dispatch("updated", currentShare);

	// Svelte's `checked={isPublished}` binding only writes to the DOM when
	// the *computed* `isPublished` value actually differs from its previous
	// value ($$invalidate's own dirty-check, not something this component
	// controls) -- reassigning `currentShare` to a fresh object is not
	// enough by itself when the recomputed boolean ends up unchanged (e.g.
	// a failed publish attempt: isPublished was false, stays false). But the
	// checkbox's own native DOM `checked` already flipped from the click
	// itself, independently of the model, and Svelte has no way to know
	// that drift happened. Force the DOM back in line explicitly.
	function syncPublishCheckbox() {
		if (publishCheckboxEl) publishCheckboxEl.checked = currentShare.web_published ?? false;
	}

	// Add member form
	let newMemberEmail = "";
	let newMemberRole: "viewer" | "editor" = "editor";

	// Web slug editing
	let editingSlug = "";

	onMount(async () => {
		await loadDetails();
	});

	async function loadDetails() {
		loading = true;
		try {
			// Determine ownership
			const multiServerAuth = live.authSession.getMultiServerAuthManager();
			if (multiServerAuth) {
				const currentUser = multiServerAuth.getUserForServer(share.serverId);
				isOwner = currentUser?.id === share.owner_user_id;
			} else {
				const authProvider = live.authSession.getAuthProvider();
				const currentUser = authProvider?.getCurrentUser();
				isOwner = currentUser?.id === share.owner_user_id;
			}

			canManagePermissions = isOwner;
			if (share.managed && !isOwner) {
				void canManagePermissionPolicy(live, share).then(allowed => { if (!disposed) canManagePermissions = allowed; });
			}

			// Load all data in parallel
			const [serverInfo, membersResult, invitesResult] = await Promise.all([
				loadServerInfo(),
				loadMembers(),
				isOwner ? loadInvites() : Promise.resolve([]),
			]);

			webPublishEnabled = serverInfo?.features?.web_publish_enabled ?? false;
			webPublishDomain = serverInfo?.features?.web_publish_domain ?? null;
			members = membersResult;
			invites = invitesResult;
			editingSlug = currentShare.web_slug || "";
		} catch (e: unknown) {
			new Notice(uiText("shareDetail.loadFailedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
		} finally {
			loading = false;
		}
	}

	function managePathPermissions() {
		openPermissionEditor(live, share, members);
	}

	async function loadServerInfo() {
		try {
			if (live.shareClientManager) {
				const client = live.shareClientManager.getClient(share.serverId);
				if (client) return await client.getServerInfo();
			} else if (live.shareClient) {
				return await live.shareClient.getServerInfo();
			}
		} catch { /* server info optional */ }
		return null;
	}

	async function loadMembers(): Promise<ShareMember[]> {
		if (live.shareClientManager) {
			return live.shareClientManager.getShareMembers(share.serverId, share.id);
		} else if (live.shareClient) {
			return live.shareClient.getShareMembers(share.id);
		}
		return [];
	}

	async function loadInvites(): Promise<Invite[]> {
		try {
			if (live.shareClientManager) {
				return await live.shareClientManager.listInvites(share.serverId, share.id);
			} else if (live.shareClient) {
				return await live.shareClient.listInvites(share.id);
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : "";
			if (msg.includes("403") || msg.includes("Insufficient permissions")) {
				isOwner = false;
			} else {
				throw e;
			}
		}
		return [];
	}

	function copyId() {
		copyToClipboard(currentShare.id);
		new Notice(uiText("shareDetail.idCopiedNotice"));
	}

	// Members
	async function addMember() {
		if (!newMemberEmail.trim()) {
			new Notice(uiText("shareDetail.members.emailRequiredNotice"));
			return;
		}
		try {
			let user;
			if (live.shareClientManager) {
				user = await live.shareClientManager.searchUserByEmail(share.serverId, newMemberEmail.trim());
				await live.shareClientManager.addMember(share.serverId, share.id, { user_id: user.id, role: newMemberRole });
			} else if (live.shareClient) {
				user = await live.shareClient.searchUserByEmail(newMemberEmail.trim());
				await live.shareClient.addMember(share.id, { user_id: user.id, role: newMemberRole });
			}
			new Notice(uiText("shareDetail.members.addedNotice"));
			newMemberEmail = "";
			members = await loadMembers();
		} catch (e: unknown) {
			if (e instanceof LimitExceededApiError) {
				const info = e.limitInfo;
				new Notice(
					uiText("shareDetail.members.limitReachedNotice", { current: info.current, max: info.max, plan: info.plan }),
					8000,
				);
			} else {
				new Notice(e instanceof Error ? e.message : uiText("shareDetail.members.addFailedFallback"));
			}
		}
	}

	// Svelte's template-expression parser doesn't accept TS `as` casts inline
	// in markup, so the <select> value (typed as plain `string` by the DOM
	// lib) is narrowed here in the <script> block instead of at the call site.
	function handleMemberRoleChange(userId: string, value: string) {
		changeMemberRole(userId, value as "viewer" | "editor");
	}

	async function changeMemberRole(userId: string, role: "viewer" | "editor") {
		try {
			if (live.shareClientManager) {
				await live.shareClientManager.updateMemberRole(share.serverId, share.id, userId, role);
			} else if (live.shareClient) {
				await live.shareClient.updateMemberRole(share.id, userId, role);
			}
			new Notice(uiText("shareDetail.members.roleChangedNotice", { role }));
			members = await loadMembers();
		} catch (e: unknown) {
			new Notice(uiText("shareDetail.members.roleChangeFailedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
		}
	}

	async function removeMember(userId: string) {
		try {
			if (live.shareClientManager) {
				await live.shareClientManager.removeMember(share.serverId, share.id, userId);
			} else if (live.shareClient) {
				await live.shareClient.removeMember(share.id, userId);
			}
			new Notice(uiText("shareDetail.members.removedNotice"));
			members = await loadMembers();
		} catch (e: unknown) {
			new Notice(uiText("shareDetail.members.removeFailedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
		}
	}

	// Invites
	function getInviteDescription(invite: Invite): string {
		const isExpired = !!(invite.expires_at && new Date(invite.expires_at) < new Date());
		const isMaxed = invite.max_uses !== null && invite.use_count >= invite.max_uses;
		const parts: string[] = [];
		if (isExpired) parts.push(uiText("shareDetail.invites.expiredTag"));
		else if (isMaxed) parts.push(uiText("shareDetail.invites.maxUsesReachedTag"));
		if (invite.expires_at) {
			parts.push(uiText("shareDetail.invites.expiresLabel", { date: new Date(invite.expires_at).toLocaleDateString() }));
		} else {
			parts.push(uiText("shared.noExpiration"));
		}
		parts.push(
			invite.max_uses !== null
				? uiText("shareDetail.invites.usesWithMax", { used: invite.use_count, max: invite.max_uses })
				: uiText("shareDetail.invites.usesNoMax", { used: invite.use_count })
		);
		return parts.join(" \u2022 ");
	}

	function isInviteValid(invite: Invite): boolean {
		const isExpired = !!(invite.expires_at && new Date(invite.expires_at) < new Date());
		const isMaxed = invite.max_uses !== null && invite.use_count >= invite.max_uses;
		return !isExpired && !isMaxed;
	}

	function copyInviteLink(invite: Invite) {
		const normalizedUrl = server.controlPlaneUrl.replace(/\/+$/, "");
		const link = `${normalizedUrl}/invite/${invite.token}/page`;
		copyToClipboard(link);
		new Notice(uiText("shareDetail.invites.linkCopiedNotice"));
	}

	async function revokeInvite(inviteId: string) {
		if (!(await confirmDialog(live.app, uiText("shareDetail.invites.revokeConfirm")))) return;
		try {
			if (live.shareClientManager) {
				await live.shareClientManager.revokeInvite(share.serverId, share.id, inviteId);
			} else if (live.shareClient) {
				await live.shareClient.revokeInvite(share.id, inviteId);
			}
			new Notice(uiText("shareDetail.invites.revokedNotice"));
			invites = await loadInvites();
		} catch (e: unknown) {
			new Notice(uiText("shareDetail.invites.revokeFailedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
		}
	}

	// Visibility
	async function updateVisibility(newVisibility: string) {
		let password: string | undefined;
		if (newVisibility === "protected") {
			const input = await promptDialog(live.app, uiText("shareDetail.actions.passwordPrompt"));
			if (!input) {
				new Notice(uiText("shared.passwordRequiredNotice"));
				currentShare = { ...currentShare }; // trigger re-render to reset
				return;
			}
			password = input;
		}
		if (!(await confirmDialog(live.app, uiText("shareDetail.actions.visibilityConfirm", { visibility: newVisibility })))) {
			currentShare = { ...currentShare };
			return;
		}
		try {
			const payload: any = { visibility: newVisibility };
			if (password) payload.password = password;
			let updated;
			if (live.shareClientManager) {
				updated = await live.shareClientManager.updateShare(share.serverId, share.id, payload);
			} else if (live.shareClient) {
				updated = await live.shareClient.updateShare(share.id, payload);
			}
			if (updated) currentShare = { ...currentShare, ...updated };
			new Notice(uiText("shareDetail.actions.visibilityChangedNotice", { visibility: newVisibility }));
		} catch (e: unknown) {
			new Notice(uiText("shared.failedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
			currentShare = { ...currentShare };
		}
	}

	// Delete
	async function deleteShare() {
		if (!(await confirmDialog(live.app, uiText("shareDetail.actions.deleteConfirm", { path: currentShare.path })))) return;
		try {
			if (live.shareClientManager) {
				await live.shareClientManager.deleteShare(share.serverId, share.id);
			} else if (live.shareClient) {
				await live.shareClient.deleteShare(share.id);
			}
			// Clean up local VaultShare
			const localFolder = live.shareRegistry.locate((sf) => sf.entityGuid === share.id);
			if (localFolder) {
				live.shareRegistry.delete(localFolder);
				live.explorerDecorations?.refreshExistingRows();
			}
			new Notice(uiText("shareDetail.actions.deletedNotice"));
			dispatch("deleted");
		} catch (e: unknown) {
			new Notice(uiText("shareDetail.actions.deleteFailedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
		}
	}

	// Web Publishing
	async function toggleWebPublishing(enabled: boolean) {
		if (enabled && currentShare.visibility === "private") {
			// Private shares need visibility change before web publishing
			const newVisibility = await choiceDialog(
				live.app,
				uiText("shareDetail.webPublish.privatePublishPrompt"),
				[
					{ label: uiText("shareDetail.webPublish.makePublicChoice"), value: "public" },
					{ label: uiText("shareDetail.webPublish.makeProtectedChoice"), value: "protected" },
				]
			);
			if (!newVisibility) {
				syncPublishCheckbox();
				return;
			}

			try {
				const payload = { visibility: newVisibility as "public" | "protected" };
				if (live.shareClientManager) {
					await live.shareClientManager.updateShare(share.serverId, share.id, payload);
				} else if (live.shareClient) {
					await live.shareClient.updateShare(share.id, payload);
				}
				currentShare = { ...currentShare, visibility: newVisibility as "public" | "protected" };
			} catch (e: unknown) {
				if (e instanceof VisibilityNotAllowedApiError) {
					const info = e.visibilityInfo;
					new Notice(
						uiText("shareDetail.webPublish.visibilityNotAllowedNotice", { visibility: info.visibility, allowed: info.allowed.join(", ") }),
						8000,
					);
				} else {
					console.error("Failed to change visibility:", e);
					new Notice(uiText("shareDetail.webPublish.visibilityChangeFailedNotice"));
				}
				syncPublishCheckbox();
				return;
			}
		}

		try {
			const updatePayload: any = { web_published: enabled };
			let skippedFiles: string[] = [];
			if (enabled) {
				if (currentShare.kind === "doc") {
					const content = await getDocumentContent(currentShare.path);
					if (content) updatePayload.web_content = content;
				} else if (currentShare.kind === "folder") {
					const items = await getFolderItems(currentShare.path);
					if (items.length > 0) {
						skippedFiles = await pushFolderContentToServer(currentShare.path, items);
						updatePayload.web_folder_items = items;
					}
				}
			}

			let updated;
			if (live.shareClientManager) {
				updated = await live.shareClientManager.updateShare(share.serverId, share.id, updatePayload);
			} else if (live.shareClient) {
				updated = await live.shareClient.updateShare(share.id, updatePayload);
			}
			if (updated) {
				currentShare = { ...currentShare, ...updated };
				editingSlug = currentShare.web_slug || "";
			}
			if (enabled && skippedFiles.length > 0) {
				new Notice(
					uiText("shareDetail.webPublish.publishedWithSkippedNotice", { count: skippedFiles.length, files: skippedFiles.join(", ") }),
					8000,
				);
			} else {
				new Notice(enabled ? uiText("shareDetail.webPublish.publishedNotice") : uiText("shareDetail.webPublish.unpublishedNotice"));
			}
		} catch (e: unknown) {
			if (e instanceof LimitExceededApiError) {
				const info = e.limitInfo;
				new Notice(
					uiText("shareDetail.webPublish.limitReachedNotice", { current: info.current, max: info.max, plan: info.plan }),
					8000,
				);
			} else if (e instanceof VisibilityNotAllowedApiError) {
				const info = e.visibilityInfo;
				new Notice(
					uiText("shareDetail.webPublish.visibilityNotAllowedNotice", { visibility: info.visibility, allowed: info.allowed.join(", ") }),
					8000,
				);
			} else {
				new Notice(uiText("shared.failedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
			}
			syncPublishCheckbox();
		}
	}

	// this "sync now" action pushes content
	// directly, bypassing WebSyncManager's own syncFile()/syncFolderFile() —
	// echo-guard each push the same way (guard is ref-counted, safe per-call).
	async function syncWebContent() {
		if (currentShare.kind === "doc") {
			try {
				const content = await getDocumentContent(currentShare.path);
				if (!content) { new Notice(uiText("shareDetail.webPublish.couldNotReadDocumentNotice")); return; }
				let updated;
				if (live.shareClientManager) {
					updated = await withOutboundSyncGuard(live.webSyncManager, () =>
						live.shareClientManager!.updateShare(share.serverId, share.id, { web_content: content })
					);
				} else if (live.shareClient) {
					updated = await withOutboundSyncGuard(live.webSyncManager, () =>
						live.shareClient!.updateShare(share.id, { web_content: content })
					);
				}
				if (updated) currentShare = { ...currentShare, ...updated };
				new Notice(uiText("shareDetail.webPublish.contentSyncedNotice"));
			} catch (e: unknown) {
				new Notice(uiText("shareDetail.webPublish.syncFailedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
			}
		} else if (currentShare.kind === "folder") {
			try {
				const items = await getFolderItems(currentShare.path);
				if (items.length === 0) { new Notice(uiText("shareDetail.webPublish.folderEmptyNotice")); return; }
				let updated;
				if (live.webSyncManager && live.shareClientManager) {
					// Through WebSyncManager: shares the per-share interval, backoff
					// and in-flight state with event-driven pushes; null if unchanged.
					const webSyncManager = live.webSyncManager;
					updated = await withOutboundSyncGuard(webSyncManager, () =>
						webSyncManager.syncFolderStructureToWeb(currentShare.path, share.serverId, share.id)
					);
				} else if (live.shareClientManager) {
					updated = await withOutboundSyncGuard(live.webSyncManager, () =>
						live.shareClientManager!.updateShare(share.serverId, share.id, { web_folder_items: items })
					);
				} else if (live.shareClient) {
					updated = await withOutboundSyncGuard(live.webSyncManager, () =>
						live.shareClient!.updateShare(share.id, { web_folder_items: items })
					);
				}
				if (updated) currentShare = { ...currentShare, ...updated };

				// Sync file content
				const slug = currentShare.web_slug;
				if (slug) {
					let synced = 0;
					for (const item of items) {
						if (item.type === "doc") {
							try {
								const content = await getDocumentContent(joinFolderPath(currentShare.path, item.path));
								if (content) {
									if (live.shareClientManager) {
										const clientManager = live.shareClientManager;
										await withOutboundSyncGuard(live.webSyncManager, () =>
											clientManager.syncFolderFileContent(share.serverId, slug, item.path, content)
										);
									} else if (live.shareClient) {
										const client = live.shareClient;
										await withOutboundSyncGuard(live.webSyncManager, () =>
											client.syncFolderFileContent(slug, item.path, content)
										);
									}
									synced++;
								}
							} catch { /* skip individual file errors */ }
						}
					}
					new Notice(uiText("shareDetail.webPublish.syncedFilesNotice", { count: synced }));
				} else {
					new Notice(uiText("shareDetail.webPublish.folderSyncedNotice", { count: items.length }));
				}
			} catch (e: unknown) {
				new Notice(uiText("shareDetail.webPublish.syncFailedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
			}
		}
	}

	async function updateWebNoindex(noindex: boolean) {
		try {
			let updated;
			if (live.shareClientManager) {
				updated = await live.shareClientManager.updateShare(share.serverId, share.id, { web_noindex: noindex });
			} else if (live.shareClient) {
				updated = await live.shareClient.updateShare(share.id, { web_noindex: noindex });
			}
			if (updated) currentShare = { ...currentShare, ...updated };
			new Notice(noindex ? uiText("shareDetail.webPublish.indexingDisabledNotice") : uiText("shareDetail.webPublish.indexingEnabledNotice"));
		} catch (e: unknown) {
			new Notice(uiText("shared.failedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
		}
	}

	// See handleMemberRoleChange above -- same reason for the wrapper.
	function handleSyncModeChange(value: string) {
		updateSyncMode(value as "auto" | "manual");
	}

	async function updateSyncMode(mode: "auto" | "manual") {
		try {
			let updated;
			if (live.shareClientManager) {
				updated = await live.shareClientManager.updateShare(share.serverId, share.id, { web_sync_mode: mode });
			} else if (live.shareClient) {
				updated = await live.shareClient.updateShare(share.id, { web_sync_mode: mode });
			}
			if (updated) currentShare = { ...currentShare, ...updated };
			if (live.webSyncManager) {
				if (mode === "auto") {
					live.webSyncManager.registerAutoSyncShare(
						currentShare.path, currentShare.id, currentShare.serverId,
						currentShare.kind, currentShare.web_slug ?? undefined,
					);
					new Notice(uiText("shareDetail.webPublish.autoSyncEnabledNotice"));
				} else {
					live.webSyncManager.unregisterAutoSyncShare(currentShare.path);
					new Notice(uiText("shareDetail.webPublish.autoSyncDisabledNotice"));
				}
			} else {
				new Notice(uiText("shareDetail.webPublish.syncModeNotice", { mode }));
			}
		} catch (e: unknown) {
			new Notice(uiText("shared.failedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
		}
	}

	async function saveWebSlug() {
		const newSlug = editingSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
		if (!newSlug || newSlug === currentShare.web_slug) return;
		try {
			let updated;
			if (live.shareClientManager) {
				updated = await live.shareClientManager.updateShare(share.serverId, share.id, { web_slug: newSlug });
			} else if (live.shareClient) {
				updated = await live.shareClient.updateShare(share.id, { web_slug: newSlug });
			}
			if (updated) {
				currentShare = { ...currentShare, ...updated };
				editingSlug = currentShare.web_slug || "";
			}
			new Notice(uiText("shareDetail.webPublish.slugUpdatedNotice", { slug: newSlug }));
		} catch (e: unknown) {
			new Notice(uiText("shared.failedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
		}
	}

	// Helpers
	async function getDocumentContent(path: string): Promise<string | null> {
		try {
			const file = live.app.vault.getAbstractFileByPath(path);
			if (file && "extension" in file) return await live.app.vault.read(file as TFile);
			return null;
		} catch { return null; }
	}

	async function getFolderItems(folderPath: string): Promise<WebFolderEntry[]> {
		try {
			const folder = resolveShareFolder(live.app.vault, folderPath);
			if (!folder) return [];
			return collectWebFolderItems(folder, folderPath);
		} catch { return []; }
	}

	// Real logic + tests live in ../webPublish/pushFolderContentToServer.ts
	// (this component can't be unit-tested directly -- no .svelte jest
	// transform in this repo). This wrapper just adapts `live`/`share`/
	// `getDocumentContent` into the extracted function's deps.
	async function pushFolderContentToServer(folderPath: string, items: WebFolderEntry[]): Promise<string[]> {
		return pushFolderContentToServerCore(folderPath, items, {
			getFilesIndex: () =>
				live.shareClientManager
					? live.shareClientManager.getFilesIndex(share.serverId, share.id)
					: live.shareClient!.getFilesIndex(share.id),
			syncWriteFile: async (path, content, precondition, mime) => {
				if (live.shareClientManager) {
					await live.shareClientManager.syncWriteFile(share.serverId, share.id, path, content, precondition, mime);
				} else if (live.shareClient) {
					await live.shareClient.syncWriteFile(share.id, path, content, precondition, mime);
				}
			},
			getDocumentContent,
		});
	}

	$: activeInvites = invites.filter(i => !i.revoked_at);
	$: isPublished = currentShare.web_published ?? false;
	$: syncMode = currentShare.web_sync_mode ?? "manual";
	$: noindex = currentShare.web_noindex ?? true;

	// Local folder connection
	let isConnectedLocally = false;
	let localFolderPath = "";

	function checkLocalConnection() {
		const localFolder = live.shareRegistry.locate((sf) => sf.entityGuid === share.id);
		isConnectedLocally = !!localFolder;
		localFolderPath = localFolder ? localFolder.path : "";
	}

	function basesSettings(node: HTMLElement) {
		const folder = live.shareRegistry.locate((sf) => sf.entityGuid === share.id);
		if (!folder) return;
		let disposed = false;
		let unsubscribe = () => {};
		new Setting(node).setName("Sync Bases").setDesc("Sync saved Bases views and retain conflicting edits for review.")
			.addToggle(toggle => {
				unsubscribe = folder.attachmentSettings.subscribe(value => toggle.setValue(value.bases === true));
				toggle.onChange(async enabled => {
					toggle.setDisabled(true);
					try {
						await folder.attachmentSettings.setCategoryEnabled("bases", enabled);
						if (enabled && folder.isOnline) await folder.refreshFromServer();
					} catch (error) {
						new Notice(error instanceof Error ? error.message : "Bases sync could not start.");
					} finally {
						if (!disposed) toggle.setValue(folder.attachmentSettings.readValue().bases === true).setDisabled(false);
					}
				});
			});
		new Setting(node).setName("Bases sync and recovery").setDesc("Review retained edits and export recovery copies.")
			.addButton(button => button.setButtonText("Review Bases sync").onClick(() => folder.basesSync?.open()));
		return { destroy() { disposed = true; unsubscribe(); } };
	}

	// Check on mount and whenever loading finishes
	$: if (!loading) checkLocalConnection();

	function connectToFolder() {
		const modal = new FolderPathPickerModal(
			live.app,
			uiText("shareDetail.localFolder.pickerTitle"),
			new Set(),
			live.shareRegistry,
			async (folderPath: string) => {
				try {
					const vaultShare = live.shareRegistry.new(toSharePath(folderPath), share.id, "relay-onprem", true);
					if (vaultShare) {
						await vaultShare.setOnpremServerId(share.serverId);
						// onpremServerId is set AFTER construction, so the constructor's
						// own auto-connect gate never saw it — connect explicitly now
						// that the server is known.
						void vaultShare.bringOnline();
					}
					live.explorerDecorations?.refreshExistingRows();
					new Notice(uiText("shareDetail.localFolder.connectedNotice"));
					checkLocalConnection();
				} catch (e: unknown) {
					new Notice(uiText("shareDetail.localFolder.connectFailedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
				}
			},
		);
		modal.open();
	}

	async function disconnectFolder() {
		if (!(await confirmDialog(live.app, uiText("shareDetail.localFolder.disconnectConfirm", { path: localFolderPath })))) return;
		const localFolder = live.shareRegistry.locate((sf) => sf.entityGuid === share.id);
		if (localFolder) {
			live.shareRegistry.delete(localFolder);
			live.explorerDecorations?.refreshExistingRows();
			new Notice(uiText("shareDetail.localFolder.disconnectedNotice"));
			checkLocalConnection();
		}
	}
</script>

<div class="evc-share-detail">
	{#if loading}
		<div class="evc-loading">{uiText("shareDetail.loading")}</div>
	{:else}
		<!-- Share Info -->
		<div class="evc-detail-header">
			<h3 class="evc-detail-title">{currentShare.path}</h3>
			<div class="evc-detail-badges">
				<span class="evc-badge">{currentShare.kind}</span>
				<span class="evc-badge evc-badge-{currentShare.visibility}">{currentShare.visibility}</span>
				<span class="evc-detail-date">{new Date(currentShare.created_at).toLocaleDateString()}</span>
				<button class="evc-link-btn" on:click={copyId}>{uiText("shareDetail.copyIdButton")}</button>
			</div>
		</div>

		<!-- Local Folder Connection (folder shares only) -->
		{#if currentShare.kind === "folder"}
			<div class="evc-section">
				<div class="evc-section-title">{uiText("shareDetail.localFolder.heading")}</div>
				{#if isConnectedLocally}
					<div class="evc-connection-row">
						<div class="evc-connection-info">
							<span class="evc-connection-path">{localFolderPath}</span>
							<span class="evc-connection-status">{uiText("shareDetail.localFolder.connectedStatus")}</span>
						</div>
						<button class="evc-small-btn" on:click={() => live.shareRegistry.locate((sf) => sf.entityGuid === share.id)?.openManagedConflicts()}>Review file conflicts</button>
						<button class="evc-btn-danger evc-small-btn" on:click={disconnectFolder}>{uiText("shareDetail.localFolder.disconnectButton")}</button>
					</div>
					<div use:basesSettings></div>
				{:else}
					<div class="evc-connection-row">
						<div class="evc-connection-info">
							<span class="evc-connection-status">{uiText("shareDetail.localFolder.notConnectedStatus")}</span>
						</div>
						<button class="mod-cta" on:click={connectToFolder}>{uiText("shareDetail.localFolder.connectButton")}</button>
					</div>
				{/if}
			</div>
		{/if}

		{#if currentShare.managed}
			<div class="evc-section">
				<div class="evc-section-title">File and comment permissions</div>
				<p>Members need explicit access rules. Membership and invitation roles do not grant file access in this share.</p>
				{#if canManagePermissions}
					<button class="mod-cta" on:click={managePathPermissions}>Manage permissions</button>
				{/if}
			</div>
		{/if}

		<!-- Members -->
		<div class="evc-section">
			<div class="evc-section-title">{uiText("shareDetail.members.heading")}</div>
			{#if members.length === 0}
				<div class="evc-empty-inline">{uiText("shareDetail.members.empty")}</div>
			{:else}
				<div class="evc-member-list">
					{#each members as member (member.id)}
						<div class="evc-member-item">
							<div class="evc-member-info">
								<span class="evc-member-email">{member.user_email}</span>
								{#if !isOwner}
									<span class="evc-badge">{member.role}</span>
								{/if}
							</div>
							{#if isOwner}
								<div class="evc-member-actions">
									<select
										class="dropdown evc-role-select"
										value={member.role}
										on:change={(e) => handleMemberRoleChange(member.user_id, e.currentTarget.value)}
									>
										<option value="viewer">{uiText("shared.viewerOption")}</option>
										<option value="editor">{uiText("shared.editorOption")}</option>
									</select>
									<button class="evc-btn-danger" on:click={() => removeMember(member.user_id)}>{uiText("shareDetail.members.removeButton")}</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			{#if isOwner}
				<div class="evc-add-member">
					<input
						type="text"
						placeholder={uiText("shared.emailPlaceholder")}
						bind:value={newMemberEmail}
						on:keypress={(e) => { if (e.key === 'Enter') addMember(); }}
					/>
					<select class="dropdown evc-role-select" bind:value={newMemberRole}>
						<option value="viewer">{uiText("shared.viewerOption")}</option>
						<option value="editor">{uiText("shared.editorOption")}</option>
					</select>
					<button class="mod-cta" on:click={addMember}>{uiText("shareDetail.members.addButton")}</button>
				</div>
			{/if}
		</div>

		<!-- Invites (owner only) -->
		{#if isOwner}
			<div class="evc-section">
				<div class="evc-section-header">
					<div class="evc-section-title">{uiText("shareDetail.invites.heading")}</div>
					<button class="evc-small-btn" on:click={() => dispatch('createInvite')}>{uiText("shareDetail.invites.createButton")}</button>
				</div>
				{#if activeInvites.length === 0}
					<div class="evc-empty-inline">{uiText("shareDetail.invites.empty")}</div>
				{:else}
					<div class="evc-invite-list">
						{#each activeInvites as invite (invite.id)}
							<div class="evc-invite-item" class:evc-invite-invalid={!isInviteValid(invite)}>
								<div class="evc-invite-info">
									<span class="evc-invite-role">{uiText("shareDetail.invites.roleSuffix", { role: invite.role })}</span>
									<span class="evc-invite-desc">{getInviteDescription(invite)}</span>
								</div>
								<div class="evc-invite-actions">
									<button class="evc-small-btn" on:click={() => copyInviteLink(invite)}>{uiText("shareDetail.invites.copyLinkButton")}</button>
									<button class="evc-btn-danger evc-small-btn" on:click={() => revokeInvite(invite.id)}>{uiText("shareDetail.invites.revokeButton")}</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Agent Keys (owner only, legacy shares) -->
		{#if isOwner && !currentShare.managed}
		<div class="evc-section">
			<div class="evc-section-header">
				<div class="evc-section-title">{uiText("shell.breadcrumb.agentKeys")}</div>
				<button class="evc-small-btn" on:click={() => dispatch('agentKeys')}>{uiText("shareDetail.agentKeys.manageButton")}</button>
			</div>
			<div class="evc-setting-desc">
				{uiText("shareDetail.agentKeys.desc")}
			</div>
		</div>
		{/if}

		<!-- Web Publishing (owner + server supports it) -->
		{#if isOwner && webPublishEnabled && !currentShare.managed}
			<div class="evc-section">
				<div class="evc-section-title">{uiText("shareDetail.webPublish.heading")}</div>

				<div class="evc-setting-row">
					<div class="evc-setting-info">
						<span>{uiText("shareDetail.webPublish.publishLabel")}</span>
					</div>
					<label class="checkbox-container" class:is-enabled={isPublished}>
						<input type="checkbox" checked={isPublished} bind:this={publishCheckboxEl} on:change={(e) => toggleWebPublishing(e.currentTarget.checked)} />
					</label>
				</div>

				{#if isPublished}
					{#if currentShare.web_url}
						<div class="evc-setting-row">
							<div class="evc-setting-info">
								<span>{uiText("shareDetail.webPublish.webUrlLabel")}</span>
								<span class="evc-setting-desc">{currentShare.web_url}</span>
							</div>
							<div class="evc-setting-actions">
								<button class="evc-small-btn" on:click={() => { copyToClipboard(currentShare.web_url || ''); new Notice(uiText("shareDetail.webPublish.urlCopiedNotice")); }}>{uiText("shareDetail.webPublish.copyButton")}</button>
								<button class="evc-small-btn" on:click={() => window.open(currentShare.web_url || '', '_blank')}>{uiText("shareDetail.webPublish.openButton")}</button>
							</div>
						</div>
					{/if}

					<div class="evc-setting-row">
						<div class="evc-setting-info">
							<span>{uiText("shareDetail.webPublish.syncContentLabel")}</span>
						</div>
						<button class="mod-cta evc-small-btn" on:click={syncWebContent}>{uiText("shareDetail.webPublish.syncNowButton")}</button>
					</div>

					<div class="evc-setting-row">
						<div class="evc-setting-info">
							<span>{uiText("shareDetail.webPublish.allowSearchEnginesLabel")}</span>
						</div>
						<label class="checkbox-container" class:is-enabled={!noindex}>
							<input type="checkbox" checked={!noindex} on:change={(e) => updateWebNoindex(!e.currentTarget.checked)} />
						</label>
					</div>

					<div class="evc-setting-row">
						<div class="evc-setting-info">
							<span>{uiText("shareDetail.webPublish.syncModeLabel")}</span>
						</div>
						<select class="dropdown" value={syncMode} on:change={(e) => handleSyncModeChange(e.currentTarget.value)}>
							<option value="manual">{uiText("shareDetail.webPublish.manualOption")}</option>
							<option value="auto">{uiText("shareDetail.webPublish.autoOption")}</option>
						</select>
					</div>

					{#if currentShare.web_slug}
						<div class="evc-setting-row">
							<div class="evc-setting-info">
								<span>{uiText("shareDetail.webPublish.webSlugLabel")}</span>
							</div>
							<div class="evc-slug-edit">
								<input type="text" bind:value={editingSlug} placeholder={uiText("shareDetail.webPublish.webSlugPlaceholder")} />
								<button class="evc-small-btn" on:click={saveWebSlug}>{uiText("shareDetail.webPublish.saveButton")}</button>
							</div>
						</div>
					{/if}
				{/if}
			</div>
		{/if}

		<!-- Actions (owner only) -->
		{#if isOwner}
			<div class="evc-section">
				<div class="evc-section-title">{uiText("shareDetail.actions.heading")}</div>

				<div class="evc-setting-row">
					<div class="evc-setting-info">
						<span>{uiText("shareDetail.actions.changeVisibilityLabel")}</span>
						<span class="evc-setting-desc">{uiText("shareDetail.actions.changeVisibilityDesc")}</span>
					</div>
					<select
						class="dropdown"
						value={currentShare.visibility}
						disabled={currentShare.managed}
						on:change={(e) => updateVisibility(e.currentTarget.value)}
					>
						<option value="private">{uiText("shareDetail.actions.privateOption")}</option>
						<option value="public">{uiText("shareDetail.actions.publicOption")}</option>
						<option value="protected">{uiText("shareDetail.actions.protectedOption")}</option>
					</select>
				</div>

				<div class="evc-setting-row">
					<div class="evc-setting-info">
						<span>{uiText("shareDetail.actions.deleteShareLabel")}</span>
						<span class="evc-setting-desc">{uiText("shareDetail.actions.deleteShareDesc")}</span>
					</div>
					<button class="evc-btn-danger" on:click={deleteShare}>{uiText("shareDetail.actions.deleteButton")}</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.evc-share-detail {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.evc-loading {
		padding: 24px;
		text-align: center;
		color: var(--text-muted);
	}

	.evc-detail-header {
		padding-bottom: 12px;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.evc-detail-title {
		margin: 0 0 8px 0;
		padding: 0;
		font-size: 1.2em;
	}

	.evc-detail-badges {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 0.85em;
	}

	.evc-detail-date {
		color: var(--text-faint);
	}

	.evc-link-btn {
		font-size: 0.75em;
		font-weight: 500;
		padding: 2px 8px;
		cursor: pointer;
		background: var(--background-modifier-border);
		border-radius: 4px;
		color: var(--text-muted);
		border: none;
		line-height: inherit;
	}

	.evc-link-btn:hover {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	.evc-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.evc-section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.evc-section-title {
		font-weight: 600;
		font-size: 1em;
	}

	.evc-empty-inline {
		color: var(--text-muted);
		font-size: 0.9em;
		padding: 8px 0;
	}

	.evc-badge {
		font-size: 0.75em;
		padding: 2px 8px;
		border-radius: 4px;
		font-weight: 500;
		background: var(--background-modifier-border);
		color: var(--text-muted);
	}

	.evc-badge-public {
		background: hsla(120, 40%, 50%, 0.15);
		color: var(--text-success, #22863a);
	}

	.evc-badge-private {
		background: var(--background-modifier-border);
	}

	.evc-badge-protected {
		background: hsla(45, 80%, 50%, 0.15);
		color: var(--text-warning, #b08800);
	}

	/* Local Folder Connection */
	.evc-connection-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 12px;
		background: var(--background-secondary);
		border-radius: 6px;
		gap: 12px;
	}

	.evc-connection-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.evc-connection-path {
		font-weight: 500;
		word-break: break-all;
	}

	.evc-connection-status {
		font-size: 0.85em;
		color: var(--text-muted);
	}

	/* Members */
	.evc-member-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.evc-member-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		background: var(--background-secondary);
		border-radius: 6px;
	}

	.evc-member-info {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.evc-member-email {
		font-weight: 500;
	}

	.evc-member-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.evc-role-select {
		font-size: 0.85em;
		padding: 2px 24px 2px 6px;
		min-width: 80px;
	}

	.evc-add-member {
		display: flex;
		gap: 6px;
		align-items: center;
		margin-top: 4px;
	}

	.evc-add-member input {
		flex: 1;
	}

	/* Invites */
	.evc-invite-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.evc-invite-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		background: var(--background-secondary);
		border-radius: 6px;
	}

	.evc-invite-invalid {
		opacity: 0.6;
	}

	.evc-invite-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.evc-invite-role {
		font-weight: 500;
		font-size: 0.9em;
	}

	.evc-invite-desc {
		font-size: 0.8em;
		color: var(--text-muted);
	}

	.evc-invite-actions {
		display: flex;
		gap: 6px;
	}

	/* Settings rows */
	.evc-setting-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--background-modifier-border);
		gap: 12px;
	}

	.evc-setting-row:last-child {
		border-bottom: none;
	}

	.evc-setting-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
	}

	.evc-setting-desc {
		font-size: 0.85em;
		color: var(--text-muted);
	}

	.evc-setting-actions {
		display: flex;
		gap: 6px;
	}

	.evc-slug-edit {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.evc-slug-edit input {
		width: 160px;
	}

	/* Buttons */
	.evc-small-btn {
		font-size: 0.85em;
		padding: 4px 10px;
	}

	.evc-btn-danger {
		color: var(--text-error);
		border-color: var(--text-error);
	}

	.evc-btn-danger:hover {
		background: var(--text-error);
		color: var(--text-on-accent);
	}
</style>
