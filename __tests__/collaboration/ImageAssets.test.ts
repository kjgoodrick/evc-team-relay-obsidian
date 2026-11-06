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
	const app = { metadataCache: { getFirstLinkpathDest: () => file }, vault: { getFileByPath: () => file, readBinary } };
	const shares = { shareFor: () => folder };
	const assets = new ImageAssets(app as unknown as App, shares as unknown as ShareRegistry);
	jest.mocked(sha256Hex).mockResolvedValue(hash);
	return { assets, note, file, folder, readBinary, shares, record, revoke: () => { permission = "none"; }, block: () => { blocked = true; }, unregister: () => { registered = false; } };
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
