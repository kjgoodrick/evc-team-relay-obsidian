import * as fs from "node:fs";
import * as path from "node:path";
import * as Y from "yjs";
import { YSweetProvider } from "../../src/client/provider";
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
