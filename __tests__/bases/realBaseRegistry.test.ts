import { readFileSync } from "node:fs";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseRegistryTransport } from "../../src/bases/BaseRegistryTransport";
import { BaseRegistryStore } from "../../src/bases/BaseRegistryStore";
import { BaseViewsController, type BaseViewsAccess } from "../../src/bases/BaseViewsController";
import { baseRegistryBinding, type BaseRegistrySnapshot, type BaseViewRepairIntent } from "../../src/bases/BaseRegistryProtocol";
import { baseRestoreBinding } from "../../src/bases/BaseContentProtocol";
import type { BaseSyncLock } from "../../src/bases/BaseSyncRunner";
Object.assign(globalThis, { IDBKeyRange });
const fixturePath = process.env.EVC_BASE_CONTENT_FIXTURE;
const integration = fixturePath ? test : test.skip;
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

integration("real saved-view HTTP preserves identities and pending repairs through ambiguity, restart and later edits", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as Record<string, string>;
	const url = new URL(fixture.base);
	if (url.hostname !== "127.0.0.1" || !url.port) throw new Error("Only a disposable loopback fixture is allowed");
	const entry = fixture.registryEntry, identity = { serverId: fixture.base, accountId: fixture.owner, shareId: fixture.share, vaultId: "registry" };
	const credential = async () => ({ accountId: fixture.owner, accessToken: fixture.ownerToken });
	const content = new BaseContentTransport(identity, credential, (url, init) => fetch(url, init));
	const registry = new BaseRegistryTransport(identity, credential, (url, init) => fetch(url, init));
	const lock: BaseSyncLock = async (_entry, action) => action();
	const factory = new IDBFactory(); let store = await BaseRegistryStore.open(identity, factory);
	let source = { path: "Registry.base", sha256: "", generation: "" };
	const access: BaseViewsAccess = { read: async () => source, current: value => value === source, writable: () => true };
	const publish = async (names: string[], orders = names.map(() => ["file.name"])) => {
		const before = await content.read(entry);
		await content.publish(entry, { operationId: crypto.randomUUID(), expected: before.state, ...baseRestoreBinding(before),
			bytes: bytes(JSON.stringify({ views: names.map((name, slot) => ({ name, type: "table", order: orders[slot] })) })) });
		const after = await content.read(entry);
		source = { path: after.state.path, sha256: after.state.record.hash!, generation: after.state.generation! };
	};
	const intent = (snapshot: BaseRegistrySnapshot, ids: (string | null)[]): BaseViewRepairIntent => ({ definitionId: snapshot.definition_id, generation: snapshot.generation, ...baseRegistryBinding(snapshot),
		request: { operation_id: crypto.randomUUID(), expected_revision: snapshot.revision, content_sha256: snapshot.content_sha256,
			bindings: ids.map((view_id, slot) => ({ slot, view_id })), archive: [] } });
	try {
		await publish(["First", "Second"], [["file.name"], ["file.size"]]);
		let controller = new BaseViewsController(store, registry, lock);
		const first = (await controller.refresh(entry, access))!.snapshot!, ids = first.views.map(view => view.id!);
		expect(new Set(ids).size).toBe(2);
		if (fixture.restoreGeneration) {
			expect(first.restore_generation).toBe(fixture.restoreGeneration);
			const legacy = { ...first }; delete legacy.restore_guard; delete legacy.restore_generation;
			const oldStore = await BaseRegistryStore.open({ ...identity, vaultId: "pre-restore" }, factory);
			try {
				await oldStore.cache(entry, legacy); const oldIntent = intent(legacy, ids);
				await oldStore.stage(entry, 1, oldIntent);
				const old = new BaseViewsController(oldStore, registry, lock);
				await expect(old.checkDelivery(entry, access)).rejects.toMatchObject({ code: "restore_generation_changed" });
				await expect(registry.reconcile(entry, oldIntent)).rejects.toMatchObject({ code: "restore_generation_changed" });
				const before = await oldStore.exportRecord(entry);
				expect(await old.checkStatus(entry, () => true)).toEqual({ status: "unknown", operation_id: oldIntent.request.operation_id, entry_id: entry });
				expect(await oldStore.exportRecord(entry)).toEqual(before); expect(before.recoveries[0].snapshot).toEqual(legacy);
				expect(await registry.inspect(entry, source.sha256, source.generation)).toEqual(first);
			} finally { oldStore.close(); }
		}
		await publish(["Second", "First renamed"], [["file.size"], ["file.name"]]);
		const renamed = (await controller.refresh(entry, access))!.snapshot!;
		expect(renamed.views.map(view => view.id)).toEqual([ids[1], ids[0]]);
		// Matching names preserve identity through a layout edit. Renaming both
		// identical configurations afterwards must require an explicit association.
		await publish(["Second", "First renamed"]); await controller.refresh(entry, access);
		await publish(["Left", "Right"]);
		const ambiguous = (await controller.refresh(entry, access))!.snapshot!;
		expect(ambiguous.views.map(view => view.id)).toEqual([null, null]);
		expect(new Set(ambiguous.unmatched.views.map(view => view.id))).toEqual(new Set(ids));
		const reviewer = new BaseRegistryTransport({ ...identity, accountId: fixture.reviewer }, async () => ({ accountId: fixture.reviewer, accessToken: fixture.reviewerToken }), (url, init) => fetch(url, init));
		expect(await reviewer.inspect(entry, source.sha256, source.generation)).toEqual(ambiguous);
		await expect(reviewer.reconcile(entry, intent(ambiguous, ids))).rejects.toMatchObject({ code: "base_editor_required" });
		const beforeRepair = await content.read(entry);
		let repairStatus = 0;
		const lossy = new BaseRegistryTransport(identity, credential, async (url, init) => {
			const response = await fetch(url, init);
			if (url.endsWith("/reconcile")) { repairStatus = response.status; throw new Error("Synthetic response loss after acceptance"); }
			return response;
		});
		controller = new BaseViewsController(store, lossy, lock);
		await expect(controller.repair(entry, access, ambiguous, intent(ambiguous, ids).request.bindings, [])).rejects.toMatchObject({ action: "retry" });
		expect(repairStatus).toBe(200);
		const pending = (await store.get(entry)).pending!;
		const accepted = await registry.inspect(entry, source.sha256, source.generation);
		expect(accepted.views.map(view => view.id)).toEqual(ids);
		const saved = await store.exportRecord(entry);
		expect(await controller.checkStatus(entry, () => true)).toEqual({ status: "accepted", result: accepted });
		expect(await store.exportRecord(entry)).toEqual(saved);
		const newer = await registry.reconcile(entry, intent(accepted, [...ids].reverse()));
		await controller.refresh(entry, access); // Refresh must not resend the saved repair.
		expect((await store.get(entry)).pending?.request.operation_id).toBe(pending.request.operation_id);
		store.close(); store = await BaseRegistryStore.open(identity, factory); controller = new BaseViewsController(store, registry, lock);
		const recovered = (await controller.checkDelivery(entry, access))!;
		expect(recovered.pending).toBeUndefined(); expect(recovered.snapshot).toEqual(newer);
		expect((await store.history(entry))[0]).toMatchObject({ status: "accepted", observedRevision: accepted.revision, bindings: pending.request.bindings });
		expect(await registry.reconcile(entry, pending)).toEqual(accepted);
		expect(await content.read(entry)).toEqual(beforeRepair); // Association repair never rewrites the .base file.
		const stale = intent(newer, ids); await store.stage(entry, recovered.revision, stale);
		const replacement = intent(newer, [null, ids[0]]); replacement.request.archive = [ids[1]];
		const latest = await registry.reconcile(entry, replacement);
		await controller.checkDelivery(entry, access);
		expect((await store.get(entry)).snapshot).toEqual(latest); expect((await store.get(entry)).pending).toBeUndefined();
		expect((await store.history(entry)).some(item => item.id === stale.request.operation_id && item.status === "superseded")).toBe(true);
		await publish(["Left"]);
		const single = (await controller.refresh(entry, access))!.snapshot!;
		const archived = (await controller.page(entry, access, single, "archived"))!;
		expect(archived.views.some(view => view.id === ids[0])).toBe(true);
		const exported = await store.exportRecord(entry);
		expect(exported.history).toHaveLength(2); expect(exported.record.snapshot).toEqual(single);
	} finally { store.close(); }
}, 30_000);
