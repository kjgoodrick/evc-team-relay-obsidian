import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { ManagedIndexTransport, type ManagedManifest } from "../../src/client/ManagedIndexTransport";
import { ItemKind, type ItemRecord } from "../../src/ItemKinds";

// Replace only Obsidian's native HTTP boundary with Node fetch.
jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));

const fixturePath = process.env.EVC_BASE_CONTENT_FIXTURE;
const integration = fixturePath ? test : test.skip;

integration("actual restored inventory fences old local work while fresh bound claims, moves and activity succeed", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as Record<string, string>;
	const url = new URL(fixture.base);
	if (url.hostname !== "127.0.0.1" || !url.port || !fixture.restoreGeneration) throw new Error("Only a disposable restored loopback fixture is allowed");
	const grant = await fetch(fixture.base + "/v1/tokens/relay", { method: "POST", headers: { Authorization: `Bearer ${fixture.ownerToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ share_id: fixture.share, doc_id: fixture.share, mode: "write" }) });
	expect(grant.status).toBe(200); const credential = await grant.json() as { relay_url: string; token: string };
	const endpoint = credential.relay_url + "/" + fixture.share;
	const documents: Y.Doc[] = [], transports: ManagedIndexTransport[] = [];
	const create = (state?: Uint8Array) => {
		const doc = new Y.Doc(); documents.push(doc); if (state) Y.applyUpdate(doc, state);
		const transport = new ManagedIndexTransport(doc, () => ({ endpoint, token: credential.token }), () => {}, () => {}); transports.push(transport);
		return { doc, transport, records: doc.getMap<ItemRecord>("filemeta_v0") };
	};
	try {
		const fresh = create(); await fresh.transport.flush();
		expect(fresh.transport.snapshot.restore_generation).toBe(fixture.restoreGeneration);
		const legacy = { ...fresh.transport.snapshot }; delete legacy.restore_generation; delete legacy.restore_guard;
		const old = create(); old.doc.getMap("managed_base_v1").set("snapshot", legacy);
		for (const [path, record] of Object.entries(legacy.records)) old.records.set(path, record);
		const [path, entry] = Object.entries(legacy.records).find(([, record]) => record.id === fixture.entry)!;
		old.doc.transact(() => { old.records.delete(path); old.records.set("Old offline move.base", entry); });
		const local = old.records.toJSON();
		await expect(old.transport.flush()).rejects.toThrow("restored");
		expect(old.records.toJSON()).toEqual(local); expect(old.transport.restoreReview?.before).toEqual(legacy);
		const reopened = create(Y.encodeStateAsUpdate(old.doc));
		await expect(reopened.transport.flush()).rejects.toThrow("restored");
		await expect(reopened.transport.claim("Unsafe.md", { id: crypto.randomUUID(), type: ItemKind.Document, version: 0 })).rejects.toThrow("restored");
		const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
		const unsafe = await fetch(endpoint + "/claim", { method: "POST", headers, body: JSON.stringify({ path, record: entry }) });
		expect(unsafe.status).toBe(409);
		const unchanged = await (await fetch(endpoint, { headers })).json() as ManagedManifest;
		expect(unchanged.records).toEqual(legacy.records);
		const added: ItemRecord = { id: crypto.randomUUID(), type: ItemKind.Document, version: 0 };
		expect(await fresh.transport.claim("New bound note.md", added)).toBe(true);
		fresh.doc.transact(() => { fresh.records.delete("New bound note.md"); fresh.records.set("Moved bound note.md", added); });
		await fresh.transport.flush(); fresh.doc.getMap("docactivity_v0").set(added.id, "bound activity"); await fresh.transport.flush();
		const final = await (await fetch(endpoint, { headers })).json() as ManagedManifest;
		expect(final.records["Moved bound note.md"]).toEqual(added); expect(final.records["New bound note.md"]).toBeUndefined();
		expect(final.activity[added.id]).toBe("bound activity"); expect(final.records[path]).toEqual(entry);
		expect(reopened.records.toJSON()).toEqual(local); expect(reopened.transport.restoreReview).toEqual(old.transport.restoreReview);
	} finally { transports.forEach(transport => transport.destroy()); documents.forEach(doc => doc.destroy()); }
}, 30_000);
