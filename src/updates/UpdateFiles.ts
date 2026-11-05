import type { DataAdapter } from "obsidian";
import { RUNTIME_FILES, sha256, versionParts, type Bundle, type Hashes } from "./releases";

export type UpdateStorage = Pick<DataAdapter, "exists" | "mkdir" | "readBinary" | "writeBinary" | "rename">;
type Journal = { format: 1; state: "prepared" | "installed" | "restored" | "superseded"; from: string; to: string; before: Hashes; after: Hashes };
const encode = (value: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

/** All writes are confined to the plugin's runtime files and its private update directory.
 * Rename must replace an existing file. We deliberately do not unlink the live main.js
 * first or fall back to truncating it when a host cannot do that. */
export class UpdateFiles {
	readonly directory: string;
	constructor(private readonly storage: UpdateStorage, readonly pluginDir: string) {
		if (!pluginDir || pluginDir.startsWith("/") || pluginDir.split("/").some(p => !p || p === "." || p === "..") || pluginDir.includes("\\")) throw new Error("Invalid plugin installation directory.");
		this.directory = `${pluginDir}/.relay-update`;
	}
	private path(file: string): string { return `${this.directory}/${file}`; }
	private async ensureDirectory(): Promise<void> {
		if (!await this.storage.exists(this.directory)) await this.storage.mkdir(this.directory);
	}
	async writeState(value: unknown): Promise<void> { await this.ensureDirectory(); await this.atomicWrite(this.path("checks.json"), encode(value)); }
	async readState(): Promise<unknown> {
		if (!await this.storage.exists(this.path("checks.json"))) return undefined;
		return JSON.parse(new TextDecoder().decode(await this.storage.readBinary(this.path("checks.json"))));
	}
	private async atomicWrite(path: string, bytes: ArrayBuffer): Promise<void> {
		await this.storage.writeBinary(`${path}.tmp`, bytes);
		if (await sha256(await this.storage.readBinary(`${path}.tmp`)) !== await sha256(bytes)) throw new Error("Update staging verification failed.");
		await this.storage.rename(`${path}.tmp`, path);
	}
	private async journal(value: Journal): Promise<void> { await this.atomicWrite(this.path("journal.json"), encode(value)); }
	private async matches(hashes: Hashes): Promise<boolean> {
		for (const file of RUNTIME_FILES) {
			if (!await this.storage.exists(`${this.pluginDir}/${file}`) || await sha256(await this.storage.readBinary(`${this.pluginDir}/${file}`)) !== hashes[file]) return false;
		}
		return true;
	}
	private async restore(j: Journal): Promise<void> {
		// Verify every backup before replacing any file; backups are never consumed.
		const backup = {} as Bundle;
		for (const f of RUNTIME_FILES) {
			backup[f] = await this.storage.readBinary(this.path(`${f}.previous`));
			if (await sha256(backup[f]) !== j.before[f]) throw new Error("The update backup is damaged. Keep .relay-update and reinstall the previous release manually.");
		}
		for (const f of RUNTIME_FILES) await this.atomicWrite(`${this.pluginDir}/${f}`, backup[f]);
		if (!await this.matches(j.before)) throw new Error("Could not verify the restored plugin files.");
		await this.journal({ ...j, state: "restored" });
	}
	async recover(): Promise<{ restored?: boolean; installedVersion?: string }> {
		if (!await this.storage.exists(this.path("journal.json"))) return {};
		const bytes = await this.storage.readBinary(this.path("journal.json"));
		if (bytes.byteLength > 16384) throw new Error("Invalid update journal. Reinstall the plugin runtime files manually.");
		const j = JSON.parse(new TextDecoder().decode(bytes)) as Journal;
		if (j.format !== 1 || !["prepared", "installed", "restored", "superseded"].includes(j.state) || !versionParts(j.from) || !versionParts(j.to) || !RUNTIME_FILES.every(f => /^[a-f0-9]{64}$/.test(j.before?.[f]) && /^[a-f0-9]{64}$/.test(j.after?.[f]))) throw new Error("Invalid update journal. Keep .relay-update for recovery.");
		if (j.state === "superseded") return {};
		if (j.state === "restored" && await this.matches(j.before)) return {};
		if (j.state === "installed" && await this.matches(j.after)) return { installedVersion: j.to };
		// A completed transaction must not undo a subsequent manual installation.
		// Pending transactions always recover, even if the manifest was already replaced.
		if (j.state !== "prepared") {
			let superseded = false;
			try {
				const manifest = JSON.parse(new TextDecoder().decode(await this.storage.readBinary(`${this.pluginDir}/manifest.json`)));
				const completedVersion = j.state === "installed" ? j.to : j.from;
				superseded = manifest.id === "team-relay-sync" && !!versionParts(manifest.version) && manifest.version !== completedVersion;
			} catch { /* An unreadable manifest still requires verified recovery. */ }
			if (superseded) { await this.journal({ ...j, state: "superseded" }); return {}; }
		}
		await this.restore(j);
		return { restored: true };
	}
	async install(bundle: Bundle, from: string, to: string): Promise<void> {
		await this.ensureDirectory();
		// Exercise replacement on disposable files before relying on host rename semantics.
		await this.atomicWrite(this.path("rename-probe"), encode("before"));
		await this.atomicWrite(this.path("rename-probe"), encode("after"));
		const recovery = await this.recover();
		if (recovery.restored) throw new Error("An interrupted update was restored. Restart Obsidian before trying again.");
		const existing = JSON.parse(new TextDecoder().decode(await this.storage.readBinary(`${this.pluginDir}/manifest.json`)));
		if (existing.id !== "team-relay-sync" || existing.version !== from) throw new Error("Plugin files changed since startup. Restart Obsidian before updating.");
		const before = {} as Hashes, after = {} as Hashes;
		for (const f of RUNTIME_FILES) {
			const previous = await this.storage.readBinary(`${this.pluginDir}/${f}`);
			before[f] = await sha256(previous); after[f] = await sha256(bundle[f]);
			await this.atomicWrite(this.path(`${f}.previous`), previous);
			await this.atomicWrite(this.path(`${f}.next`), bundle[f]);
		}
		const j: Journal = { format: 1, state: "prepared", from, to, before, after };
		await this.journal(j); // durable recovery information before the first live replacement
		try {
			for (const f of RUNTIME_FILES) await this.storage.rename(this.path(`${f}.next`), `${this.pluginDir}/${f}`);
			if (!await this.matches(after)) throw new Error("Installed files failed verification.");
			await this.journal({ ...j, state: "installed" });
		} catch (error) {
			try { await this.restore(j); }
			catch { throw new Error("Update interrupted and automatic restoration failed. Keep .relay-update and reinstall the previous release before restarting Obsidian."); }
			throw new Error("Update failed. The previous plugin files were restored; your running session was kept.");
		}
	}
}
