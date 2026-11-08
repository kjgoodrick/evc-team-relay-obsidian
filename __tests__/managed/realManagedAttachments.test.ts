import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { BlobClient } from "../../src/BlobClient";
import { RelayCredentialCache } from "../../src/RelayCredentialCache";
import { RelayOnPremTokenProvider } from "../../src/auth/RelayOnPremTokenProvider";
import { ManagedIndexTransport } from "../../src/client/ManagedIndexTransport";
import { readManagedAttachment } from "../../src/client/readManagedAttachment";
import { RemoteFileAddress, ResourceAddress } from "../../src/ResourceAddress";
import { sha256Hex } from "../../src/contentDigest";
import type { AttachmentFile } from "../../src/AttachmentFile";
import type { VaultShare } from "../../src/VaultShare";
import type { AuthSession } from "../../src/AuthSession";
import type { IAuthProvider } from "../../src/auth/IAuthProvider";
import { MockClock } from "../mocks/MockClock";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const fixturePath = process.env.EVC_MANAGED_ATTACHMENT_FIXTURE;
const integration = fixturePath ? test : test.skip;

integration("actual attachment client checks uploads and reads verified distinct image revisions from MinIO", async () => {
	const f = JSON.parse(readFileSync(fixturePath!, "utf8")) as Record<string, string>;
	if (new URL(f.base).hostname !== "127.0.0.1" || !f.generation) throw new Error("Only a disposable restored fixture is allowed");
	const headers = { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" };
	const grant = await fetch(f.base + "/v1/tokens/relay", { method: "POST", headers, body: JSON.stringify({ share_id: f.share, doc_id: f.share, mode: "write" }) });
	expect(grant.status).toBe(200); const credential = await grant.json() as { token: string };
	const doc = new Y.Doc();
	const index = new ManagedIndexTransport(doc, () => ({ endpoint: f.base + "/v1/managed/index/" + f.share, token: credential.token }), () => {}, () => {});
	const auth = { getToken: () => f.token, getValidToken: async () => f.token } as IAuthProvider;
	const provider = new RelayOnPremTokenProvider({ controlPlaneUrl: f.base, authProvider: auth });
	const cache = new RelayCredentialCache({} as AuthSession, new MockClock(), "disposable", 5, new Map([["fixture", provider]]));
	const share = { config: { onpremServerId: "fixture" }, credentialCache: cache,
		captureAttachmentContext: (file: AttachmentFile) => ({ ...index.captureContentContext(file.entryPath, file.entityGuid), managed: true }),
		ensureManagedEntry: async () => { await index.flush(); } } as unknown as VaultShare;
	const blobs = new BlobClient(share);
	try {
		await index.flush(); expect(index.snapshot.restore_generation).toBe(f.generation);
		const revisions: string[] = [];
		const file = { s3rn: new RemoteFileAddress("relay-onprem", f.share, f.entry), entityGuid: f.entry, entryPath: "Upload.png", mimeType: "image/png",
			stat: { mtime: 1, ctime: 1, size: 0 }, syncMeta: { hash: "" }, contentAddressedCache: {} } as unknown as AttachmentFile;
		for (const value of ["first exact image revision", "second exact image revision"]) {
			const content = new TextEncoder().encode(value).buffer, hash = await sha256Hex(content); revisions.push(hash);
			file.stat.size = content.byteLength; file.stat.mtime++;
			file.contentAddressedCache.readSnapshot = async () => ({ content, hash });
			const uploaded = await blobs.pushFile(file); uploaded.check(); expect(uploaded.hash).toBe(hash);
			file.syncMeta!.hash = hash;
			expect(await blobs.headFile(file)).toBe(true);
			expect(new TextDecoder().decode(await blobs.pullFile(file))).toBe(value);
		}
		file.syncMeta!.hash = revisions[0]; expect(new TextDecoder().decode(await blobs.pullFile(file))).toBe("first exact image revision");
		const inspection = await cache.requestFileInspectionToken(ResourceAddress.serialize(file.s3rn), revisions[0], "image/png", "fixture", { restoreGeneration: f.generation });
		inspection.check(); expect(inspection.grant.authorization).toBe("read-only");
		const readGrant = inspection.grant;
		const inspected = await fetch(readGrant.baseUrl + "/download-url", { headers: { Authorization: `Bearer ${readGrant.token}` } });
		expect(inspected.status).toBe(200);
		const inspectionUrl = (await inspected.json() as { downloadUrl: string }).downloadUrl;
		expect(await (await fetch(inspectionUrl)).text()).toBe("first exact image revision");
		expect((await fetch(readGrant.baseUrl + "/upload-url", { method: "POST", headers: { Authorization: `Bearer ${readGrant.token}` } })).status).toBe(403);
		expect((await fetch(inspectionUrl, { method: "PUT", body: "first exact image revision" })).status).toBe(403);
		await expect(cache.requestFileInspectionToken(ResourceAddress.serialize(file.s3rn), revisions[0], "image/png", "fixture", {})).rejects.toThrow("read-only attachment grant");
		const preview = await readManagedAttachment(cache, ResourceAddress.serialize(file.s3rn), revisions[0], "fixture", { restoreGeneration: f.generation });
		preview.check(); expect(new TextDecoder().decode(preview.content)).toBe("first exact image revision");
		await expect(readManagedAttachment(cache, ResourceAddress.serialize(file.s3rn), revisions[0], "fixture", { restoreGeneration: f.generation }, { maxBytes: 2 })).rejects.toThrow("unsupported size");
		const oldUrl = `${f.base}/shares/${f.share}/files/${f.entry}/content?token=${f.oldToken}`;
		expect((await fetch(oldUrl, { method: "PUT", body: "original credential" })).status).toBe(409);
		const bad = await provider.requestFileToken("relay-onprem", f.share, f.entry, "a".repeat(64), "image/png", 3, { restoreGeneration: f.generation });
		const badUrl = await fetch(bad.baseUrl + "/upload-url", { method: "POST", headers: { Authorization: `Bearer ${bad.token}` } });
		expect(badUrl.status).toBe(200);
		expect((await fetch((await badUrl.json() as { uploadUrl: string }).uploadUrl, { method: "PUT", body: "bad" })).status).toBe(422);
		file.entityGuid = f.legacy; file.entryPath = "Legacy.png"; file.s3rn = new RemoteFileAddress("relay-onprem", f.share, f.legacy); file.syncMeta!.hash = f.legacyHash;
		expect(await blobs.headFile(file)).toBe(true);
		expect(new TextDecoder().decode(await blobs.pullFile(file))).toBe("verified legacy attachment fixture");
		file.syncMeta!.hash = "b".repeat(64); expect(await blobs.headFile(file)).toBe(false);
		await expect(blobs.pullFile(file)).rejects.toThrow("409");
	} finally { blobs.destroy(); cache.destroy(); index.destroy(); doc.destroy(); }
}, 30_000);
