import type { DataAdapter } from 'obsidian';
import { sha256 } from '../updates/releases';
import { FILES, validId, portableSettings, type Dependency, type RuntimeFile } from './protocol';
export interface PluginHost {
    enabledPlugins: Set<string>;
    manifests: Record<string, {
        version: string;
        dir?: string;
    }>;
    disablePluginAndSave(id: string): Promise<unknown>;
    enablePluginAndSave(id: string): Promise<unknown>;
    loadManifests(): Promise<unknown>;
}
type Journal = {
    id: string;
    state: 'prepared' | 'installed' | 'restored';
    enabled: boolean;
    before: Record<string, string | null>;
};
const names = [...FILES, 'data.json'];
export class PluginInstaller {
    constructor(private io: DataAdapter, private configDir: string, private stateDir: string, private host: PluginHost) { }
    private pluginDir(id: string) { if (!validId(id))
        throw Error('Invalid plugin ID'); return `${this.configDir}/plugins/${id}`; }
    private async mkdir(path: string) { if (!await this.io.exists(path))
        await this.io.mkdir(path); }
    private async write(path: string, bytes: ArrayBuffer) { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (await this.io.exists(path))
        await this.io.process(path, () => text);
    else
        await this.io.writeBinary(path, bytes); if (await sha256(await this.io.readBinary(path)) !== await sha256(bytes))
        throw Error('Plugin file verification failed'); }
    private async json(path: string, value: unknown) { await this.write(path, new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer); }
    private async restore(j: Journal) {
        const backup: Record<string, ArrayBuffer> = {};
        for (const name of names) {
            const hash = j.before[name];
            if (hash !== null) {
                if (!/^[a-f0-9]{64}$/.test(hash))
                    throw Error('Invalid plugin recovery record');
                let bytes = await this.io.exists(`${this.stateDir}/${j.id}/${name}.previous`) ? await this.io.readBinary(`${this.stateDir}/${j.id}/${name}.previous`) : new ArrayBuffer(0);
                if (await sha256(bytes) !== hash && name === 'data.json' && await this.io.exists(`${this.stateDir}/${j.id}/data.json.saved`))
                    bytes = await this.io.readBinary(`${this.stateDir}/${j.id}/data.json.saved`);
                if (await sha256(bytes) !== hash)
                    throw Error('Plugin recovery copy is damaged');
                backup[name] = bytes;
            }
        }
        await this.host.disablePluginAndSave(j.id);
        for (const name of names) {
            const path = `${this.pluginDir(j.id)}/${name}`;
            if (j.before[name] === null) {
                if (await this.io.exists(path))
                    await this.io.remove(path);
            }
            else
                await this.write(path, backup[name]);
        }
        await this.host.loadManifests();
        if (j.enabled)
            await this.host.enablePluginAndSave(j.id);
        await this.json(`${this.stateDir}/journal.json`, { ...j, state: 'restored' });
    }
    async recover() {
        const path = `${this.stateDir}/journal.json`;
        if (!await this.io.exists(path))
            return;
        const j = JSON.parse(await this.io.read(path)) as Journal;
        if (!validId(j.id) || !['prepared', 'installed', 'restored'].includes(j.state) || typeof j.enabled !== 'boolean' || !j.before || Object.keys(j.before).sort().join() !== [...names].sort().join())
            throw Error('Invalid shared plugin recovery journal');
        if (j.state === 'prepared')
            await this.restore(j);
    }
    async matches(p: Dependency) {
        if (!this.host.enabledPlugins.has(p.id))
            return false;
        const dir = this.pluginDir(p.id);
        for (const f of FILES) {
            if (!await this.io.exists(`${dir}/${f}`) || await sha256(await this.io.readBinary(`${dir}/${f}`)) !== p.files[f].sha256)
                return false;
        }
        if (Object.keys(p.settings).length) {
            if (!await this.io.exists(`${dir}/data.json`))
                return false;
            const data = JSON.parse(await this.io.read(`${dir}/data.json`));
            for (const [k, v] of Object.entries(p.settings))
                if (JSON.stringify(data[k]) !== JSON.stringify(v))
                    return false;
        }
        return true;
    }
    async install(p: Dependency, bundle: Record<RuntimeFile, ArrayBuffer>, current: () => boolean) {
        portableSettings(p.id, p.repository, p.settings);
        const installedDir = this.host.manifests[p.id]?.dir;
        if (installedDir && installedDir !== this.pluginDir(p.id)) throw Error(`${p.name} is installed in a nonstandard folder; move it through Obsidian before using shared setup.`);
        if (!current())
            throw Error('Share connection changed');
        await this.mkdir(`${this.configDir}/plugins`);
        await this.mkdir(this.stateDir);
        await this.mkdir(`${this.stateDir}/${p.id}`);
        await this.mkdir(this.pluginDir(p.id));
        const enabled = this.host.enabledPlugins.has(p.id);
        const j: Journal = { id: p.id, state: 'prepared', enabled, before: {} };
        // Capture before disabling: if preservation fails the active plugin remains usable.
        for (const name of names) {
            const path = `${this.pluginDir(p.id)}/${name}`;
            if (await this.io.exists(path)) {
                const bytes = await this.io.readBinary(path);
                j.before[name] = await sha256(bytes);
                await this.write(`${this.stateDir}/${p.id}/${name}.previous`, bytes);
            }
            else
                j.before[name] = null;
        }
        await this.json(`${this.stateDir}/journal.json`, j);
        try {
            await this.host.disablePluginAndSave(p.id);
            // Unload may save settings. Refresh the settings backup before applying shared keys.
            const dataPath = `${this.pluginDir(p.id)}/data.json`;
            if (await this.io.exists(dataPath)) {
                const bytes = await this.io.readBinary(dataPath);
                j.before['data.json'] = await sha256(bytes);
                await this.write(`${this.stateDir}/${p.id}/data.json.saved`, bytes);
                await this.json(`${this.stateDir}/journal.json`, j);
            }
            if (!current())
                throw Error('Share connection changed');
            for (const f of FILES)
                await this.write(`${this.pluginDir(p.id)}/${f}`, bundle[f]);
            if (Object.keys(p.settings).length) {
                const local = await this.io.exists(dataPath) ? JSON.parse(await this.io.read(dataPath)) : {};
                if (!local || typeof local !== 'object' || Array.isArray(local))
                    throw Error('Existing plugin settings are not an object');
                await this.json(dataPath, { ...local, ...p.settings });
            }
            if (!current())
                throw Error('Share connection changed');
            await this.host.loadManifests();
            const activated = await this.host.enablePluginAndSave(p.id);
            if (activated === false)
                throw Error(`${p.name} could not be loaded.`);
            if (!this.host.enabledPlugins.has(p.id))
                throw Error(`${p.name} could not be enabled. Check restricted mode and compatibility.`);
            await this.json(`${this.stateDir}/journal.json`, { ...j, state: 'installed' });
        }
        catch (error) {
            try {
                await this.restore(j);
            }
            catch {
                throw Error('Plugin setup was interrupted. Keep the local recovery files and restart Relay to recover.');
            }
            throw error;
        }
    }
}
