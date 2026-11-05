"use strict";

import {
	TFolder,
	Notice,
	MarkdownView,
	normalizePath,
	MetadataCache,
	TFile,
	TAbstractFile,
	Vault,
	FileManager,
	requireApiVersion,
	Modal,
	moment,
	addIcon,
	setIcon,
	Menu,
	App,
	type PluginManifest,
	requestUrl,
} from "obsidian";
import { Platform } from "obsidian";
import { PluginUpdater } from "./updates/PluginUpdater";
import { UpdateFiles } from "./updates/UpdateFiles";

/** Internal Obsidian App properties not exposed in the public API */
interface ObsidianApp {
	appId: string;
	reloadRelay?: () => Promise<void>;
	plugins: {
		disablePlugin(id: string): Promise<void>;
		enablePlugin(id: string): Promise<void>;
	};
	setting: {
		open(): Promise<void>;
		openTabById(id: string): Promise<void>;
	};
	internalPlugins?: {
		plugins?: {
			webviewer?: {
				enabled: boolean;
				instance?: {
					options: Record<string, unknown>;
				};
			};
		};
	};
	commands: {
		commands: Record<string, unknown>;
		editorCommands: Record<string, unknown>;
	};
	hotkeyManager: {
		removeDefaultHotkeys(id: string): boolean;
	};
}
import { relative } from "path-browserify";
import { Plugin } from "obsidian";

// Core sync/data model
import { VaultShare, ShareRegistry } from "./VaultShare";
import { holdsOnlySyncedText, uploadsOnModify } from "./uploadOnModify";
import type { VaultShareSettings } from "./VaultShare";
import { ViewBindingRegistry } from "./ViewBindings";
import { RelayRegistry } from "./RelayRegistry";
import { SystemClock, type Clock } from "./Clock";
import { auditNotifierTeardown } from "./notifiers/Notifier";
import { NotificationDispatcher } from "./notifiers/NotificationDispatcher";
import { TransferQueue } from "./TransferQueue";
import { getPatchRegistry, PatchRegistry } from "./PatchRegistry";
import { RelayCredentialCache } from "./RelayCredentialCache";
import ServiceHealthMonitor from "./ServiceHealthMonitor";

// Auth
import { AuthSession, type AuthSettings } from "./AuthSession";

// UI: nav decorations, settings tab, and the various modals main.ts opens
import { ExplorerDecorationCoordinator } from "./ui/ExplorerDecorationCoordinator";
import { RelaySettingsPage } from "./ui/RelaySettingsPage";
import { TenantConfigModal } from "./ui/TenantConfigModal";
import { FeatureTogglesModal } from "./ui/FeatureTogglesModal";
import { DiagnosticsModal } from "./ui/DiagnosticsModal";
import { IssueReportModal } from "./ui/IssueReportModal";
import { StorageAnalysisModal } from "./ui/StorageAnalysisModal";

// Debug/logging
import {
	namedLogger,
	setVerboseLogging,
	instanceLabels,
	startLogWriter,
	flushPendingLogs,
} from "./logging";
import { VaultFileSink, NoticeSink } from "./ObsidianLogSinks";

// Feature toggles + settings persistence
import { FeatureToggleDefaults, featureKey, type FeatureToggles } from "./featureToggles";
import { FeatureToggleState, withToggle } from "./featureToggleState";
import { SettingsScope, Settings } from "./SettingsPersistence";

// Diff viewer (conflict-copy review)
import {
	FileDiffView,
	VIEW_TYPE_FILE_DIFF,
} from "./fileDiff/fileDiffView";

import { AttachmentSyncSettings } from "./AttachmentSyncSettings";
import { FileHashCache, isAttachmentFile } from "./AttachmentFile";
import { isDocument } from "./Document";
import { TenantRegistry, type TenantSettings } from "./TenantRegistry";
import {
	DEFAULT_RELAY_ONPREM_SETTINGS,
	EVC_SERVER_ID,
	type RelayOnPremSettings,
	type RelayOnPremServer,
	migrateRelayOnPremSettings,
	getDefaultServer,
} from "./RelayOnPremConfig";
import { RelayOnPremTokenProvider } from "./auth/RelayOnPremTokenProvider";
import { getAuthStore, registerAuthStorageHost } from "./auth/RelayOnPremAuthStore";
import {
	snapshotRelayOnPremServers,
	diffRelayOnPremServers,
} from "./relay/reconcileRelayOnPremServers";
import type { IAuthProvider } from "./auth/IAuthProvider";
import { RelayOnPremShareClient, type WebFolderEntry } from "./RelayOnPremShareClient";
import { RelayOnPremShareClientManager, type ShareWithServer } from "./RelayOnPremShareClientManager";
import { dedupeFolderSharesByPath } from "./dedupeFolderSharesByPath";
import { QuickShareModal } from "./ui/QuickShareModal";
import { confirmDialog } from "./ui/dialogs";
import { VaultScopedMap } from "./VaultScopedMap";
import { collectWebFolderItems, isRootSharePath, joinFolderPath, resolveShareFolder } from "./vaultRootPath";

interface LoggingSettings {
	debugging: boolean;
}

const DEFAULT_DEBUG_SETTINGS: LoggingSettings = {
	debugging: false,
};

interface StoredSettings extends FeatureToggles, LoggingSettings {
	sharedFolders: VaultShareSettings[];
	endpoints: TenantSettings;
	relayOnPrem: RelayOnPremSettings;
}

const DEFAULT_SETTINGS: StoredSettings = {
	sharedFolders: [],
	endpoints: {},
	relayOnPrem: DEFAULT_RELAY_ONPREM_SETTINGS,
	...FeatureToggleDefaults,
	...DEFAULT_DEBUG_SETTINGS,
};

declare const GIT_TAG: string;

// relay-onprem control-plane URLs are runtime/per-server config (multi-server,
// user-editable), not a build-time constant — unlike the TenantRegistry's
// cloud-backend API_URL/AUTH_URL, there is no fixed default to bake in at build time.
function healthUrlForServer(server?: RelayOnPremServer): string {
	if (!server?.controlPlaneUrl) {
		return "";
	}
	return `${server.controlPlaneUrl.replace(/\/+$/, "")}/v1/health?version=${GIT_TAG}`;
}

// Debugging-mode commands all share the same shape: open a modal and track it
// in activeModals. Kept as a dispatch table (rather than five near-identical
// addCommand calls) so enabling/disabling debug mode is one loop each way.
interface DebugModalCommand {
	id: string;
	name: string;
	openModal: (plugin: TeamRelayPlugin) => Modal;
}

const DEBUG_MODAL_COMMANDS: DebugModalCommand[] = [
	{
		id: "toggle-feature-flags",
		name: "Show feature flags",
		openModal: (plugin) =>
			new FeatureTogglesModal(plugin.app, () => {
				void plugin.reloadPlugin();
			}),
	},
	{
		id: "send-bug-report",
		name: "Send bug report",
		openModal: (plugin) => new IssueReportModal(plugin.app, plugin),
	},
	{
		id: "show-debug-info",
		name: "Show debug info",
		openModal: (plugin) => new DiagnosticsModal(plugin.app, plugin),
	},
	{
		id: "analyze-indexeddb",
		name: "Analyze database",
		openModal: (plugin) => new StorageAnalysisModal(plugin.app, plugin),
	},
];

export default class TeamRelayPlugin extends Plugin {
	// Obsidian-provided plumbing this plugin needs a handle on
	instanceAppId!: string;
	pluginVault!: Vault;
	vaultFileManager!: FileManager;
	uiNotifier!: NoticeSink;
	clock!: Clock;

	// Plugin lifecycle / misc state
	startupDurationMs?: number;
	webviewerPatchInstalled = false;
	activeModals: Modal[] = [];
	webviewInterceptPatterns: Array<string | RegExp> = [];
	mergeWarningNoticeKey = "file-diff-merge-warning";
	pluginVersion = GIT_TAG;

	// Sync core
	shareRegistry!: ShareRegistry;
	relayRegistry!: RelayRegistry;
	credentialCache!: RelayCredentialCache;
	fileHashRegistry!: FileHashCache;
	serviceHealth!: ServiceHealthMonitor;
	transferQueue!: TransferQueue;
	crdtBackgroundSyncPoller!: import("./CrdtBackgroundSyncPoller").CrdtBackgroundSyncPoller;
	explorerDecorations!: ExplorerDecorationCoordinator;
	private _viewRegistry!: ViewBindingRegistry;

	// Auth + settings UI
	authSession!: AuthSession;
	settingsPage!: RelaySettingsPage;
	updater!: PluginUpdater;
	private updaterBlockedStartup = false;
	pluginSettings!: Settings<StoredSettings>;

	// Persisted-settings namespaces
	private featureToggleSettings!: SettingsScope<FeatureToggles>;
	private loggingSettings!: SettingsScope<LoggingSettings>;
	// Deliberately NOT renamed to vaultShareSettings (, dictionary
	// residue after/!237): this scope wraps the on-wire settings key
	// "sharedFolders" (constructed below with that literal), and RelaySettings
	// .sharedFolders is the actual top-level key in every installed vault's
	// data.json -- untouchable. This field's name deliberately mirrors the
	// key it holds; renaming it would desync the identifier from the wire
	// name it exists to address, worsening readability to chase a metric.
	private sharedFolderSettings!: SettingsScope<VaultShareSettings[]>;
	public authSettingsScope!: SettingsScope<AuthSettings>;
	public tenantEndpointSettings!: SettingsScope<TenantSettings>;
	public relayOnPremSettings!: SettingsScope<RelayOnPremSettings>;

	// Relay-onprem: server connection + inbound sync
	public shareClient?: RelayOnPremShareClient;
	public shareClientManager?: RelayOnPremShareClientManager;
	public webSyncManager?: import("./WebSyncManager").WebSyncManager;
	public inboundFileDownloader?: import("./InboundFileDownloader").InboundFileDownloader;
	public inboundSyncPoller?: import("./InboundSyncPoller").InboundSyncPoller;

	// Logging (bound in the constructor via instanceLabels/namedLogger)
	logDebug!: (...args: unknown[]) => void;
	logInfo!: (...args: unknown[]) => void;
	logWarn!: (...args: unknown[]) => void;
	logError!: (...args: unknown[]) => void;

	activateDebugMode(save?: boolean) {
		setVerboseLogging(true);
		console.warn("live instance registry:", instanceLabels);
		if (save) {
			void this.loggingSettings.mutateValue((settings) => ({
				...settings,
				debugging: true,
			}));
		}
	}

	deactivateDebugMode(save?: boolean) {
		setVerboseLogging(false);
		if (save) {
			void this.loggingSettings.mutateValue((settings) => ({
				...settings,
				debugging: false,
			}));
		}
	}

	flipDebugMode(save?: boolean): boolean {
		const setTo = !this.loggingSettings.readValue().debugging;
		setVerboseLogging(setTo);
		if (save) {
			void this.loggingSettings.mutateValue((settings) => ({
				...settings,
				debugging: setTo,
			}));
		}
		return setTo;
	}

	composeApiUrl(path: string) {
		return this.authSession.resolveTenantRegistry().resolveApiUrl() + path;
	}

	/**
	 * Pops the modal where a user points the plugin at a custom/enterprise endpoint.
	 */
	showTenantConfigModal() {
		const modal = new TenantConfigModal(this.app, this, () => {
			void this.reloadPlugin();
		});
		modal.open();
	}

	/**
	 * Kicks off endpoint validation and persists whatever it decided.
	 */
	/** Clears any previously-recorded validation failure — the success shape
	 * shared by both the manual "validate now" action and startup
	 * auto-validation below. */
	private async recordValidationSuccess(): Promise<void> {
		await this.tenantEndpointSettings.mutateValue((current) => ({
			...current,
			_lastValidationError: undefined,
			_lastValidationAttempt: undefined,
		}));
	}

