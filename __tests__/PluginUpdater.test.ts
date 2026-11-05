import { UpdateFiles, type UpdateStorage } from "../src/updates/UpdateFiles";
import { PluginUpdater } from "../src/updates/PluginUpdater";
import { RELEASES_URL, RUNTIME_FILES, assetUrl, compareVersions, decode, downloadBundle, parseChecksums, selectRelease, sha256, type Bundle, type HttpResponse } from "../src/updates/releases";

const bytes = (value: string) => new TextEncoder().encode(value).buffer as ArrayBuffer;
const dir = ".custom-config/plugins/team-relay-sync";
class MemoryStorage implements UpdateStorage {
	files = new Map<string, ArrayBuffer>();
	dirs = new Set<string>();
	writes: string[] = [];
	fault?: (operation: string, path: string) => void;
	async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
	async mkdir(p: string) { this.dirs.add(p); }
	async readBinary(p: string) { if (!this.files.has(p)) throw Error(`Missing ${p}`); return this.files.get(p)!.slice(0); }
	async writeBinary(p: string, b: ArrayBuffer) { this.fault?.("write", p); this.writes.push(p); this.files.set(p, b.slice(0)); }
	async process(p: string, fn: (text: string) => string) { this.fault?.("process", p); const text = fn(decode(await this.readBinary(p))); this.writes.push(p); this.files.set(p, bytes(text)); return text; }
}
async function fixture(version = "0.2.6") {
	const storage = new MemoryStorage();
	const bundle: Bundle = { "main.js": bytes("module.exports = 'new fixture';"), "styles.css": bytes(".new{}"), "manifest.json": bytes(JSON.stringify({ id: "team-relay-sync", name: "Team Relay Sync", version, minAppVersion: "1.8.7", isDesktopOnly: false })) };
	const old: Bundle = { "main.js": bytes("old code"), "styles.css": bytes(".old{}"), "manifest.json": bytes('{"id":"team-relay-sync","version":"0.2.5"}') };
	for (const f of RUNTIME_FILES) storage.files.set(`${dir}/${f}`, old[f]);
	storage.files.set(`${dir}/data.json`, bytes('{"savedLogin":"keep","sharedFolders":["keep"]}'));
	storage.files.set("Notes/unsaved-copy.md", bytes("keep these edits"));
	const sums = bytes((await Promise.all(RUNTIME_FILES.map(async f => `${await sha256(bundle[f])}  ${f}`))).join("\n") + "\n");
	const downloads: Record<string, ArrayBuffer> = { ...bundle, SHA256SUMS: sums };
	const release = { tag_name: version, draft: false, prerelease: true, published_at: "2026-11-04T00:00:00Z", assets: Object.entries(downloads).map(([name, b]) => ({ name, state: "uploaded", size: b.byteLength, browser_download_url: assetUrl(version, name) })) };
	const calls: string[] = [];
	const request = jest.fn(async (url: string): Promise<HttpResponse> => {
		calls.push(url);
		if (url === RELEASES_URL) return { status: 200, arrayBuffer: bytes(JSON.stringify([release])) };
		const name = Object.keys(downloads).find(f => assetUrl(version, f) === url);
		if (!name) throw Error("unexpected URL");
		return { status: 200, arrayBuffer: downloads[name] };
	});
	const files = new UpdateFiles(storage, dir);
	return { storage, bundle, old, downloads, release, request, calls, files };
}
function expectOriginal(f: Awaited<ReturnType<typeof fixture>>) {
	for (const name of RUNTIME_FILES) expect(f.storage.files.get(`${dir}/${name}`)).toEqual(f.old[name]);
	expect(decode(f.storage.files.get(`${dir}/data.json`)!)).toContain('"savedLogin":"keep"');
	expect(decode(f.storage.files.get("Notes/unsaved-copy.md")!)).toBe("keep these edits");
}

