import { saveDiscussionCollection } from "../../src/collaboration/DiscussionExport";
import { parseExportCatalog, type DiscussionExportCatalog } from "../../src/collaboration/DiscussionExportProtocol";
import { pictureHash } from "../../src/collaboration/PictureProtocol";
import { exportFixture, exportIdentity as identity, exportId as id, exportDisk } from "../mocks/DiscussionExport";

function fixture() {
	const first = exportFixture();
	let json = JSON.stringify(first);
	for (const value of [3, 4, 5, 6, 8, 9]) json = json.split(id(value)).join(id(value + 10));
	const second = JSON.parse(json) as typeof first; second.entry.path = "Folder/Second.md";
	const snapshots = [first, second];
	const catalog: DiscussionExportCatalog = { format: "team-relay-discussion-export-catalog", version: 1, catalog_id: id(50),
		captured_at: first.captured_at, exporter_id: identity.accountId, share_id: identity.shareId, collaboration_epoch: first.collaboration_epoch,
		sequence: first.sequence, scopes: snapshots.map(snapshot => ({ scope_id: snapshot.scope_id!, entry_id: snapshot.entry.id, path: snapshot.entry.path,
			kind: "note", view_id: null, view_name: null, view_state: null })) };
	return { catalog, snapshots, source: { exportCatalog: jest.fn(async () => catalog), exportSnapshot: jest.fn(async (scopeId: string) => snapshots.find(snapshot => snapshot.entry.id === scopeId)!), pictureContent: jest.fn() }, disk: exportDisk() };
}

test("folder archive writes verified children sequentially and seals the exact catalog/child completion hashes last", async () => {
	const f = fixture(), progress = jest.fn();
	const path = await saveDiscussionCollection(f.source, identity, f.disk.io, () => true, false, progress);
	const manifest = JSON.parse(f.disk.texts.get(path + "/manifest.json")!), complete = JSON.parse(f.disk.texts.get(path + "/COMPLETE.json")!);
	expect(manifest).toMatchObject({ atomic: false, picture_files: "not_selected", catalog_id: f.catalog.catalog_id });
	expect(manifest.scopes).toHaveLength(2);
	for (const scope of manifest.scopes) {
		const content = f.disk.texts.get(`${path}/${scope.folder}/COMPLETE.json`)!;
		expect(await pictureHash(new TextEncoder().encode(content).buffer)).toBe(scope.completionSha256);
	}
	expect(await pictureHash(new TextEncoder().encode(f.disk.texts.get(path + "/manifest.json")!).buffer)).toBe(complete.manifestSha256);
	expect(f.source.exportSnapshot.mock.calls.map(call => call[0])).toEqual([id(3), id(13)]);
	expect([...f.disk.texts.keys()].at(-1)).toBe(path + "/COMPLETE.json");
	expect(progress).toHaveBeenCalledWith("Scope 2 of 2: Capturing posted discussions…");
});

test.each(["denied", "identity", "epoch", "sequence", "closed"])("%s after first scope leaves complete child evidence but no completed collection", async kind => {
	const f = fixture(); let current = true;
	f.source.exportSnapshot.mockImplementation(async scopeId => {
		if (scopeId === id(3)) return f.snapshots[0];
		if (kind === "denied") throw new Error("Access revoked");
		if (kind === "closed") current = false;
		return { ...f.snapshots[1], ...(kind === "identity" ? { scope_id: id(99) } : kind === "epoch" ? { collaboration_epoch: id(99) } : kind === "sequence" ? { sequence: 2, records: [] } : {}) };
	});
	await expect(saveDiscussionCollection(f.source, identity, f.disk.io, () => current, false)).rejects.toThrow();
	const completions = [...f.disk.texts.keys()].filter(path => path.endsWith("COMPLETE.json"));
	expect(completions).toHaveLength(1); expect(completions[0].split("/")).toHaveLength(4);
});

test("empty authorized folder still saves an explicit inventory without snapshots or pictures", async () => {
	const f = fixture(); f.catalog.scopes = [];
	const path = await saveDiscussionCollection(f.source, identity, f.disk.io, () => true);
	expect(f.source.exportSnapshot).not.toHaveBeenCalled(); expect(f.source.pictureContent).not.toHaveBeenCalled();
	expect(JSON.parse(f.disk.texts.get(path + "/manifest.json")!).scopes).toEqual([]);
});

test("catalog parser preserves archived view metadata and rejects duplicates, other accounts and malformed lineage", () => {
	const f = fixture(), row = f.catalog.scopes[0]; row.kind = "base"; row.view_id = id(80); row.view_name = "Old timeline"; row.view_state = "archived";
	expect(parseExportCatalog(f.catalog, identity).scopes[0].view_state).toBe("archived");
	for (const scopes of [[row, row], [f.catalog.scopes[1], row], [{ ...row, view_id: null }], [{ ...row, view_state: "invented" }],
		[{ ...row, kind: "note" }], [{ ...row, entry_id: "../../target" }], Array(257).fill(row)]) {
		expect(() => parseExportCatalog({ ...f.catalog, scopes }, identity)).toThrow();
	}
	expect(() => parseExportCatalog({ ...f.catalog, exporter_id: id(99) }, identity)).toThrow();
	const unknown = { ...f.catalog, token: "secret", scopes: f.catalog.scopes.map(row => ({ ...row, reason: "private" })) };
	expect(parseExportCatalog(unknown, identity)).toEqual(f.catalog);
});

test("collection freezes its inventory and does not add scopes that appear while capture is running", async () => {
	const f = fixture();
	f.source.exportSnapshot.mockImplementation(async scopeId => {
		f.catalog.scopes = [];
		const snapshot = f.snapshots.find(row => row.entry.id === scopeId)!;
		return { ...snapshot, sequence: 100, entry: { ...snapshot.entry, path: "Renamed/Current.md" } };
	});
	const path = await saveDiscussionCollection(f.source, identity, f.disk.io, () => true, false);
	expect(JSON.parse(f.disk.texts.get(path + "/catalog.json")!).scopes).toHaveLength(2);
	expect(f.source.exportSnapshot).toHaveBeenCalledTimes(2);
});