	/** Records a validation failure (rejected result or thrown error) for
	 * display in settings — the failure shape shared by both validation
	 * entry points, each of which has both an unsuccessful-result branch and
	 * a catch block that both need this recorded identically. */
	private async recordValidationFailure(errorMessage: string | undefined): Promise<void> {
		await this.tenantEndpointSettings.mutateValue((current) => ({
			...current,
			_lastValidationError: errorMessage,
			_lastValidationAttempt: Date.now(),
		}));
	}

	async verifyAndApplyEndpoints() {
		const settings = this.tenantEndpointSettings.readValue();

		if (!settings.activeTenantId || !settings.tenants?.length) {
			new Notice("Please configure an enterprise tenant first", 4000);
			return;
		}

		const notice = new Notice("Validating endpoints...", 0);

		try {
			const result = await this.authSession.reconcileEndpoints();
			notice.hide();

			if (result.success) {
				await this.recordValidationSuccess();
				new Notice("Endpoints validated and applied successfully!", 5000);
				if (result.licenseInfo) {
					this.logInfo("license accepted, details:", result.licenseInfo);
				}
				return;
			}
			await this.recordValidationFailure(result.error);
			new Notice(`❌ Validation failed: ${result.error}`, 8000);
		} catch (error: unknown) {
			notice.hide();
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			await this.recordValidationFailure(errorMessage);
			new Notice(`❌ Validation error: ${errorMessage}`, 8000);
		}
	}

	/**
	 * Discards any custom tenant configuration and falls back to the built-in endpoints.
	 */
	clearTenantEndpoints() {
		this.authSession.resolveTenantRegistry().resetValidatedEndpoints();
		void this.tenantEndpointSettings.mutateValue(() => ({}));
		new Notice("Reset to default endpoints", 3000);
	}

	/** Startup auto-validation only runs at all once a tenant is actually
	 * configured — returns the tenant, or undefined (having already logged
	 * why) when there's nothing to validate. */
	private activeTenantForStartupValidation() {
		const settings = this.tenantEndpointSettings.readValue();
		if (!settings.activeTenantId || !settings.tenants?.length) {
			this.logInfo("no tenant is active, sticking with default endpoints");
			return undefined;
		}
		const activeTenant = settings.tenants.find(
			(t) => t.id === settings.activeTenantId,
		);
		if (!activeTenant) {
			this.logInfo("active tenant id doesn't match any known tenant, using defaults");
			return undefined;
		}
		return activeTenant;
	}

	/**
	 * Runs endpoint validation at plugin load, but only if an enterprise
	 * tenant is actually configured -- otherwise this is a no-op.
	 */
	private async verifyEndpointsAtStartup(
		endpointManager: TenantRegistry,
	): Promise<void> {
		const activeTenant = this.activeTenantForStartupValidation();
		if (!activeTenant) {
			return;
		}

		this.logInfo("found a configured enterprise tenant, running startup validation:", {
			tenantId: activeTenant.id,
			tenantUrl: activeTenant.tenantUrl,
			tenantName: activeTenant.name,
		});

		try {
			// Startup validation gets a tighter budget than an interactive check.
			const result = await endpointManager.applyValidatedEndpoints(5000);

			if (result.success) {
				await this.recordValidationSuccess();
				this.logInfo("startup validation passed, tenant endpoints applied", {
					licenseInfo: result.licenseInfo,
				});
				return;
			}
			this.logError(
				"startup validation rejected the tenant's endpoints:",
				result.error,
			);
			await this.recordValidationFailure(result.error);
			new Notice(
				`❌ Custom endpoints failed validation: ${result.error}`,
				8000,
			);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			this.logError("startup endpoint validation threw:", errorMessage);
			await this.recordValidationFailure(errorMessage);
			new Notice(`❌ Endpoint validation error: ${errorMessage}`, 8000);
		}
	}

	/**
	 * Reimplements Obsidian's internal `MetadataCache.fileToLinktext` for a
	 * file that lives in a shared folder, so links generated for it behave
	 * identically to links generated for any other vault file. The patch
	 * installed on `MetadataCache.prototype` in `onload()` delegates here
	 * once it's confirmed the file is actually in a shared folder (files
	 * outside a shared folder fall through to the original implementation
	 * unchanged); `omitMdExtension` is resolved to its default beforehand.
	 */
	private vaultShareLinktext(
		file: TFile,
		sourcePath: string,
		omitMdExtension: boolean,
	): string {
		const fileName =
			file.extension === "md" && omitMdExtension ? file.basename : file.name;

		const normalizedFileName = normalizePath(file.name);
		const destinationFiles = (
			this.app.metadataCache as unknown as {
				uniqueFileLookup: Map<string, TFile[]>;
			}
		).uniqueFileLookup.get(normalizedFileName.toLowerCase());

		const isUnambiguous =
			destinationFiles &&
			destinationFiles.length === 1 &&
			destinationFiles[0] === file;
		if (isUnambiguous) {
			return fileName;
		}

		const filePath =
			file.extension === "md" && omitMdExtension
				? file.path.slice(0, file.path.length - 3)
				: file.path;
		const rpath = relative(sourcePath, filePath);
		return rpath === "../" + fileName ? "./" + fileName : rpath;
	}

	/** Log-rotation limits for the file-backed logger — kept small since the
	 * log lives inside the vault's plugin data directory, not somewhere with
	 * its own retention policy. */
	private static readonly LOG_ROTATION_CONFIG = {
		maxLogFileBytes: 5 * 1024 * 1024, // 5MB
		maxBackupFiles: 3,
		suppressConsoleMirror: false, // keep mirroring log lines to devtools as well
	};