test("selects the highest complete published preview, ignoring drafts, upstream/missing/foreign assets and downgrades", async () => {
	const { release } = await fixture();
	const incomplete = { ...release, tag_name: "9.0.0", assets: [] };
	const foreign = { ...release, assets: release.assets.map(a => ({ ...a, browser_download_url: a.browser_download_url.replace('kjgoodrick/', 'entire-vc/') })) };
	expect(selectRelease([incomplete, { ...release, draft: true }, foreign, release], "0.2.5")?.version).toBe("0.2.6");
	expect(selectRelease([release], "0.2.6")).toBeUndefined();
	expect(selectRelease([release], "0.3.0")).toBeUndefined();
	expect(compareVersions("0.2.10", "0.2.9")).toBe(1);
	expect(() => compareVersions("v0.2.6", "0.2.5")).toThrow();
});
test.each(["missing", "duplicate", "path", "bad hash"])("rejects %s checksums", async variant => {
	const { downloads } = await fixture(); let sums = decode(downloads.SHA256SUMS);
	if (variant === "missing") sums = sums.split("\n").slice(1).join("\n");
	if (variant === "duplicate") sums += sums;
	if (variant === "path") sums = sums.replace("main.js", "../main.js");
	if (variant === "bad hash") sums = sums.replace(/^[a-f0-9]/, "z");
	expect(() => parseChecksums(sums)).toThrow();
});
test.each(["hash", "identity", "version", "minAppVersion", "desktopOnly", "length"])("rejects %s failure before any runtime write", async variant => {
	const f = await fixture();
	if (["identity", "version", "minAppVersion", "desktopOnly"].includes(variant)) {
		const manifest = JSON.parse(decode(f.bundle["manifest.json"]));
		if (variant === "identity") manifest.id = "another-plugin";
		if (variant === "version") manifest.version = "0.2.7";
		if (variant === "minAppVersion") manifest.minAppVersion = "99.0.0";
		if (variant === "desktopOnly") manifest.isDesktopOnly = true;
		f.downloads["manifest.json"] = bytes(JSON.stringify(manifest));
		f.downloads.SHA256SUMS = bytes((await Promise.all(RUNTIME_FILES.map(async name => `${await sha256(f.downloads[name])}  ${name}`))).join("\n"));
		f.release.assets.forEach(a => a.size = f.downloads[a.name].byteLength);
	} else f.downloads["main.js"] = bytes(variant === "length" ? "short" : "x".repeat(f.downloads["main.js"].byteLength));
	const u = new PluginUpdater(f.files, "0.2.5", f.request, v => v !== "99.0.0", true);
	await u.initialize(); await u.check(); await u.install();
	expect(u.snapshot().error).toBeTruthy(); expectOriginal(f);
	expect(f.storage.writes.some(p => RUNTIME_FILES.some(name => p === `${dir}/${name}`))).toBe(false);
});
test("verified installation preserves settings/notes, does not execute code, and is recognized after restart", async () => {
	const f = await fixture(); const notify = jest.fn();
	const u = new PluginUpdater(f.files, "0.2.5", f.request, () => true, true, notify);
	await u.initialize(); await u.check(); await Promise.all([u.install(), u.install(), u.check()]);
	for (const name of RUNTIME_FILES) expect(f.storage.files.get(`${dir}/${name}`)).toEqual(f.bundle[name]);
	expect(u.snapshot().installedVersion).toBe("0.2.6");
	expect(f.calls.filter(url => url.endsWith("main.js"))).toHaveLength(1);
	expect(f.storage.writes.every(p => p.startsWith(`${dir}/`) && !p.endsWith("/data.json"))).toBe(true);
	expect(decode(f.storage.files.get("Notes/unsaved-copy.md")!)).toBe("keep these edits");
	const restarted = new PluginUpdater(f.files, "0.2.6", f.request, () => true, true);
	expect(await restarted.initialize()).toBe(true);
	expect(restarted.snapshot().installedVersion).toBeUndefined();
});
test.each(RUNTIME_FILES)("a failed replacement of %s rolls all runtime files back", async name => {
	const f = await fixture(); let failed = false;
	f.storage.fault = (op, p) => { if (!failed && op === "process" && p === `${dir}/${name}`) { failed = true; throw Error("disk failure"); } };
	await expect(f.files.install(f.bundle, "0.2.5", "0.2.6")).rejects.toThrow("previous plugin files were restored");
	expectOriginal(f); expect(await f.files.recover()).toEqual({});
});
test("a partial host write is detected and the previous runtime is restored", async () => {
	const f = await fixture(); const original = f.storage.process.bind(f.storage); let partial = true;
	f.storage.process = async (p, fn) => {
		if (partial && p === `${dir}/main.js`) { partial = false; f.storage.files.set(p, bytes("partial")); return "partial"; }
		return original(p, fn);
	};
	await expect(f.files.install(f.bundle, "0.2.5", "0.2.6")).rejects.toThrow("previous plugin files were restored");
	expectOriginal(f);
});
test("startup recovers an interrupted replacement with verified backups, and requires restart", async () => {
	const f = await fixture(); let blocked = false;
	f.storage.fault = (op, p) => { if (op === "process" && (p === `${dir}/styles.css` || (blocked && p.startsWith(dir) && !p.includes(".relay-update")))) { blocked = true; throw Error("device disappeared"); } };
	await expect(f.files.install(f.bundle, "0.2.5", "0.2.6")).rejects.toThrow("automatic restoration failed");
	expect(f.storage.files.get(`${dir}/main.js`)).toEqual(f.bundle["main.js"]);
	f.storage.fault = undefined;
	const u = new PluginUpdater(f.files, "0.2.5", f.request, () => true, true);
	expect(await u.initialize()).toBe(false); expectOriginal(f);
	expect(u.snapshot().error).toContain("Restart Obsidian");
	expect(await new PluginUpdater(f.files, "0.2.5", f.request, () => true, true).initialize()).toBe(true);
});
test("corrupt backups are refused before partial recovery", async () => {
	const f = await fixture(); await f.files.install(f.bundle, "0.2.5", "0.2.6");
	f.storage.files.set(`${dir}/styles.css`, bytes("corrupted"));
	f.storage.files.set(`${dir}/.relay-update/manifest.json.previous`, bytes("bad backup"));
	const main = f.storage.files.get(`${dir}/main.js`);
	await expect(f.files.recover()).rejects.toThrow("backup is damaged");
	expect(f.storage.files.get(`${dir}/main.js`)).toEqual(main);
});
test("a completed update does not roll back a later manual version", async () => {
	const f = await fixture(); await f.files.install(f.bundle, "0.2.5", "0.2.6");
	for (const name of RUNTIME_FILES) f.storage.files.set(`${dir}/${name}`, name === "manifest.json" ? bytes('{"id":"team-relay-sync","version":"0.2.7"}') : bytes("manual 0.2.7"));
	expect(await f.files.recover()).toEqual({});
	expect(decode(f.storage.files.get(`${dir}/main.js`)!)).toBe("manual 0.2.7");
	expect(await f.files.recover()).toEqual({});
});
test("failed staging and stale running versions leave all existing files alone", async () => {
	const f = await fixture();
	await expect(f.files.install(f.bundle, "0.2.4", "0.2.6")).rejects.toThrow("changed since startup");
	f.storage.fault = (op, p) => { if (op === "write" && p.endsWith("styles.css.next")) throw Error("out of space"); };
	await expect(f.files.install(f.bundle, "0.2.5", "0.2.6")).rejects.toThrow("out of space");
	expectOriginal(f);
});
test("an available update remains offered after reopening without another network check", async () => {
	const f = await fixture(); const u = new PluginUpdater(f.files, "0.2.5", f.request, () => true, true);
	await u.initialize(); await u.check();
	const next = new PluginUpdater(f.files, "0.2.5", f.request, () => true, true);
	await next.initialize(); await next.check(false);
	expect(next.snapshot().release?.version).toBe("0.2.6");
	expect(f.request).toHaveBeenCalledTimes(1);
});
test("checks once daily, retries failures after an hour, persists opt-out and allows manual checking", async () => {
	const f = await fixture(); let now = 2_000_000_000_000;
	const u = new PluginUpdater(f.files, "0.2.5", f.request, () => true, true, jest.fn(), () => now);
	await u.initialize(); await u.check(false); await u.check(false); expect(f.request).toHaveBeenCalledTimes(1);
	now += 24 * 60 * 60_000; await u.check(false); expect(f.request).toHaveBeenCalledTimes(2);
	await u.setAutomatic(false); now += 48 * 60 * 60_000; await u.check(false); expect(f.request).toHaveBeenCalledTimes(2);
	const next = new PluginUpdater(f.files, "0.2.5", f.request, () => true, true, jest.fn(), () => now);
	await next.initialize(); expect(next.snapshot().automatic).toBe(false); await next.check(); expect(f.request).toHaveBeenCalledTimes(3);
	await next.setAutomatic(true); f.request.mockRejectedValue(Error("offline")); now += 48 * 60 * 60_000;
	await next.check(false); await next.check(false); expect(f.request).toHaveBeenCalledTimes(4);
	now += 60 * 60_000; await next.check(false); expect(f.request).toHaveBeenCalledTimes(5);
	expectOriginal(f);
});
test("rate limiting is explained and a later manual check can recover", async () => {
	const f = await fixture(); f.request.mockResolvedValueOnce({ status: 403, arrayBuffer: bytes("limited") });
	const u = new PluginUpdater(f.files, "0.2.5", f.request, () => true, true);
	await u.initialize(); await u.check(); expect(u.snapshot().error).toContain("limiting");
	await u.check(); expect(u.snapshot().error).toBeUndefined(); expect(u.snapshot().release?.version).toBe("0.2.6");
});
test("unloading during a download prevents any late runtime installation", async () => {
	const f = await fixture(); let finish!: (v: HttpResponse) => void;
	const u = new PluginUpdater(f.files, "0.2.5", f.request, () => true, true);
	await u.initialize(); await u.check();
	f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const pending = u.install(); u.dispose(); finish({ status: 200, arrayBuffer: f.downloads.SHA256SUMS }); await pending;
	expectOriginal(f);
});
test("download timeout does not write late bytes", async () => {
	jest.useFakeTimers();
	try {
		const f = await fixture(); const u = new PluginUpdater(f.files, "0.2.5", f.request, () => true, true);
		await u.initialize(); await u.check(); let finish!: (v: HttpResponse) => void;
		f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const pending = u.install(); await jest.advanceTimersByTimeAsync(30_001); await pending;
		expect(u.snapshot().error).toContain("in time"); finish({ status: 200, arrayBuffer: f.downloads.SHA256SUMS });
		await Promise.resolve(); expectOriginal(f); u.dispose();
	} finally { jest.useRealTimers(); }
});
