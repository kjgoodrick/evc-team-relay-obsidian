import { savedCommandReview, recoveryCommandReview } from "../../src/collaboration/SavedCommandReview";
import { queuedEnvelope } from "../../src/collaboration/DiscussionTransport";
import type { InspectedLocalWork } from "../../src/collaboration/LocalWorkImport";
import type { QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "destination" };
const op = (): QueuedCommand => ({ operationId: id(4), scopeId: id(3), type: "thread.create", dependsOn: [], payload: {
	type: "thread.create", thread_id: id(5), message_id: id(6), anchor: { version: 1, type: "note" }, body: { version: 1, blocks: [
		{ type: "paragraph", children: [{ type: "text", text: "Keep formatting", marks: ["bold"] }, { type: "mention", user_id: id(8) }] },
		{ type: "picture", picture_id: id(9) },
	] },
} });
const copy = (): InspectedLocalWork => ({ directory: "review", manifestSha256: "a".repeat(64), pictureBytes: 0, snapshot: {
	format: "team-relay-local-comment-work", version: 1, storageVersion: 23, id: id(10), createdAt: 0,
	identity: { ...identity, serverId: identity.serverId + "/", vaultId: "source-vault" }, drafts: [], actions: [], pictures: [], dependencies: [],
	operations: [{ ...op(), state: "queued", createdAt: 0, attempt: 0, nextAttemptAt: 0 }],
} });

test("review preserves rich content, mentions, picture IDs and the exact request without changing the source", () => {
	const source = copy(), before = JSON.stringify(source);
	const review = recoveryCommandReview(source, id(4), identity);
	expect(queuedEnvelope(identity.shareId, review.operation)).toBe(queuedEnvelope(identity.shareId, op()));
	expect(review.body?.blocks).toHaveLength(2); expect(review.target).toEqual({ version: 1, type: "note" });
	(review.operation.payload as Record<string, unknown>).body = "changed review";
	expect(JSON.stringify(source)).toBe(before);
});

test.each(["serverId", "accountId", "shareId"])("foreign %s fails before any request can be prepared", field => {
	const destination = { ...identity, [field]: field === "serverId" ? "https://foreign.test" : id(99) };
	expect(() => recoveryCommandReview(copy(), id(4), destination)).toThrow("same server, account and shared folder");
});

test("unknown formats and picture uploads cannot be silently checked as ordinary comments", () => {
	expect(() => savedCommandReview({ ...op(), type: "picture.upload" }, identity.shareId)).toThrow("separate receipts");
	const source = op(); (source.payload as Record<string, unknown>).body = { version: 99, blocks: [] };
	expect(() => savedCommandReview(source, identity.shareId)).toThrow();
	expect(() => recoveryCommandReview(copy(), id(99), identity)).toThrow("no longer");
});

test("reaction review preserves explicit removal and rejects an unknown reaction", () => {
	const operation: QueuedCommand = { ...op(), type: "reaction.set", payload: {
		type: "reaction.set", thread_id: id(5), message_id: id(6), emoji: "heart", present: false,
	} };
	expect(savedCommandReview(operation, identity.shareId)).toMatchObject({ label: "Remove reaction ❤️", operation });
	(operation.payload as Record<string, unknown>).emoji = "unknown";
	expect(() => savedCommandReview(operation, identity.shareId)).toThrow("invalid");
});
