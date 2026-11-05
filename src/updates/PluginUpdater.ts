import { UpdateFiles } from "./UpdateFiles";
import { RELEASES_URL, assetUrl, decode, downloadBundle, selectRelease, versionParts, type UpdateRelease, type UpdateRequest } from "./releases";

export type UpdateState = {
	currentVersion: string;
	automatic: boolean;
	busy: boolean;
	message: string;
	release?: UpdateRelease;
	installedVersion?: string;
	error?: string;
};
type CheckState = { automatic: boolean; lastAttempt: number; lastSuccess: number; available?: UpdateRelease };
export class PluginUpdater {
	private state: UpdateState;
	private checks: CheckState = { automatic: true, lastAttempt: 0, lastSuccess: 0 };
	private listeners = new Set<(state: UpdateState) => void>();
	private disposed = false;
	private announced?: string;
	private timer?: ReturnType<typeof setInterval>;
	private startupTimer?: ReturnType<typeof setTimeout>;
	private ready = false;
	constructor(
		readonly files: UpdateFiles,
		readonly currentVersion: string,
		private readonly request: UpdateRequest,
		private readonly supportsApi: (version: string) => boolean,
		private readonly mobile: boolean,
		private readonly notify: (message: string) => void = () => {},
		private readonly now: () => number = Date.now,
	) { this.state = { currentVersion, automatic: true, busy: false, message: "Checks this fork’s GitHub releases, including previews." }; }
	subscribe = (listener: (state: UpdateState) => void): (() => void) => {
		this.listeners.add(listener); listener(this.state);
		return () => this.listeners.delete(listener);
	};
	snapshot(): UpdateState { return this.state; }
	private set(patch: Partial<UpdateState>): void {
		this.state = { ...this.state, ...patch };
		if (!this.disposed) for (const listener of this.listeners) listener(this.state);
	}
	/** Returns false when recovery changed disk files: the host must restart before sync starts. */
	async initialize(): Promise<boolean> {
		try {
			if (!versionParts(this.currentVersion)) { this.set({ error: "Updates require a versioned preview build." }); return true; }
			const recovery = await this.files.recover();
			if (recovery.restored) {
				this.set({ error: "An interrupted update was restored. Restart Obsidian before using Relay." });
				this.notify(this.state.error!);
				return false;
			}
			if (recovery.installedVersion && recovery.installedVersion !== this.currentVersion) this.set({ installedVersion: recovery.installedVersion, message: "Update installed. Restart Obsidian to load it." });
			try {
				const saved = await this.files.readState() as Partial<CheckState> | undefined;
				if (saved) {
					this.checks = { automatic: saved.automatic !== false, lastAttempt: Number.isFinite(saved.lastAttempt) ? saved.lastAttempt! : 0, lastSuccess: Number.isFinite(saved.lastSuccess) ? saved.lastSuccess! : 0 };
					const cached = saved.available;
					if (cached && versionParts(cached.version) && cached.sizes) {
						// Revalidate cache data and derive all links from our fixed repository.
						this.checks.available = selectRelease([{ tag_name: cached.version, draft: false, published_at: "cached", prerelease: cached.prerelease, assets: ["main.js", "manifest.json", "styles.css", "SHA256SUMS"].map(name => ({ name, size: cached.sizes[name], state: "uploaded", browser_download_url: assetUrl(cached.version, name) })) }], this.currentVersion);
						if (this.checks.available && !this.state.installedVersion) this.set({ release: this.checks.available, message: `Version ${this.checks.available.version} is available (last checked previously).` });
					}
				}
			} catch { /* A damaged check timestamp must not block synchronization. */ }
			this.ready = true; this.set({ automatic: this.checks.automatic });
			return true;
		} catch (error) {
			this.set({ error: `Updater unavailable: ${this.errorMessage(error)}` });
			// An unreadable journal may describe a partially installed bundle. Stop
			// startup instead of syncing under an unverified mixture of runtime files.
			this.notify(this.state.error!);
			return false;
		}
	}
	start(): void {
		if (this.timer || this.disposed || !this.ready) return;
		this.startupTimer = setTimeout(() => { void this.check(false); }, 30_000);
		this.timer = setInterval(() => { void this.check(false); }, 60 * 60_000);
	}
	async setAutomatic(automatic: boolean): Promise<void> {
		if (this.disposed || this.state.busy) return;
		const previous = this.checks.automatic;
		this.checks.automatic = automatic;
		try { await this.files.writeState(this.checks); this.set({ automatic, error: undefined }); }
		catch { this.checks.automatic = previous; this.set({ error: "Could not save the update preference." }); }
	}
	async check(manual = true): Promise<void> {
		if (!this.ready || this.disposed || this.state.busy || this.state.installedVersion) return;
		const now = this.now();
		if (!manual && (!this.checks.automatic || (now >= this.checks.lastAttempt && now - this.checks.lastAttempt < 60 * 60_000) || (now >= this.checks.lastSuccess && now - this.checks.lastSuccess < 24 * 60 * 60_000))) return;
		this.set({ busy: true, error: undefined, message: "Checking GitHub…" });
		this.checks.lastAttempt = now;
		try {
			await this.files.writeState(this.checks);
			const response = await this.timedRequest(RELEASES_URL);
			if (response.status === 403 || response.status === 429) throw new Error("GitHub is limiting update checks. Try again later.");
			if (response.status !== 200) throw new Error(`GitHub check failed (HTTP ${response.status}). Try again later.`);
			if (response.arrayBuffer.byteLength > 4_000_000) throw new Error("GitHub returned an oversized release list.");
			const release = selectRelease(JSON.parse(decode(response.arrayBuffer)), this.currentVersion);
			if (this.disposed) return;
			this.checks.lastSuccess = now;
			this.checks.available = release;
			await this.files.writeState(this.checks);
			this.set({ release, message: release ? `Version ${release.version} is available${release.prerelease ? " (preview)" : ""}.` : "You’re up to date." });
			if (!manual && release && this.announced !== release.version) { this.announced = release.version; this.notify(`Team Relay ${release.version} is available. Open plugin settings to update.`); }
		} catch (error) { if (!this.disposed) this.set({ error: this.errorMessage(error), message: "Update check did not finish." }); }
		finally { this.set({ busy: false }); }
	}
	private async timedRequest(url: string) {
		if (this.disposed) throw new Error("The plugin was unloaded.");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				this.request(url),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("GitHub did not respond in time. Try again later.")), 30_000); }),
			]);
			if (this.disposed) throw new Error("The plugin was unloaded.");
			return result;
		} finally { clearTimeout(timer); }
	}
	async install(): Promise<void> {
		const release = this.state.release;
		if (!this.ready || this.disposed || this.state.busy || !release || this.state.installedVersion) return;
		this.set({ busy: true, error: undefined, message: `Downloading and verifying ${release.version}…` });
		try {
			const bundle = await downloadBundle(url => this.timedRequest(url), release, this.supportsApi, this.mobile);
			if (this.disposed) return;
			this.set({ message: "Installing verified files. Keep Obsidian open…" });
			await this.files.install(bundle, this.currentVersion, release.version);
			this.set({ installedVersion: release.version, message: `Installed ${release.version}. Save your edits and restart Obsidian to load the update.` });
			if (!this.disposed) this.notify(this.state.message);
		} catch (error) { if (!this.disposed) this.set({ error: this.errorMessage(error), message: "Update was not installed." }); }
		finally { this.set({ busy: false }); }
	}
	private errorMessage(error: unknown): string { return error instanceof Error ? error.message : "The update could not be completed."; }
	dispose(): void { this.disposed = true; clearInterval(this.timer); clearTimeout(this.startupTimer); this.listeners.clear(); }
}
