import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { YSweetProvider } from "../../src/client/provider";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { captureImageAnchor, markdownImages, resolveImageOccurrence } from "../../src/collaboration/anchors/images";
import type { ImageGeometry } from "../../src/collaboration/anchors/imageGeometry";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const run = process.env.EVC_IMAGE_ANCHOR_FIXTURE ? test : test.skip;
async function until(check: () => boolean) {
	const end = Date.now() + 10000;
	while (!check()) { if (Date.now() > end) throw new Error("Shared image source did not synchronize"); await new Promise(resolve => setTimeout(resolve, 25)); }
}

run("real image comments preserve duplicate occurrence, geometry, private dependencies and immutable retries", async () => {
	const fixture = JSON.parse(readFileSync(process.env.EVC_IMAGE_ANCHOR_FIXTURE!, "utf8"));
	for (const url of [fixture.base, fixture.relay]) expect(new URL(url).hostname).toBe("127.0.0.1");
	const docs: Y.Doc[] = [], providers: YSweetProvider[] = [];
	async function peer(token: string, mode: string) {
		const response = await fetch(fixture.base + "/v1/tokens/relay", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
			body: JSON.stringify({ share_id: fixture.share, doc_id: fixture.note, mode }) });
		expect(response.status).toBe(200); const grant = await response.json(), doc = new Y.Doc(); docs.push(doc);
		const provider = new YSweetProvider(grant.relay_url, fixture.note, doc, { connect: false, disableBc: true, params: { token: grant.token } });
		providers.push(provider); provider.connect(); await until(() => provider.synced); return { text: doc.getText("contents"), provider };
	}
	const transport = new DiscussionTransport({ serverId: fixture.base, accountId: fixture.bobId, shareId: fixture.share }, async () => ({ accountId: fixture.bobId, accessToken: fixture.bobToken }), fetch);
	try {
		expect(await transport.capabilities()).toMatchObject({ imageOccurrences: true });
		expect(await transport.permissions(fixture.note)).toMatchObject({ read: true, comment: true, edit: false });
		const owner = await peer(fixture.ownerToken, "write"), reviewer = await peer(fixture.bobToken, "read");
		const source = "![[chart.png|400]]\n\n![[chart.png|200]]"; owner.text.insert(0, source); await until(() => reviewer.text.toString() === source);
		const context = await transport.anchorContext(fixture.note);
		for (const geometry of [{ type: "whole" }, { type: "pin", x: 0.25, y: 0.75 }, { type: "region", x: 0.1, y: 0.2, width: 0.4, height: 0.5 }] as ImageGeometry[]) {
			const anchor = captureImageAnchor(reviewer.text, fixture.note, context.generation, markdownImages(reviewer.text.toString())[1],
				{ kind: "managed", entry_id: fixture.image, sha256: "a".repeat(64) }, { width: 1200, height: 800, orientation: "display" }, geometry);
			const operation = { operationId: randomUUID(), scopeId: fixture.note, type: "thread.create" as const, dependsOn: [], payload: {
				type: "thread.create", thread_id: randomUUID(), message_id: randomUUID(), anchor: protocolJson(anchor), body: protocolJson(bodyFromText("Review this image")) } };
			const receipt = await transport.send(operation); expect(await transport.send(operation)).toEqual(receipt);
			const page = await transport.thread(fixture.note, receipt.thread_id); expect(page.anchor).toEqual(anchor);
			owner.text.insert(0, "Before\n\n"); await until(() => reviewer.text.toString() === owner.text.toString());
			expect(resolveImageOccurrence(reviewer.text, fixture.note, context.generation, anchor)).toMatchObject({ status: "attached", image: { destination: "chart.png", from: markdownImages(reviewer.text.toString())[1].from } });
			const denied = { ...operation, operationId: randomUUID(), payload: { ...operation.payload, thread_id: randomUUID(), message_id: randomUUID(), anchor: protocolJson({ ...anchor, asset: { ...anchor.asset, entry_id: fixture.secret } }) } };
			await expect(transport.send(denied)).rejects.toMatchObject({ action: "reject", code: "image_unavailable" });
		}
		expect((await transport.threads(fixture.note)).threads).toHaveLength(3);
	} finally { for (const provider of providers) provider.destroy(); for (const doc of docs) doc.destroy(); }
}, 45000);
