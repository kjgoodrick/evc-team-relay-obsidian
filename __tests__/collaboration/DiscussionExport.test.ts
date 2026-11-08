import { parseDiscussionExport, DISCUSSION_EXPORT_MAX_RECORDS } from "../../src/collaboration/DiscussionExportProtocol";
import { saveDiscussionExport } from "../../src/collaboration/DiscussionExport";
import { pictureHash } from "../../src/collaboration/PictureProtocol";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { exportFixture, exportWithPicture, exportIdentity as identity, exportId as id, exportDisk } from "../mocks/DiscussionExport";

const sourceFor = (snapshot = exportFixture(), bytes = new ArrayBuffer(0)) => ({ exportSnapshot: jest.fn(async () => snapshot), pictureContent: jest.fn(async () => bytes) });

test("validates identity/history and copies supported metadata without credentials or unknown body fields", () => {
	const snapshot = exportFixture();
	const input = { ...snapshot, credentials: "secret", entry: { ...snapshot.entry, token: "secret" }, records: snapshot.records.map(row =>
		row.type === "message_revision" ? { ...row, reason: "private", body: { ...row.body, secret: "private" } } : { ...row, object_key: "secret" }) };
	const result = parseDiscussionExport(input, identity);
	expect(result).toEqual(snapshot); expect(JSON.stringify(result)).not.toMatch(/secret|private|object_key/);
	input.entry.path = "changed"; expect(result.entry.path).toBe("Folder/Note.md");
});

test.each([
	["other account", (s: any) => s.exporter_id = id(90)], ["other share", (s: any) => s.share_id = id(90)],
	["other entry", (s: any) => s.entry.id = id(90)], ["other view", (s: any) => s.view_id = id(90)],
	["unknown version", (s: any) => s.version = 2], ["removed content", (s: any) => s.includes.removed_content = true],
	["removed thread", (s: any) => s.records[0].removed = true], ["deleted body", (s: any) => s.records[2].deleted = true],
	["unknown record", (s: any) => s.records.push({ type: "credential", token: "secret" })],
	["duplicate", (s: any) => s.records.push(s.records[0])], ["missing current body", (s: any) => s.records.splice(4, 1)],
	["missing current anchor", (s: any) => s.records.splice(1, 1)], ["orphan revision", (s: any) => s.records[3].message_id = id(90)],
	["future revision", (s: any) => s.records[3].revision = 100], ["future sequence", (s: any) => s.sequence = 1],
	["unavailable anchor with quote", (s: any) => s.records[1].unavailable = true],
	["mixed image target", (s: any) => s.entry.kind = "image"], ["null scope with records", (s: any) => s.scope_id = null],
	["too many records", (s: any) => s.records = Array(DISCUSSION_EXPORT_MAX_RECORDS + 1).fill(s.records[0])],
])("rejects %s before disk writes", async (_label, change) => {
	const snapshot = exportFixture(); change(snapshot); const disk = exportDisk();
	await expect(saveDiscussionExport(sourceFor(snapshot), identity, disk.io, () => true)).rejects.toThrow();
	expect(disk.folders).toEqual([]);
});

test("saved Bases view retains its identity and unavailable historical targets without fetching their content", () => {
	const snapshot = exportFixture(), scopeId = baseDiscussionScope(id(3), id(20));
	snapshot.entry.kind = "base"; snapshot.view_id = id(20);
	const row = snapshot.records[1]; if (row.type !== "anchor_revision") throw new Error();
	row.anchor = { type: "base", version: 1, definition_id: id(21), view_id: id(20), generation: id(8), registry_revision: 1, target: { type: "view" } };
	expect(parseDiscussionExport(snapshot, { ...identity, scopeId }).view_id).toBe(id(20));
	row.anchor = null; row.unavailable = true;
	expect(parseDiscussionExport(snapshot, { ...identity, scopeId }).records[1]).toMatchObject({ anchor: null, unavailable: true });
});