	/** Time provider, file-backed logger, and the debug/log/warn/error
	 * shorthands every other method on this class calls through — must run
	 * before anything else in onload() logs or reads the clock. */
	private initializeLoggingInfrastructure(): void {
		this.clock = new SystemClock();
		this.register(() => {
			this.clock.teardown();
		});

		const logFilePath = normalizePath(
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/relay.log`,
		);
		startLogWriter(
			new VaultFileSink(this.app.vault),
			this.clock,
			logFilePath,
			TeamRelayPlugin.LOG_ROTATION_CONFIG,
		);
		this.uiNotifier = new NoticeSink();

		this.logDebug = namedLogger("[Relay]", "debug");
		this.logInfo = namedLogger("[Relay]", "log");
		this.logWarn = namedLogger("[Relay]", "warn");
		this.logError = namedLogger("[Relay]", "error");
	}

	async onload() {
		this.updater = new PluginUpdater(
			new UpdateFiles(this.app.vault.adapter, this.manifest.dir || normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`)),
			this.manifest.version,
			async (url) => {
				const response = await requestUrl({ url, headers: { Accept: url.startsWith("https://api.github.com/") ? "application/vnd.github+json" : "application/octet-stream" }, throw: false });
				return { status: response.status, arrayBuffer: response.arrayBuffer };
			},
			requireApiVersion, Platform.isMobile,
			(message) => { new Notice(message, 10000); },
		);
		if (!await this.updater.initialize()) { this.updaterBlockedStartup = true; return; }
		this.updater.start();

		this.instanceAppId = (this.app as unknown as ObsidianApp).appId;
		registerAuthStorageHost(this.instanceAppId, this.app);
		const start = moment.now();
		instanceLabels.set(this, "plugin");
		this.initializeLoggingInfrastructure();

		this.pluginSettings = new Settings<StoredSettings>(this, DEFAULT_SETTINGS);
		await this.pluginSettings.hydrate();

		// Migrate relay-onprem settings from legacy single-server format to multi-server
		const rawRelayOnPremSettings = this.pluginSettings.snapshot().relayOnPrem;
		const migration = migrateRelayOnPremSettings(rawRelayOnPremSettings);
		if (migration.changed) {
			await this.pluginSettings.mutate((settings) => ({
				...settings,
				relayOnPrem: migration.settings,
			}));
		}
		// If an existing server was adopted as EVC, migrate its local storage auth key
		// and update all shared folder settings that reference the old server ID
		if (migration.renamedServerId) {
			const oldId = migration.renamedServerId;
			try {
				getAuthStore(this.instanceAppId).renameServer(oldId, EVC_SERVER_ID);
			} catch {
				// local storage may not be available during startup
			}
			// Migrate onpremServerId in shared folder settings
			const currentSettings = this.pluginSettings.snapshot();
			const folders = currentSettings.sharedFolders;
			if (folders?.length) {
				let folderChanged = false;
				const updated = folders.map((f) => {
					if (f.onpremServerId === oldId) {
						folderChanged = true;
						return { ...f, onpremServerId: EVC_SERVER_ID };
					}
					return f;
				});
				if (folderChanged) {
					await this.pluginSettings.mutate((s) => ({ ...s, sharedFolders: updated }));
				}
			}
		}

		const settingsBase = this.pluginSettings as unknown as Settings<unknown>;
		this.featureToggleSettings = new SettingsScope(settingsBase, "(enable*)");
		this.loggingSettings = new SettingsScope(settingsBase, "(debugging)");
		this.sharedFolderSettings = new SettingsScope(
			settingsBase,
			"sharedFolders",
		);
		this.authSettingsScope = new SettingsScope(settingsBase, "login");
		this.tenantEndpointSettings = new SettingsScope(settingsBase, "endpoints");
		this.relayOnPremSettings = new SettingsScope(settingsBase, "relayOnPrem");

		const featureToggleState = FeatureToggleState.getShared();
		featureToggleState.bindSettings(this.featureToggleSettings);

		this.settingsPage = new RelaySettingsPage(this.app, this);

		// Register custom EVC Relay icon
		addIcon("evc-relay", `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><g transform="scale(0.333333)"><g><path fill="currentColor" d="M 11.914969 99.237534 C 24.033806 99.046112 36.213295 99.289841 48.341644 99.170944 C 51.59132 99.138855 54.709785 100.099091 56.287449 103.287704 C 58.8848 108.536697 61.970402 113.782532 64.009758 119.258606 C 65.717018 124.316162 60.033283 130.881668 54.537395 129.028961 C 49.582062 127.358566 47.504257 120.03772 45.145096 115.681992 C 41.199928 115.644348 37.254375 115.630478 33.309204 115.641174 C 31.607891 115.639969 27.951637 115.53891 26.411209 115.806808 L 26.183739 116.165878 C 26.220995 117.831924 55.919304 174.47226 58.774639 179.955078 L 89.279808 179.928101 C 91.172134 176.000397 93.297867 171.989853 95.29287 168.100174 C 97.119392 164.547714 98.928131 158.911163 103.1063 157.727798 C 104.985542 157.212601 106.993217 157.48172 108.670761 158.473236 C 111.701668 160.298203 113.50206 164.976105 112.27549 168.30307 C 110.644325 172.727768 108.047783 177.048218 105.977509 181.306061 C 104.063759 185.241699 102.030739 189.213013 99.927589 193.049194 C 98.963799 194.505203 97.083336 195.794769 95.299988 195.959625 C 91.153107 196.343262 86.709808 196.090393 82.535988 196.124481 L 64.463516 196.170471 C 61.042667 196.18277 57.48547 196.250519 54.070545 196.130829 C 53.020763 196.094376 50.863697 195.683426 50.079811 195.072327 C 48.939274 194.183029 47.711941 192.606934 47.029503 191.308258 C 44.950912 187.350815 42.906799 183.33786 40.866241 179.360626 L 27.982546 154.259003 L 13.372949 126.231491 C 10.72765 121.150925 6.464263 113.902206 4.774438 108.342514 C 4.267175 106.672913 5.326883 103.239365 6.512603 101.882019 C 8.067284 100.102249 9.543509 99.446381 11.914969 99.237534 Z"/><path fill="currentColor" d="M 96.765511 99.206619 C 104.64196 98.855881 112.642067 99.161423 120.531998 99.149155 C 125.15921 99.141632 133.149017 98.681122 137.281616 99.417038 C 138.877914 99.701202 140.38623 101.225372 141.28067 102.524033 C 142.465607 104.246368 143.15477 106.884125 142.723587 108.977005 C 142.127579 111.869965 131.412796 132.920242 129.553772 135.769623 C 128.994995 136.625641 128.348618 137.31601 127.489838 137.879532 C 125.958946 138.884155 123.912041 139.336716 122.10968 138.944778 C 119.988678 138.483887 118.224754 137.024307 117.105209 135.197754 C 113.812767 129.825134 117.837166 124.246414 120.330299 119.512619 C 120.819336 118.584473 121.585373 117.38092 121.758942 116.345383 C 121.811264 116.031128 121.686035 115.97287 121.521179 115.72757 C 119.903885 115.250809 105.285164 115.594818 102.599846 115.600342 C 100.726547 118.87854 98.589294 123.348801 96.784935 126.824341 C 95.811234 128.946915 94.195511 131.818924 93.090225 133.941879 L 85.836746 147.964966 C 83.232254 153.157272 80.585785 158.328217 77.896873 163.477722 C 76.897804 165.36055 75.342743 168.486938 74.166519 170.174789 L 73.581581 170.210052 C 72.546432 169.047714 66.1371 156.252777 64.921638 153.907471 C 65.589813 152.263626 67.242775 149.362717 68.123344 147.697067 L 73.751602 136.890366 C 79.474556 125.851044 85.262115 114.852127 91.068687 103.857193 C 92.470428 101.202377 93.881645 100.01944 96.765511 99.206619 Z"/></g><g><path fill="currentColor" d="M 229.592743 80.346909 C 225.620056 81.464081 222.799362 78.789856 219.698334 76.720947 L 211.969116 71.582443 C 210.270462 70.453598 208.56575 69.333633 206.854858 68.223083 C 205.807663 67.542068 203.431625 66.137802 202.741852 65.300659 C 199.394806 61.237976 201.1017 54.953613 206.419769 53.831467 C 210.131241 53.048584 212.647934 55.291641 215.396652 57.044693 C 215.197998 56.612656 214.99588 56.181946 214.790176 55.753128 C 206.48027 38.370483 191.632401 24.979767 173.486664 18.503357 C 155.566162 12.226807 135.899277 13.225739 118.706818 21.285645 C 102.899513 28.707184 90.333931 41.629028 83.35743 57.637833 C 82.531479 59.514069 81.796463 61.429108 81.155586 63.376297 C 80.675835 64.869034 80.260368 66.37413 79.768669 67.865723 C 78.550438 71.560181 74.3181 73.636627 70.640404 72.193039 C 68.903053 71.499191 67.51226 70.144241 66.773537 68.425507 C 66.33036 67.429642 66.114784 66.34761 66.142128 65.257996 C 66.195793 63.067215 68.387192 57.190826 69.22052 55.006943 C 70.202843 52.332474 71.779228 49.05687 73.085312 46.543411 C 81.885345 29.671783 96.01577 16.182495 113.277481 8.174713 C 134.042603 -1.336609 157.720856 -2.27594 179.174255 5.560577 C 197.290985 12.225525 212.627197 24.811676 222.698181 41.280365 C 225.095444 45.167862 226.856827 48.729919 228.759521 52.852127 C 229.574036 50.892975 230.491577 48.96637 231.304245 47.016327 C 232.823837 43.370514 237.393616 41.796753 240.898041 43.603424 C 242.446838 44.41243 243.606079 45.809433 244.115341 47.481049 C 244.723312 49.409882 244.483749 50.598175 243.77037 52.457092 C 243.269394 53.762375 242.740311 55.066391 242.223953 56.366257 L 238.624496 65.430374 C 237.718628 67.701248 236.82666 69.977524 235.948349 72.259262 C 234.42601 76.225433 234.068451 78.94632 229.592743 80.346909 Z"/><path fill="currentColor" d="M 81.009193 214.557129 C 84.981888 213.439941 87.802574 216.114166 90.903603 218.18309 L 98.632828 223.321594 C 100.331482 224.450439 102.036186 225.570389 103.747086 226.680939 C 104.794273 227.361969 107.170319 228.766235 107.860092 229.603363 C 111.207138 233.666046 109.500237 239.950424 104.182167 241.072556 C 100.470695 241.855438 97.954002 239.612396 95.205276 237.859344 C 95.403946 238.291367 95.606056 238.722076 95.811752 239.150909 C 104.121674 256.533569 118.969536 269.924255 137.11528 276.400665 C 155.035782 282.677216 174.702667 281.678284 191.895126 273.618408 C 207.702423 266.196838 220.268005 253.274994 227.244507 237.26619 C 228.07045 235.389969 228.805481 233.474915 229.44635 231.52774 C 229.926102 230.035004 230.341568 228.529907 230.833267 227.0383 C 232.051498 223.343842 236.283844 221.267395 239.961533 222.710999 C 241.698883 223.404846 243.089676 224.759796 243.8284 226.478516 C 244.271576 227.47438 244.487152 228.556427 244.459808 229.646027 C 244.406143 231.836807 242.214752 237.713196 241.381409 239.897095 C 240.399094 242.571548 238.822708 245.847153 237.516632 248.360611 C 228.716599 265.232239 214.586166 278.721558 197.324463 286.729309 C 176.559341 296.240662 152.881088 297.179962 131.427689 289.343445 C 113.310944 282.678497 97.974739 270.092346 87.903755 253.623657 C 85.506485 249.73616 83.745117 246.174103 81.842415 242.051895 C 81.027901 244.011047 80.110359 245.937653 79.297691 247.887695 C 77.778099 251.533524 73.208321 253.107269 69.703888 251.300598 C 68.155106 250.491608 66.99585 249.094589 66.486595 247.422974 C 65.878624 245.494141 66.118187 244.305847 66.831558 242.44693 C 67.332535 241.141663 67.861626 239.837631 68.377975 238.537781 L 71.977432 229.473663 C 72.883316 227.202789 73.775284 224.926498 74.653587 222.64476 C 76.175934 218.678589 76.533493 215.957703 81.009193 214.557129 Z"/></g><g><path fill="currentColor" d="M 244.770096 96.388397 C 241.608612 94.792068 239.73555 93.846298 235.701004 94.020554 C 232.660995 94.280548 231.450714 94.94342 228.81105 96.262756 L 224.349686 98.486786 L 210.462036 105.391602 L 195.45816 112.83522 L 190.458542 115.298233 C 187.985382 116.518234 186.030899 117.332047 184.2229 119.549362 C 182.416779 121.764114 181.613113 124.538849 181.835648 127.392609 C 182.110916 130.461609 183.489136 133.133301 185.893967 135.078339 C 187.230026 136.158859 189.085464 136.964081 190.649475 137.725021 L 194.619629 139.686066 L 211.814667 148.176056 L 224.883926 154.615067 C 226.7155 155.516632 230.004898 157.27359 231.793304 157.949051 C 233.699203 158.663101 235.737015 158.956085 237.766968 158.807877 C 240.468796 158.607788 242.251343 157.715363 244.591873 156.544388 L 249.116989 154.276337 L 263.0495 147.364243 L 278.732574 139.587021 L 283.125916 137.406158 C 283.994324 136.979523 285.108246 136.467285 285.921356 135.994781 C 287.058746 135.345322 288.077362 134.507217 288.933472 133.516327 C 292.887177 128.926895 292.202576 121.467407 287.469788 117.74881 C 285.887634 116.505646 284.056183 115.782028 282.262939 114.896622 L 275.540497 111.566772 L 252.542023 100.239471 L 245.657806 96.835022 C 245.349777 96.681107 245.054718 96.53212 244.770096 96.388397 Z M 241.139893 104.779465 C 241.490112 104.967133 241.83017 105.149338 242.156433 105.312271 L 247.808517 108.094299 L 265.681885 116.901123 L 277.893036 122.924942 C 279.119019 123.541245 280.394623 124.112076 281.591187 124.766373 C 282.75589 125.403381 282.643677 127.456345 281.505005 128.032333 C 279.477478 129.057816 277.424805 130.03212 275.390717 131.042313 L 261.775757 137.794754 L 246.846924 145.220947 L 242.338379 147.434845 C 240.90715 148.151047 238.760712 149.438782 237.212997 149.6483 L 237.148453 149.649445 C 236.347702 149.663651 235.647308 149.676086 234.891327 149.331024 C 233.58844 148.736313 232.286835 148.08429 231.001511 147.45256 L 223.175995 143.555893 L 204.295868 134.250107 L 195.354401 129.827896 C 194.165131 129.243332 192.837936 128.682358 191.715118 128.004044 C 190.906601 127.515671 190.698929 125.983231 191.362244 125.297623 C 191.670105 124.979477 191.9841 124.746521 192.38829 124.553268 C 194.808578 123.333267 197.254578 122.160583 199.679993 120.952164 L 217.786179 111.978394 L 228.762894 106.523834 C 230.4151 105.697876 234.647781 103.327927 236.219528 103.164276 C 237.851334 103.017334 239.59465 103.951477 241.139893 104.779465 Z"/><path fill="currentColor" d="M 288.635193 145.318848 C 290.814087 145.186493 292.598328 145.987595 293.498627 148.10202 C 294.312836 150.014343 293.518768 152.689163 291.679047 153.712357 C 290.540222 154.345657 289.282776 154.924774 288.097656 155.513046 L 281.490692 158.786865 L 264.080139 167.429489 L 249.344238 174.762634 L 244.523972 177.160034 C 243.485199 177.673859 242.404694 178.250412 241.321625 178.639008 C 238.810013 179.55072 235.535065 179.765411 232.956284 178.93988 C 230.682785 178.211975 228.015686 176.76442 225.834229 175.666473 L 217.808624 171.703491 L 184.229187 155.157593 C 182.130493 154.126114 180.120987 153.374619 179.601318 150.835007 C 179.357193 149.594284 179.632477 148.307678 180.362671 147.275345 C 181.279388 145.973022 183.236298 145.143478 184.765869 145.46521 C 186.261292 145.779785 188.339981 146.951614 189.725189 147.641083 L 195.311813 150.424103 L 227.259048 166.177185 L 232.224228 168.629761 C 233.219116 169.123001 234.62178 169.908508 235.661407 170.16333 C 236.396469 170.343704 237.675781 170.244385 238.36853 169.941666 C 240.006577 169.225464 241.706955 168.335342 243.315125 167.534393 L 252.050079 163.213791 L 279.654266 149.534256 C 281.326904 148.715729 287.194519 145.580826 288.537872 145.335724 L 288.635193 145.318848 Z"/><path fill="currentColor" d="M 288.576172 165.897629 C 293.808472 165.48587 295.77124 171.601578 291.525818 174.372742 C 290.652557 174.942719 289.314087 175.488983 288.335327 175.970764 L 282.488464 178.866974 L 263.286621 188.405731 L 248.137665 195.946838 L 244.179108 197.914764 C 243.276688 198.362671 242.279648 198.893646 241.338776 199.212219 C 238.650085 200.146652 235.742874 200.252411 232.993439 199.515503 C 231.170731 199.019562 227.380524 197.041046 225.495224 196.093185 L 217.138306 191.951385 L 184.341812 175.769531 C 182.247559 174.740326 180.189301 174.015137 179.608597 171.4991 C 179.343903 170.303253 179.568863 169.051392 180.233322 168.022476 C 181.158035 166.586945 182.997467 165.785858 184.679688 166.025833 C 186.319458 166.259659 191.112274 168.936188 192.91597 169.812881 L 223.025345 184.66983 L 231.498886 188.851379 C 232.721741 189.451782 234.295197 190.358917 235.568649 190.738251 C 237.679779 191.366974 240.242264 189.645309 242.122574 188.719177 L 250.808914 184.418015 L 279.461456 170.187073 L 284.802704 167.518097 C 285.981659 166.936829 287.321442 166.17662 288.576172 165.897629 Z"/></g></g></svg>`);
		this.addRibbonIcon("evc-relay", "Relay settings", () => {
			void this.showSettingsTab();
		});

		this.register(
			this.loggingSettings.subscribe((settings) => {
				if (settings.debugging) {
					this.activateDebugMode();
					this.removeCommand("enable-debugging");
					for (const cmd of DEBUG_MODAL_COMMANDS) {
						this.addCommand({
							id: cmd.id,
							name: cmd.name,
							callback: () => {
								const modal = cmd.openModal(this);
								this.activeModals.push(modal);
								modal.open();
							},
						});
					}
					this.addCommand({
						id: "disable-debugging",
						name: "Disable debugging",
						callback: () => {
							this.deactivateDebugMode(true);
						},
					});
				} else {
					for (const cmd of DEBUG_MODAL_COMMANDS) {
						this.removeCommand(cmd.id);
					}
					this.removeCommand("disable-debugging");
					this.addCommand({
						id: "enable-debugging",
						name: "Enable debugging",
						callback: () => {
							this.activateDebugMode(true);
						},
					});
				}
			}),
		);

		// Store app reference for reload function (avoid window.app per Obsidian guidelines)
		const appRef = this.app as unknown as ObsidianApp;
		appRef.reloadRelay = async () => {
			await appRef.plugins.disablePlugin("team-relay");
			await appRef.plugins.enablePlugin("team-relay");
		};

		this.addCommand({
			id: "reload",
			name: "Reload relay",
			callback: async () => await (this.app as unknown as ObsidianApp).reloadRelay?.(),
		});

		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				void this.showSettingsTab();
			},
		});

		this.addCommand({
			id: "configure-endpoints",
			name: "Configure enterprise tenant",
			callback: () => {
				this.showTenantConfigModal();
			},
		});

		const vault = this.app.vault;
		this.pluginVault = vault;
		const vaultName = vault.getName();
		this.vaultFileManager = this.app.fileManager;
		this.fileHashRegistry = new FileHashCache(this.instanceAppId);

		// TenantRegistry has to be constructed and validated before we can
		// build AuthSession, since AuthSession wires itself up against
		// whatever endpoints come out of that validation pass.
		const endpointManager = new TenantRegistry(this.tenantEndpointSettings);
		await this.verifyEndpointsAtStartup(endpointManager);

		this.authSession = new AuthSession(
			this.instanceAppId,
			this.showSettingsTab.bind(this),
			this.clock,
			this.installWebviewerPatch.bind(this),
			this.authSettingsScope,
			endpointManager,
			this.relayOnPremSettings.readValue(),
			this.relayOnPremSettings,
		);
		this.relayRegistry = new RelayRegistry(this.authSession);
		this.shareRegistry = new ShareRegistry(
			this.relayRegistry,
			this.pluginVault,
			this._instantiateVaultShare.bind(this),
			this.sharedFolderSettings,
		);

		// Initialize relay-onprem token providers and share client if enabled
		const relayOnPremSettings = this.relayOnPremSettings.readValue();
		const defaultServer = getDefaultServer(relayOnPremSettings);
		// /tracks which URL the settings-subscription block below
		// last saw for the resolved default server, so it can detect an edit
		// and re-point serviceHealth's health-check URL.
		let tokenProviderControlPlaneUrl = defaultServer?.controlPlaneUrl;

		// Lazy auth provider for a SPECIFIC server — defers to
		// authSession.getAuthProviderForServer(serverId) at call time
		// (needed because OAuth auth providers may not be available at
		// plugin load). Each on-prem server gets its own RelayOnPremTokenProvider
		// bound to one of these, so a /tokens/relay request always carries
		// that server's own token — a single shared provider bound to
		// whichever server happened to be "active" used to route every
		// on-prem share's token request through one server's auth.
		const buildLazyAuthProviderForServer = (serverId: string): IAuthProvider => ({
			isLoggedIn: () => this.authSession.getAuthProviderForServer(serverId)?.isLoggedIn() ?? false,
			getCurrentUser: () => this.authSession.getAuthProviderForServer(serverId)?.getCurrentUser(),
			getToken: () => this.authSession.getAuthProviderForServer(serverId)?.getToken(),
			getValidToken: async () => {
				const provider = this.authSession.getAuthProviderForServer(serverId);
				return provider ? await provider.getValidToken() : undefined;
			},
			loginWithPassword: () => Promise.reject(new Error("Use loginManager directly")),
			loginWithOAuth2: () => Promise.reject(new Error("Use loginManager directly")),
			refreshToken: () => {
				const provider = this.authSession.getAuthProviderForServer(serverId);
				if (!provider) return Promise.reject(new Error("No auth provider available"));
				return provider.refreshToken();
			},
			logout: () => Promise.reject(new Error("Use loginManager directly")),
			isTokenValid: () => this.authSession.getAuthProviderForServer(serverId)?.isTokenValid() ?? false,
		});

		// serverId -> its own RelayOnPremTokenProvider (own controlPlaneUrl +
		// own auth provider). Kept in sync with relayOnPremSettings.servers by
		// the settings-subscription block below (add/remove/URL-edit).
		const relayOnPremTokenProviders = new Map<string, RelayOnPremTokenProvider>();
		if (relayOnPremSettings.enabled) {
			for (const server of relayOnPremSettings.servers) {
				relayOnPremTokenProviders.set(
					server.id,
					new RelayOnPremTokenProvider({
						controlPlaneUrl: server.controlPlaneUrl,
						authProvider: buildLazyAuthProviderForServer(server.id),
						clientVersion: this.manifest.version,
					}),
				);
			}
		}

		if (relayOnPremSettings.enabled && defaultServer) {
			// Initialize share client for relay-onprem mode (backward compatibility)
			this.shareClient = new RelayOnPremShareClient(
				defaultServer.controlPlaneUrl,
				async () => {
					const provider = this.authSession.getAuthProvider();
					return provider ? await provider.getValidToken() : undefined;
				},
			);
		}

		// Wait for auth restoration before using auth state
		await this.authSession.waitForRestore();

		// Initialize multi-server share client manager
		if (relayOnPremSettings.enabled && relayOnPremSettings.servers.length > 0) {
			const multiServerAuthManager = this.authSession.getMultiServerAuthManager();
			if (multiServerAuthManager) {
				this.shareClientManager = new RelayOnPremShareClientManager(
					multiServerAuthManager,
					relayOnPremSettings.servers,
				);
			}
		}

		// Initialize WebSyncManager for auto-sync (v1.8.1)
		if (this.shareClientManager) {
			const { WebSyncManager } = await import("./WebSyncManager");
			this.webSyncManager = new WebSyncManager(
				this.pluginVault,
				this.shareClientManager
			);
		}

		// Initialize InboundFileDownloader for sync-artifact inbound sync (v1.9)
		if (this.pluginVault && this.shareClientManager && this.webSyncManager) {
			const { InboundFileDownloader } = await import("./InboundFileDownloader");
			// Persisted across restarts — see InboundFileDownloader's
			// constructor doc for why an in-memory-only manifest is unsafe.
			const hashManifestStore = new VaultScopedMap<Record<string, string>>(
				"InboundSyncHashManifest/" + vaultName,
				this.app,
			);
			this.inboundFileDownloader = new InboundFileDownloader(
				this.pluginVault,
				this.app.fileManager,
				this.shareClientManager,
				this.webSyncManager,
				hashManifestStore,
			);

			this.addCommand({
				id: "show-sync-conflicts",
				name: "Show sync conflicts",
				callback: () => {
					void (async () => {
						const { SyncConflictsModal } = await import("./ui/SyncConflictsModal");
						new SyncConflictsModal(this.app, this).open();
					})();
				},
			});
		}

		// Initialize InboundSyncPoller (v1.9)
		if (this.shareClientManager && this.webSyncManager && this.inboundFileDownloader) {
			const { InboundSyncPoller } = await import("./InboundSyncPoller");
			// Persisted across restarts — see InboundSyncPoller's
			// constructor doc for why an in-memory-only watermark is unsafe.
			const lastUpdatedAtStore = new VaultScopedMap<string>(
				"InboundSyncLastUpdatedAt/" + vaultName,
				this.app,
			);
			this.inboundSyncPoller = new InboundSyncPoller(
				this.clock,
				this.shareClientManager,
				this.webSyncManager,
				this.inboundFileDownloader,
				undefined,
				lastUpdatedAtStore,
			);
			// Every way a shared folder goes away (deleted, unshared from the
			// menu, the share view or the management modal) leaves the
			// registry; stop polling a share that no longer has a VaultShare
			// or, for one polled by path alone, its folder.
			this.register(
				this.shareRegistry.on(() => {
					// A share polled by path that now has a VaultShare follows the
					// VaultShare from here on: disconnecting it stops the polling.
					for (const shareId of [...this.pathOnlyPolledShares.keys()]) {
						if (this.shareRegistry.locate((sf) => sf.entityGuid === shareId)) {
							this.pathOnlyPolledShares.delete(shareId);
						}
					}
					this.inboundSyncPoller?.retainOnly(this.keepPollingShare);
				}),
			);
		}

		// Add status bar item for Relay On-Prem (v1.8.2)
		if (relayOnPremSettings.enabled) {
			this.addRelayStatusBarItem();
		}

		this.credentialCache = new RelayCredentialCache(
			this.authSession,
			this.clock,
			vaultName,
			3,
			relayOnPremTokenProviders,
			this.app,
			defaultServer?.id,
		);

		this.serviceHealth = new ServiceHealthMonitor(
			this.clock,
			healthUrlForServer(defaultServer),
		);

		this.transferQueue = new TransferQueue(
			this.authSession,
			this.clock,
			this.shareRegistry,
		);

		{
			const { CrdtBackgroundSyncPoller } = await import(
				"./CrdtBackgroundSyncPoller"
			);
			this.crdtBackgroundSyncPoller = new CrdtBackgroundSyncPoller(
				this.clock,
				this.shareRegistry,
			);
		}

		if (!this.authSession.initialize()) {
			// In relay-onprem mode, setup() returns false because auth is handled
			// asynchronously via waitForRestore(). Only show notice for non-relay-onprem.
			if (!this.authSession.isRelayOnPremMode()) {
				new Notice("Please sign in to use relay");
			}
		}

		this.app.workspace.onLayoutReady(() => {
			this.shareRegistry.restore();

			const liveViews = new ViewBindingRegistry(
				this.app,
				this.shareRegistry,
				this.authSession,
				this.serviceHealth,
			);
			this._viewRegistry = liveViews;
			// The editor extensions list is registered exactly once here; after
			// that it's mutated in place and this.app.workspace.updateOptions()
			// is what applies further changes — not another registerEditorExtension call.
			this.registerEditorExtension(liveViews.cmExtensions);

			const handleLoginStateChange = () => {
				// A new session may open shares the old one was refused.
				this.credentialCache.clearAccessDenied();
				if (this.authSession.isAuthenticated) {
					this._handleAuthLogin();
				} else {
					this._handleAuthLogout();
				}
			};
			this.register(this.authSession.on(handleLoginStateChange));
			// A refreshed session may carry access a refused share lacked.
			this.register(this.authSession.onTokenRefreshed(() => this.credentialCache.clearAccessDenied()));

			// Auth can finish restoring before onLayoutReady fires, in which case
			// the listener registered above misses that first state-change event —
			// so if we're already logged in at this point, run the login side of
			// the handler once manually to pick it up.
			if (this.authSession.isAuthenticated) {
				this._handleAuthLogin();
			}

			this.credentialCache.startSweeping();

			// Sync shareClientManager when relay-onprem settings change. The
			// added/removed/updated split (updated = controlPlaneUrl or name
			// actually changed) lives in reconcileRelayOnPremServers.ts so it's
			// unit-testable without constructing the plugin.
			let prevServers = snapshotRelayOnPremServers(
				this.relayOnPremSettings.readValue().servers,
			);
			this.register(
				this.relayOnPremSettings.subscribe((settings) => {
					const currentServers = settings.servers || [];
					const diff = diffRelayOnPremServers(prevServers, currentServers);

					for (const server of diff.added) {
						void this.ensureShareClientManager();
						this.shareClientManager?.addServer(server);
						this.credentialCache.setRelayOnPremProvider(
							server.id,
							new RelayOnPremTokenProvider({
								controlPlaneUrl: server.controlPlaneUrl,
								authProvider: buildLazyAuthProviderForServer(server.id),
								clientVersion: this.manifest.version,
							}),
						);
					}
					for (const id of diff.removedIds) {
						this.shareClientManager?.removeServer(id);
						this.credentialCache.removeRelayOnPremProvider(id);
					}
					// a per-server provider is otherwise long-lived and
					// never re-reads settings on its own, so a control-plane URL
					// edit left /tokens/relay going to the old host until
					// Obsidian restarted. Simplest correct fix for N servers is
					// to replace the provider (was updateControlPlaneUrl() on
					// the single shared instance before multi-server). Limited
					// to diff.updated — relayOnPremSettings.subscribe() fires on
					// ANY settings write (e.g. toggling a different server's
					// default flag), and recreating every known provider
					// unconditionally on every write drops in-flight
					// TokenRequestThrottle queues for servers nothing changed on.
					for (const server of diff.updated) {
						this.shareClientManager?.updateServer(server);
						this.credentialCache.setRelayOnPremProvider(
							server.id,
							new RelayOnPremTokenProvider({
								controlPlaneUrl: server.controlPlaneUrl,
								authProvider: buildLazyAuthProviderForServer(server.id),
								clientVersion: this.manifest.version,
							}),
						);
					}
					prevServers = snapshotRelayOnPremServers(currentServers);

					const newDefaultServer = getDefaultServer(settings);
					this.credentialCache.setDefaultRelayOnPremServerId(newDefaultServer?.id);
					if (
						newDefaultServer &&
						newDefaultServer.controlPlaneUrl !== tokenProviderControlPlaneUrl
					) {
						// serviceHealth's health-check URL is derived from the
						// same default-server controlPlaneUrl — re-point it too, or a
						// server-URL edit leaves offline/online detection pointed at
						// the old (or no) host until Obsidian restarts.
						this.serviceHealth.updateUrl(healthUrlForServer(newDefaultServer));
						tokenProviderControlPlaneUrl = newDefaultServer.controlPlaneUrl;
					}
				})
			);

			if (!Platform.isIosApp) {
				// iOS reports offline unconditionally, so network status is skipped there.
				this.serviceHealth.addStatusListener("offline", () => {
					this.credentialCache.stopSweeping();
					this.shareRegistry.each((folder) => folder.goOffline());
					this._viewRegistry.handleNetworkOffline();
				});
				this.serviceHealth.addStatusListener("online", () => {
					this.credentialCache.startSweeping();
					this.relayRegistry.watchRealtime();
					void this.relayRegistry.refresh();
					this._viewRegistry.handleNetworkOnline();
				});
				this.serviceHealth.beginPolling();
			}

			this.registerView(
				VIEW_TYPE_FILE_DIFF,
				(leaf) => new FileDiffView(leaf),
			);

			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (file instanceof TFolder) {
						const folder = this.shareRegistry.locate(
							(vaultShare) => vaultShare.path === file.path,
						);
						if (!folder) {
							// Folder is not shared yet - offer to share in relay-onprem mode,
							// unless it's nested with an existing share: Relay doesn't
							// support overlapping shares, so don't even offer the option.
							const nestingConflict = this.shareRegistry.findNestingConflict(file.path);
							if (
								!nestingConflict &&
								this.authSession.isRelayOnPremMode() &&
								this.authSession.isLoggedInToAnyServer()
							) {
								menu.addItem((item) => {
									item
										.setTitle("Relay: share folder")
										.setIcon("share-2")
										.onClick(() => {
											const modal = new QuickShareModal(this.app, this, file.path);
											modal.open();
										});
								});
							}
							return;
						}
						if (folder.workspaceId) {
							menu.addItem((item) => {
								item
									.setTitle("Relay: relay settings")
									.setIcon("gear")
									.onClick(() => {
										void this.showSettingsTab(`/relays?id=${folder.workspaceId}`);
									});
							});
							menu.addItem((item) => {
								item
									.setTitle("Relay: share settings")
									.setIcon("settings")
									.onClick(() => {
										if (folder.config?.onpremServerId && this.authSession.isRelayOnPremMode()) {
											// eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for optional polyfill
											const { ShareManagementModal } = require("./ui/ShareManagementModal") as typeof import("./ui/ShareManagementModal");
											new ShareManagementModal(this.app, this, folder.config.onpremServerId, undefined, folder.entityGuid).open();
										} else {
											void this.showSettingsTab(`/shared-folders?id=${folder.entityGuid}`);
										}
									});
							});
							menu.addItem((item) => {
								item
									.setTitle(
										folder.isOnline ? "Relay: disconnect" : "Relay: connect",
									)
									.setIcon("satellite")
									.onClick(() => {
										if (folder.isOnline) {
											folder.wantsConnection = false;
											folder.goOffline();
										} else {
											folder.wantsConnection = true;
											// A manual connect retries a refused share now.
											folder.clearAccessDenied();
											void folder.bringOnline();
										}
										void this._viewRegistry.refreshViews("folder connection toggle");
									});
							});
						} else {
							menu.addItem((item) => {
								item
									.setTitle("Relay: share settings")
									.setIcon("settings")
									.onClick(() => {
										if (folder.config?.onpremServerId && this.authSession.isRelayOnPremMode()) {
											// eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for optional polyfill
											const { ShareManagementModal } = require("./ui/ShareManagementModal") as typeof import("./ui/ShareManagementModal");
											new ShareManagementModal(this.app, this, folder.config.onpremServerId, undefined, folder.entityGuid).open();
										} else {
											void this.showSettingsTab(`/shared-folders?id=${folder.entityGuid}`);
										}
									});
							});
							// Add Unshare option for relay-onprem folders
							if (folder.config?.onpremServerId && this.authSession.isRelayOnPremMode()) {
								menu.addItem((item) => {
									item
										.setTitle("Relay: unshare folder")
										.setIcon("folder-x")
										.onClick(async () => {
											const confirmed = await confirmDialog(
												this.app,
												`Are you sure you want to unshare "${folder.path}"?\n\nThis will remove the share from the server and disconnect this folder.`
											);
											if (!confirmed) return;

											try {
												// Delete from server
												if (this.shareClientManager && folder.entityGuid) {
													await this.shareClientManager.deleteShare(
														folder.config.onpremServerId!,
														folder.entityGuid
													);
												}
												// Remove local shared folder
												if (folder.entityGuid) this.inboundSyncPoller?.unregisterShare(folder.entityGuid);
												this.shareRegistry.delete(folder);
												this.explorerDecorations?.refreshExistingRows();
												new Notice(`Folder "${folder.path}" unshared`);
											} catch (error: unknown) {
												new Notice(
													`Failed to unshare: ${error instanceof Error ? error.message : "Unknown error"}`
												);
											}
										});
								});
							}
						}
						if (folder.workspaceId && folder.isOnline) {
							menu.addItem((item) => {
								item
									.setTitle("Relay: sync")
									.setIcon("folder-sync")
									.onClick(async () => {
										void folder.refreshFromServer();
										// Also update web_folder_items if share is web-published
										if (this.webSyncManager && this.shareClientManager && folder.entityGuid) {
											try {
												const serverId = folder.config?.onpremServerId;
												if (serverId) {
													const share = await this.shareClientManager.getShare(serverId, folder.entityGuid);
													if (share?.web_published) {
														await this.webSyncManager.syncFolderStructureToWeb(
															folder.path, serverId, folder.entityGuid
														);
													}
												}
											} catch {
												// Web sync is best-effort, don't block CRDT sync
											}
										}
									});
							});
						}
					} else if (file instanceof TFile) {
						const folder = this.shareRegistry.shareFor(file.path);
						const ifile = folder?.entryFor(file);
						if (ifile && isAttachmentFile(ifile)) {
							menu.addItem((item) => {
								item
									.setTitle("Relay: download")
									.setIcon("cloud-download")
									.onClick(async () => {
										await ifile.pullFromRemote();
										new Notice(`Download complete: ${ifile.name}`);
									});
							});
							if (this.loggingSettings.readValue().debugging) {
								menu.addItem((item) => {
									item
										.setTitle("Relay: verify upload")
										.setIcon("search-check")
										.onClick(async () => {
											const present = await ifile.verifyRemoteUpload();
											new Notice(
												`${ifile.name} ${present ? "on server" : "missing from server"}`,
											);
										});
								});
							}
							menu.addItem((item) => {
								item
									.setTitle("Relay: upload")
									.setIcon("cloud-upload")
									.onClick(async () => {
										await ifile.pushToRemote(true);
										const present = await ifile.verifyRemoteUpload();
										new Notice(
											`${present ? "File uploaded:" : "File upload failed:"} ${ifile.name}`,
										);
									});
							});
						}
					}
				}),
			);
			this.initializeRuntime();
			void this._viewRegistry.refreshViews("init");
			this.startupDurationMs = moment.now() - start;

		});
	}

	async reloadPlugin() {
		await (this.app as unknown as ObsidianApp).reloadRelay?.();
	}

	private _instantiateVaultShare(
		path: string,
		guid: string,
		workspaceId?: string,
		hasPendingUpdates?: boolean,
		isRestore?: boolean,
		freshlyCreated?: boolean,
	): VaultShare {
		// Address this folder's settings slice by its guid, not array index.
		const folderSettings = new SettingsScope<VaultShareSettings>(
			this.pluginSettings as unknown as Settings<unknown>,
			`sharedFolders/[guid=${guid}]`,
		);
		const settings: VaultShareSettings = { guid: guid, path: path };
		if (workspaceId) {
			settings["relay"] = workspaceId;
		}
		void folderSettings.mutateValue((current) => {
			return {
				...current,
				path,
				guid,
				...(workspaceId ? { relay: workspaceId } : {}),
				...{
					sync: current.sync ? current.sync : AttachmentSyncSettings.defaultCategoryFlags,
				},
			};
		}, true);

		const folder = new VaultShare(
			this.instanceAppId,
			guid,
			path,
			this.authSession,
			this.pluginVault,
			this.vaultFileManager,
			this.credentialCache,
			this.relayRegistry,
			this.fileHashRegistry,
			this.transferQueue,
			folderSettings,
			this.app,
			workspaceId,
			hasPendingUpdates,
			isRestore,
			freshlyCreated,
		);
		return folder;
	}

	/**
	 * Vault "rename" handler, extracted out of setup() for readability.
	 * A folder rename that matches a top-level shared-folder root is handled
	 * as a folder move; everything else (files, and folders nested inside a
	 * shared folder) is resolved via a from/to shared-folder lookup.
	 */
	private handleVaultRename(
		file: TAbstractFile,
		oldPath: string,
		vaultLog: ReturnType<typeof namedLogger>,
	): void {
		// TODO an empty folder move isn't detected here yet.
		const movedVaultShare =
			file instanceof TFolder
				? this.shareRegistry.locate((folder) => folder.path == oldPath)
				: undefined;
		if (movedVaultShare) {
			movedVaultShare.relocate(file.path);
			this.shareRegistry.notifyDebounced();
			// Update web_folder_items for auto-sync folder shares
			this.webSyncManager?.onFileRenamed(file.path, oldPath);
			return;
		}

		const fromFolder = this.shareRegistry.shareFor(oldPath);
		const toFolder = this.shareRegistry.shareFor(file.path);
		const folder = fromFolder || toFolder;
		if (fromFolder?.isRecoveryMove(oldPath, file.path) || toFolder?.isRecoveryMove(oldPath, file.path)) {
			void this._viewRegistry.refreshViews("structural recovery");
			return;
		}
		if (folder) {
			vaultLog("Rename", file.path, oldPath);
			if (fromFolder && toFolder) {
				// File moved from one shared folder into another -- tell both sides.
				fromFolder.renameEntry(file, oldPath);
				toFolder.renameEntry(file, oldPath);
				void this._viewRegistry.refreshViews("rename");
				this.explorerDecorations.refreshExistingRows();
			} else {
				folder.renameEntry(file, oldPath);
				void this._viewRegistry.refreshViews("rename");
				this.explorerDecorations.refreshAllRows();
			}
		}
		// Update web_folder_items for auto-sync folder shares
		this.webSyncManager?.onFileRenamed(file.path, oldPath);
	}

	/**
	 * Folder shares polled because a folder sits at their path although no
	 * VaultShare was made for it; keyed by share id, valued by that path.
	 */
	private pathOnlyPolledShares = new Map<string, string>();

	/** Whether a polled share still has a VaultShare, or still has its folder. */
	private keepPollingShare = (shareId: string): boolean => {
		if (this.shareRegistry.locate((sf) => sf.entityGuid === shareId)) return true;
		const path = this.pathOnlyPolledShares.get(shareId);
		return path !== undefined && !!resolveShareFolder(this.app.vault, path);
	};

	/**
	 * Hand a folder share from the share list to the inbound poller: polled
	 * if it has a VaultShare or a folder in this vault, otherwise checked
	 * from the listed timestamp.
	 */
	private trackFolderShare(
		shareId: string,
		serverId: string,
		sharePath: string,
		listedUpdatedAt: string | null | undefined,
	): void {
		if (!this.inboundSyncPoller) return;
		// Re-run after a listed check's download: once it has written the
		// folder, the share is polled.
		const isLocal = (): boolean => {
			const registered = !!this.shareRegistry.locate((sf) => sf.entityGuid === shareId);
			const pathOnly = !registered && !!resolveShareFolder(this.app.vault, sharePath);
			if (pathOnly) this.pathOnlyPolledShares.set(shareId, sharePath);
			else this.pathOnlyPolledShares.delete(shareId);
			return registered || pathOnly;
		};
		this.inboundSyncPoller.track(shareId, serverId, isLocal(), listedUpdatedAt, isLocal);
	}

	private async loadRelayOnPremShares() {
		const log = namedLogger("[RelayOnPrem]", "log");
		const err = namedLogger("[RelayOnPrem]", "error");

		try {
			log("Loading existing shares from control plane...");

			// Use multi-server manager if available, otherwise fall back to single client
			if (this.shareClientManager) {
				// Multi-server mode: load from all servers
				const rawShares = await this.shareClientManager.getAllSharesFlat();
				// Collapse duplicate folder shares at the same path down to the
				// newest one BEFORE processing -- see dedupeFolderSharesByPath's
				// doc comment: without this, N shares at one path
				// churn the local VaultShare through N migrate-and-reconnect
				// cycles instead of settling on the one that should win.
				const allShares = dedupeFolderSharesByPath(rawShares);
				log(`Found ${rawShares.length} shares across all servers (${allShares.length} after folder-path dedup)`);

				for (const share of allShares) {
					if (share.kind === "folder") {
						// Find existing by guid OR by path (settings may have old client-side guid)
						const byGuid = this.shareRegistry.locate(
							(sf) => sf.entityGuid === share.id
						);
						const byPath = !byGuid ? this.shareRegistry.locate(
							(sf) => sf.path === share.path
						) : undefined;
						const existing = byGuid || byPath;

						if (existing && (existing.entityGuid !== share.id || !existing.workspaceId)) {
							// Migrate: guid mismatch or missing workspaceId — recreate
							log(`Migrating VaultShare ${share.path} (guid: ${existing.entityGuid} → ${share.id})`);
							this.shareRegistry.delete(existing);
							const vaultShare = this.shareRegistry.new(
								share.path,
								share.id,
								"relay-onprem",
								false
							);
							if (vaultShare) {
								await vaultShare.setOnpremServerId(share.serverId);
								// onpremServerId is set AFTER construction — the constructor's
								// own gate never saw it, so trigger the connect explicitly.
								void vaultShare.bringOnline();
							}
						} else if (!existing) {
							// Only auto-create if the folder exists locally in vault
							const vaultFolder = resolveShareFolder(this.app.vault, share.path);
							if (vaultFolder) {
								const vaultShare = this.shareRegistry.new(
									share.path,
									share.id,
									"relay-onprem",
									true
								);
								if (vaultShare) {
									await vaultShare.setOnpremServerId(share.serverId);
									void vaultShare.bringOnline();
								}
								log(`Created VaultShare for ${share.path} on server ${share.serverId}`);
							} else {
								log(`Share "${share.path}" not connected locally (folder not in vault)`);
							}
						} else if (existing && !existing.isOnline) {
							// Folder exists with correct guid+workspaceId but not connected
							log(`Connecting VaultShare ${share.path}`);
							void existing.bringOnline();
						}
					}

					// Register auto-sync shares (v1.8.1) - supports both doc and folder shares
					if (share.web_published && share.web_sync_mode === "auto") {
						if (this.webSyncManager) {
							this.webSyncManager.registerAutoSyncShare(
								share.path,
								share.id,
								share.serverId,
								share.kind,
								share.web_slug ?? undefined
							);
							log(`Registered auto-sync for ${share.kind} ${share.path} on server ${share.serverId}`);
						}
					}

					// Inbound polling only for folders present in the vault; the
					// rest are checked against this list (v1.9).
					if (share.kind === "folder" && this.inboundSyncPoller) {
						this.trackFolderShare(share.id, share.serverId, share.path, share.web_content_updated_at);
					}
				}

				// Deferred initial full-sync for stale auto-sync folder shares
				const staleAutoSyncShares = allShares.filter(s => {
					if (!s.web_published || s.kind !== "folder" || s.web_sync_mode !== "auto") return false;
					if (!s.web_content_updated_at) return true;
					return Date.now() - new Date(s.web_content_updated_at).getTime() > 6 * 60 * 60 * 1000;
				});
				if (staleAutoSyncShares.length > 0) {
					log(`Scheduling initial full-sync for ${staleAutoSyncShares.length} stale auto-sync shares`);
					window.setTimeout(() => { void this._initialFullSync(staleAutoSyncShares); }, 15_000);
				}
			} else if (this.shareClient) {
				// Single-server mode (legacy)
				const rawShares = await this.shareClient.listShares();
				// Same folder-path collision, same fix as the multi-server
				// branch above -- see dedupeFolderSharesByPath's doc comment
				//.
				const shares = dedupeFolderSharesByPath(rawShares);
				log(`Found ${rawShares.length} shares (${shares.length} after folder-path dedup)`);

				// Get default server ID
				const relayOnPremSettings = this.relayOnPremSettings.readValue();
				const defaultServerId = relayOnPremSettings.defaultServerId ||
					(relayOnPremSettings.servers.length > 0 ? relayOnPremSettings.servers[0].id : "default");

				for (const share of shares) {
					if (share.kind === "folder") {
						// Find existing by guid OR by path (settings may have old client-side guid)
						const byGuid = this.shareRegistry.locate(
							(sf) => sf.entityGuid === share.id
						);
						const byPath = !byGuid ? this.shareRegistry.locate(
							(sf) => sf.path === share.path
						) : undefined;
						const existing = byGuid || byPath;

						if (existing && (existing.entityGuid !== share.id || !existing.workspaceId)) {
							// Migrate: guid mismatch or missing workspaceId — recreate
							log(`Migrating VaultShare ${share.path} (guid: ${existing.entityGuid} → ${share.id})`);
							this.shareRegistry.delete(existing);
							const vaultShare = this.shareRegistry.new(
								share.path,
								share.id,
								"relay-onprem",
								false
							);
							if (vaultShare) {
								await vaultShare.setOnpremServerId(defaultServerId);
								// onpremServerId is set AFTER construction — the constructor's
								// own gate never saw it, so trigger the connect explicitly.
								void vaultShare.bringOnline();
							}
						} else if (!existing) {
							// Only auto-create if the folder exists locally in vault
							const vaultFolder = resolveShareFolder(this.app.vault, share.path);
							if (vaultFolder) {
								const vaultShare = this.shareRegistry.new(
									share.path,
									share.id,
									"relay-onprem",
									true
								);
								if (vaultShare) {
									await vaultShare.setOnpremServerId(defaultServerId);
									void vaultShare.bringOnline();
								}
								log(`Created VaultShare for ${share.path}`);
							} else {
								log(`Share "${share.path}" not connected locally (folder not in vault)`);
							}
						} else if (existing && !existing.isOnline) {
							// Folder exists with correct guid+workspaceId but not connected
							log(`Connecting VaultShare ${share.path}`);
							void existing.bringOnline();
						}
					}

					// Register auto-sync shares (v1.8.1) - supports both doc and folder shares
					if (share.web_published && share.web_sync_mode === "auto") {
						if (this.webSyncManager) {
							this.webSyncManager.registerAutoSyncShare(
								share.path,
								share.id,
								defaultServerId,
								share.kind,
								share.web_slug ?? undefined
							);
							log(`Registered auto-sync for ${share.kind} ${share.path}`);
						}
					}

					// Inbound polling only for folders present in the vault; the
					// rest are checked against this list (v1.9).
					if (share.kind === "folder" && this.inboundSyncPoller) {
						this.trackFolderShare(share.id, defaultServerId, share.path, share.web_content_updated_at);
					}
				}
			} else {
				log("No share client available, skipping share load");
				return;
			}

			// Start inbound poller after all shares registered (v1.9)
			this.inboundSyncPoller?.start();

			// Refresh visual indicators
			this.explorerDecorations?.refreshExistingRows();
			log("Relay-onprem shares loaded");
		} catch (error: unknown) {
			err("Failed to load relay-onprem shares:", error);
		}
	}

	/**
	 * Add status bar item with menu for Relay On-Prem (v1.8.3)
	 */
	private addRelayStatusBarItem() {
		const statusBarItem = this.addStatusBarItem();
		statusBarItem.addClass("relay-onprem-statusbar");
		// Use the same registered evc-relay icon as ribbon
		const iconEl = statusBarItem.createSpan({ cls: "relay-status-icon" });
		setIcon(iconEl, "evc-relay");
		statusBarItem.setAttribute("aria-label", "Relay status");
		statusBarItem.setAttribute("data-tooltip-position", "top");
		statusBarItem.addClass("evc-cursor-pointer");

		statusBarItem.addEventListener("click", (event) => {
			const menu = new Menu();

			// Sync All option
			menu.addItem((item) => {
				item
					.setTitle("Sync all shares")
					.setIcon("refresh-cw")
					.onClick(async () => {
						await this.syncAllShares();
					});
			});

			// Sync Current option
			menu.addItem((item) => {
				item
					.setTitle("Sync current file")
					.setIcon("file-sync")
					.onClick(async () => {
						await this.syncCurrentFile();
					});
			});

			menu.addSeparator();

			// Shares option
			menu.addItem((item) => {
				item
					.setTitle("Manage shares")
					.setIcon("folder-shared")
					.onClick(() => {
						// eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for optional polyfill
						const { ShareManagementModal } = require("./ui/ShareManagementModal") as typeof import("./ui/ShareManagementModal");
						new ShareManagementModal(this.app, this).open();
					});
			});

			// Settings option
			menu.addItem((item) => {
				item
					.setTitle("Settings")
					.setIcon("settings")
					.onClick(() => {
						void this.showSettingsTab("/relay-onprem");
					});
			});

			menu.showAtMouseEvent(event);
		});
	}

	/**
	 * Ensure shareClientManager exists, creating it lazily if needed
	 */
	private async ensureShareClientManager(): Promise<void> {
		if (this.shareClientManager) return;
		const settings = this.relayOnPremSettings.readValue();
		if (!settings.enabled || settings.servers.length === 0) return;
		const multiServerAuthManager = this.authSession.getMultiServerAuthManager();
		if (!multiServerAuthManager) return;
		this.shareClientManager = new RelayOnPremShareClientManager(
			multiServerAuthManager,
			settings.servers,
		);
		if (!this.webSyncManager) {
			const { WebSyncManager } = await import("./WebSyncManager");
			this.webSyncManager = new WebSyncManager(this.pluginVault, this.shareClientManager);
		}
	}

	/**
	 * Sync all web-published shares
	 */
	private async syncAllShares() {
		if (!this.shareClientManager) {
			new Notice("No share client available");
			return;
		}

		try {
			new Notice("Syncing all shares...");
			const shares = await this.shareClientManager.getAllSharesFlat();

			// 1. Reconnect CRDT relay for all folder shares. A manual sync
			// retries refused shares now instead of after their backoff.
			this.credentialCache.clearAccessDenied();
			let relaySynced = 0;
			for (const share of shares) {
				if (share.kind === "folder") {
					const folder = this.shareRegistry.locate(sf => sf.entityGuid === share.id);
					if (folder) {
						void folder.bringOnline();
						relaySynced++;
					} else {
						this.trackFolderShare(share.id, share.serverId, share.path, share.web_content_updated_at);
					}
				}
			}

			// 2. Sync web-published shares
			// pushes content directly via
			// shareClientManager, bypassing WebSyncManager's own syncFile()/
			// syncFolderFile() — wrap in the same echo-guard those use so
			// InboundSyncPoller/InboundFileDownloader don't race this manual
			// push the way fixed for the debounced auto-sync path.
			const { withOutboundSyncGuard } = await import("./WebSyncManager");
			let webSynced = 0;
			const webShares = shares.filter(s => s.web_published);
			await withOutboundSyncGuard(this.webSyncManager, async () => {
				for (const share of webShares) {
					try {
						if (share.kind === "doc") {
							const file = this.pluginVault.getAbstractFileByPath(share.path);
							if (file instanceof TFile) {
								const content = await this.pluginVault.read(file);
								await this.shareClientManager!.updateShare(share.serverId, share.id, {
									web_content: content,
								});
								webSynced++;
							}
						} else if (share.kind === "folder") {
							const folderAbs = resolveShareFolder(this.pluginVault, share.path);
							if (folderAbs) {
								// 1. Build recursive folder items and PATCH structure. Via
								// WebSyncManager so it obeys the per-share interval/backoff.
								const items = collectWebFolderItems(folderAbs, share.path);
								await this.pushFolderItems(share, items);
								// 2. POST content for each doc/canvas
								if (share.web_slug) {
									for (const item of items) {
										if (item.type === "doc" || item.type === "canvas") {
											try {
												const filePath = joinFolderPath(share.path, item.path);
												const f = this.pluginVault.getAbstractFileByPath(filePath);
												if (f instanceof TFile) {
													const content = await this.pluginVault.read(f);
													await this.shareClientManager!.syncFolderFileContent(
														share.serverId, share.web_slug, item.path, content
													);
													webSynced++;
												}
											} catch { /* skip individual file errors */ }
										}
									}
								}
							}
						}
					} catch (e: unknown) {
						console.error(`Failed to sync ${share.path}:`, e);
					}
				}
			});

			const parts = [];
			if (relaySynced > 0) parts.push(`${relaySynced} relay`);
			if (webSynced > 0) parts.push(`${webSynced} web`);
			new Notice(parts.length > 0 ? `Synced: ${parts.join(", ")}` : "No shares to sync");
		} catch (error: unknown) {
			new Notice(`Sync failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	/**
	 * PATCH a folder share's web_folder_items through WebSyncManager, so the
	 * push shares the per-share minimum interval, backoff and in-flight state
	 * with event-driven pushes.
	 */
	private async pushFolderItems(share: ShareWithServer, items: WebFolderEntry[]): Promise<void> {
		if (this.webSyncManager) {
			await this.webSyncManager.syncFolderStructureToWeb(share.path, share.serverId, share.id);
			return;
		}
		await this.shareClientManager!.updateShare(share.serverId, share.id, {
			web_folder_items: items,
		});
	}

	private async _initialFullSync(shares: ShareWithServer[]): Promise<void> {
		if (!this.shareClientManager) return;
		this.logInfo("Running initial full-sync for stale auto-sync shares", shares.length);
		// same echo-guard as syncAllShares —
		// this pushes content directly, bypassing WebSyncManager's own
		// syncFile()/syncFolderFile().
		const { withOutboundSyncGuard } = await import("./WebSyncManager");
		await withOutboundSyncGuard(this.webSyncManager, async () => {
			for (const share of shares) {
				try {
					const folderAbs = resolveShareFolder(this.pluginVault, share.path);
					if (!folderAbs) {
						this.logInfo("Folder not in vault, skipping initial full-sync", share.path);
						continue;
					}
					const items = collectWebFolderItems(folderAbs, share.path);
					await this.pushFolderItems(share, items);
					if (share.web_slug) {
						let syncedCount = 0;
						for (const item of items) {
							if (item.type === "doc" || item.type === "canvas") {
								try {
									const f = this.pluginVault.getAbstractFileByPath(joinFolderPath(share.path, item.path));
									if (f instanceof TFile) {
										const content = await this.pluginVault.read(f);
										if (!content) {
											this.logInfo("Skipping empty file in initial full-sync", item.path);
											continue;
										}
										await this.shareClientManager!.syncFolderFileContent(
											share.serverId, share.web_slug, item.path, content
										);
										syncedCount++;
										await new Promise<void>(r => window.setTimeout(r, 200));
									}
								} catch (e: unknown) {
									this.logInfo("Failed to sync file in initial full-sync", item.path, String(e));
								}
							}
						}
						this.logInfo("Initial full-sync done for share", share.path, syncedCount, "of", items.length);
					}
					// Bump web_content_updated_at so the stale check won't re-trigger on next startup
					await this.shareClientManager!.updateShare(share.serverId, share.id, {
						web_content_updated_at: new Date().toISOString(),
					});
				} catch (e: unknown) {
					this.logInfo("Initial full-sync failed for share", share.path, String(e));
				}
			}
		});
	}

	/**
	 * Sync the current active file if it's a web-published share (doc or inside folder share)
	 */
	private async syncCurrentFile() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file");
			return;
		}

		if (!this.shareClientManager) {
			new Notice("No share client available");
			return;
		}

		try {
			const shares = await this.shareClientManager.getAllSharesFlat();

			// same echo-guard as syncAllShares —
			// pushes content directly, bypassing WebSyncManager's own
			// syncFile()/syncFolderFile().
			const { withOutboundSyncGuard } = await import("./WebSyncManager");
			await withOutboundSyncGuard(this.webSyncManager, async () => {
				// Check direct doc share match
				const docShare = shares.find(s => s.path === activeFile.path && s.web_published);
				if (docShare) {
					const content = await this.pluginVault.read(activeFile);
					await this.shareClientManager!.updateShare(docShare.serverId, docShare.id, {
						web_content: content,
					});
					new Notice(`Synced ${activeFile.name} to web`);
					return;
				}

				// Check if file is inside a folder share. A root share
				// (path === "") contains every file unconditionally -- the
				// generic `path + "/"` prefix match is always false for it,
				// since real vault paths never start with a separator.
				const folderShare = shares.find(s =>
					s.kind === "folder" && s.web_published && s.web_slug &&
					(isRootSharePath(s.path) || activeFile.path.startsWith(s.path + "/"))
				);
				if (folderShare && folderShare.web_slug) {
					const content = await this.pluginVault.read(activeFile);
					const relativePath = isRootSharePath(folderShare.path)
						? activeFile.path
						: activeFile.path.substring(folderShare.path.length + 1);
					await this.shareClientManager!.syncFolderFileContent(
						folderShare.serverId, folderShare.web_slug, relativePath, content
					);
					new Notice(`Synced ${activeFile.name} to web`);
					return;
				}

				new Notice("Current file is not in a web-published share");
			});
		} catch (error: unknown) {
			new Notice(`Sync failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private _handleAuthLogout() {
		this.credentialCache?.clear();
		this.relayRegistry?.signOut();
		void this._viewRegistry.refreshViews("logout");
	}

	private _handleAuthLogin() {
		this.shareRegistry.restore();

		// Load relay-onprem shares after login
		if (this.shareClient || this.shareClientManager) {
			void this.loadRelayOnPremShares();
		}
		this.relayRegistry?.signIn();
		void this._viewRegistry.refreshViews("login");
	}

	async showSettingsTab(path: string = "/") {
		const setting = (this.app as unknown as ObsidianApp).setting;
		await setting.open();
		await setting.openTabById(this.manifest.id);
		this.settingsPage.showPath(path);
	}

	installWebviewerPatch(): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed to preserve `this` reference inside getPatchRegistry callback functions
		const plugin = this;
		try {
			if (this.webviewerPatchInstalled) {
				return;
			}

			const webviewer = (this.app as unknown as ObsidianApp).internalPlugins?.plugins?.webviewer;
			if (!webviewer?.instance?.options || !webviewer.enabled) {
				this.logWarn("core Webviewer plugin isn't enabled, nothing to patch");
				return;
			}

			const options = webviewer.instance.options;
			const originalDesc = Object.getOwnPropertyDescriptor(
				options,
				"openExternalURLs",
			);

			if (!originalDesc) {
				this.logWarn("openExternalURLs isn't defined on the Webviewer options -- can't patch");
				return;
			}

			// Capture the open-url event in a closure so the getter below can access it
			// without relying on the deprecated window.event global
			let capturedOpenUrlEvent: { type?: string; detail?: { url?: string } } | undefined;
			const openUrlListener = (e: Event) => {
				capturedOpenUrlEvent = e;
			};
			activeWindow.addEventListener("open-url", openUrlListener, true);

			Object.defineProperty(options, "openExternalURLs", {
				get(): boolean | undefined {
					const currentEvent = capturedOpenUrlEvent;
					if (currentEvent?.type === "open-url" && currentEvent?.detail?.url) {
						const url = currentEvent.detail.url;
						for (const pattern of plugin.webviewInterceptPatterns) {
							if (
								(typeof pattern === "string" && url.startsWith(pattern)) ||
								(pattern instanceof RegExp && pattern.test(url))
							) {
								plugin.logInfo(
									"matched an intercept pattern, deferring to the OS browser:",
									currentEvent.detail.url,
								);
								return false;
							}
						}
					}
					return originalDesc.value as boolean | undefined;
				},
				set(value: boolean) {
					originalDesc.value = value;
				},
				configurable: true,
			});

			this.register(() => {
				window.removeEventListener("open-url", openUrlListener, true);
				Object.defineProperty(options, "openExternalURLs", originalDesc);
			});

			const intercepts = this.authSession.resolveWebviewIntercepts();
			intercepts.forEach((intercept) => {
				this.logDebug("registering webviewer intercept pattern:", intercept.source);
				this.webviewInterceptPatterns.push(intercept);
			});

			const apiUrl = this.authSession.resolveTenantRegistry().resolveApiUrl();
			const apiRegExp = new RegExp(apiUrl.replace("/", "\\/") + ".*");
			this.logDebug("registering webviewer intercept pattern:", apiRegExp.source);
			this.webviewInterceptPatterns.push(apiRegExp);

			this.webviewerPatchInstalled = true;
			this.logDebug("webviewer external-URL patch installed");
		} catch (error: unknown) {
			this.logError("webviewer patch attempt threw:", error);
		}
	}

	initializeRuntime() {
		this.explorerDecorations = new ExplorerDecorationCoordinator(
			this.pluginVault,
			this.app.workspace,
			this.shareRegistry,
			this.transferQueue,
		);
		this.explorerDecorations.refreshAllRows();

		// Load relay-onprem shares if enabled
		if (this.shareClient || this.shareClientManager) {
			void this.loadRelayOnPremShares();
		}

		this.addSettingTab(this.settingsPage);

		const workspaceLog = namedLogger("[Relay][Workspace]", "log");

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				workspaceLog("file-open");
				void plugin._viewRegistry.refreshViews("file-open");
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				workspaceLog("workspace layout changed");
				void this._viewRegistry.refreshViews("layout-change");
			}),
		);

		const vaultLog = namedLogger("[Relay][Vault Events]", "log");

		const handlePromiseRejection = (event: PromiseRejectionEvent): void => {
			//event.preventDefault();
		};
		const rejectionListener = (event: PromiseRejectionEvent) =>
			handlePromiseRejection(event);
		activeWindow.addEventListener("unhandledrejection", rejectionListener, true);
		this.register(() =>
			activeWindow.removeEventListener("unhandledrejection", rejectionListener, true),
		);

		this.registerEvent(
			this.app.vault.on("create", (tfile) => {
				// NOTE: Obsidian fires this for every existing file on vault load too.
				const folder = this.shareRegistry.shareFor(tfile.path);
				if (folder) {
					// claimAndUploadFile() runs the same upload-claim protection
					// adoptLocalFiles has -- this event
					// fires for pre-existing files too, so it can race a second
					// client discovering the SAME brand-new vpath at once, same as
					// the initial-sync path.
					void folder.claimAndUploadFile(tfile);
				}
				// Update web_folder_items for auto-sync folder shares
				if (this.webSyncManager && tfile instanceof TFile) {
					this.webSyncManager.onFileCreated(tfile);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFolder && this.pathOnlyPolledShares.size > 0) {
					this.inboundSyncPoller?.retainOnly(this.keepPollingShare);
				}
				if (file instanceof TFolder) {
					const folder = this.shareRegistry.locate(
						(folder) => folder.path === file.path,
					);
					if (folder) {
						// The folder left the vault: stop polling its share.
						if (folder.entityGuid) this.inboundSyncPoller?.unregisterShare(folder.entityGuid);
						this.shareRegistry.delete(folder);
						return;
					}
				}
				const folder = this.shareRegistry.shareFor(file.path);
				if (folder) {
					vaultLog("Delete", file.path);
					const vpath = folder.toVirtualPath(file.path);
					folder.markDeletePending(vpath);
					void folder.awaitReady().then((folder) => {
						folder.rootRelative.removeEntry(file.path, file instanceof TFolder);
					}).finally(() => {
						folder.clearDeletePending(vpath);
					});
				}
				// Update web_folder_items for auto-sync folder shares
				this.webSyncManager?.onFileDeleted(file.path);
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.handleVaultRename(file, oldPath, vaultLog);
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (tfile) => {
				// InboundFileDownloader writes sync-artifact content via
				// vault.adapter.writeBinary(), which still fires this "modify" event
				// (the underlying file-system watcher doesn't distinguish it from a
				// user edit) — without this guard, our own inbound download for an
				// unconnected Document was mistaken for a local edit and enqueued
				// right back out via backgroundSync.enqueueUpload(), which reconciles
				// by diffing the vault file against the Y.Doc's CURRENT text
				// (TransferQueue.ts uploadDocumentViaSocket). If a second client's
				// edit had merged into that Y.Doc between the inbound write and this
				// handler firing, the echoed sync would treat the (now-stale)
				// inbound content as the "local edit" and reconcile against it,
				// demoting the second client's genuine edit into a conflict-copy
				// file ('s reconcileWithConflictCopy prevents outright data
				// loss, but this is still a spurious, avoidable conflict).
				// Previously only the web-auto-sync branch below checked this
				// (v1.9); this mirrors the same guard onto the VaultShare/Document
				// path (U4).
				const isInboundEcho =
					this.inboundFileDownloader?.isInboundWriting(tfile.path) ?? false;

				const folder = this.shareRegistry.shareFor(tfile.path);
				if (folder) {
					vaultLog("Modify", tfile.path);
					if (!isInboundEcho) {
						const file = folder.rootRelative.entryFor(tfile);
						if (file && isAttachmentFile(file)) {
							void file.runSync();
						}
						// For Documents (folder share files): without an editor bound to
						// the document, edits bypass Y.Text entirely (no live CM binding),
						// even while a background pull holds it connected. Enqueue a sync
						// to push vault content to relay. With an editor bound and
						// connected, LiveCMPluginValue handles sync automatically.
						if (file && isDocument(file) && uploadsOnModify(file)) {
							if (!file.isOnline) {
								void folder.transfers.enqueueUpload(file, { priority: true });
							} else if (tfile instanceof TFile) {
								void holdsOnlySyncedText(file, () => this.app.vault.read(tfile)).then((echo) => {
									if (!echo) void folder.transfers.enqueueUpload(file, { priority: true });
								});
							}
						}
					}
					// Trigger metadata resolve with the actual TFile (not our Document proxy)
					this.clock.scheduleTimeout(() => {
						this.app.metadataCache.trigger("resolve", tfile);
					}, 500);
				}

				// Handle auto-sync to web (v1.8.1); skip if InboundFileDownloader is writing (echo-loop guard, v1.9)
				if (this.webSyncManager && tfile instanceof TFile && !isInboundEcho) {
					void this.webSyncManager.onFileModified(tfile);
				}
			}),
		);

		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed to preserve `this` reference inside getPatchRegistry callback functions where `this` is rebound
		const plugin = this;

		getPatchRegistry().install(MarkdownView.prototype, {
			// At this point the view's editor references are still stale.
			onUnloadFile(old: unknown) {
				return function (this: unknown, file: unknown) {
					plugin._viewRegistry.clearExtensions();
					return (old as (...args: unknown[]) => unknown).call(this, file);
				};
			},
		});

		getPatchRegistry().install(this.app.vault, {
			process(old: unknown) {
				return function (
					this: unknown,
					tfile: unknown,
					fn: (data: string) => string,
					options: unknown,
				) {
					try {
						const tfileTyped = tfile as { path?: string };
						const folder = tfileTyped.path ? plugin.shareRegistry.shareFor(tfileTyped.path) : undefined;
						if (folder) {
							if (!(tfile instanceof TFile)) return;
						const file = folder.rootRelative.entryFor(tfile);
							if (file && isDocument(file)) {
								file.applyQueuedOps(fn);
							}
						}
					} catch (e: unknown) {
						plugin.logInfo(e);
					}

					return (old as (...args: unknown[]) => unknown).call(this, tfile, fn, options);
				};
			},
		});

		this.installWebviewerPatch();

		withToggle(featureKey.enableNewLinkFormat, () => {
			getPatchRegistry().install(MetadataCache.prototype, {
				fileToLinktext(next: unknown) {
					const old = next as (
						file: TFile,
						sourcePath: string,
						omitMdExtension?: boolean,
					) => string;
					return function (
						file: TFile,
						sourcePath: string,
						omitMdExtension?: boolean,
					) {
						const folder = plugin.shareRegistry.shareFor(file.path);
						if (!folder) {
							// @ts-ignore
							return old.call(this, file, sourcePath, omitMdExtension);
						}
						return plugin.vaultShareLinktext(
							file,
							sourcePath,
							omitMdExtension ?? true,
						);
					};
				},
			});
		});

		interface ProtocolLinkParams {
			action: string;
			relay?: string;
			id?: string;
			version?: string;
		}

		this.registerObsidianProtocolHandler("evc-team-relay/settings/relays", (e) => {
			const parameters = e as unknown as ProtocolLinkParams;
			const query = new URLSearchParams({ ...parameters }).toString();
			const path = `/${parameters.action.split("/").slice(-1).join("")}?${query}`;
			void this.showSettingsTab(path);
		});

		this.registerObsidianProtocolHandler(
			"evc-team-relay/settings/shared-folders",
			(e) => {
				const parameters = e as unknown as ProtocolLinkParams;
				const query = new URLSearchParams({ ...parameters }).toString();
				const path = `/${parameters.action.split("/").slice(-1).join("")}?${query}`;
				void this.showSettingsTab(path);
			},
		);

		this.registerObsidianProtocolHandler("evc-team-relay/billing-ok", (e) => {
			new Notice("Payment successful! Refreshing billing data...");
			// Clear billing cache by refreshing settings
			void this.showSettingsTab();
		});

		this.transferQueue.begin();
		this.crdtBackgroundSyncPoller.start();
	}

	removeCommand(command: string): void {
		// Obsidian only exposes a native removeCommand from 1.7.2 onward.
		if (requireApiVersion("1.7.2")) {
			// @ts-ignore
			super.removeCommand(command);
		} else {
			const appAny = this.app as unknown as ObsidianApp;
			const appCommands = appAny.commands;
			const qualifiedCommand = `team-relay:${command}`;
			if (
				Object.prototype.hasOwnProperty.call(appCommands.commands, qualifiedCommand) ||
				appAny.hotkeyManager.removeDefaultHotkeys(qualifiedCommand)
			) {
				delete appCommands.commands[qualifiedCommand];
				delete appCommands.editorCommands[qualifiedCommand];
			}
		}
	}

	onunload() {
		this.updater?.dispose();
		if (this.updaterBlockedStartup) return;
		// Save settings before cleanup to persist any changes
		// Must await to ensure settings are persisted before destroying namespaced settings
		void this.pluginSettings?.persist();

		// Unwind every monkeypatch installed via getPatchRegistry() and drop its singleton.
		PatchRegistry.shutdown();

		this.clock?.teardown();

		this.explorerDecorations?.dismantle();

		// Note: detachLeavesOfType should not be called in onunload (Obsidian handles leaf cleanup)

		this._viewRegistry?.shutdown();
		this._viewRegistry = null as unknown as ViewBindingRegistry;

		this.relayRegistry?.teardown();
		this.relayRegistry = null as unknown as RelayRegistry;

		this.credentialCache?.stopSweeping();
		this.credentialCache?.resetState();
		this.credentialCache?.teardown();
		this.credentialCache = null as unknown as RelayCredentialCache;

		this.serviceHealth?.stopPolling();
		this.serviceHealth?.dismantle();
		this.serviceHealth = null as unknown as ServiceHealthMonitor;

		this.activeModals.forEach((modal) => {
			modal.close();
		});
		this.activeModals.length = 0;

		this.shareRegistry?.destroy();
		this.shareRegistry = null as unknown as ShareRegistry;

		this.settingsPage?.teardown();
		this.settingsPage = null as unknown as RelaySettingsPage;

		this.authSession?.destroy();
		this.authSession = null as unknown as AuthSession;

		this.transferQueue?.shutdown();
		this.transferQueue = null as unknown as TransferQueue;

		this.crdtBackgroundSyncPoller?.destroy();
		this.crdtBackgroundSyncPoller =
			null as unknown as import("./CrdtBackgroundSyncPoller").CrdtBackgroundSyncPoller;

		// Cleanup InboundSyncPoller (v1.9)
		if (this.inboundSyncPoller) {
			this.inboundSyncPoller.destroy();
			this.inboundSyncPoller = undefined;
		}

		// Cleanup InboundFileDownloader (v1.9)
		if (this.inboundFileDownloader) {
			this.inboundFileDownloader.destroy();
			this.inboundFileDownloader = undefined;
		}

		// Cleanup WebSyncManager (v1.8.1)
		if (this.webSyncManager) {
			this.webSyncManager.destroy();
			this.webSyncManager = undefined;
		}

		this.fileHashRegistry.shutdown();
		this.fileHashRegistry = null as unknown as FileHashCache;

		this.app?.workspace.updateOptions();
		(this.app as unknown as ObsidianApp).reloadRelay = undefined;
		this.app = null as unknown as App;
		this.vaultFileManager = null as unknown as FileManager;
		this.manifest = null as unknown as PluginManifest;
		this.pluginVault = null as unknown as Vault;

		this.loggingSettings.destroy();
		this.loggingSettings = null as unknown as SettingsScope<LoggingSettings, Record<string, unknown>>;
		this.sharedFolderSettings.destroy();
		this.sharedFolderSettings = null as unknown as SettingsScope<VaultShareSettings[], Record<string, unknown>>;

		// featureToggleSettings must outlive the feature-toggle manager that reads from it.
		FeatureToggleState.resetInstance();

		this.featureToggleSettings.destroy();
		this.featureToggleSettings = null as unknown as SettingsScope<FeatureToggles, Record<string, unknown>>;
		this.authSettingsScope.destroy();
		this.authSettingsScope = null as unknown as SettingsScope<AuthSettings, Record<string, unknown>>;
		this.tenantEndpointSettings.destroy();
		this.tenantEndpointSettings = null as unknown as SettingsScope<TenantSettings, Record<string, unknown>>;
		this.relayOnPremSettings.destroy();
		this.relayOnPremSettings = null as unknown as SettingsScope<RelayOnPremSettings, Record<string, unknown>>;

		this.webviewInterceptPatterns.length = 0;
		NotificationDispatcher.shutdown();

		this.uiNotifier = null as unknown as NoticeSink;

		auditNotifierTeardown();
		void flushPendingLogs();
	}

	hydrateSettings() {
		void this.pluginSettings.hydrate();
	}

	async persistSettings() {
		await this.pluginSettings.persist();
	}
}
