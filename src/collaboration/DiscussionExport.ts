import { baseDiscussionScope } from "./DiscussionScope";
import { RECOVERY_FOLDER } from "../conflictCopyPath";
import { parseDiscussionExport, parseExportCatalog, type DiscussionExport, type DiscussionExportCatalog, type ExportRequestIdentity } from "./DiscussionExportProtocol";
import { pictureHash, type PictureRendition } from "./PictureProtocol";
import type { LocalWorkIO } from "./LocalWorkRecovery";

export const DISCUSSION_EXPORT_PICTURE_BUDGET = 100 * 1024 * 1024;
export interface DiscussionExportSource {
	exportSnapshot(scopeId: string, current?: () => boolean): Promise<DiscussionExport>;
	pictureContent(scopeId: string, id: string, variant: "content", expected: PictureRendition, current?: () => boolean): Promise<ArrayBuffer>;
}
export interface DiscussionCollectionSource extends DiscussionExportSource {
	exportCatalog(current?: () => boolean): Promise<DiscussionExportCatalog>;
}
export const DISCUSSION_COLLECTION_METADATA_BUDGET = 64 * 1024 * 1024;
export const DISCUSSION_COLLECTION_PICTURE_BUDGET = 250 * 1024 * 1024;
type ScopeArchiveResult = { path: string; completion: { file: string; sha256: string; size: number } };
type CollectionBudget = { metadata: number; pictures: number };
const encoded = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;
const explanation = `Shared discussion archive

This contains the readable, posted discussions for one note, image or saved Bases
view at the recorded capture time. Message and target histories are included.
Removed threads and removed message bodies are excluded. Identities are UUID
references. Drafts, queued changes, note files, permissions and other views are
not included. This is not a coherent service backup or an outbox to replay.

manifest.json describes the snapshot and whether picture files were selected.
Pictures are the server's sanitized content renditions, not original uploads.
Thumbnail renditions, embedded note images and external URL bytes are not saved.
When pictures were not selected, their metadata and references remain in JSON.
No URLs are opened automatically. Treat every comment and path as untrusted data.

COMPLETE.json is written last and records the verified manifest hash. A folder
without it is incomplete. Verify all hashes and lengths before using an archive.
There is no automatic import in this preview. Keep this folder together.
Team Relay excludes the recovery folder from its own sync. Other backup or sync
software may copy it. This is a plain, unencrypted copy; later access changes or
removed comments do not erase files already exported to this device.
`;

/** Separate from local drafts/outbox recovery. No cache fallback, import, command
 * writes or unbounded parallel downloads. Failed attempts leave an incomplete
 * unique folder; a retry captures fresh authorized state in a new folder. */
