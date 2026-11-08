import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { RemoteDocumentAddress, RemoteFolderAddress, ResourceAddress } from "../src/ResourceAddress";
import { sourceDocumentCacheSync, sourceInventoryCacheSync, sourceDocumentCache, sourceInventoryCache } from "../src/storage/source-document-cache";

test("constructor descriptors preserve the WebCrypto namespace in both Node and browser bundles", async () => {
	const bundle = buildSync({ stdin: { contents: 'export { digest } from "lib0/hash/sha256";', resolveDir: process.cwd() },
		bundle: true, platform: "browser", format: "cjs", write: false, metafile: true });
	expect(Object.keys(bundle.metafile!.inputs)).toContain("node_modules/lib0/hash/sha256.js");
	expect(Object.keys(bundle.metafile!.inputs).some(path => path.endsWith("sha256.node.js"))).toBe(false);
	const module = { exports: {} as { digest: (bytes: Uint8Array) => Uint8Array } };
	runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports });
	const folder = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
	for (const generation of [null, "A3333333-3333-4333-8333-333333333333"]) for (const hostAppId of ["vault", "Café 日本語 📆", "x".repeat(256)]) {
		const scope = { hostAppId, serverId: "fixture", controlPlaneUrl: "https://FIXTURE.test:443/path/", restoreGeneration: generation };
		const document = { ...scope, s3rn: ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", folder, id)) };
		const inventory = { ...scope, s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", folder)) };
		const descriptors = [sourceDocumentCacheSync(document), sourceInventoryCacheSync(inventory)];
		expect(descriptors).toEqual([await sourceDocumentCache(document), await sourceInventoryCache(inventory)]);
		for (const descriptor of descriptors) {
			const bytes = new TextEncoder().encode(descriptor.identity), browser = module.exports.digest(bytes);
			const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
			expect([...browser]).toEqual([...expected]);
			expect(descriptor.name.endsWith([...expected].map(byte => byte.toString(16).padStart(2, "0")).join(""))).toBe(true);
			expect(Object.isFrozen(descriptor)).toBe(true);
		}
	}
});
