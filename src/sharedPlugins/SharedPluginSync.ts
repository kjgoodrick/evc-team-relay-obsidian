import { sha256 } from "../updates/releases";
import { Component, Modal, Notice, Platform, Setting, normalizePath, requestUrl, requireApiVersion } from 'obsidian';
import type TeamRelayPlugin from '../main';
import { permissionEditorBinding } from '../ui/openPermissionEditor';
import { PluginInstaller, type PluginHost } from './Installer';
import { FILES, fetchRuntime, mergeSetups, portableSettings, resolveRelease, type Dependency, type FetchAsset, type Setup } from './protocol';
export type Scope = {
    serverId: string;
    id: string;
    name: string;
};
type Approval = {
    automatic: boolean;
    repositories: Record<string, string>;
    revision: number;
};
const portableKeys = ['weekStart', 'dependencyProperty', 'lockedProperty', 'showBarProperties', 'barPropertyMinWidth'];
export class SharedPluginSync extends Component {
    private approvals: Record<string, Approval> = {};
    private busy = false;
    private polling = false;
    private stopped = false;
    private notified = new Set<string>();
    private root: string;
    private installer: PluginInstaller;
    readonly host: PluginHost;
    readonly request: FetchAsset = async (url) => { let timer: ReturnType<typeof setTimeout> | undefined; try {
        const r = await Promise.race([requestUrl({ url, throw: false }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Plugin download timed out; try again.')), 30000); })]);
        return { status: r.status, arrayBuffer: r.arrayBuffer };
    }
    finally {
        clearTimeout(timer);
    } };
    constructor(readonly plugin: TeamRelayPlugin) { super(); this.root = normalizePath(`${plugin.manifest.dir || `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/.shared-plugins`); this.host = (plugin.app as unknown as {
        plugins: PluginHost;
    }).plugins; this.installer = new PluginInstaller(plugin.app.vault.adapter, plugin.app.vault.configDir, this.root, this.host); }
    onload() { this.register(this.plugin.shareRegistry.on(() => { void this.poll(); })); this.registerInterval(window.setInterval(() => { void this.poll(); }, 5 * 60000)); this.plugin.app.workspace.onLayoutReady(() => { void this.start(); }); }
    onunload() { this.stopped = true; }
    private async start() { if (this.stopped) return; try {
        if (!this.host?.loadManifests || !this.host.enablePluginAndSave || !this.host.disablePluginAndSave)
            throw Error('Shared plugin installation is unavailable in this Obsidian version.');
        if (await this.plugin.app.vault.adapter.exists(`${this.root}/approvals.json`))
            this.approvals = JSON.parse(await this.plugin.app.vault.adapter.read(`${this.root}/approvals.json`));
        if (this.stopped) return;
        await this.installer.recover();
        await this.poll();
    }
    catch (e) {
        new Notice(`Shared plugin setup: ${this.error(e)}`);
    } }
    scopes(): Scope[] { return this.plugin.shareRegistry.toArray().filter(f => f.config.onpremServerId && !f.isTornDown).map(f => ({ serverId: f.config.onpremServerId!, id: f.entityGuid, name: f.path || 'Vault' })); }
    private key(s: Scope) { const auth = this.plugin.authSession.getMultiServerAuthManager(); const user = auth?.getUserForServer(s.serverId) || this.plugin.authSession.getAuthProvider()?.getCurrentUser(); const url = this.plugin.relayOnPremSettings.readValue().servers.find(v => v.id === s.serverId)?.controlPlaneUrl; return JSON.stringify([s.serverId, url, s.id, user?.id]); }
    private connected(s: Scope) { return this.scopes().some(v => v.id === s.id && v.serverId === s.serverId); }
    async read(s: Scope) { const b = permissionEditorBinding(this.plugin, s.serverId, s.id); if (!b)
        throw Error('Sign in to this share’s server first.'); try {
        const result = await b.legacyClient.sharedPluginSetup(s.id);
        if (!b.current())
            throw Error('Share account changed');
        return result;
    }
    finally {
        b.dispose();
    } }
    async publish(s: Scope, setup: Setup, plugins: Dependency[]) { const b = permissionEditorBinding(this.plugin, s.serverId, s.id); if (!b)
        throw Error('Sign in first'); try {
        const result = await b.legacyClient.sharedPluginSetup(s.id, { expected_revision: setup.revision, plugins });
        if (!b.current())
            throw Error('Share account changed');
        return result;
    }
    finally {
        b.dispose();
    } }
    automatic(s: Scope) { return this.approvals[this.key(s)]?.automatic === true; }
    private async save() { const io = this.plugin.app.vault.adapter; if (!await io.exists(this.root))
        await io.mkdir(this.root); const path = `${this.root}/approvals.json`, text = JSON.stringify(this.approvals); if (await io.exists(path))
        await io.process(path, () => text);
    else
        await io.write(path, text); }
    async stopAutomatic(s: Scope) { const a = this.approvals[this.key(s)]; if (a) {
        const previous = a.automatic;
        a.automatic = false;
        try {
            await this.save();
        }
        catch (e) {
            a.automatic = previous;
            throw e;
        }
    } }
    async apply(s: Scope, expected: Setup, automatic: boolean, fromPoll = false) {
        if (this.busy)
            throw Error('Another shared plugin operation is running');
        if (!this.connected(s))
            throw Error('Connect this share to a local folder first.');
        this.busy = true;
        const b = permissionEditorBinding(this.plugin, s.serverId, s.id), key = this.key(s);
        const current = () => !this.stopped && !!b?.current() && this.key(s) === key && this.connected(s);
        try {
            if (!b || !current())
                throw Error('Share account changed');
            await this.installer.recover();
            const actual = await b.legacyClient.sharedPluginSetup(s.id);
            if (actual.revision !== expected.revision || JSON.stringify(actual.plugins) !== JSON.stringify(expected.plugins))
                throw Error('Shared setup changed. Review the latest revision.');
            const otherScopes = this.scopes().filter(v => v.id !== s.id || v.serverId !== s.serverId);
            // An unavailable other share must not silently lose its required version.
            mergeSetups([actual, ...await Promise.all(otherScopes.map(v => this.read(v)))]);
            const approved = this.approvals[key];
            if (fromPoll && (!approved?.automatic || actual.plugins.some(p => approved.repositories[p.id] !== p.repository)))
                throw Error('New plugin sources need approval.');
            const downloads = [];
            for (const p of actual.plugins) {
                if (!await this.installer.matches(p))
                    downloads.push({ p, files: await fetchRuntime(p, this.request, requireApiVersion, Platform.isMobile) });
            }
            if (!current())
                throw Error('Share account changed');
            const fresh = await b.legacyClient.sharedPluginSetup(s.id);
            if (fresh.revision !== actual.revision)
                throw Error('Setup changed while downloading; review again.');
            for (const { p, files } of downloads) {
                if (!current())
                    throw Error('Share disconnected');
                await this.installer.install(p, files, current);
            }
            if (!current())
                throw Error('Share account changed');
            this.approvals[key] = { automatic, repositories: Object.fromEntries(actual.plugins.map(p => [p.id, p.repository])), revision: actual.revision };
            await this.save();
            if (!fromPoll || downloads.length)
                new Notice(`Shared plugins ready for ${s.name}${downloads.length ? `. Applied ${downloads.length} plugin update(s).` : '.'}`);
        }
        finally {
            b?.dispose();
            this.busy = false;
        }
    }
    private async poll() {
        if (this.stopped || this.busy || this.polling)
            return;
        this.polling = true;
        try {
            for (const scope of this.scopes()) {
                try {
                    const setup = await this.read(scope), key = this.key(scope), approval = this.approvals[key];
                    if (!setup.plugins.length || approval?.revision === setup.revision)
                        continue;
                    if (approval?.automatic && setup.plugins.every(p => approval.repositories[p.id] === p.repository)) {
                        await this.apply(scope, setup, true, true);
                    }
                    else if (!this.notified.has(key + setup.revision)) {
                        this.notified.add(key + setup.revision);
                        const fragment = document.createDocumentFragment();
                        fragment.append(`Shared plugins are available for ${scope.name}. `);
                        const button = document.createElement('button');
                        button.textContent = 'Review setup';
                        button.onclick = () => this.open(scope);
                        fragment.append(button);
                        new Notice(fragment, 15000);
                    }
                }
                catch (e) {
                    const key = this.key(scope) + this.error(e);
                    if (!this.notified.has(key)) {
                        this.notified.add(key);
                        new Notice(`Shared plugins: ${this.error(e)}`);
                    }
                }
            }
        }
        finally {
            this.polling = false;
        }
    }
    error(e: unknown) { return e instanceof Error ? e.message : 'Setup could not be completed'; }
    open(scope?: Scope) { new SetupModal(this, scope).open(); }
    async installedDependencies(): Promise<{
        plugins: Dependency[];
        missing: string[];
    }> {
        const response = await this.request('https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json');
        if (response.status !== 200 || response.arrayBuffer.byteLength > 4000000)
            throw Error('Cannot read the community plugin catalog');
        const catalog = JSON.parse(new TextDecoder().decode(response.arrayBuffer)) as {
            id: string;
            repo: string;
        }[];
        const plugins: Dependency[] = [], missing: string[] = [];
        for (const id of this.host.enabledPlugins) {
            if (id === 'team-relay-sync')
                continue;
            const repository = id === 'timeline-gantt-view' ? 'kjgoodrick/obsidian-time-and-line-planning' : catalog.find(p => p.id === id)?.repo;
            const version = this.host.manifests[id]?.version;
            if (!repository || !version) {
                missing.push(id);
                continue;
            }
            try {
                let p: Dependency;
                try {
                    p = await resolveRelease(repository, version, this.request);
                }
                catch {
                    p = await resolveRelease(repository, 'v' + version, this.request);
                }
                if (p.id !== id || p.version !== version)
                    throw Error('Version mismatch');
                for (const file of FILES) {
                    const path = `${this.plugin.app.vault.configDir}/plugins/${id}/${file}`;
                    const bytes = await this.plugin.app.vault.adapter.exists(path) ? await this.plugin.app.vault.adapter.readBinary(path) : new ArrayBuffer(0);
                    if (await sha256(bytes) !== p.files[file].sha256) throw Error('Installed files differ from the public release; choose the source explicitly.');
                }
                plugins.push(p);
            }
            catch {
                missing.push(id);
            }
        }
        return { plugins, missing };
    }
    async captureSettings(p: Dependency) { const path = `${this.plugin.app.vault.configDir}/plugins/${p.id}/data.json`; const stored = await this.plugin.app.vault.adapter.exists(path) ? JSON.parse(await this.plugin.app.vault.adapter.read(path)) : {}; const value = { weekStart: 1, dependencyProperty: 'blocked-by', lockedProperty: 'locked', showBarProperties: true, barPropertyMinWidth: 80, ...stored }; return portableSettings(p.id, p.repository, Object.fromEntries(portableKeys.filter(k => k in value).map(k => [k, value[k]]))); }
}
class SetupModal extends Modal {
    private setup?: Setup;
    private draft: Dependency[] = [];
    private pending = false;
    private closed = false;
    private message = '';
    private repository = 'kjgoodrick/obsidian-time-and-line-planning';
    private tag = '';
    constructor(private sync: SharedPluginSync, private selectedScope?: Scope) { super(sync.plugin.app); }
    onOpen() { void this.reload(); }
    onClose() { this.closed = true; this.contentEl.empty(); }
    private async action(fn: () => Promise<void>) { if (this.pending)
        return; this.pending = true; this.render(); try {
        await fn();
    }
    catch (e) {
        this.message = this.sync.error(e);
    }
    finally {
        this.pending = false;
        if (!this.closed)
            this.render();
    } }
    private async reload() { if (!this.selectedScope) {
        this.render();
        return;
    } await this.action(async () => { this.setup = await this.sync.read(this.selectedScope!); this.draft = this.setup.plugins.map(p => ({ ...p, settings: { ...p.settings } })); this.message = ''; }); }
    private render() {
        if (this.closed)
            return;
        const el = this.contentEl;
        el.empty();
        el.createEl('h2', { text: 'Shared plugins and configuration' });
        if (!this.selectedScope) {
            for (const s of this.sync.scopes())
                new Setting(el).setName(s.name).addButton(b => b.setButtonText('Open setup').onClick(() => { this.selectedScope = s; void this.reload(); }));
            if (!this.sync.scopes().length)
                el.createEl('p', { text: 'Connect a shared folder in Relay settings first.' });
            return;
        }
        el.createEl('p', { text: `${this.selectedScope.name}. Plugins install into this Obsidian vault and run code here. Only listed portable settings are shared; personal settings and other plugins stay local.` });
        if (this.message)
            el.createEl('p', { text: this.message });
        if (this.pending)
            el.createEl('p', { text: 'Working…' });
        if (!this.setup)
            return;
        for (const p of this.draft) {
            new Setting(el).setName(`${p.name} · ${p.version}`).setDesc(`${p.repository} · ${p.desktop_only ? 'desktop only' : 'desktop and mobile'} · shared settings: ${Object.keys(p.settings).join(', ') || 'none'}`)
                .addButton(b => b.setButtonText('Release').onClick(() => { window.open(`https://github.com/${p.repository}/releases/tag/${encodeURIComponent(p.tag)}`); }));
            if (this.setup.can_manage) {
                const row = new Setting(el);
                row.addButton(b => b.setButtonText('Remove requirement').setDisabled(this.pending).onClick(() => { this.draft = this.draft.filter(v => v.id !== p.id); this.render(); }));
                if (p.id === 'timeline-gantt-view' && p.repository === 'kjgoodrick/obsidian-time-and-line-planning')
                    row.addButton(b => b.setButtonText('Share portable settings').setDisabled(this.pending).onClick(() => this.action(async () => { p.settings = await this.sync.captureSettings(p); this.message = 'Captured week start, dependency/lock property names and badge options. Markers, colors and device preferences remain local.'; }))).addButton(b => b.setButtonText('Keep settings local').setDisabled(this.pending).onClick(() => { p.settings = {}; this.render(); }));
            }
        }
        const dirty = JSON.stringify(this.draft) !== JSON.stringify(this.setup.plugins);
        new Setting(el).setName(`Published revision ${this.setup.revision}`).setDesc('After approval, automatic sync may install newer or older versions pinned by the owner from these same repositories. New plugins or changed repositories require approval.')
            .addButton(b => b.setButtonText('Install and keep in sync').setCta().setDisabled(this.pending || dirty || !this.setup!.plugins.length).onClick(() => this.action(async () => { await this.sync.apply(this.selectedScope!, this.setup!, true); this.message = 'Shared setup applied. Automatic sync is on.'; })))
            .addButton(b => b.setButtonText('Apply once').setDisabled(this.pending || dirty || !this.setup!.plugins.length).onClick(() => this.action(async () => { await this.sync.apply(this.selectedScope!, this.setup!, false); this.message = 'Shared setup applied. Future changes require review.'; })));
        if (this.sync.automatic(this.selectedScope))
            new Setting(el).setName('Automatic shared setup is on').addButton(b => b.setButtonText('Turn off').setDisabled(this.pending).onClick(() => this.action(async () => { await this.sync.stopAutomatic(this.selectedScope!); this.message = 'Automatic sync is off.'; })));
        if (this.setup.can_manage) {
            el.createEl('h3', { text: 'Owner configuration' });
            new Setting(el).setName('GitHub repository').addText(t => t.setValue(this.repository).setPlaceholder('owner/repository').onChange(v => { this.repository = v.trim(); }));
            new Setting(el).setName('Release tag').setDesc('Leave blank for the newest published release with plugin files.').addText(t => t.setValue(this.tag).onChange(v => { this.tag = v.trim(); }));
            new Setting(el).addButton(b => b.setButtonText('Add release').setDisabled(this.pending).onClick(() => this.action(async () => { const p = await resolveRelease(this.repository, this.tag, this.sync.request); const old = this.draft.find(v => v.id === p.id); if (old?.repository === p.repository)
                p.settings = old.settings; this.draft = [...this.draft.filter(v => v.id !== p.id), p]; this.message = 'Review and publish the setup.'; })))
                .addButton(b => b.setButtonText('Add installed plugins').setDisabled(this.pending).onClick(() => this.action(async () => { const result = await this.sync.installedDependencies(); for (const p of result.plugins)
                if (!this.draft.some(v => v.id === p.id))
                    this.draft.push(p); this.message = result.missing.length ? `Could not match public releases for: ${result.missing.join(', ')}. Add their repository/tag explicitly.` : 'Installed plugin versions captured. Review before publishing.'; })));
            new Setting(el).addButton(b => b.setButtonText('Publish shared setup').setCta().setDisabled(this.pending || !dirty).onClick(() => this.action(async () => { this.setup = await this.sync.publish(this.selectedScope!, this.setup!, this.draft); this.draft = this.setup.plugins.map(p => ({ ...p, settings: { ...p.settings } })); this.message = 'Published. Members will be prompted or receive approved updates.'; })));
        }
        new Setting(el).addButton(b => b.setButtonText('Reload published setup').setDisabled(this.pending).onClick(() => this.reload()));
    }
}
