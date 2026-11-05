export const RELEASE_REPOSITORY = "kjgoodrick/evc-team-relay-obsidian";
export const RELEASES_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100`;
export const PLUGIN_ID = "team-relay-sync";
export const RUNTIME_FILES = ["main.js", "styles.css", "manifest.json"] as const;
export type RuntimeFile = typeof RUNTIME_FILES[number];
export type Bundle = Record<RuntimeFile, ArrayBuffer>;
export type Hashes = Record<RuntimeFile, string>;
export type UpdateRelease = { version: string; url: string; prerelease: boolean; sizes: Record<string, number> };
export type HttpResponse = { status: number; arrayBuffer: ArrayBuffer };
export type UpdateRequest = (url: string) => Promise<HttpResponse>;

const LIMITS: Record<string, number> = { "main.js": 20_000_000, "styles.css": 2_000_000, "manifest.json": 16_384, SHA256SUMS: 16_384 };
export function versionParts(value: unknown): number[] | undefined {
	if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return;
	const parts = value.split(".").map(Number);
	return parts.every(Number.isSafeInteger) ? parts : undefined;
}
export function compareVersions(a: string, b: string): number {
	const x = versionParts(a), y = versionParts(b);
	if (!x || !y) throw new Error("Cannot compare an invalid release version.");
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
	return 0;
}
export function assetUrl(version: string, file: string): string {
	if (!versionParts(version) || !Object.prototype.hasOwnProperty.call(LIMITS, file)) throw new Error("Invalid release asset.");
	return `https://github.com/${RELEASE_REPOSITORY}/releases/download/${version}/${file}`;
}
export function selectRelease(value: unknown, current: string): UpdateRelease | undefined {
	if (!Array.isArray(value)) throw new Error("GitHub returned an invalid release list.");
	return value.flatMap((r): UpdateRelease[] => {
		if (!r || r.draft !== false || !versionParts(r.tag_name) || !r.published_at || !Array.isArray(r.assets) || compareVersions(r.tag_name, current) <= 0) return [];
		const sizes: Record<string, number> = {};
		for (const file of Object.keys(LIMITS)) {
			const matches = r.assets.filter((a: Record<string, unknown> | null) => a?.name === file);
			if (matches.length !== 1) return [];
			const a = matches[0];
			if (a.state !== "uploaded" || a.browser_download_url !== assetUrl(r.tag_name, file) || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > LIMITS[file]) return [];
			sizes[file] = a.size;
		}
		return [{ version: r.tag_name, url: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${r.tag_name}`, prerelease: r.prerelease === true, sizes }];
	}).sort((a, b) => compareVersions(b.version, a.version))[0];
}
export function decode(bytes: ArrayBuffer): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export async function sha256(bytes: ArrayBuffer): Promise<string> {
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function parseChecksums(text: string): Hashes {
	const hashes = {} as Hashes;
	for (const line of text.trim().split(/\r?\n/)) {
		const match = /^([a-fA-F0-9]{64}) [ *]([^\s/\\]+)$/.exec(line);
		if (!match) throw new Error("The release checksum file is invalid.");
		if (!RUNTIME_FILES.includes(match[2] as RuntimeFile)) continue;
		const name = match[2] as RuntimeFile;
		if (hashes[name]) throw new Error("The release contains duplicate checksums.");
		hashes[name] = match[1].toLowerCase();
	}
	if (!RUNTIME_FILES.every(f => hashes[f])) throw new Error("The release is missing checksums.");
	return hashes;
}
export function validateManifest(bytes: ArrayBuffer, version: string, supportsApi: (version: string) => boolean, mobile: boolean): void {
	const manifest = JSON.parse(decode(bytes));
	if (manifest.id !== PLUGIN_ID || manifest.version !== version || !versionParts(manifest.minAppVersion) || typeof manifest.name !== "string") throw new Error("The downloaded manifest does not match this plugin release.");
	if (!supportsApi(manifest.minAppVersion)) throw new Error(`This release requires Obsidian ${manifest.minAppVersion} or newer.`);
	if (mobile && manifest.isDesktopOnly !== false) throw new Error("This release does not declare mobile support.");
}
export async function downloadAsset(request: UpdateRequest, release: UpdateRelease, file: string): Promise<ArrayBuffer> {
	const response = await request(assetUrl(release.version, file));
	if (response.status !== 200) throw new Error(`GitHub download failed (HTTP ${response.status}). Try again later.`);
	if (response.arrayBuffer.byteLength !== release.sizes[file] || response.arrayBuffer.byteLength > LIMITS[file]) throw new Error(`The downloaded ${file} has an unexpected size.`);
	return response.arrayBuffer;
}
export async function downloadBundle(request: UpdateRequest, release: UpdateRelease, supportsApi: (version: string) => boolean, mobile: boolean): Promise<Bundle> {
	const hashes = parseChecksums(decode(await downloadAsset(request, release, "SHA256SUMS")));
	const bundle = {} as Bundle;
	for (const file of RUNTIME_FILES) {
		bundle[file] = await downloadAsset(request, release, file);
		if (await sha256(bundle[file]) !== hashes[file]) throw new Error(`Checksum verification failed for ${file}. Nothing was installed.`);
	}
	validateManifest(bundle["manifest.json"], release.version, supportsApi, mobile);
	return bundle;
}