async function saveScopeArchive(source: DiscussionExportSource, identity: ExportRequestIdentity,
	io: LocalWorkIO, current: () => boolean, includePictures = true, progress: (message: string) => void = () => {}, parentPath = RECOVERY_FOLDER, budget?: CollectionBudget): Promise<ScopeArchiveResult> {
	const check = () => { if (!current()) throw new Error("Export stopped because the account, view or access changed."); };
	check(); progress("Capturing posted discussions…");
	const snapshot = parseDiscussionExport(await source.exportSnapshot(identity.scopeId, current), identity); check();
	const pictures = snapshot.records.filter(row => row.type === "picture");
	if (budget) {
		if (includePictures) budget.pictures += pictures.reduce((total, row) => total + (row.metadata?.renditions.content?.size ?? 0), 0);
		if (budget.pictures > DISCUSSION_COLLECTION_PICTURE_BUDGET)
			throw new Error("This folder exceeds the archive limit (64 MiB metadata or 250 MiB picture files). Export individual scopes or omit picture files.");
	}
	if (includePictures && pictures.some(row => !row.available || !row.metadata?.renditions.content))
		throw new Error("A referenced picture is unavailable. Retry later, or export without picture files.");
	if (includePictures && pictures.reduce((total, row) => total + (row.metadata?.renditions.content?.size ?? 0), 0) > DISCUSSION_EXPORT_PICTURE_BUDGET)
		throw new Error("Picture files exceed the 100 MiB export limit. Export without picture files or choose a smaller discussion scope.");
	const path = `${parentPath}/Discussions-${crypto.randomUUID()}`;
	await io.mkdir(parentPath); check(); await io.mkdir(path); check();
	const files: { file: string; sha256: string; size: number; picture_id?: string; mime?: string; width?: number; height?: number }[] = [];
	if (includePictures && pictures.length) { await io.mkdir(`${path}/pictures`); check(); }
	for (let index = 0; includePictures && index < pictures.length; index++) {
		check(); const row = pictures[index], rendition = row.metadata!.renditions.content!;
		progress(`Saving comment picture ${index + 1} of ${pictures.length}…`);
		const bytes = await source.pictureContent(identity.scopeId, row.picture_id, "content", rendition, current); check();
		if (bytes.byteLength !== rendition.size || await pictureHash(bytes) !== rendition.sha256) throw new Error("A captured picture changed or could not be verified. This export is incomplete.");
		check(); const file = `pictures/${String(index + 1).padStart(5, "0")}.${rendition.mime === "image/png" ? "png" : "jpg"}`;
		await io.writeBinary(`${path}/${file}`, bytes); check();
		const written = await io.readBinary(`${path}/${file}`); check();
		if (written.byteLength !== rendition.size || await pictureHash(written) !== rendition.sha256) throw new Error("A saved picture could not be verified. This export is incomplete.");
		files.push({ file, picture_id: row.picture_id, ...rendition });
	}
	const writeText = async (file: string, text: string) => {
		check(); await io.write(`${path}/${file}`, text); check();
		if (await io.read(`${path}/${file}`) !== text) throw new Error("Saved export metadata could not be verified. This export is incomplete.");
		check(); const bytes = encoded(text); return { file, sha256: await pictureHash(bytes), size: bytes.byteLength };
	};
	progress("Verifying the discussion archive…");
	files.unshift(await writeText("discussions.json", JSON.stringify(snapshot)));
	files.push(await writeText("README.txt", explanation));
	const manifest = JSON.stringify({ format: "team-relay-discussion-archive", version: 1, export_id: snapshot.export_id,
		captured_at: snapshot.captured_at, exporter_id: snapshot.exporter_id, share_id: snapshot.share_id, entry_id: snapshot.entry.id,
		view_id: snapshot.view_id, picture_files: includePictures ? "included" : "not_selected", files });
	const metadata = await writeText("manifest.json", manifest);
	check(); const completion = await writeText("COMPLETE.json", JSON.stringify({ format: "team-relay-discussion-archive-complete", version: 1,
		export_id: snapshot.export_id, manifest: metadata.file, manifestSha256: metadata.sha256, manifestBytes: metadata.size }));
	check(); return { path, completion };
}


export function saveDiscussionExport(source: DiscussionExportSource, identity: ExportRequestIdentity,
	io: LocalWorkIO, current: () => boolean, includePictures = true, progress: (message: string) => void = () => {}): Promise<string> {
	return saveScopeArchive(source, identity, io, current, includePictures, progress).then(result => result.path);
}

/** Inventory is captured atomically; later scope captures each reauthorize and
 * record their own sequence. A collection is not a vault-wide atomic backup. */
