import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { YSweetProvider } from "../../src/client/provider";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { bodyFromText, localTextAnchor, protocolJson, wireTextAnchor } from "../../src/collaboration/DiscussionProtocol";
import { captureTextAnchor, resolveTextAnchor } from "../../src/collaboration/anchors/text";
import { captureBlockAnchor } from "../../src/collaboration/anchors/blocks";
import type { QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionReattachment } from "../../src/collaboration/DiscussionReattachment";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
Object.assign(globalThis, { IDBKeyRange });

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const run = process.env.EVC_TEXT_ANCHOR_FIXTURE ? test : test.skip;
async function until(check: () => boolean, label: string) {
	const deadline = Date.now() + 12000;
	while (!check()) { if (Date.now() >= deadline) throw new Error("Timed out: " + label); await new Promise(resolve => setTimeout(resolve, 25)); }
}

run("real selected-text comments wait for delete-only edits, survive lost replies and relay restart", async () => {
	const fixture = JSON.parse(readFileSync(process.env.EVC_TEXT_ANCHOR_FIXTURE!, "utf8"));
	for (const url of [fixture.base, fixture.relay]) expect(new URL(url).hostname).toBe("127.0.0.1");
	const docs: Y.Doc[] = [], providers: YSweetProvider[] = [];
	const transport = new DiscussionTransport({ serverId: fixture.base, accountId: fixture.bobId, shareId: fixture.share },
		async () => ({ accountId: fixture.bobId, accessToken: fixture.bobToken }), fetch);
	async function grant(token: string, mode: string) {
		const response = await fetch(fixture.base + "/v1/tokens/relay", { method: "POST", headers: {
			Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ share_id: fixture.share, doc_id: fixture.note, mode }) });
		expect(response.status).toBe(200); return response.json();
	}
	async function peer(token: string, mode: string) {
		const auth = await grant(token, mode), doc = new Y.Doc(); docs.push(doc);
		const provider = new YSweetProvider(auth.relay_url, fixture.note, doc, { connect: false, disableBc: true, params: { token: auth.token } });
		providers.push(provider); provider.connect(); await until(() => provider.synced, "peer sync");
		return { doc, provider, text: doc.getText("contents"), auth };
	}
	const command = (anchor: ReturnType<typeof wireTextAnchor>): QueuedCommand => ({ operationId: randomUUID(), scopeId: fixture.note,
		type: "thread.create", dependsOn: [], payload: { type: "thread.create", thread_id: randomUUID(), message_id: randomUUID(),
			anchor: protocolJson(anchor), body: protocolJson(bodyFromText("Review this selection")) } });
	try {
		expect(await transport.capabilities()).toMatchObject({ discussions: true, textAnchors: true, blockAnchors: true, imageOccurrences: false, imageFiles: false, pictures: false, recovery: true, baseTargets: [], baseRecordTypes: [], search: false });
		expect(await transport.permissions(fixture.note)).toEqual({ read: true, comment: true, edit: false, moderate: false });
		const owner = await peer(fixture.ownerToken, "write"); owner.text.insert(0, "alpha beta gamma");
		const reviewer = await peer(fixture.bobToken, "read");
		await until(() => reviewer.text.toString() === "alpha beta gamma", "reviewer receives note");
		const context = await transport.anchorContext(fixture.note);
		const original = wireTextAnchor(captureTextAnchor(reviewer.text, fixture.note, context.generation, 6, 10));
		const first = command(original), accepted = await transport.send(first);
		expect(accepted.message_revision).toBe(1);
		for (const route of ["validate", "source"]) {
			const forbidden = await fetch(fixture.relay.replace("ws:", "http:") + "/internal/collaboration/" + route, {
				method: "POST", headers: { Authorization: "Bearer " + owner.auth.token, "Content-Type": "application/json" }, body: "{}" });
			expect([401, 403]).toContain(forbidden.status); // A write-capable document token is never a private server credential.
		}
		owner.provider.disconnect();
		owner.text.delete(0, 6); // Does not advance the state vector: deletion evidence is required.
		const afterDeletion = wireTextAnchor(captureTextAnchor(owner.text, fixture.note, context.generation, 0, 4));
		const waiting = command(afterDeletion);
		await expect(transport.send(waiting)).rejects.toMatchObject({ action: "retry", code: "anchor_dependency_not_ready", status: 409 });
		expect((await transport.threads(fixture.note)).threads).toHaveLength(1);
		owner.provider.connect(); await until(() => owner.provider.synced && reviewer.text.toString() === "beta gamma", "deletion reaches relay");
		let lost = true;
		const lossy = new DiscussionTransport(transport.identity, async () => ({ accountId: fixture.bobId, accessToken: fixture.bobToken }), async (url, options) => {
			const response = await fetch(url, options);
			if (lost && response.ok && options.method === "POST") { lost = false; await response.text(); throw new Error("Synthetic lost response"); }
			return response;
		});
		await expect(lossy.send(waiting)).rejects.toMatchObject({ action: "retry", code: "network_unavailable" });
		const receipt = await transport.send(waiting);
		expect(await transport.send(waiting)).toEqual(receipt);
		expect((await transport.threads(fixture.note)).threads).toHaveLength(2);
		for (const provider of providers) provider.destroy();
		writeFileSync(join(fixture.restartDir, "restart-request"), "restart");
		await until(() => existsSync(join(fixture.restartDir, "restart-done")), "relay restarts");
		const restored = await peer(fixture.bobToken, "read");
		expect(restored.text.toString()).toBe("beta gamma");
		expect(await transport.anchorContext(fixture.note)).toEqual(context);
		const page = await transport.thread(fixture.note, receipt.thread_id);
		expect(page.anchor.type).toBe("text");
		if (page.anchor.type !== "text") throw new Error("Expected text anchor");
		expect(resolveTextAnchor(restored.text, fixture.note, context.generation, localTextAnchor(page.anchor))).toEqual({ status: "attached", from: 0, to: 4 });
		// A new command after restart forces private registration and validation;
		// the duplicate above alone would only prove the SQL receipt survived.
		expect((await transport.send(command(afterDeletion))).message_revision).toBe(1);
		await expect(transport.send(command({ ...afterDeletion, generation: randomUUID() })))
			.rejects.toMatchObject({ action: "reject", code: "anchor_generation_mismatch" });
		const block = wireTextAnchor(captureBlockAnchor(restored.text, fixture.note, context.generation, 2, 2));
		const blockCommand = command(block), blockReceipt = await transport.send(blockCommand);
		expect(await transport.send(blockCommand)).toEqual(blockReceipt);
		const blockThread = await transport.thread(fixture.note, blockReceipt.thread_id);
		expect(blockThread.anchor).toEqual(block);
		if (blockThread.anchor.type !== "text") throw new Error("Expected block range");
		expect(blockThread.anchor.structure).toEqual({ kind: "blocks", blocks: [{ kind: "paragraph" }] });
		expect(resolveTextAnchor(restored.text, fixture.note, context.generation, localTextAnchor(blockThread.anchor)))
			.toEqual({ status: "attached", from: 0, to: "beta gamma".length });
		// Reattach through the real private durability barrier, then lose the
		// successful response and recover from the durable client intent.
		expect((await transport.capabilities()).reattach).toBe(true);
		const store = await DiscussionStore.open({ ...transport.identity, vaultId: "reattach-real" }, new IDBFactory());
		try {
			let loseMove = true;
			const uncertain = new DiscussionTransport(transport.identity, async () => ({ accountId: fixture.bobId, accessToken: fixture.bobToken }), async (url, options) => {
				const response = await fetch(url, options);
				if (loseMove && response.ok && options.method === "POST") { loseMove = false; await response.text(); throw new Error("Lost move response"); }
				return response;
			});
			const moves = new DiscussionReattachment(store, uncertain);
			const gamma = wireTextAnchor(captureTextAnchor(restored.text, fixture.note, context.generation, 5, 10));
			const move = await moves.prepare(fixture.note, blockReceipt.thread_id, 1, gamma, () => true);
			await expect(moves.send(move, () => true)).rejects.toMatchObject({ code: "network_unavailable" });
			expect(await moves.pending(fixture.note, blockReceipt.thread_id)).toEqual(move);
			expect(await moves.recover(move, () => true)).toBe("accepted");
			const history = await transport.anchorHistory(fixture.note, blockReceipt.thread_id);
			expect(history.revisions.map(row => row.anchor)).toEqual([block, gamma]);
			expect(history.thread.anchor_revision).toBe(2); expect(history.revisions[1].actor_id).toBe(fixture.bobId);
			const state = await transport.state(fixture.note, blockReceipt.thread_id);
			expect(state.anchor).toEqual(gamma); expect(state.thread.state_revision).toBe(1);
			await expect(transport.sendOnline({ ...move, operationId: randomUUID() })).rejects.toMatchObject({ code: "stale_anchor_revision" });
			const abandoned = await moves.prepare(fixture.note, blockReceipt.thread_id, 2, { version: 1, type: "note" }, () => true);
			expect(await moves.recover(abandoned, () => true)).toBe("withdrawn");
			await expect(transport.sendOnline(abandoned)).rejects.toMatchObject({ code: "operation_withdrawn" });
			expect((await transport.anchorHistory(fixture.note, blockReceipt.thread_id)).revisions).toHaveLength(2);
			expect((await transport.changes(fixture.note)).events.some(event => event.kind === "thread.state" && event.data.thread_id === blockReceipt.thread_id)).toBe(true);
		} finally { store.close(); }
	} finally { for (const provider of providers) provider.destroy(); for (const doc of docs) doc.destroy(); }
}, 60000);
