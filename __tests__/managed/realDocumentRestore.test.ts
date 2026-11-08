import * as fs from "node:fs";
import * as path from "node:path";
import * as Y from "yjs";
import { YSweetProvider } from "../../src/client/provider";

const fixturePath = process.env.EVC_DOCUMENT_RESTORE_FIXTURE;
const integration = fixturePath ? test : test.skip;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string) {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) { if (check()) return; await delay(20); }
	throw new Error("Timed out: " + message);
}

integration("managed document sockets reject original grants after generation rotation and never replay their queued edits", async () => {
	const f = JSON.parse(fs.readFileSync(fixturePath!, "utf8")) as Record<string, string>;
	if (new URL(f.base).hostname !== "127.0.0.1" || !f.restartDir.includes("evc-managed-integration-")) throw new Error("Only a disposable fixture is allowed");
	const providers: YSweetProvider[] = [], docs: Y.Doc[] = [];
	async function grant(mode: "read" | "write", generation?: string, expected = 200) {
		const response = await fetch(f.base + "/v1/tokens/relay", { method: "POST", headers: { Authorization: `Bearer ${f.ownerToken}`,
			"Content-Type": "application/json", ...(generation ? { "X-Relay-Restore-Generation": generation } : {}) },
			body: JSON.stringify({ share_id: f.share, doc_id: f.note, mode }) });
		expect(response.status).toBe(expected);
		return response.json() as Promise<{ token: string; relay_url: string; restore_generation: string | null }>;
	}
	async function peer(auth: { relay_url: string; token: string }) {
		const doc = new Y.Doc(); docs.push(doc);
		const provider = new YSweetProvider(auth.relay_url, f.note, doc, { connect: false, disableBc: true, params: { token: auth.token } });
		providers.push(provider); provider.connect();
		await until(() => provider.synced, "fresh document synchronization");
		return { doc, provider, text: doc.getText("contents") };
	}
	try {
		const original = await grant("write"); expect(original.restore_generation).toBeNull();
		const writer = await peer(original), reader = await peer(await grant("read"));
		writer.text.insert(0, "content before rotation\n");
		await until(() => reader.text.toString() === writer.text.toString(), "original content");
		const generation = crypto.randomUUID();
		fs.writeFileSync(path.join(f.restartDir, "rotate-request"), generation);
		await until(() => fs.existsSync(path.join(f.restartDir, "rotate-done")), "fixture generation rotation");
		await until(() => !writer.provider.wsconnected && !reader.provider.wsconnected, "active old sockets closed");
		writer.provider.disconnect(); reader.provider.disconnect();
		writer.text.insert(writer.text.length, "OLD OFFLINE EDIT MUST STAY LOCAL\n");
		writer.provider.connect(); await delay(300); expect(writer.provider.wsconnected).toBe(false); writer.provider.disconnect();
		await grant("write", undefined, 409); await grant("read", undefined, 409);
		await grant("write", crypto.randomUUID(), 409);
		const bound = await grant("write", generation); expect(bound.restore_generation).toBe(generation);
		const fresh = await peer(bound);
		expect(fresh.text.toString()).toBe("content before rotation\n");
		fresh.text.insert(fresh.text.length, "bound edit\n");
		const currentReader = await peer(await grant("read", generation));
		await until(() => currentReader.text.toString() === fresh.text.toString(), "fresh bound write/read");
		expect(currentReader.text.toString()).not.toContain("OLD OFFLINE");
		expect(writer.text.toString()).toContain("OLD OFFLINE EDIT MUST STAY LOCAL");
	} finally { providers.forEach(provider => provider.destroy()); docs.forEach(doc => doc.destroy()); }
}, 30_000);
