import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type Draft } from "../../src/collaboration/storage/DiscussionStore";
import { copySavedDraft, reviewSavedDraftCopy } from "../../src/collaboration/SavedDraftCopy";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { pictureIds, prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "copy" }, scope = id(3), destination = id(4);
const target = { version: 1, type: "note" }, destinationId = "selection:" + destination + ":" + id(5);
async function fixture() {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	const body = { ...editableCommentDraft({ version: 1, blocks: [...bodyFromText("Recovered discussion").blocks,
		{ type: "picture", picture_id: id(20), alt: "Local" }, { type: "picture", picture_id: id(21), alt: "Server only" }] }, () => "Member"), editBaseRevision: 8 };
	const source: Draft = { id: "imported:" + id(6), scopeId: scope, revision: 3, body: protocolJson(body), target };
	await store.saveDraft(source, null, [await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer)]);
	const review = await reviewSavedDraftCopy(store, source.id, destination, target, undefined, () => true);
	return { store, source, review, close: () => store.close() };
}

test("copies rich work to a new target with fresh pictures, keeps source and requires explicit omission of unavailable cross-scope originals", async () => {
	const f = await fixture();
	try {
		expect(f.review.originals).toHaveLength(1); expect(f.review.missingOriginals).toEqual([id(21)]); expect(Object.isFrozen(f.review.source.body)).toBe(true);
		await expect(copySavedDraft(f.store, f.review, destinationId, false, () => true)).rejects.toThrow("omit");
		expect(await f.store.getDraft(destinationId)).toBeUndefined();
		const result = await copySavedDraft(f.store, f.review, destinationId, true, () => true);
		expect(result.created).toBe(true); expect(result.draft).toMatchObject({ id: destinationId, scopeId: destination, revision: 0, target });
		expect(result.draft.body).not.toHaveProperty("editBaseRevision"); const ids = pictureIds(result.draft.body, true); expect(ids).toHaveLength(1); expect(ids[0]).not.toBe(id(20));
		expect(await f.store.pictureSource(ids[0], destination)).toMatchObject({ bytes: new Uint8Array([1, 2, 3]).buffer });
		expect(await f.store.getDraft(f.source.id)).toEqual(f.source); expect(await f.store.preference("activeNewDraft:" + destination)).toBe(destinationId);
		expect(await f.store.storageUsage()).toMatchObject({ drafts: 2, savedPictures: 2, savedPictureBytes: 6, queued: 0 });
		expect((await copySavedDraft(f.store, f.review, destinationId, true, () => true)).created).toBe(false);
		await f.store.saveDraft({ ...result.draft, revision: 1, body: "Later edit" }, 0);
		await expect(copySavedDraft(f.store, f.review, destinationId, true, () => true)).rejects.toThrow("already changed");
		expect((await f.store.getDraft(destinationId))?.body).toBe("Later edit");
		await f.store.removeDraft(destinationId, 1);
		await expect(copySavedDraft(f.store, f.review, destinationId, true, () => true)).rejects.toThrow("already removed");
		expect(await f.store.storageUsage()).toMatchObject({ drafts: 1, savedPictures: 1 });
	} finally { f.close(); }
});

test("same-scope review preserves references to server pictures without downloading them", async () => {
	const f = await fixture();
	try {
		const review = await reviewSavedDraftCopy(f.store, f.source.id, scope, target, undefined, () => true);
		const result = await copySavedDraft(f.store, review, "selection:" + scope + ":" + id(5), false, () => true);
		expect(pictureIds(result.draft.body, true)).toContain(id(21)); expect(await f.store.pictureSource(id(21), scope)).toBeUndefined();
	} finally { f.close(); }
});

test.each(["edit", "discard", "online", "recovery", "destination", "quota"])("a concurrent %s change leaves no copied draft or extra pictures", async kind => {
	const f = await fixture();
	try {
		if (kind === "edit") await f.store.saveDraft({ ...f.source, revision: 4, body: "Changed" }, 3);
		if (kind === "discard") await f.store.removeDraft(f.source.id, 3);
		if (kind === "online" || kind === "recovery") await f.store.setPreference(kind + ":" + f.source.id, {});
		if (kind === "destination") await f.store.setPreference("activeNewDraft:" + destination, "another");
		if (kind === "quota") await f.store.setPreference("pictureSourceBytes", 100 * 1024 * 1024);
		const before = await f.store.storageUsage();
		await expect(copySavedDraft(f.store, f.review, destinationId, true, () => true)).rejects.toThrow();
		expect(await f.store.getDraft(destinationId)).toBeUndefined(); expect(await f.store.storageUsage()).toEqual(before);
	} finally { f.close(); }
});

