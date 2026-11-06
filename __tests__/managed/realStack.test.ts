import * as fs from "node:fs";
import * as path from "node:path";
import * as Y from "yjs";
import { YSweetProvider } from "../../src/client/provider";
import { ItemKind, type ItemRecord } from "../../src/ItemKinds";
import { prepareRecoveryBackup } from "../../src/ManagedRecoveryBackup";
import { select } from "../../src/client/managedRecovery";
import { ManagedIndexTransport } from "../../src/client/ManagedIndexTransport";

// Only the Obsidian transport boundary is replaced; Yjs, provider, FastAPI,
// permission database and Rust relay all run their real implementation.
jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));

const run = process.env.EVC_MANAGED_FIXTURE ? test : test.skip;
const providers: YSweetProvider[] = [];
const docs: Y.Doc[] = [];
const indexes: ManagedIndexTransport[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 12000) {
	const end = Date.now() + timeout;
	while (!check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await sleep(25); }
}
afterEach(() => { for (const i of indexes) i.destroy(); for (const p of providers) p.destroy(); for (const d of docs) d.destroy(); });

run("real relay: inventory filtering, concurrent editing, offline/restart, read-only and live revocation", async () => {
	const fixture = JSON.parse(fs.readFileSync(process.env.EVC_MANAGED_FIXTURE!, "utf8"));
	for (const address of [fixture.base, fixture.relay]) expect(new URL(address).hostname).toBe("127.0.0.1");
	async function api(route: string, token: string, body?: unknown, method?: string) {
		return fetch(fixture.base + route, { method: method ?? (body ? "POST" : "GET"), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
	}
	async function grant(token: string, id = fixture.note, mode = "write") {
		const response = await api("/v1/tokens/relay", token, { share_id: fixture.share, doc_id: id, mode });
		expect(response.status).toBe(200);
		return response.json();
	}
	const root = await grant(fixture.bobToken, fixture.share);
	const rootDoc = new Y.Doc(); docs.push(rootDoc);
	const inventory = new ManagedIndexTransport(rootDoc, () => ({ endpoint: root.relay_url + "/" + fixture.share, token: root.token }), () => {}, error => { throw error; });
	indexes.push(inventory);
	await inventory.flush();
	expect(Object.keys(rootDoc.getMap("filemeta_v0").toJSON())).toEqual(["Note.md"]);
	expect(JSON.stringify(rootDoc.getMap("managed_base_v1").toJSON())).not.toContain("Budget.md");
	expect((await api("/v1/tokens/relay", fixture.bobToken, { share_id: fixture.share, doc_id: fixture.secret, mode: "read" })).status).toBe(403);
	const aliceGrant = await grant(fixture.ownerToken), bobGrant = await grant(fixture.bobToken);
	async function peer(auth: { relay_url: string; token: string }, bytes?: Uint8Array) {
		const doc = new Y.Doc(); docs.push(doc);
		if (bytes) Y.applyUpdate(doc, bytes);
		const provider = new YSweetProvider(auth.relay_url, fixture.note, doc, { connect: false, disableBc: true, params: { token: auth.token } });
		providers.push(provider); provider.connect();
		await until(() => provider.synced, "peer synchronized");
		return { doc, provider, text: doc.getText("contents") };
	}
	const a = await peer(aliceGrant);
	a.text.insert(0, "base\n");
	const b = await peer(bobGrant);
	await until(() => b.text.toString() === "base\n", "initial text");
	// Managed awareness uses the authenticated profile, never client identity/URLs.
	const profile = { id: "fixture-alice", name: "Alice", avatarUrl: "https://id.example/alice.png" };
	a.provider.awareness.setLocalStateField("user", profile);
	await until(() => b.provider.awareness.getStates().get(a.doc.clientID)?.user?.id === fixture.ownerId, "authenticated peer received");
	expect(b.provider.awareness.getStates().get(a.doc.clientID)?.user).toEqual({ id: fixture.ownerId, name: "owner" });
	a.provider.awareness.setLocalStateField("user", { ...profile, avatarUrl: "https://id.example/updated.png" });
	await sleep(100);
	expect(b.provider.awareness.getStates().get(a.doc.clientID)?.user?.avatarUrl).toBeUndefined();
	a.provider.awareness.setLocalStateField("user", { id: profile.id, name: profile.name });
	await until(() => !b.provider.awareness.getStates().get(a.doc.clientID)?.user?.avatarUrl, "peer picture removed");
	expect(a.text.toString()).toBe("base\n");
	a.text.insert(a.text.length, "alice\n");
	b.text.insert(b.text.length, "bob\n");
	await until(() => a.text.toString() === b.text.toString() && a.text.toString().includes("bob"), "concurrent edits converge");
	b.provider.disconnect();
	await sleep(100);
	b.text.insert(b.text.length, "offline\n");
	a.text.insert(a.text.length, "online\n");
	b.provider.connect();
	await until(() => a.text.toString() === b.text.toString() && a.text.toString().includes("offline"), "offline edit merged");
	const expected = a.text.toString();
	const saved = Y.encodeStateAsUpdate(b.doc);
	a.provider.destroy(); b.provider.destroy();
	await sleep(1600);
	fs.writeFileSync(path.join(fixture.restartDir, "restart-request"), "restart");
	await until(() => fs.existsSync(path.join(fixture.restartDir, "restart-done")), "relay restarted");
	const restored = await peer(await grant(fixture.ownerToken));
	const offlineRestored = await peer(await grant(fixture.bobToken), saved);
	await until(() => restored.text.toString() === expected && offlineRestored.text.toString() === expected, "durable state restored exactly once");
	// Two inventories rename one stable document while Bob edits it offline.
	// The conflicting move must not block an unrelated new note, or lose text.
	const ownerRoot = await grant(fixture.ownerToken, fixture.share);
	const ownerDoc = new Y.Doc(); docs.push(ownerDoc);
	const ownerIndex = new ManagedIndexTransport(ownerDoc, () => ({ endpoint: ownerRoot.relay_url + "/" + fixture.share, token: ownerRoot.token }), () => {}, () => {});
	indexes.push(ownerIndex); await ownerIndex.flush();
	inventory.stop(); offlineRestored.provider.disconnect();
	offlineRestored.text.insert(offlineRestored.text.length, "edit during competing moves\n");
	const localRecords = rootDoc.getMap<ItemRecord>("filemeta_v0"), ownerRecords = ownerDoc.getMap<ItemRecord>("filemeta_v0");
	const original = localRecords.get("Note.md")!;
	rootDoc.transact(() => { localRecords.delete("Note.md"); localRecords.set("Bob.md", original); localRecords.set("Unrelated.md", { id: crypto.randomUUID(), type: ItemKind.Document, version: 0 }); });
	ownerDoc.transact(() => { ownerRecords.delete("Note.md"); ownerRecords.set("Alice.md", original); });
	await ownerIndex.flush();
	inventory.start(); await inventory.flush();
	expect(inventory.conflicts).toHaveLength(1);
	expect(inventory.snapshot.records["Unrelated.md"]).toBeDefined();
	expect(localRecords.get("Bob.md")?.id).toBe(fixture.note);
	expect(localRecords.has("Alice.md")).toBe(false);
	const conflict = inventory.conflicts[0];
	let savedBackup = "";
	await inventory.resolve(conflict.id, "local", select(inventory.snapshot.records, conflict), async () => {
		const capture = async () => ({ files: [{ path: "Bob.md", bytes: new TextEncoder().encode(offlineRestored.text.toString()).buffer }],
			documents: [{ id: fixture.note, update: Y.encodeStateAsUpdate(offlineRestored.doc), text: offlineRestored.text.toString() }], index: Y.encodeStateAsUpdate(rootDoc) });
		const base = fixture.restartDir;
		const backup = await prepareRecoveryBackup({
			mkdir: async p => { await fs.promises.mkdir(path.join(base, p), { recursive: true }); },
			write: (p, text) => fs.promises.writeFile(path.join(base, p), text),
			writeBinary: (p, bytes) => fs.promises.writeFile(path.join(base, p), new Uint8Array(bytes)),
		}, capture, conflict);
		savedBackup = backup.path;
		return backup.verify;
	});
	expect(inventory.conflicts).toHaveLength(0);
	expect(inventory.snapshot.records["Bob.md"]?.id).toBe(fixture.note);
	const recoveryDoc = new Y.Doc(); docs.push(recoveryDoc);
	Y.applyUpdate(recoveryDoc, fs.readFileSync(path.join(fixture.restartDir, savedBackup, `documents/${fixture.note}.yjs`)));
	expect(recoveryDoc.getText("contents").toString()).toContain("edit during competing moves");
	offlineRestored.provider.connect();
	await until(() => restored.text.toString() === offlineRestored.text.toString() && restored.text.toString().includes("edit during competing moves"), "text survived structural recovery");
	const rules = [{ user_id: fixture.bobId, path: "", recursive: true, permission: "read" }, { user_id: fixture.bobId, path: "Budget.md", recursive: false, permission: "none" }];
	expect((await api(`/v1/managed/shares/${fixture.share}/rules`, fixture.ownerToken, rules, "PUT")).status).toBe(200);
	await until(() => !offlineRestored.provider.wsconnected, "existing writer disconnected after downgrade");
	offlineRestored.provider.disconnect();
	const viewer = await peer(await grant(fixture.bobToken, fixture.note, "read"));
	viewer.text.insert(viewer.text.length, "FORBIDDEN\n");
	await sleep(250);
	expect(restored.text.toString()).not.toContain("FORBIDDEN");
	viewer.provider.disconnect();
	const denied = await api("/v1/tokens/relay", fixture.bobToken, { share_id: fixture.share, doc_id: fixture.note, mode: "write" });
	expect(denied.status).toBe(403);
	// An app grant is not a relay CWT and cannot bypass the policy gateway.
	const direct = await fetch(fixture.relay.replace("ws:", "http:") + `/d/${fixture.note}/as-update`, { headers: { Authorization: `Bearer ${bobGrant.token}` } });
	expect(direct.status).not.toBe(200);
}, 60000);
