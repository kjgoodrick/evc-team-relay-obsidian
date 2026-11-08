import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { sha256Hex } from "../../src/contentDigest";
import type { BaseAccepted, BasePending, BaseSnapshot } from "../../src/bases/BaseContentProtocol";
import { BaseContentFailure } from "../../src/bases/BaseContentTransport";
import { BaseSyncStore } from "../../src/bases/BaseSyncStore";
import { BaseSyncRunner, sameBaseBytes, type BaseSyncAccess, type BaseSyncLock } from "../../src/bases/BaseSyncRunner";
import { NativeBaseFile, baseText, nativeBaseLock } from "../../src/bases/NativeBaseFile";
import { TFile, type Vault } from "obsidian";
Object.assign(globalThis, { IDBKeyRange });

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.example", accountId: id(1), shareId: id(2), vaultId: "vault" };
const entryId = id(3), path = "Planning.base";
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = (value: ArrayBuffer | null | undefined) => value == null ? value : new TextDecoder().decode(value);
async function snapshot(value: string | null, version = 1): Promise<BaseSnapshot> {
	const data = value === null ? null : bytes(value);
	return { bytes: data, state: { path, generation: data === null ? null : id(9), content_version: data === null ? null : id(100 + version),
		record: { id: entryId, version: 0, type: "file", ...(data === null ? {} : { hash: await sha256Hex(data), mimetype: "application/yaml", synctime: version }) } } };
}
function exclusiveLock(): BaseSyncLock {
	let held = false;
	return async (_id, action) => { if (held) return undefined; held = true; try { return await action(); } finally { held = false; } };
}
async function setup(localText = "base", remoteText: string | null = "base") {
	const factory = new IDBFactory(), store = await BaseSyncStore.open(identity, factory);
	let remote = await snapshot(remoteText), local = bytes(localText), current = true, writable = true, version = 2;
	const fileIdentity = {}, receipts = new Map<string, BaseAccepted>();
	const transport = {
		read: jest.fn(async () => remote),
		publish: jest.fn(async (_entryId: string, pending: BasePending) => {
			const receipt = receipts.get(pending.operationId); if (receipt) return receipt;
			if (JSON.stringify(pending.expected) !== JSON.stringify(remote.state)) throw new BaseContentFailure("conflict", "base_content_conflict");
			remote = await snapshot(text(pending.bytes)!, version++);
			const accepted = { operation_id: pending.operationId, state: remote.state }; receipts.set(pending.operationId, accepted); return accepted;
		}),
		withdraw: jest.fn(async (_entryId: string, pending: BasePending) => receipts.has(pending.operationId)
			? { status: "accepted" as const, result: receipts.get(pending.operationId)! }
			: { status: "withdrawn" as const, operation_id: pending.operationId, entry_id: entryId }),
	};
	const access: BaseSyncAccess = {
		path, current: () => current, writable: () => writable, canInitialize: false,
		read: jest.fn(async () => ({ bytes: local, identity: fileIdentity })),
		replace: jest.fn(async (before, data) => { if (!sameBaseBytes(before.bytes, local)) return false; local = data; return true; }),
	};
	const runner = new BaseSyncRunner(store, transport, exclusiveLock());
	return { store, factory, transport, access, runner, receipts, local: () => text(local), remote: () => remote,
		setLocal: (value: string) => { local = bytes(value); }, setRemote: async (value: string) => { remote = await snapshot(value, version++); },
		setCurrent: (value: boolean) => { current = value; }, setWritable: (value: boolean) => { writable = value; } };
}

test("adoption does not rewrite unchanged baselines on each inventory poll", async () => {
	const s = await setup(); try {
		expect(await s.runner.sync(entryId, s.access)).toBe("synced"); const first = await s.store.get(entryId);
		await s.runner.sync(entryId, s.access); expect((await s.store.get(entryId)).revision).toBe(first.revision);
		expect(s.transport.publish).not.toHaveBeenCalled(); expect(s.access.replace).not.toHaveBeenCalled();
	} finally { s.store.close(); }
});

test("pending bytes commit before HTTP; a newer local edit is not replaced by the acceptance", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); s.setLocal("one");
		const publish = s.transport.publish.getMockImplementation()!;
		s.transport.publish.mockImplementationOnce(async (entry, pending) => {
			expect(text((await s.store.get(entry)).pending?.bytes)).toBe("one"); s.setLocal("two"); return publish(entry, pending);
		});
		await s.runner.sync(entryId, s.access); expect(s.local()).toBe("two"); expect(text((await s.store.get(entryId)).baseline?.bytes)).toBe("one");
		await s.runner.sync(entryId, s.access); expect(text(s.remote().bytes)).toBe("two");
	} finally { s.store.close(); }
});

