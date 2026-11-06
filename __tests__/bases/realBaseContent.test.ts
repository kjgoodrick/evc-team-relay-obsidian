import { readFileSync } from "node:fs";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseSyncStore } from "../../src/bases/BaseSyncStore";
import { decideBaseSync, type BasePending } from "../../src/bases/BaseContentProtocol";
Object.assign(globalThis, { IDBKeyRange });
const fixturePath = process.env.EVC_BASE_CONTENT_FIXTURE;
const integration = fixturePath ? test : test.skip;
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

integration("real Bases HTTP preserves offline writes and resolves unknown delivery without duplicate or late publication", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as Record<string, string>;
	const url = new URL(fixture.base);
	if (url.hostname !== "127.0.0.1" || !url.port) throw new Error("Only a disposable loopback fixture is allowed");
	const identity = { serverId: fixture.base, accountId: fixture.owner, shareId: fixture.share, vaultId: "disposable" };
	const credential = async () => ({ accountId: fixture.owner, accessToken: fixture.ownerToken });
	const real = new BaseContentTransport(identity, credential, (url, init) => fetch(url, init));
	const factory = new IDBFactory(); let store = await BaseSyncStore.open(identity, factory);
	try {
		const claimed = await real.read(fixture.entry); expect(claimed.bytes).toBeNull();
		expect(await decideBaseSync(undefined, bytes("views: []\n"), claimed, true)).toBe("upload");
		const original = await store.stage(fixture.entry, 0, claimed.state, bytes("views: []\n"));
		store.close(); store = await BaseSyncStore.open(identity, factory);
		expect((await store.get(fixture.entry)).pending).toEqual(original);
		const losesResponse = new BaseContentTransport(identity, credential, async (url, init) => {
			const response = await fetch(url, init); expect(response.status).toBe(200);
			throw new Error("Synthetic response loss after server acceptance");
		});
		await expect(losesResponse.publish(fixture.entry, original)).rejects.toMatchObject({ action: "retry" });
		expect((await store.get(fixture.entry)).pending?.operationId).toBe(original.operationId);
		const delivered = await real.withdraw(fixture.entry, original);
		expect(delivered.status).toBe("accepted");
		await store.settle(fixture.entry, original.operationId, delivered);
		const baseline = (await store.get(fixture.entry)).baseline!;
		const local = await store.stage(fixture.entry, 2, baseline.state, bytes("views: []\n# local offline\n"));
		const remote: BasePending = { operationId: crypto.randomUUID(), expected: baseline.state, bytes: bytes("views: []\n# another editor\n") };
		await real.publish(fixture.entry, remote);
		await expect(real.publish(fixture.entry, local)).rejects.toMatchObject({ action: "conflict" });
		const withdrawn = await real.withdraw(fixture.entry, local);
		expect(withdrawn.status).toBe("withdrawn");
		await store.settle(fixture.entry, local.operationId, withdrawn);
		await expect(real.publish(fixture.entry, local)).rejects.toMatchObject({ code: "base_content_withdrawn" });
		const remoteSnapshot = await real.read(fixture.entry);
		expect(await decideBaseSync(baseline, local.bytes, remoteSnapshot)).toBe("diverged");
		await store.retainConflict(fixture.entry, 4, { reason: "diverged", local: local.bytes, remote: remoteSnapshot });
		store.close(); store = await BaseSyncStore.open(identity, factory);
		expect((await store.get(fixture.entry)).conflict?.local).toEqual(local.bytes);
		expect((await store.recoveries(fixture.entry))[0].record.pending?.operationId).toBe(local.operationId);
		const reviewer = new BaseContentTransport({ ...identity, accountId: fixture.reviewer }, async () => ({ accountId: fixture.reviewer, accessToken: fixture.reviewerToken }), (url, init) => fetch(url, init));
		expect(await reviewer.read(fixture.entry)).toEqual(remoteSnapshot);
		await expect(reviewer.publish(fixture.entry, { ...remote, operationId: crypto.randomUUID(), expected: remoteSnapshot.state })).rejects.toMatchObject({ code: "base_editor_required" });
	} finally { store.close(); }
}, 30_000);
