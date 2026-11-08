import { createSourceInstallationDownloads } from "../../src/SourceInstallationDownloads";
import { readManagedSource } from "../../src/client/readManagedSource";
import { readManagedAttachment } from "../../src/client/readManagedAttachment";
import { readManagedInventory } from "../../src/client/readManagedInventory";
import type { RelayCredentialCache } from "../../src/RelayCredentialCache";
import type { SourceInventoryIdentity } from "../../src/storage/source-document-cache";
import type { ManagedManifest } from "../../src/client/ManagedIndexTransport";
import type { InstallationEntry } from "../../src/SourceInstallationPlan";
import { ResourceAddress, RemoteFolderAddress, RemoteCanvasAddress } from "../../src/ResourceAddress";
import { ItemKind } from "../../src/ItemKinds";

jest.mock("../../src/client/readManagedSource");
jest.mock("../../src/client/readManagedAttachment");
jest.mock("../../src/client/readManagedInventory");
const sourceRead = jest.mocked(readManagedSource), attachmentRead = jest.mocked(readManagedAttachment), inventoryRead = jest.mocked(readManagedInventory);
const folder = "11111111-1111-4111-8111-111111111111", note = "22222222-2222-4222-8222-222222222222", picture = "33333333-3333-4333-8333-333333333333";
function setup(options: Parameters<typeof createSourceInstallationDownloads>[3] = {}) {
	const source: { -readonly [K in keyof SourceInventoryIdentity]: SourceInventoryIdentity[K] } = { hostAppId: "fixture", serverId: "source", controlPlaneUrl: "https://source.test", s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", folder)), restoreGeneration: null };
	const snapshot: ManagedManifest = { records: { "Note.md": { id: note, type: ItemKind.Document, version: 0 },
		"Image.png": { id: picture, type: ItemKind.Image, version: 0, hash: "a".repeat(64), synctime: 1, mimetype: "image/png" } }, permissions: { "Note.md": "read", "Image.png": "read" }, activity: {}, owner: false, restore_guard: true, restore_generation: null };
	const current = { value: true }, check = () => { if (!current.value) throw new Error("account changed"); };
	const credentials = { captureDocumentSourceContext: () => ({ serverId: "source", controlPlaneUrl: "https://source.test", check }) } as unknown as RelayCredentialCache;
	const downloads = createSourceInstallationDownloads(credentials, source, snapshot, options);
	const entry = (path: string): InstallationEntry => ({ path, record: { ...snapshot.records[path] } });
	return { source, snapshot, current, credentials, downloads, entry };
}
beforeEach(() => {
	jest.resetAllMocks();
	sourceRead.mockResolvedValue({ update: new Uint8Array([0, 0]), stateVector: new Uint8Array([0]), downloadedAt: "fixture", check: () => {} });
	attachmentRead.mockResolvedValue({ content: new ArrayBuffer(3), downloadedAt: "fixture", check: () => {} });
	inventoryRead.mockResolvedValue({ records: {}, permissions: {}, activity: {}, owner: false, restore_guard: true, restore_generation: null });
});

test("routes source, attachment and fresh inventory reads through captured identities and limits", async () => {
	const s = setup(), update = await s.downloads.source(s.entry("Note.md"), s.source, 100);
	expect(update).toEqual(new Uint8Array([0, 0]));
	expect(sourceRead).toHaveBeenCalledWith(s.credentials, expect.stringContaining(note), "Note.md", "source", s.source, expect.objectContaining({ maxBytes: 100, check: expect.any(Function) }));
	expect((await s.downloads.attachment(s.entry("Image.png"), s.source, 200)).byteLength).toBe(3);
	expect(attachmentRead).toHaveBeenCalledWith(s.credentials, expect.stringContaining(picture), "a".repeat(64), "source", s.source, expect.objectContaining({ maxBytes: 200 }));
	await s.downloads.revalidate(s.source);
	expect(inventoryRead).toHaveBeenCalledWith(s.credentials, s.source.s3rn, "source", s.source, expect.objectContaining({ timeoutMs: 30_000 }));
});

test.each(["hostAppId", "serverId", "controlPlaneUrl", "s3rn", "restoreGeneration"] as const)("rejects a different %s before downloading", async field => {
	const s = setup(), other = { ...s.source, [field]: field === "restoreGeneration" ? note : "different" };
	await expect(s.downloads.source(s.entry("Note.md"), other, 100)).rejects.toThrow();
	await expect(s.downloads.revalidate(other)).rejects.toThrow();
	expect(sourceRead).not.toHaveBeenCalled(); expect(inventoryRead).not.toHaveBeenCalled();
});

test.each(["path", "identity", "revision"])("rejects an entry with changed %s", async change => {
	const s = setup(), entry = s.entry("Image.png");
	if (change === "path") entry.path = "Different.png";
	if (change === "identity") entry.record.id = note;
	if (change === "revision") entry.record.hash = "b".repeat(64);
	await expect(s.downloads.attachment(entry, s.source, 100)).rejects.toThrow("differs from the captured inventory"); expect(attachmentRead).not.toHaveBeenCalled();
});

test("frozen capture cannot be relabeled by mutating the caller's metadata", async () => {
	const s = setup(), source = { ...s.source }, entry = s.entry("Image.png");
	s.source.restoreGeneration = note; s.snapshot.records["Image.png"].hash = "b".repeat(64);
	await s.downloads.attachment(entry, source, 100);
	expect(attachmentRead.mock.calls[0][2]).toBe("a".repeat(64)); expect(attachmentRead.mock.calls[0][4].restoreGeneration).toBeNull();
});

test("late results cannot survive account or caller context changes", async () => {
	const s = setup();
	attachmentRead.mockImplementationOnce(async () => { s.current.value = false; return { content: new ArrayBuffer(3), downloadedAt: "fixture", check: () => {} }; });
	await expect(s.downloads.attachment(s.entry("Image.png"), s.source, 100)).rejects.toThrow("account changed");
});

test("rechecks the preview's own validity before returning its bytes", async () => {
	const s = setup(); sourceRead.mockResolvedValueOnce({ update: new Uint8Array([0, 0]), stateVector: new Uint8Array(), downloadedAt: "fixture", check: () => { throw new Error("preview invalidated"); } });
	await expect(s.downloads.source(s.entry("Note.md"), s.source, 100)).rejects.toThrow("preview invalidated");
});

test("cancellation prevents all three download kinds", async () => {
	const signal = new AbortController(), s = setup({ signal: signal.signal }); signal.abort();
	await expect(s.downloads.source(s.entry("Note.md"), s.source, 100)).rejects.toMatchObject({ name: "AbortError" });
	await expect(s.downloads.attachment(s.entry("Image.png"), s.source, 100)).rejects.toMatchObject({ name: "AbortError" });
	await expect(s.downloads.revalidate(s.source)).rejects.toMatchObject({ name: "AbortError" });
	expect(sourceRead).not.toHaveBeenCalled(); expect(attachmentRead).not.toHaveBeenCalled(); expect(inventoryRead).not.toHaveBeenCalled();
});

test("source and attachment entry kinds cannot be interchanged", async () => {
	const s = setup();
	await expect(s.downloads.source(s.entry("Image.png"), s.source, 100)).rejects.toThrow("not an editing source");
	await expect(s.downloads.attachment(s.entry("Note.md"), s.source, 100)).rejects.toThrow("not a captured attachment");
	expect(sourceRead).not.toHaveBeenCalled(); expect(attachmentRead).not.toHaveBeenCalled();
});

test("existing Canvas source files use their own source address without enabling Canvas discussions", async () => {
	const s = setup(), record: InstallationEntry["record"] = { id: note, type: ItemKind.Canvas, version: 0 };
	s.snapshot.records = { "Existing.canvas": record };
	const downloads = createSourceInstallationDownloads(s.credentials, s.source, s.snapshot);
	await downloads.source({ path: "Existing.canvas", record }, s.source, 100);
	expect(ResourceAddress.parse(sourceRead.mock.calls[0][1])).toBeInstanceOf(RemoteCanvasAddress);
	expect(attachmentRead).not.toHaveBeenCalled();
});

test.each(["endpoint", "generation", "guard"])("rejects a mismatched captured %s before any read", change => {
	const s = setup();
	if (change === "endpoint") s.source.controlPlaneUrl = "https://different.test";
	if (change === "generation") s.source.restoreGeneration = note;
	if (change === "guard") s.snapshot.restore_guard = false;
	expect(() => createSourceInstallationDownloads(s.credentials, s.source, s.snapshot)).toThrow();
	expect(sourceRead).not.toHaveBeenCalled(); expect(inventoryRead).not.toHaveBeenCalled();
});
