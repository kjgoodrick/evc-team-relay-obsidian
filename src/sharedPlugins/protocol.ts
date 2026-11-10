import { sha256 } from '../updates/releases';
export const FILES = ['main.js', 'manifest.json', 'styles.css'] as const;
export type RuntimeFile = typeof FILES[number];
export type Dependency = {
    id: string;
    name: string;
    repository: string;
    tag: string;
    version: string;
    min_app_version: string;
    desktop_only: boolean;
    files: Record<RuntimeFile, {
        sha256: string;
        size: number;
    }>;
    settings: Record<string, unknown>;
};
export type Setup = {
    revision: number;
    plugins: Dependency[];
    can_manage: boolean;
};
export type FetchAsset = (url: string) => Promise<{
    status: number;
    arrayBuffer: ArrayBuffer;
}>;
const idPattern = /^[a-z0-9][a-z0-9-]{0,99}$/;
export function validId(id: unknown): id is string { return typeof id === 'string' && idPattern.test(id) && id !== 'team-relay-sync'; }
export function portableSettings(id: string, repository: string, input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw Error('Invalid shared settings');
    const settings = input as Record<string, unknown>;
    if (Object.keys(settings).length && (id !== 'timeline-gantt-view' || repository !== 'kjgoodrick/obsidian-time-and-line-planning'))
        throw Error('This plugin has no portable-settings adapter. Its settings remain local.');
    for (const [key, v] of Object.entries(settings)) {
        const ok = key === 'weekStart' ? (v === 0 || v === 1) : key === 'showBarProperties' ? typeof v === 'boolean' : key === 'barPropertyMinWidth' ? Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 1000 : ['dependencyProperty', 'lockedProperty'].includes(key) && typeof v === 'string' && v.length > 0 && v.length <= 100;
        if (!ok)
            throw Error(`Unsupported shared setting: ${key}`);
    }
    return { ...settings };
}
export function parseDependency(value: unknown): Dependency {
    const p = value as Dependency;
    if (!p || !validId(p.id) || typeof p.name !== 'string' || !p.name || p.name.length > 150 || !/^\w[\w.-]{0,99}\/\w[\w.-]{0,99}$/.test(p.repository) || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(p.tag) || !/^[0-9][A-Za-z0-9._+-]{0,99}$/.test(p.version) || !/^\d+\.\d+\.\d+$/.test(p.min_app_version) || typeof p.desktop_only !== 'boolean')
        throw Error('Invalid plugin dependency');
    if (!p.files || Object.keys(p.files).sort().join() !== [...FILES].sort().join())
        throw Error('Invalid runtime file list');
    for (const f of FILES) {
        const a = p.files[f], limit = f === 'main.js' ? 20000000 : f === 'manifest.json' ? 16384 : 2000000;
        if (!a || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size < (f === 'styles.css' ? 0 : 1) || a.size > limit)
            throw Error('Invalid plugin asset');
    }
    return { ...p, settings: portableSettings(p.id, p.repository, p.settings) };
}
export function parseSetup(value: unknown): Setup {
    const s = value as Setup;
    if (!s || !Number.isSafeInteger(s.revision) || s.revision < 0 || typeof s.can_manage !== 'boolean' || !Array.isArray(s.plugins) || s.plugins.length > 30)
        throw Error('Invalid shared setup');
    const plugins = s.plugins.map(parseDependency);
    if (plugins.reduce((n, p) => n + FILES.reduce((m, f) => m + p.files[f].size, 0), 0) > 100000000)
        throw Error('Shared plugin setup exceeds 100 MB');
    if (new Set(plugins.map(p => p.id)).size !== plugins.length)
        throw Error('Duplicate plugin IDs');
    return { ...s, plugins };
}
export function assetUrl(p: Pick<Dependency, 'repository' | 'tag'>, file: RuntimeFile): string { return `https://github.com/${p.repository}/releases/download/${encodeURIComponent(p.tag)}/${file}`; }
export async function fetchRuntime(p: Dependency, request: FetchAsset, supports: (v: string) => boolean, mobile: boolean): Promise<Record<RuntimeFile, ArrayBuffer>> {
    p = parseDependency(p);
    if (!supports(p.min_app_version) || mobile && p.desktop_only)
        throw Error(`${p.name} requires ${p.desktop_only ? 'desktop Obsidian' : 'Obsidian'} ${p.min_app_version} or newer.`);
    const files = {} as Record<RuntimeFile, ArrayBuffer>;
    for (const f of FILES) {
        const response = p.files[f].size === 0 ? { status: 200, arrayBuffer: new ArrayBuffer(0) } : await request(assetUrl(p, f));
        if (response.status !== 200 || response.arrayBuffer.byteLength !== p.files[f].size || await sha256(response.arrayBuffer) !== p.files[f].sha256)
            throw Error(`${p.name}: ${f} does not match the owner's approved release.`);
        files[f] = response.arrayBuffer;
    }
    const m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files['manifest.json']));
    if (m.id !== p.id || m.version !== p.version || m.minAppVersion !== p.min_app_version || !!m.isDesktopOnly !== p.desktop_only)
        throw Error('Downloaded plugin manifest differs from the shared setup');
    return files;
}
export async function resolveRelease(repository: string, tag: string, request: FetchAsset): Promise<Dependency> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository) || tag && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(tag))
        throw Error('Enter owner/repository and an optional release tag.');
    const response = await request(`https://api.github.com/repos/${repository}/releases${tag ? '/tags/' + encodeURIComponent(tag) : '?per_page=30'}`);
    if (response.status !== 200 || response.arrayBuffer.byteLength > 4000000)
        throw Error('Cannot read public GitHub releases');
    const value = JSON.parse(new TextDecoder().decode(response.arrayBuffer));
    const candidates = tag ? [value] : value;
    const r = Array.isArray(candidates) && candidates.find(r => !r.draft && r.published_at && Array.isArray(r.assets) && ['main.js', 'manifest.json'].every(f => r.assets.some((a: {
        name: string;
    }) => a.name === f)));
    if (!r)
        throw Error('No published release with Obsidian runtime assets was found');
    const selectedTag = r.tag_name;
    if (typeof selectedTag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(selectedTag))
        throw Error('Unsupported release tag');
    const files = {} as Dependency['files'];
    let manifest: any;
    for (const f of FILES) {
        const matches = r.assets.filter((a: {
            name: string;
        }) => a.name === f);
        if (matches.length === 0 && f === 'styles.css') {
            files[f] = { size: 0, sha256: await sha256(new ArrayBuffer(0)) };
            continue;
        }
        const a = matches[0], limit = f === 'main.js' ? 20000000 : f === 'manifest.json' ? 16384 : 2000000;
        const url = assetUrl({ repository, tag: selectedTag }, f);
        if (matches.length !== 1 || a.state !== 'uploaded' || a.browser_download_url !== url || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > limit)
            throw Error('Release has invalid or oversized assets');
        const data = await request(url);
        if (data.status !== 200 || data.arrayBuffer.byteLength !== a.size)
            throw Error('Release download failed');
        files[f] = { size: a.size, sha256: await sha256(data.arrayBuffer) };
        if (f === 'manifest.json')
            manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.arrayBuffer));
    }
    return parseDependency({ id: manifest.id, name: manifest.name, repository, tag: selectedTag, version: manifest.version, min_app_version: manifest.minAppVersion, desktop_only: !!manifest.isDesktopOnly, files, settings: {} });
}
export function mergeSetups(setups: Setup[]): Dependency[] {
    const all = new Map<string, Dependency>();
    for (const s of setups)
        for (const p of s.plugins) {
            const previous = all.get(p.id);
            if (previous && (JSON.stringify(previous.files) !== JSON.stringify(p.files) || previous.repository !== p.repository || previous.version !== p.version || JSON.stringify(previous.settings) !== JSON.stringify(p.settings)))
                throw Error(`Connected shares require conflicting versions or settings for ${p.name}. Ask their owners to agree.`);
            all.set(p.id, p);
        }
    return [...all.values()];
}
