/** Actual loopback API/object-store and filesystem archive, no live vault. */
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { saveDiscussionExport } from "../../src/collaboration/DiscussionExport";
import { parseDiscussionExport } from "../../src/collaboration/DiscussionExportProtocol";
import { bodyFromText, protocolJson, type MessageBody } from "../../src/collaboration/DiscussionProtocol";
import { pictureHash } from "../../src/collaboration/PictureProtocol";
import { PermissionPolicyClient } from "../../src/collaboration/PermissionPolicy";
import type { LocalWorkIO } from "../../src/collaboration/LocalWorkRecovery";

const fixturePath = process.env.EVC_EXPORT_FIXTURE;
const integration = fixturePath ? test : test.skip;
integration("real read-only archive keeps history/pictures, excludes removed bodies and denies revoked downloads", async () => {
	const f = JSON.parse(readFileSync(fixturePath!, "utf8")) as { base: string; share: string; entry: string; reviewer: string; owner: string; token: string; ownerToken: string; picturePath?: string };
	if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(f.base)) throw new Error("Only the disposable loopback fixture is allowed");
	const identity = { serverId: f.base, shareId: f.share, accountId: f.reviewer, scopeId: f.entry };
	const reader = new DiscussionTransport(identity, async () => ({ accountId: f.reviewer, accessToken: f.token }), fetch);
	const owner = new DiscussionTransport({ ...identity, accountId: f.owner }, async () => ({ accountId: f.owner, accessToken: f.ownerToken }), fetch);
	const policy = new PermissionPolicyClient(f.base, { shareId: f.share, actorId: f.owner }, () => f.ownerToken, () => true, fetch);
	const thread = randomUUID(), message = randomUUID(), picture = randomUUID();
	const original: MessageBody = bodyFromText("Original posted content"), root = await mkdtemp(join(tmpdir(), "evc-export-http-"));
	const io: LocalWorkIO = { mkdir: async path => { await mkdir(join(root, path), { recursive: true }); },
		write: async (path, text) => { await writeFile(join(root, path), text, { flag: "wx" }); },
		writeBinary: async (path, bytes) => { await writeFile(join(root, path), new Uint8Array(bytes), { flag: "wx" }); },
		read: path => readFile(join(root, path), "utf8"), readBinary: async path => new Uint8Array(await readFile(join(root, path))).buffer };
	try {
		if (f.picturePath) {
			const bytes = new Uint8Array(readFileSync(f.picturePath)).buffer;
			await owner.uploadPicture(f.entry, { type: "picture.upload", picture_id: picture, size: bytes.byteLength, sha256: await pictureHash(bytes) }, bytes);
			original.blocks.push({ type: "picture", picture_id: picture, alt: "Historical picture" });
		}
		await owner.send({ operationId: randomUUID(), scopeId: f.entry, type: "thread.create", dependsOn: [], payload: {
			type: "thread.create", thread_id: thread, message_id: message, anchor: { type: "note", version: 1 }, body: protocolJson(original) } });
		await owner.send({ operationId: randomUUID(), scopeId: f.entry, type: "message.edit", dependsOn: [], payload: {
			type: "message.edit", thread_id: thread, message_id: message, expected_revision: 1, body: protocolJson(bodyFromText("Edited content")) } });
		const reply = randomUUID();
		await owner.send({ operationId: randomUUID(), scopeId: f.entry, type: "reply.create", dependsOn: [], payload: {
			type: "reply.create", thread_id: thread, message_id: reply, body: protocolJson(bodyFromText("Removed private reply")) } });
		await owner.sendOnline({ operationId: randomUUID(), scopeId: f.entry, payload: { type: "message.delete", thread_id: thread, message_id: reply, expected_revision: 1, reason: "Private moderation reason" } });
		const before = await policy.read();
		await policy.save(before, { file_rules: [{ user_id: f.reviewer, path: "", recursive: true, permission: "read" }], comment_rules: [] });
		expect(await reader.permissions(f.entry)).toMatchObject({ read: true, comment: false }); expect((await reader.capabilities()).export).toBe(true);
		const path = await saveDiscussionExport(reader, identity, io, () => true, !!f.picturePath);
		const snapshot = parseDiscussionExport(JSON.parse(await io.read(path + "/discussions.json")), identity);
		expect(JSON.stringify(snapshot)).not.toMatch(/Removed private reply|Private moderation reason|object_key|accessToken/);
		expect(snapshot.records.filter(row => row.type === "message_revision")).toHaveLength(2);
		expect(snapshot.records.find(row => row.type === "message" && row.id === reply)).toMatchObject({ deleted: true });
		const manifest = JSON.parse(await io.read(path + "/manifest.json")), complete = JSON.parse(await io.read(path + "/COMPLETE.json"));
		for (const file of manifest.files) {
			const bytes = await io.readBinary(path + "/" + file.file);
			expect(bytes.byteLength).toBe(file.size); expect(await pictureHash(bytes)).toBe(file.sha256);
		}
		expect(complete.manifestSha256).toBe(await pictureHash(new TextEncoder().encode(await io.read(path + "/manifest.json")).buffer));
		if (f.picturePath) {
			expect(manifest.files.filter((file: { picture_id?: string }) => file.picture_id === picture)).toHaveLength(1);
			const interrupted = { exportSnapshot: async (scopeId: string) => {
				const captured = await reader.exportSnapshot(scopeId), current = await policy.read();
				await policy.save(current, { file_rules: [{ user_id: f.reviewer, path: "", recursive: true, permission: "none" }], comment_rules: [] }); return captured;
			}, pictureContent: reader.pictureContent.bind(reader) };
			await expect(saveDiscussionExport(interrupted, identity, io, () => true)).rejects.toMatchObject({ status: 404 });
			const folders = await readdir(join(root, path.split("/")[0]));
			let completeCount = 0; for (const folder of folders) {
				if ((await readdir(join(root, path.split("/")[0], folder))).includes("COMPLETE.json")) completeCount++;
			}
			expect(completeCount).toBe(1); await expect(reader.exportSnapshot(f.entry)).rejects.toMatchObject({ status: 404 });
		}
		const removed = await owner.exportSnapshot(f.entry);
		expect(JSON.stringify(removed)).not.toMatch(/Removed private reply|Private moderation reason/);
	} finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
