import { readFileSync } from "node:fs";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseSyncStore } from "../../src/bases/BaseSyncStore";
import { decideBaseSync, type BasePending } from "../../src/bases/BaseContentProtocol";
import { BaseSyncRunner, sameBaseBytes, type BaseSyncAccess } from "../../src/bases/BaseSyncRunner";
import { nativeBaseLock } from "../../src/bases/NativeBaseFile";
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
		const savedRequest = await store.get(fixture.entry);
		const receipt = await real.status(fixture.entry, original); expect(receipt.status).toBe("accepted");
		expect(await store.get(fixture.entry)).toEqual(savedRequest);
		const beforeCheck = await real.read(fixture.entry);
		expect((await real.status(fixture.entry, { ...original, operationId: crypto.randomUUID() })).status).toBe("unknown");
		expect(await real.read(fixture.entry)).toEqual(beforeCheck);
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
		expect(await real.status(fixture.entry, local)).toEqual(withdrawn);
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
		expect((await reviewer.status(fixture.entry, original)).status).toBe("unknown");
		await expect(reviewer.publish(fixture.entry, { ...remote, operationId: crypto.randomUUID(), expected: remoteSnapshot.state })).rejects.toMatchObject({ code: "base_editor_required" });

		// Drive the actual worker through review, another lost response/restart,
		// and a server-side race. The disk port here is intentionally in-memory;
		// this fixture proves the HTTP/store orchestration, not Obsidian's API.
		let disk = local.bytes; const fileIdentity = {}, lock = nativeBaseLock(identity, navigator.locks);
		const access: BaseSyncAccess = { path: remoteSnapshot.state.path, current: () => true, writable: () => true, canInitialize: false,
			read: async () => ({ bytes: disk, identity: fileIdentity }),
			replace: async (before, next) => { if (!sameBaseBytes(before.bytes, disk)) return false; disk = next; return true; } };
		let runner = new BaseSyncRunner(store, real, lock);
		const review = (await runner.review(fixture.entry, access))!;
		expect(await runner.resolve(fixture.entry, access, review, "local")).toBe("synced"); expect((await real.read(fixture.entry)).bytes).toEqual(disk);
		disk = bytes("views: []\n# worker offline edit\n");
		const losingRunner = new BaseSyncRunner(store, { read: real.read.bind(real), publish: losesResponse.publish.bind(losesResponse), withdraw: real.withdraw.bind(real) }, lock);
		await expect(losingRunner.sync(fixture.entry, access)).rejects.toMatchObject({ action: "retry" });
		const acceptedVersion = (await real.read(fixture.entry)).state.content_version;
		store.close(); store = await BaseSyncStore.open(identity, factory); runner = new BaseSyncRunner(store, real, lock);
		expect(await runner.sync(fixture.entry, access)).toBe("synced"); expect((await real.read(fixture.entry)).state.content_version).toBe(acceptedVersion);
		disk = bytes("views: []\n# conflicting worker edit\n");
		const racingRunner = new BaseSyncRunner(store, { read: real.read.bind(real), withdraw: real.withdraw.bind(real), publish: async (entry, pending) => {
			await real.publish(entry, { ...pending, operationId: crypto.randomUUID(), bytes: bytes("views: []\n# racing editor\n") });
			return real.publish(entry, pending);
		} }, lock);
		expect(await racingRunner.sync(fixture.entry, access)).toBe("conflict");
		expect(new TextDecoder().decode(disk)).toContain("conflicting worker edit");
		expect(await runner.resolve(fixture.entry, access, (await runner.review(fixture.entry, access))!, "server")).toBe("synced");
		expect(new TextDecoder().decode(disk)).toContain("racing editor");
		expect((await store.recoveries(fixture.entry)).some(copy => copy.record.conflict?.reason === "reviewed-copies")).toBe(true);
	} finally { store.close(); }
}, 30_000);