test("a lost accepted response survives restart and retries the exact operation", async () => {
	const s = await setup(); let reopened: BaseSyncStore | undefined;
	try {
		await s.runner.sync(entryId, s.access); s.setLocal("offline edit"); const publish = s.transport.publish.getMockImplementation()!;
		s.transport.publish.mockImplementationOnce(async (entry, pending) => { await publish(entry, pending); throw new BaseContentFailure("retry", "network_unavailable"); });
		await expect(s.runner.sync(entryId, s.access)).rejects.toThrow("network_unavailable");
		const pending = (await s.store.get(entryId)).pending!; s.store.close(); reopened = await BaseSyncStore.open(identity, s.factory);
		await new BaseSyncRunner(reopened, s.transport, exclusiveLock()).sync(entryId, s.access);
		expect(s.transport.publish.mock.calls[1][1].operationId).toBe(pending.operationId); expect(s.receipts.size).toBe(1);
		expect((await reopened.get(entryId)).pending).toBeUndefined();
	} finally { s.store.close(); reopened?.close(); }
});

test("a download intent is committed before the native write; a concurrent edit becomes a retained conflict", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); await s.setRemote("remote");
		s.access.replace = jest.fn(async () => { expect(text((await s.store.get(entryId)).download?.before)).toBe("base"); s.setLocal("new edit"); return false; });
		expect(await s.runner.sync(entryId, s.access)).toBe("conflict"); expect(s.local()).toBe("new edit");
		const record = await s.store.get(entryId); expect(text(record.conflict?.local)).toBe("new edit"); expect(text(record.conflict?.remote.bytes)).toBe("remote");
		expect((await s.store.recoveries(entryId))[0].record.download).toBeDefined();
	} finally { s.store.close(); }
});

test("restart after a native write acknowledges its saved intent without writing twice", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); await s.setRemote("remote");
		await s.store.prepareDownload(entryId, (await s.store.get(entryId)).revision, bytes("base"), s.remote()); s.setLocal("remote");
		expect(await s.runner.sync(entryId, s.access)).toBe("synced"); expect(s.access.replace).not.toHaveBeenCalled();
		expect(text((await s.store.get(entryId)).baseline?.bytes)).toBe("remote"); expect((await s.store.get(entryId)).download).toBeUndefined();
	} finally { s.store.close(); }
});

test("download recovery preserves an intervening remote version rather than writing the old intent", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); await s.setRemote("old remote");
		await s.store.prepareDownload(entryId, (await s.store.get(entryId)).revision, bytes("base"), s.remote()); await s.setRemote("new remote");
		expect(await s.runner.sync(entryId, s.access)).toBe("conflict"); expect(s.local()).toBe("base"); expect(s.access.replace).not.toHaveBeenCalled();
	} finally { s.store.close(); }
});

test("concurrent saves fence the pending request and preserve both editable copies", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); s.setLocal("local");
		const publish = s.transport.publish.getMockImplementation()!;
		s.transport.publish.mockImplementationOnce(async (entry, pending) => { await s.setRemote("competitor"); return publish(entry, pending); });
		expect(await s.runner.sync(entryId, s.access)).toBe("conflict");
		const record = await s.store.get(entryId); expect(record.pending).toBeUndefined(); expect(text(record.conflict?.remote.bytes)).toBe("competitor");
		expect(text((await s.store.recoveries(entryId))[0].record.pending?.bytes)).toBe("local");
	} finally { s.store.close(); }
});

test("withdrawal acceptance wins over a simultaneous conflicting send", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); s.setLocal("local"); const publish = s.transport.publish.getMockImplementation()!;
		s.transport.publish.mockImplementationOnce(async (entry, pending) => { await publish(entry, pending); throw new BaseContentFailure("conflict", "base_content_conflict"); });
		expect(await s.runner.sync(entryId, s.access)).toBe("synced"); expect((await s.store.get(entryId)).conflict).toBeUndefined();
		expect(text((await s.store.get(entryId)).baseline?.bytes)).toBe("local");
	} finally { s.store.close(); }
});

