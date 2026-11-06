import type { App, TFile } from "obsidian";
import type { ShareRegistry } from "../../src/VaultShare";
import { ImageAssets } from "../../src/collaboration/ImageAssets";
import { sha256Hex } from "../../src/contentDigest";
jest.mock("../../src/contentDigest", () => ({ sha256Hex: jest.fn() }));
const hash = "a".repeat(64), id = "00000000-0000-4000-8000-000000000004";
function fixture() {
	const note = { path: "Team/Note.md" } as TFile, file = { path: "Team/chart.png", stat: { mtime: 1, size: 8 } } as TFile;
	let permission = "read", registered = true, blocked = false, record = { type: "image", id, hash, mimetype: "image/png" };
	const folder = { wantsConnection: true, isRecoveringStructure: false, toVirtualPath: (path: string) => path.slice(5),
		folderIndex: { recordFor: () => record }, _liveProvider: { managedIndex: { registered: () => registered, isBlocked: () => blocked } },
		crdtDoc: { getMap: () => ({ get: () => ({ owner: false, permissions: { "chart.png": permission, "renamed.png": permission } }) }) } };
	const readBinary = jest.fn(async () => new ArrayBuffer(8));
	const app = { metadataCache: { getFirstLinkpathDest: () => file }, vault: { getFileByPath: () => file, readBinary, getResourcePath: () => `app://local/${file.path}?${file.stat.mtime}` } };
	const shares = { shareFor: () => folder };
	const assets = new ImageAssets(app as unknown as App, shares as unknown as ShareRegistry);
	jest.mocked(sha256Hex).mockResolvedValue(hash);
	return { assets, note, file, folder, app, readBinary, shares, record, revoke: () => { permission = "none"; }, block: () => { blocked = true; }, unregister: () => { registered = false; } };
}
beforeEach(() => { jest.clearAllMocks(); jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview"); jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

test("loads and hashes authorized local bytes without upload or granting attachment write, surviving rename by identity", async () => {
	const f = fixture(), preview = await f.assets.load(f.note, "chart.png", () => true);
	expect(preview.asset).toEqual({ kind: "managed", entry_id: id, sha256: hash }); expect(f.readBinary).toHaveBeenCalledWith(f.file);
	expect(preview.valid()).toBe(true); f.file.path = "Team/renamed.png"; expect(preview.valid()).toBe(true);
	f.record.hash = "b".repeat(64); expect(preview.valid()).toBe(false); preview.release(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
});

test.each(["revoke", "block", "unregister"] as const)("rejects %s before reading image bytes", async method => {
	const f = fixture(); f[method](); await expect(f.assets.load(f.note, "chart.png", () => true)).rejects.toThrow(); expect(f.readBinary).not.toHaveBeenCalled();
});

test("rejects unsynchronized bytes and lost authority during asynchronous loading without publishing a blob URL", async () => {
	const f = fixture(); jest.mocked(sha256Hex).mockResolvedValue("b".repeat(64));
	await expect(f.assets.load(f.note, "chart.png", () => true)).rejects.toThrow("synchronizing"); expect(URL.createObjectURL).not.toHaveBeenCalled();
	jest.mocked(sha256Hex).mockImplementation(async () => { f.revoke(); return hash; });
	await expect(f.assets.load(f.note, "chart.png", () => true)).rejects.toThrow(); expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test("external URLs carry unknown version evidence and never use the vault or server byte fetcher", async () => {
	const f = fixture(), preview = await f.assets.load(f.note, "https://images.test/chart.png", () => true);
	expect(preview.asset).toEqual({ kind: "external", url: "https://images.test/chart.png", version_evidence: "unknown" });
	expect(f.readBinary).not.toHaveBeenCalled(); expect(sha256Hex).not.toHaveBeenCalled();
	for (const path of ["file:///private", "data:image/png;base64,AA==", "https://user:password@images.test/a", "//images.test/a", "https:bad"]) expect(() => f.assets.describe(f.note, path)).toThrow();
});

test("direct-file previews use the actual file identity without resolving a Markdown link", async () => {
	const f = fixture();
	jest.spyOn(f.app.metadataCache, "getFirstLinkpathDest").mockImplementation(() => { throw new Error("No note link available"); });
	expect(f.assets.describeFile(f.file)).toEqual({ kind: "managed", entry_id: id, sha256: hash });
	const preview = await f.assets.loadFile(f.file, () => true);
	expect(preview.valid()).toBe(true); expect(f.readBinary).toHaveBeenCalledWith(f.file);
	f.revoke(); expect(preview.valid()).toBe(false); preview.release();
});

test("direct-file render verification rejects resource replacement and a file moved outside its share", async () => {
	const f = fixture(), image = rendered(f.app.vault.getResourcePath());
	const evidence = await f.assets.verifyRenderedFile(f.file, image, () => true);
	expect(evidence.valid()).toBe(true);
	Object.assign(image, { currentSrc: "app://local/other.png" }); expect(evidence.valid()).toBe(false);
	Object.assign(image, { currentSrc: f.app.vault.getResourcePath() });
	jest.spyOn(f.shares, "shareFor").mockReturnValue(undefined as unknown as typeof f.folder);
	expect(evidence.valid()).toBe(false);
});

function rendered(src: string): HTMLImageElement { return { src, currentSrc: src, isConnected: true, complete: true, naturalWidth: 800 } as HTMLImageElement; }
test("verifies exact native resource versions once for repeated renders and rechecks authority without retaining image bytes", async () => {
	const f = fixture(), first = rendered(f.app.vault.getResourcePath()), second = rendered(f.app.vault.getResourcePath());
	const [a, b] = await Promise.all([f.assets.verifyRendered(f.note, "chart.png", first, () => true), f.assets.verifyRendered(f.note, "chart.png", second, () => true)]);
	expect(a.valid()).toBe(true); expect(b.valid()).toBe(true); expect(f.readBinary).toHaveBeenCalledTimes(1); expect(URL.createObjectURL).not.toHaveBeenCalled();
	await f.assets.verifyRendered(f.note, "chart.png", first, () => true); expect(f.readBinary).toHaveBeenCalledTimes(1);
	f.revoke(); expect(a.valid()).toBe(false); expect(b.valid()).toBe(false);
});

test("never overlays a stale native image resource or a different external URL", async () => {
	const f = fixture();
	await expect(f.assets.verifyRendered(f.note, "chart.png", rendered('app://local/Team/chart.png?0'), () => true)).rejects.toThrow();
	expect(f.readBinary).not.toHaveBeenCalled();
	await expect(f.assets.verifyRendered(f.note, "https://images.test/a.png", rendered('https://images.test/b.png'), () => true)).rejects.toThrow();
	const image = rendered('https://images.test/a.png'), evidence = await f.assets.verifyRendered(f.note, image.src, image, () => true);
	expect(evidence.asset.kind).toBe('external'); expect(f.readBinary).not.toHaveBeenCalled();
	Object.assign(image, { currentSrc: 'https://images.test/b.png' }); expect(evidence.valid()).toBe(false);
});

test("late digest completion cannot authorize a closed pane and a fresh pane can reuse only the digest", async () => {
	const f = fixture(), image = rendered(f.app.vault.getResourcePath()); let current = true, finish!: (hash: string) => void;
	jest.mocked(sha256Hex).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
	const pending = f.assets.verifyRendered(f.note, "chart.png", image, () => current);
	await Promise.resolve(); current = false; finish(hash);
	await expect(pending).rejects.toThrow();
	const next = await f.assets.verifyRendered(f.note, "chart.png", image, () => true);
	expect(next.valid()).toBe(true); expect(f.readBinary).toHaveBeenCalledTimes(1);
});

test("limits distinct image reads to two and drops queued verification when its last surface closes", async () => {
	const f = fixture(), files = [0, 1, 2].map(n => ({ ...f.file, path: `Team/chart${n}.png` } as TFile));
	const finish: ((value: ArrayBuffer) => void)[] = [];
	const readBinary = jest.fn(() => new Promise<ArrayBuffer>(resolve => { finish.push(resolve); }));
	const app = { metadataCache: { getFirstLinkpathDest: (destination: string) => files.find(file => file.path === 'Team/' + destination) },
		vault: { getFileByPath: (path: string) => files.find(file => file.path === path), getResourcePath: (file: TFile) => `app://local/${file.path}?1`, readBinary } };
	f.folder.crdtDoc.getMap = () => ({ get: () => ({ owner: true, permissions: { 'chart.png': 'read', 'renamed.png': 'read' } }) });
	const assets = new ImageAssets(app as unknown as App, f.shares as unknown as ShareRegistry); let lastVisible = true;
	const pending = files.map((file, i) => assets.verifyRendered(f.note, `chart${i}.png`, rendered(app.vault.getResourcePath(file)), () => i < 2 || lastVisible));
	expect(readBinary).toHaveBeenCalledTimes(2); lastVisible = false;
	finish.forEach(resolve => resolve(new ArrayBuffer(8)));
	const results = await Promise.allSettled(pending);
	expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']); expect(readBinary).toHaveBeenCalledTimes(2);
});