export async function saveDiscussionCollection(source: DiscussionCollectionSource, identity: { accountId: string; shareId: string },
	io: LocalWorkIO, current: () => boolean, includePictures = true, progress: (message: string) => void = () => {}): Promise<string> {
	const check = () => { if (!current()) throw new Error("Folder export stopped because its account, window or access changed."); };
	check(); progress("Finding readable discussions in this shared folder…");
	const catalog = parseExportCatalog(await source.exportCatalog(current), identity); check();
	const path = `${RECOVERY_FOLDER}/DiscussionCollection-${crypto.randomUUID()}`;
	await io.mkdir(RECOVERY_FOLDER); check(); await io.mkdir(path); check();
	const budget: CollectionBudget = { metadata: 0, pictures: 0 };
	const output: LocalWorkIO = {
		mkdir: path => io.mkdir(path), read: path => io.read(path), readBinary: path => io.readBinary(path), writeBinary: (path, bytes) => io.writeBinary(path, bytes),
		write: async (path, text) => {
			budget.metadata += encoded(text).byteLength;
			if (budget.metadata > DISCUSSION_COLLECTION_METADATA_BUDGET) throw new Error("Folder archive metadata exceeds 64 MiB. Export individual scopes instead.");
			await io.write(path, text);
		},
	};
	const captured = [];
	for (let index = 0; index < catalog.scopes.length; index++) {
		check(); const scope = catalog.scopes[index];
		const scopeId = scope.view_id ? baseDiscussionScope(scope.entry_id, scope.view_id) : scope.entry_id;
		const bound: DiscussionExportSource = {
			exportSnapshot: async (_scopeId, live) => {
				const snapshot = parseDiscussionExport(await source.exportSnapshot(scopeId, live), { ...identity, scopeId });
				if (snapshot.scope_id !== scope.scope_id || snapshot.entry.kind !== scope.kind || snapshot.collaboration_epoch !== catalog.collaboration_epoch || snapshot.sequence < catalog.sequence)
					throw new Error("A discussion identity or server history changed after the folder inventory. Retry a fresh export.");
				return snapshot;
			},
			pictureContent: source.pictureContent.bind(source),
		};
		const saved = await saveScopeArchive(bound, { ...identity, scopeId }, output, current, includePictures,
			message => progress(`Scope ${index + 1} of ${catalog.scopes.length}: ${message}`), path, budget);
		check();
		captured.push({ entry_id: scope.entry_id, view_id: scope.view_id, folder: saved.path.slice(path.length + 1),
			completionSha256: saved.completion.sha256, completionBytes: saved.completion.size });
	}
	const files = [];
	const write = async (file: string, text: string) => {
		check(); await output.write(`${path}/${file}`, text); check();
		if (await io.read(`${path}/${file}`) !== text) throw new Error("The saved folder archive could not be verified. This collection is incomplete.");
		check(); const bytes = encoded(text); return { file, sha256: await pictureHash(bytes), size: bytes.byteLength };
	};
	files.push(await write("catalog.json", JSON.stringify(catalog)));
	files.push(await write("README.txt", `Shared-folder discussion collection

The catalog lists readable discussion scopes at its capture time. Each child
archive captures and reauthorizes that scope separately and records its own time
and sequence. Edits and new discussions during collection may appear in later
captures; new scopes created after the catalog are not part of this inventory.
This is not an atomic service backup. Archived saved views may be included when
their existing discussions remain readable. Removed bodies are excluded.

A child archive can be complete while this collection is incomplete. Check the
collection COMPLETE.json, manifest and every child's completion/file hashes.
Missing or denied scopes/pictures stop completion; no automatic omission occurs.
Retry creates a fresh collection. Files already saved remain unencrypted local
copies even after access changes. No import or command replay is provided.
`));
	const manifest = await write("manifest.json", JSON.stringify({ format: "team-relay-discussion-collection", version: 1,
		catalog_id: catalog.catalog_id, share_id: catalog.share_id, exporter_id: catalog.exporter_id, inventory_captured_at: catalog.captured_at,
		completed_at: new Date().toISOString(), atomic: false, picture_files: includePictures ? "included" : "not_selected", files, scopes: captured }));
	check(); await write("COMPLETE.json", JSON.stringify({ format: "team-relay-discussion-collection-complete", version: 1,
		catalog_id: catalog.catalog_id, manifest: manifest.file, manifestSha256: manifest.sha256, manifestBytes: manifest.size }));
	check(); return path;
}