test("explicit withdrawal requires review and cannot silently enqueue the withdrawn edit again", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); s.setLocal("withdrawn");
		await s.store.stage(entryId, (await s.store.get(entryId)).revision, s.remote().state, bytes("withdrawn"));
		await s.runner.withdraw(entryId, s.access); expect((await s.store.get(entryId)).reviewRequired).toBe("withdrawn");
		await expect(s.store.stage(entryId, (await s.store.get(entryId)).revision, s.remote().state, bytes("replacement"))).rejects.toThrow("Review");
		expect(await s.runner.sync(entryId, s.access)).toBe("conflict"); expect(s.transport.publish).not.toHaveBeenCalled();
	} finally { s.store.close(); }
});

test.each(["local", "server"] as const)("review chooses %s atomically while retaining the original conflict", async choice => {
	const s = await setup("local", "server"); try {
		expect(await s.runner.sync(entryId, s.access)).toBe("conflict"); const reviewed = (await s.runner.review(entryId, s.access))!;
		expect(await s.runner.resolve(entryId, s.access, reviewed, choice)).toBe("synced");
		expect(s.local()).toBe(choice); expect(text(s.remote().bytes)).toBe(choice);
		expect((await s.store.recoveries(entryId))[0].record.conflict).toBeDefined();
		await expect(s.runner.resolve(entryId, s.access, reviewed, choice)).rejects.toThrow();
	} finally { s.store.close(); }
});

test.each(["local", "remote"])("review is rejected if the %s copy changed after display", async changed => {
	const s = await setup("local", "server"); try {
		await s.runner.sync(entryId, s.access); const reviewed = (await s.runner.review(entryId, s.access))!;
		if (changed === "local") s.setLocal("later"); else await s.setRemote("later");
		await expect(s.runner.resolve(entryId, s.access, reviewed, "server")).rejects.toThrow("base_review_changed");
		expect((await s.store.get(entryId)).conflict).toBeDefined(); expect(s.access.replace).not.toHaveBeenCalled();
	} finally { s.store.close(); }
});

test("server resolution archives newer reviewed local edits as well as the original conflict", async () => {
	const s = await setup("initial local", "server"); try {
		await s.runner.sync(entryId, s.access); s.setLocal("later local");
		const reviewed = (await s.runner.review(entryId, s.access))!;
		await s.runner.resolve(entryId, s.access, reviewed, "server");
		const saved = (await s.store.recoveries(entryId)).map(item => text(item.record.conflict?.local));
		expect(saved).toEqual(expect.arrayContaining(["initial local", "later local"])); expect(s.local()).toBe("server");
	} finally { s.store.close(); }
});

test("resolution quota failure retains both the conflict and disk contents", async () => {
	const store = await BaseSyncStore.open(identity, new IDBFactory(), 12), remote = await snapshot("server");
	try {
		await store.retainConflict(entryId, 0, { reason: "diverged", local: bytes("local"), remote });
		await expect(store.resolveConflict(entryId, 1, "server", bytes("local"), remote)).rejects.toThrow("quota");
		const record = await store.get(entryId); expect(record.conflict).toBeDefined(); expect(record.download).toBeUndefined(); expect(record.pending).toBeUndefined();
		expect(await store.recoveries(entryId)).toEqual([]);
	} finally { store.close(); }
});

test("account loss after remote acceptance retains the exact pending request for later receipt recovery", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); s.setLocal("local"); const publish = s.transport.publish.getMockImplementation()!;
		s.transport.publish.mockImplementationOnce(async (entry, pending) => { const result = await publish(entry, pending); s.setCurrent(false); return result; });
		await expect(s.runner.sync(entryId, s.access)).rejects.toThrow("base_context_changed");
		expect((await s.store.get(entryId)).pending).toBeDefined(); s.setCurrent(true);
		await s.runner.sync(entryId, s.access); expect(s.receipts.size).toBe(1); expect((await s.store.get(entryId)).pending).toBeUndefined();
	} finally { s.store.close(); }
});

test("read-only local edits are retained; the reviewer can explicitly restore the server copy", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); s.setLocal("local"); s.setWritable(false);
		expect(await s.runner.sync(entryId, s.access)).toBe("conflict"); const review = (await s.runner.review(entryId, s.access))!;
		await expect(s.runner.resolve(entryId, s.access, review, "local")).rejects.toThrow("base_editor_required");
		expect(await s.runner.resolve(entryId, s.access, review, "server")).toBe("synced"); expect(s.local()).toBe("base");
		expect(s.transport.publish).not.toHaveBeenCalled();
	} finally { s.store.close(); }
});