test("competing copy intents serialize the destination selection and only one is activated", async () => {
	const f = await fixture();
	try {
		const results = await Promise.allSettled([copySavedDraft(f.store, f.review, destinationId, true, () => true),
			copySavedDraft(f.store, f.review, "selection:" + destination + ":" + id(7), true, () => true)]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(await f.store.storageUsage()).toMatchObject({ drafts: 2, savedPictures: 2 });
	} finally { f.close(); }
});

test("context loss at transaction completion rolls back draft, activation and picture ownership", async () => {
	const f = await fixture();
	try {
		let inStore = false, checks = 0;
		const write = f.store.copyDraftForTarget.bind(f.store);
		jest.spyOn(f.store, "copyDraftForTarget").mockImplementation((...args) => { inStore = true; return write(...args); });
		await expect(copySavedDraft(f.store, f.review, destinationId, true, () => !inStore || checks++ < 2)).rejects.toThrow("changed");
		expect(await f.store.storageUsage()).toMatchObject({ drafts: 1, savedPictures: 1, savedPictureBytes: 3 });
		expect(await f.store.preference("activeNewDraft:" + destination)).toBeUndefined();
	} finally { f.close(); }
});

test("a missing-picture-only rich draft can be explicitly copied as an empty editable draft", async () => {
	const f = await fixture();
	try {
		await f.store.saveDraft({ ...f.source, revision: 4, body: protocolJson(editableCommentDraft({ version: 1, blocks: [{ type: "picture", picture_id: id(21) }] }, () => "Member")) }, 3);
		const review = await reviewSavedDraftCopy(f.store, f.source.id, destination, target, undefined, () => true);
		const result = await copySavedDraft(f.store, review, destinationId, true, () => true);
		expect(result.draft.body).toMatchObject({ pictures: [], rich: { blocks: [{ type: "paragraph", children: [] }] } });
	} finally { f.close(); }
});

test.each(["cell", "image", "lane_range"])("copies into an exact %s target without carrying the old target or changing the saved view", async kind => {
	const f = await fixture();
	try {
		const savedView = `base:${destination}:${id(40)}`, scopeId = kind === "image" ? destination : savedView;
		const anchor = kind === "image" ? { version: 1, type: "image_file", generation: id(30),
			asset: { kind: "managed", entry_id: destination, sha256: "a".repeat(64) }, basis: { width: 800, height: 500, orientation: "display" }, geometry: { type: "pin", x: 0.25, y: 0.75 } } :
			kind === "cell" ? { version: 1, type: "base", definition_id: id(41), view_id: id(40), generation: id(30), registry_revision: 2,
				target: { type: "cell", record_id: id(42), record_generation: id(43), property: { source: "note", name: "status" } } } :
			{ version: 1, type: "base_group_pending", entry_id: destination, property: { source: "note", name: "status" },
				capture: { operation_id: id(44), definition_id: id(41), view_id: id(40), generation: id(30), registry_revision: 2,
					group_definition_id: id(45), group_definition_revision: 2, record_id: id(42), record_generation: id(43), dependency: "AA==", time_zone: "UTC", value: { type: "text", value: "Done" } },
				range: { type: "timeline_range", axis_definition_id: id(46), axis_definition_revision: 2,
					axis: { version: 1, renderer: "sabidurian-sequence", start_property: { source: "note", name: "order" }, end_property: null, time_zone: null },
					range: { version: 1, kind: "ordinal", start: "100.000000001", end: "100.000000002", start_inclusive: true, end_inclusive: false, unit: "property-value" } } };
		const review = await reviewSavedDraftCopy(f.store, f.source.id, scopeId, anchor, undefined, () => true);
		const result = await copySavedDraft(f.store, review, "selection:" + scopeId + ":" + id(5), true, () => true);
		if (kind === "lane_range") {
			const saved = result.draft.target as unknown as { capture: { operation_id: string }; range: unknown };
			expect(saved.capture.operation_id).not.toBe(id(44)); expect(saved.range).toEqual(anchor.range);
		} else expect(result.draft.target).toEqual(anchor);
		expect(await f.store.getDraft(f.source.id)).toEqual(f.source);
		await expect(reviewSavedDraftCopy(f.store, f.source.id, kind === "image" ? id(99) : `base:${destination}:${id(99)}`, anchor, undefined, () => true)).rejects.toThrow("target");
	} finally { f.close(); }
});
