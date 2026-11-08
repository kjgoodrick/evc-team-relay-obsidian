import type { DiscussionExport } from "../../src/collaboration/DiscussionExportProtocol";
import { bodyFromText } from "../../src/collaboration/DiscussionProtocol";
import type { LocalWorkIO } from "../../src/collaboration/LocalWorkRecovery";
import { pictureHash } from "../../src/collaboration/PictureProtocol";
export const exportId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const exportIdentity = { accountId: exportId(1), shareId: exportId(2), scopeId: exportId(3) };
export function exportFixture(): DiscussionExport {
	const id = exportId, at = "2026-11-07T00:00:00Z";
	return { format: "team-relay-discussion-export", version: 1, export_id: id(9), captured_at: at, exporter_id: id(1), share_id: id(2), scope_id: id(4),
		entry: { id: id(3), path: "Folder/Note.md", kind: "note", generation: id(8) }, view_id: null, collaboration_epoch: id(7), sequence: 3,
		includes: { message_history: true, anchor_history: true, picture_bytes: false, removed_content: false }, records: [
			{ type: "thread", id: id(5), author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1, removed: false, created_sequence: 1, activity_sequence: 3, created_at: at },
			{ type: "anchor_revision", thread_id: id(5), revision: 1, actor_id: id(1), created_at: at, anchor: { type: "note", version: 1 }, unavailable: false },
			{ type: "message", id: id(6), thread_id: id(5), author_id: id(1), revision: 2, deleted: false, created_sequence: 1, created_at: at, edited_at: at },
			{ type: "message_revision", message_id: id(6), revision: 1, actor_id: id(1), created_at: at, body: bodyFromText("Original") },
			{ type: "message_revision", message_id: id(6), revision: 2, actor_id: id(1), created_at: at, body: bodyFromText("Revised <script>text stays data</script>") },
			{ type: "reaction", message_id: id(6), emoji: "heart", count: 1, mine: true },
			{ type: "identity", id: id(1) },
		] };
}
export async function exportWithPicture() {
	const snapshot = exportFixture(), bytes = new Uint8Array([1, 2, 3]).buffer;
	const rendition = { size: bytes.byteLength, sha256: await pictureHash(bytes), mime: "image/png" as const, width: 1, height: 1 };
	const revision = snapshot.records.find(row => row.type === "message_revision")!;
	if (revision.type === "message_revision") revision.body!.blocks.push({ type: "picture", picture_id: exportId(10), alt: "Historical picture" });
	snapshot.records.push({ type: "picture", picture_id: exportId(10), available: true, metadata: { picture_id: exportId(10), state: "attached", source_sha256: rendition.sha256,
		source_size: bytes.byteLength, source_mime: "image/png", expires_at: null, renditions: { content: rendition, thumbnail: { ...rendition } } } });
	return { snapshot, bytes, rendition };
}
export function exportDisk() {
	const texts = new Map<string, string>(), binaries = new Map<string, ArrayBuffer>(), folders: string[] = [];
	const io: LocalWorkIO = {
		mkdir: jest.fn(async path => { folders.push(path); }),
		write: jest.fn(async (path, text) => { if (texts.has(path)) throw new Error("File exists"); texts.set(path, text); }),
		writeBinary: jest.fn(async (path, bytes) => { if (binaries.has(path)) throw new Error("File exists"); binaries.set(path, bytes.slice(0)); }),
		read: jest.fn(async path => texts.get(path)!), readBinary: jest.fn(async path => binaries.get(path)!.slice(0)),
	};
	return { io, texts, binaries, folders };
}