test("account or path changes during remote read cannot stage or write local data", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); await s.setRemote("remote");
		s.transport.read.mockImplementationOnce(async () => { s.setCurrent(false); return s.remote(); });
		await expect(s.runner.sync(entryId, s.access)).rejects.toThrow("base_context_changed");
		expect((await s.store.get(entryId)).download).toBeUndefined(); expect(s.access.replace).not.toHaveBeenCalled();
		s.setCurrent(true); const moved = s.remote(); moved.state.path = "Elsewhere.base";
		await expect(s.runner.sync(entryId, s.access)).rejects.toThrow("base_context_changed");
	} finally { s.store.close(); }
});

test("concurrent runners share the lock before any network or disk work", async () => {
	const s = await setup(), lock = exclusiveLock(); let release!: () => void;
	try {
		const first = new BaseSyncRunner(s.store, s.transport, lock), second = new BaseSyncRunner(s.store, s.transport, lock);
		s.transport.read.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return s.remote(); });
		const active = first.sync(entryId, s.access);
		while (!release) await new Promise(resolve => setTimeout(resolve, 1));
		expect(await second.sync(entryId, s.access)).toBe("busy"); release(); await active;
		expect(s.transport.read).toHaveBeenCalledTimes(1);
	} finally { release?.(); s.store.close(); }
});

function nativeFixture(value: string) {
	let data = value, current = true; const file = Object.assign(Object.create(TFile.prototype) as TFile, { path, stat: { size: bytes(value).byteLength } });
	let found: TFile | null = file, beforeProcess = () => {};
	const vault = {
		getAbstractFileByPath: jest.fn(() => found), readBinary: jest.fn(async () => bytes(data)),
		process: jest.fn(async (_file: TFile, action: (value: string) => string) => { beforeProcess(); data = action(data); return data; }),
		create: jest.fn(async (_path: string, value: string) => { if (found) throw new Error("exists"); data = value; found = file; return file; }),
	};
	return { adapter: new NativeBaseFile(vault as unknown as Vault, path, () => current), vault, file,
		data: () => data, edit: (value: string) => { data = value; }, setCurrent: (value: boolean) => { current = value; },
		setFile: (value: TFile | null) => { found = value; }, before: (fn: () => void) => { beforeProcess = fn; } };
}

test("native replacement checks bytes at the process callback, not at the earlier read", async () => {
	const s = nativeFixture("original"), before = await s.adapter.read(); s.before(() => s.edit("concurrent"));
	await expect(s.adapter.replace(before, bytes("remote"))).resolves.toBe(false); expect(s.data()).toBe("concurrent");
});

test.each(["account", "rename", "replacement"])("native replacement rechecks %s identity at the write boundary", async change => {
	const s = nativeFixture("original"), before = await s.adapter.read();
	s.before(() => { if (change === "account") s.setCurrent(false); else if (change === "rename") s.file.path = "Moved.base"; else s.setFile(Object.create(TFile.prototype) as TFile); });
	if (change === "account") await expect(s.adapter.replace(before, bytes("remote"))).rejects.toThrow("base_context_changed");
	else await expect(s.adapter.replace(before, bytes("remote"))).resolves.toBe(false);
	expect(s.data()).toBe("original");
});

test("native writes preserve BOM, Unicode and CRLF; malformed UTF-8 never becomes replacement text", async () => {
	const original = "\uFEFFviews:\r\n  - name: Café 📆\r\n", next = original + "    type: table\r\n", s = nativeFixture(original);
	expect(baseText(bytes(original))).toBe(original);
	await expect(s.adapter.replace(await s.adapter.read(), bytes(next))).resolves.toBe(true); expect(s.data()).toBe(next);
	expect(() => baseText(new Uint8Array([0xc3, 0x28]).buffer)).toThrow("base_invalid_utf8");
});

test("native creation refuses to overwrite a file that appeared after the missing-file read", async () => {
	const s = nativeFixture("new file"); s.setFile(null); const before = await s.adapter.read(); s.setFile(s.file);
	await expect(s.adapter.replace(before, bytes("remote"))).resolves.toBe(false); expect(s.vault.create).not.toHaveBeenCalled();
	s.setFile(null); await expect(s.adapter.replace(before, bytes("remote"))).resolves.toBe(true); expect(s.data()).toBe("remote");
});