test("saves historical picture bytes and verified metadata with completion last, using generated paths only", async () => {
	const { snapshot, bytes } = await exportWithPicture(); snapshot.entry.path = "../../outside/<script>.md";
	const disk = exportDisk(), source = sourceFor(snapshot, bytes), progress = jest.fn();
	const path = await saveDiscussionExport(source, identity, disk.io, () => true, true, progress);
	expect(source.pictureContent).toHaveBeenCalledTimes(1);
	const manifest = JSON.parse(disk.texts.get(path + "/manifest.json")!), complete = JSON.parse(disk.texts.get(path + "/COMPLETE.json")!);
	expect(manifest).toMatchObject({ picture_files: "included", entry_id: id(3) });
	for (const file of manifest.files) {
		const content = disk.binaries.get(path + "/" + file.file) ?? new TextEncoder().encode(disk.texts.get(path + "/" + file.file)!).buffer;
		expect(content.byteLength).toBe(file.size); expect(await pictureHash(content)).toBe(file.sha256);
	}
	expect(complete.manifestSha256).toBe(await pictureHash(new TextEncoder().encode(disk.texts.get(path + "/manifest.json")!).buffer));
	expect([...disk.texts.keys()].at(-1)).toBe(path + "/COMPLETE.json");
	expect([...disk.texts.keys(), ...disk.binaries.keys()].every(key => key.startsWith(path + "/") && !key.includes(".."))).toBe(true);
	expect(progress).toHaveBeenCalledWith("Saving comment picture 1 of 1…");
});

test("metadata-only selection explicitly omits bytes and tolerates already unavailable picture references", async () => {
	const { snapshot } = await exportWithPicture(); const picture = snapshot.records.find(row => row.type === "picture")!;
	if (picture.type !== "picture") throw new Error(); picture.available = false; picture.metadata = null;
	const disk = exportDisk(), source = sourceFor(snapshot);
	await expect(saveDiscussionExport(source, identity, disk.io, () => true)).rejects.toThrow("unavailable");
	expect(disk.folders).toHaveLength(0);
	const path = await saveDiscussionExport(source, identity, disk.io, () => true, false);
	expect(source.pictureContent).not.toHaveBeenCalled(); expect(disk.binaries.size).toBe(0);
	expect(JSON.parse(disk.texts.get(path + "/manifest.json")!)).toMatchObject({ picture_files: "not_selected" });
});

test.each(["download", "write", "readback", "metadata", "close"])("%s failure never writes a completion marker; retry creates a different folder", async kind => {
	const { snapshot, bytes } = await exportWithPicture(); const source = sourceFor(snapshot, bytes), disk = exportDisk(); let current = true;
	if (kind === "download") source.pictureContent.mockRejectedValueOnce(new Error("Access revoked"));
	if (kind === "write") jest.spyOn(disk.io, "writeBinary").mockRejectedValueOnce(new Error("Disk full"));
	if (kind === "readback") jest.spyOn(disk.io, "readBinary").mockResolvedValueOnce(new Uint8Array([1, 2, 4]).buffer);
	if (kind === "metadata") jest.spyOn(disk.io, "read").mockResolvedValueOnce("corrupt");
	if (kind === "close") source.pictureContent.mockImplementationOnce(async () => { current = false; return bytes; });
	await expect(saveDiscussionExport(source, identity, disk.io, () => current)).rejects.toThrow();
	expect([...disk.texts.keys()].some(key => key.endsWith("COMPLETE.json"))).toBe(false);
	current = true; const path = await saveDiscussionExport(source, identity, disk.io, () => current);
	expect(disk.folders.filter(key => /\/Discussions-[^/]+$/.test(key))).toHaveLength(2);
	expect(disk.texts.has(path + "/COMPLETE.json")).toBe(true);
});

test("oversized picture collection fails before downloads or folders; metadata-only remains usable", async () => {
	const { snapshot } = await exportWithPicture(), original = snapshot.records.find(row => row.type === "picture")!;
	if (original.type !== "picture" || !original.metadata) throw new Error();
	original.metadata.renditions.content!.size = 10 * 1024 * 1024;
	const revision = snapshot.records.find(row => row.type === "message_revision")!;
	if (revision.type !== "message_revision") throw new Error();
	for (let i = 0; i < 10; i++) {
		const picture = structuredClone(original); picture.picture_id = id(30 + i); picture.metadata!.picture_id = picture.picture_id;
		snapshot.records.push(picture);
		// Spread references over two revisions to respect the per-body bound.
		const target = i < 9 ? revision : snapshot.records[4];
		if (target.type === "message_revision") target.body!.blocks.push({ type: "picture", picture_id: picture.picture_id });
	}
	const source = sourceFor(snapshot), disk = exportDisk();
	await expect(saveDiscussionExport(source, identity, disk.io, () => true)).rejects.toThrow("100 MiB");
	expect(source.pictureContent).not.toHaveBeenCalled(); expect(disk.folders).toEqual([]);
	await saveDiscussionExport(source, identity, disk.io, () => true, false);
});
