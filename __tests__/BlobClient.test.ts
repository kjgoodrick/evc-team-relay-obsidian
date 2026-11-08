import { BlobClient } from "../src/BlobClient";
import { ResourceAddress, RemoteFileAddress } from "../src/ResourceAddress";
import { sha256Hex } from "../src/contentDigest";
import { platformFetch } from "../src/platformFetch";
import type { VaultShare } from "../src/VaultShare";
import type { AttachmentFile } from "../src/AttachmentFile";

jest.mock("../src/platformFetch");
jest.mock("../src/logging", () => ({ Loggable: class { log() {} } }));
const fetch = jest.mocked(platformFetch);
const restored = "a1111111-1111-4111-8111-111111111111";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };

async function fixture() {
	const content = new TextEncoder().encode("captured image bytes").buffer;
	const hash = await sha256Hex(content);
	const state = { current: true, account: true, restore: null as string | null };
	const check = () => { if (!state.current) throw new Error("context changed"); };
	const credentials = {
		captureFileContext: jest.fn(() => () => { if (!state.account) throw new Error("account changed"); }),
		resolveFileToken: jest.fn(async () => ({ token: "fixture", baseUrl: "https://fixture/file", restoreGuard: true, restoreGeneration: state.restore })),
	};
	const share = {
		credentialCache: credentials, config: { onpremServerId: "fixture-server" },
		captureAttachmentContext: jest.fn(() => ({ managed: true, binding: { restoreGeneration: state.restore }, check })),
		ensureManagedEntry: jest.fn(async () => undefined),
	} as unknown as VaultShare;
	const file = {
		s3rn: new RemoteFileAddress("relay-onprem", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"),
		entityGuid: "22222222-2222-4222-8222-222222222222", entryPath: "photo.png", mimeType: "image/png",
		stat: { mtime: 10, ctime: 1, size: content.byteLength }, syncMeta: { hash },
		contentAddressedCache: { readSnapshot: jest.fn(async () => ({ content, hash })), resolveHash: jest.fn(async () => "different later hash") },
	} as unknown as AttachmentFile;
	return { client: new BlobClient(share), share, file, credentials, state, content, hash };
}

beforeEach(() => fetch.mockReset());

test("upload token and receipt describe exactly the captured bytes, with restore binding", async () => {
	const f = await fixture(); f.state.restore = restored;
	fetch.mockResolvedValueOnce(reply({ uploadUrl: "https://fixture/upload" })).mockResolvedValueOnce(new Response());
	const receipt = await f.client.pushFile(f.file);
	expect(f.credentials.resolveFileToken).toHaveBeenCalledWith(ResourceAddress.serialize(f.file.s3rn), f.hash, "image/png", f.content.byteLength, "fixture-server", { restoreGeneration: restored });
	expect(f.file.contentAddressedCache.resolveHash).not.toHaveBeenCalled();
	expect(fetch.mock.calls[1][1]?.body).toBe(f.content);
	expect(receipt.hash).toBe(f.hash); expect(receipt.mtime).toBe(10); receipt.check();
	f.file.stat.mtime++;
	expect(receipt.check).toThrow("changed during upload");
});

test.each([403, 409, 500])("final PUT failure %s is never reported as successful", async status => {
	const f = await fixture();
	fetch.mockResolvedValueOnce(reply({ uploadUrl: "https://fixture/upload" })).mockResolvedValueOnce(new Response(null, { status }));
	await expect(f.client.pushFile(f.file)).rejects.toThrow(`upload failed (${status})`);
});

test("a restore or a local edit while reading bytes prevents any token or upload request", async () => {
	for (const change of ["restore", "edit"]) {
		const f = await fixture(), wait = deferred<{ content: ArrayBuffer; hash: string }>();
		jest.mocked(f.file.contentAddressedCache.readSnapshot).mockReturnValueOnce(wait.promise);
		const pending = f.client.pushFile(f.file);
		if (change === "restore") f.state.current = false; else f.file.stat.mtime++;
		wait.resolve({ content: f.content, hash: f.hash });
		await expect(pending).rejects.toThrow();
		expect(f.credentials.resolveFileToken).not.toHaveBeenCalled();
	}
	expect(fetch).not.toHaveBeenCalled();
});

test("changed restore context in token response prevents upload URL and PUT", async () => {
	const f = await fixture();
	f.credentials.resolveFileToken.mockImplementation(async () => ({ token: "fixture", baseUrl: "https://fixture/file", restoreGuard: true, restoreGeneration: restored }));
	await expect(f.client.pushFile(f.file)).rejects.toThrow("restore context changed");
	expect(fetch).not.toHaveBeenCalled();
});

test("account change or teardown during final PUT cannot acknowledge success", async () => {
	for (const change of ["account", "destroy"]) {
		const f = await fixture();
		fetch.mockResolvedValueOnce(reply({ uploadUrl: "https://fixture/upload" })).mockImplementationOnce(async () => {
			if (change === "account") f.state.account = false; else f.client.destroy();
			return new Response();
		});
		await expect(f.client.pushFile(f.file)).rejects.toThrow();
	}
});

test("download is verified before returning bytes, and HTTP failures never become local file content", async () => {
	const f = await fixture();
	fetch.mockResolvedValueOnce(reply({ downloadUrl: "https://fixture/download" })).mockResolvedValueOnce(new Response(f.content));
	expect(await f.client.pullFile(f.file)).toEqual(f.content);
	for (const result of [new Response("wrong bytes"), new Response("denied", { status: 403 })]) {
		fetch.mockResolvedValueOnce(reply({ downloadUrl: "https://fixture/download" })).mockResolvedValueOnce(result);
		await expect(f.client.pullFile(f.file)).rejects.toThrow();
	}
});

test("a changed remote revision during download prevents returning old bytes", async () => {
	const f = await fixture();
	fetch.mockResolvedValueOnce(reply({ downloadUrl: "https://fixture/download" })).mockImplementationOnce(async () => {
		f.file.syncMeta!.hash = "new hash";
		return new Response(f.content);
	});
	await expect(f.client.pullFile(f.file)).rejects.toThrow("revision changed");
});