test.each(["deleted", "renamed", "replaced", "account"])("native creation does not acknowledge a %s result", async change => {
	const s = nativeFixture("new file"); s.setFile(null); const before = await s.adapter.read();
	s.vault.create.mockImplementationOnce(async () => {
		s.setFile(s.file);
		if (change === "deleted") s.setFile(null);
		if (change === "renamed") { s.file.path = "Moved.base"; s.setFile(null); }
		if (change === "replaced") s.setFile(Object.assign(Object.create(TFile.prototype) as TFile, { path }));
		if (change === "account") s.setCurrent(false);
		return s.file;
	});
	if (change === "account") await expect(s.adapter.replace(before, bytes("remote"))).rejects.toThrow("base_context_changed");
	else await expect(s.adapter.replace(before, bytes("remote"))).resolves.toBe(false);
	expect(s.vault.create).toHaveBeenCalledTimes(1);
});

test("Web Locks use the same disk scope for different accounts, and unsupported hosts retain work", async () => {
	const names: string[] = [], locks = { request: jest.fn(async (name: string, _options: unknown, action: (lock: object) => Promise<unknown>) => { names.push(name); return action({}); }) };
	await nativeBaseLock(identity, locks as unknown as LockManager)(entryId, async () => "one");
	await nativeBaseLock({ ...identity, accountId: id(20) }, locks as unknown as LockManager)(entryId, async () => "two");
	expect(names[0]).toBe(names[1]);
	await expect(nativeBaseLock(identity, null)(entryId, async () => "never")).rejects.toThrow("base_lock_unavailable");
});

test.each(["accepted", "withdrawn", "unknown"] as const)("read-only %s receipt review preserves pending bytes without local or server mutation", async status => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access);
		const pending = await s.store.stage(entryId, (await s.store.get(entryId)).revision, s.remote().state, bytes("pending"));
		const accepted = { operation_id: pending.operationId, state: (await snapshot("pending", 2)).state };
		const check = jest.fn(async () => status === "accepted" ? { status, result: accepted } : { status, operation_id: pending.operationId, entry_id: entryId });
		const runner = new BaseSyncRunner(s.store, { ...s.transport, status: check }, exclusiveLock());
		const before = await s.store.get(entryId); s.setWritable(false);
		expect((await runner.checkStatus(entryId, s.access)).status).toBe(status);
		expect(await s.store.get(entryId)).toEqual(before); expect(await s.store.recoveries(entryId)).toEqual([]);
		expect(s.transport.publish).not.toHaveBeenCalled(); expect(s.transport.withdraw).not.toHaveBeenCalled(); expect(s.access.replace).not.toHaveBeenCalled();
	} finally { s.store.close(); }
});

test.each(["account", "record"])("receipt review refuses a late response after %s changed", async change => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access);
		const pending = await s.store.stage(entryId, (await s.store.get(entryId)).revision, s.remote().state, bytes("pending"));
		const runner = new BaseSyncRunner(s.store, { ...s.transport, status: async () => {
			if (change === "account") s.setCurrent(false);
			else await s.store.retainRetirement(entryId, (await s.store.get(entryId)).revision, path, bytes("pending"));
			return { status: "unknown", operation_id: pending.operationId, entry_id: entryId };
		} }, exclusiveLock());
		await expect(runner.checkStatus(entryId, s.access)).rejects.toThrow(change === "account" ? "base_context_changed" : "base_review_changed");
		expect((await s.store.get(entryId)).pending).toEqual(pending);
	} finally { s.store.close(); }
});

test("local edits based on a pre-restore baseline require explicit review before new-generation publication", async () => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); s.setLocal("old local edit");
		const context = { supported: true, generation: id(60) }; s.remote().restoreContext = context;
		expect(await s.runner.sync(entryId, s.access)).toBe("conflict");
		expect((await s.store.get(entryId)).conflict?.reason).toBe("restore-changed"); expect(s.transport.publish).not.toHaveBeenCalled();
		const publish = s.transport.publish.getMockImplementation()!;
		s.transport.publish.mockImplementation(async (entry, pending) => { const result = await publish(entry, pending); s.remote().restoreContext = context; return result; });
		const review = (await s.runner.review(entryId, s.access))!;
		expect(await s.runner.resolve(entryId, s.access, review, "local")).toBe("synced");
		expect(s.transport.publish.mock.calls[0][1].restoreGeneration).toBe(context.generation);
		expect((await s.store.get(entryId)).baseline?.restoreContext).toEqual(context);
		expect((await s.store.recoveries(entryId)).some(copy => text(copy.record.conflict?.local) === "old local edit")).toBe(true);
	} finally { s.store.close(); }
});

test("an old pending publication stays intact across restore and reopening and cannot be withdrawn or replayed", async () => {
	const s = await setup(); let reopened: BaseSyncStore | undefined;
	try {
		await s.runner.sync(entryId, s.access);
		const pending = await s.store.stage(entryId, (await s.store.get(entryId)).revision, s.remote().state, bytes("old queued work"));
		s.remote().restoreContext = { supported: true, generation: id(60) };
		await expect(s.runner.sync(entryId, s.access)).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect((await s.store.get(entryId)).pending).toEqual(pending);
		await expect(s.runner.withdraw(entryId, s.access)).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect(s.transport.publish).not.toHaveBeenCalled(); expect(s.transport.withdraw).not.toHaveBeenCalled();
		s.store.close(); reopened = await BaseSyncStore.open(identity, s.factory);
		expect((await reopened.get(entryId)).pending).toEqual(pending);
		await expect(new BaseSyncRunner(reopened, s.transport, exclusiveLock()).sync(entryId, s.access)).rejects.toMatchObject({ code: "restore_generation_changed" });
	} finally { s.store.close(); reopened?.close(); }
});

test("new restored work retains its original generation through lost acceptance and restart", async () => {
	const s = await setup(); let reopened: BaseSyncStore | undefined;
	try {
		const context = { supported: true, generation: id(60) }; s.remote().restoreContext = context;
		await s.runner.sync(entryId, s.access); s.setLocal("new restored edit");
		const publish = s.transport.publish.getMockImplementation()!; let lose = true;
		s.transport.publish.mockImplementation(async (entry, pending) => {
			const result = await publish(entry, pending); s.remote().restoreContext = context;
			if (lose) { lose = false; throw new BaseContentFailure("retry", "network_unavailable"); } return result;
		});
		await expect(s.runner.sync(entryId, s.access)).rejects.toThrow("network_unavailable");
		const pending = (await s.store.get(entryId)).pending!; expect(pending.restoreGeneration).toBe(context.generation);
		s.store.close(); reopened = await BaseSyncStore.open(identity, s.factory);
		expect(await new BaseSyncRunner(reopened, s.transport, exclusiveLock()).sync(entryId, s.access)).toBe("synced");
		expect(s.transport.publish.mock.calls[1][1]).toEqual(pending); expect(s.receipts.size).toBe(1);
		expect((await reopened.get(entryId)).baseline?.restoreContext).toEqual(context);
	} finally { s.store.close(); reopened?.close(); }
});

test("a later local restore observation fences a late acceptance without discarding pending bytes", async () => {
	const s = await setup(); try {
		s.remote().restoreContext = { supported: true, generation: id(60) };
		await s.runner.sync(entryId, s.access); s.setLocal("late edit");
		const publish = s.transport.publish.getMockImplementation()!;
		s.transport.publish.mockImplementation(async (entry, pending) => {
			const result = await publish(entry, pending);
			await s.store.observeRestoreContext(entry, (await s.store.get(entry)).revision, { supported: true, generation: id(61) }, () => true);
			return result;
		});
		await expect(s.runner.sync(entryId, s.access)).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect((await s.store.get(entryId)).pending).toMatchObject({ restoreGeneration: id(60) });
		expect(text((await s.store.get(entryId)).baseline?.bytes)).toBe("base");
	} finally { s.store.close(); }
});

test.each([false, true])("restore makes a prepared download reviewable even if its old bytes already reached disk (%s)", async alreadyWritten => {
	const s = await setup(); try {
		await s.runner.sync(entryId, s.access); await s.setRemote("downloaded copy");
		await s.store.prepareDownload(entryId, (await s.store.get(entryId)).revision, bytes("base"), s.remote());
		if (alreadyWritten) s.setLocal("downloaded copy");
		s.remote().restoreContext = { supported: true, generation: id(60) };
		expect(await s.runner.sync(entryId, s.access)).toBe("conflict");
		const record = await s.store.get(entryId); expect(record.download).toBeUndefined(); expect(record.conflict?.reason).toBe("restore-changed");
		expect((await s.store.recoveries(entryId))[0].record.download).toBeDefined(); expect(s.access.replace).not.toHaveBeenCalled();
		const review = (await s.runner.review(entryId, s.access))!;
		expect(await s.runner.resolve(entryId, s.access, review, "server")).toBe("synced");
		expect((await s.store.get(entryId)).baseline?.restoreContext?.generation).toBe(id(60));
	} finally { s.store.close(); }
});
