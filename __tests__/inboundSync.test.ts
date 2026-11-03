/**
 * Unit tests: InboundSyncPoller + InboundFileDownloader
 *
 * Covers:
 *   (a) poller fires on web_content_updated_at bump; skips when unchanged
 *   (b) downloader diffs file index by sha256 and writes only new/changed items
 *   (c) no outbound echo triggered during inbound write (writingPaths guard)
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

// ─── Import from obsidian (moduleNameMapper → __tests__/mocks/obsidian.ts) ────
import { TFile, noticeMock } from "obsidian";

// ─── Mock hashing so tests don't need WebCrypto ───────────────────────────────
const mockGenerateHash = jest.fn<() => Promise<string>>();
jest.mock("src/contentDigest", () => ({
	sha256Hex: mockGenerateHash,
}));

// ─── Mock debug logging (no-op) ───────────────────────────────────────────────
jest.mock("src/logging", () => ({
	namedLogger: () => () => undefined,
}));

import { MockClock } from "./mocks/MockClock";
import { InboundSyncPoller } from "src/InboundSyncPoller";
import { InboundFileDownloader } from "src/InboundFileDownloader";
import { RelayHttpError } from "src/relayRequestErrors";
import type { RelayOnPremShareClientManager } from "src/RelayOnPremShareClientManager";
import type { WebSyncManager } from "src/WebSyncManager";
import type { FileManager, Vault } from "obsidian";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Flush all pending microtasks (resolves mock promises queued by mockResolvedValue). */
const flushPromises = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

const SHARE_ID = "share-001";
const SERVER_ID = "server-001";
const SHARE_PATH = "shared/docs";

function makeShare(webContentUpdatedAt: string | null = null) {
	return {
		id: SHARE_ID,
		kind: "folder" as const,
		path: SHARE_PATH,
		visibility: "private" as const,
		owner_user_id: "user-1",
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		web_content_updated_at: webContentUpdatedAt,
	};
}

function makeMockClientManager(overrides: Partial<{
	getShare: jest.Mock;
	getFilesIndex: jest.Mock;
	downloadFile: jest.Mock;
}> = {}): jest.Mocked<Pick<RelayOnPremShareClientManager, "getShare" | "getFilesIndex" | "downloadFile">> {
	return {
		getShare: jest.fn<RelayOnPremShareClientManager["getShare"]>().mockResolvedValue(makeShare() as any),
		getFilesIndex: jest.fn<RelayOnPremShareClientManager["getFilesIndex"]>().mockResolvedValue([]),
		downloadFile: jest.fn<RelayOnPremShareClientManager["downloadFile"]>().mockResolvedValue(new ArrayBuffer(4)),
		...overrides,
	} as any;
}

function makeMockWebSyncManager(isOutboundSyncing = false): Pick<WebSyncManager, "isOutboundSyncing"> {
	return { isOutboundSyncing };
}

function makeMockVault() {
	const adapter = {
		mkdir: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
		writeBinary: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	};
	// Declared as their own consts (rather than inline in the returned object
	// literal) so `typeof` below can carry the real jest.fn<...> generic
	// through — annotating the return type as the bare `jest.Mock` widened
	// every call's argument type to `never`, which is what produced the
	// `.mockReturnValue(x)`/`.mockResolvedValue(x)` "Expected 0 arguments"
	// class of tsc errors at every call site across this file.
	const getAbstractFileByPath = jest.fn<(path: string) => TFile | null>().mockReturnValue(null);
	const readBinary = jest.fn<() => Promise<ArrayBuffer>>().mockResolvedValue(new ArrayBuffer(4));
	const del = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
	return {
		getAbstractFileByPath,
		readBinary,
		delete: del,
		adapter,
	} as unknown as Vault & {
		adapter: typeof adapter;
		getAbstractFileByPath: typeof getAbstractFileByPath;
		readBinary: typeof readBinary;
		delete: typeof del;
	};
}

// ─── InboundSyncPoller ────────────────────────────────────────────────────────

describe("InboundSyncPoller", () => {
	let timeProvider: MockClock;
	let clientManager: ReturnType<typeof makeMockClientManager>;
	let webSyncManager: ReturnType<typeof makeMockWebSyncManager>;
	let fileDownloader: jest.Mocked<Pick<InboundFileDownloader, "downloadShare" | "isInboundWriting">>;
	let poller: InboundSyncPoller;
	let startTime: number;

	beforeEach(() => {
		jest.clearAllMocks();
		timeProvider = new MockClock();
		startTime = timeProvider.now();
		clientManager = makeMockClientManager();
		webSyncManager = makeMockWebSyncManager();
		fileDownloader = {
			downloadShare: jest.fn<() => Promise<"ran" | "skipped">>().mockResolvedValue("ran"),
			isInboundWriting: jest.fn<() => boolean>().mockReturnValue(false),
		};
		poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			fileDownloader as any,
			30_000,
		);
	});

	test("fires downloadShare when web_content_updated_at bumps", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(clientManager.getShare).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, true);
		expect(fileDownloader.downloadShare).toHaveBeenCalledWith(SHARE_ID, SERVER_ID);
	});

	test("a share whose folder is not in the vault costs no GET per poll; a local one is polled", async () => {
		(clientManager.getShare as unknown as jest.Mock<() => Promise<unknown>>).mockResolvedValue(
			makeShare("2026-06-08T10:00:00Z"),
		);

		for (let i = 0; i < 14; i++) poller.track(`remote-${i}`, SERVER_ID, false, null);
		poller.track(SHARE_ID, SERVER_ID, true, null);
		poller.start();

		for (let t = 1; t <= 10; t++) {
			timeProvider.setTime(startTime + t * 30_000);
			await flushPromises();
		}

		const polled = (clientManager.getShare as jest.Mock).mock.calls.map((c) => c[1]);
		expect(polled.filter((id) => id !== SHARE_ID)).toEqual([]);
		expect(polled.length).toBe(10);
	});

	test("a non-local share is downloaded from the listed timestamp once, and not again while it is unchanged", async () => {
		const ts = "2026-06-08T10:00:00Z";

		poller.track("remote", SERVER_ID, false, ts);
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledWith("remote", SERVER_ID);

		poller.track("remote", SERVER_ID, false, ts);
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);

		poller.track("remote", SERVER_ID, false, "2026-06-08T11:00:00Z");
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(2);
		expect(clientManager.getShare).not.toHaveBeenCalled();
	});

	test("a non-local share whose download wrote its folder is polled from then on", async () => {
		let local = false;
		(fileDownloader.downloadShare as unknown as jest.Mock<() => Promise<string>>).mockImplementation(
			async () => {
				local = true;
				return "ran";
			},
		);

		poller.track("remote", SERVER_ID, false, "2026-06-08T10:00:00Z", () => local);
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);

		(clientManager.getShare as unknown as jest.Mock<() => Promise<unknown>>).mockResolvedValue(
			makeShare("2026-06-08T12:00:00Z"),
		);
		poller.start();
		timeProvider.setTime(startTime + 30_000);
		await flushPromises();
		expect(clientManager.getShare).toHaveBeenCalledWith(SERVER_ID, "remote", true);
	});

	test("skips downloadShare when web_content_updated_at is unchanged", async () => {
		const ts = "2026-06-08T10:00:00Z";
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare(ts));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		// First tick — bumps from null → ts → should download
		timeProvider.setTime(startTime + 30_000);
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);

		// Second tick — same ts → should skip
		timeProvider.setTime(startTime + 60_000);
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);
	});

	test("skips polling entirely when isOutboundSyncing is true", async () => {
		(webSyncManager as any).isOutboundSyncing = true;
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(clientManager.getShare).not.toHaveBeenCalled();
		expect(fileDownloader.downloadShare).not.toHaveBeenCalled();
	});

	test("does not fire when web_content_updated_at is null", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare(null));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(fileDownloader.downloadShare).not.toHaveBeenCalled();
	});

	test("handles getShare errors without crashing the poller", async () => {
		(clientManager.getShare as jest.Mock).mockRejectedValue(new Error("Network error"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await expect(flushPromises()).resolves.toBeUndefined();

		// Poller remains alive for next tick
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));
		// The first cooldown may last 36s with jitter, so resume on the
		// following tick rather than assuming the minimum delay.
		timeProvider.setTime(startTime + 90_000);
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);
	});

	test("does not overlap a slow download across poll ticks", async () => {
		let finish!: () => void;
		fileDownloader.downloadShare.mockImplementation(() => new Promise<"ran" | "skipped">((resolve) => { finish = () => resolve("ran"); }));
		clientManager.getShare.mockResolvedValue(makeShare("changed") as any);
		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();
		timeProvider.setTime(startTime + 30_000);
		await flushPromises();
		timeProvider.setTime(startTime + 60_000);
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);
		finish();
		await flushPromises();
	});

	test("backs off the server after repeated failures and resets after recovery", async () => {
		const random = jest.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			clientManager.getShare.mockRejectedValue(new Error("Request timed out"));
			poller.registerShare(SHARE_ID, SERVER_ID);
			poller.registerShare("same-server", SERVER_ID);
			poller.start();
			for (const elapsed of [30_000, 60_000, 90_000]) {
				timeProvider.setTime(startTime + elapsed);
				await flushPromises();
			}
			expect(clientManager.getShare).toHaveBeenCalledTimes(2);
			clientManager.getShare.mockResolvedValue(makeShare("changed") as any);
			timeProvider.setTime(startTime + 120_000);
			await flushPromises();
			expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(2);
			clientManager.getShare.mockRejectedValue(new Error("Request timed out"));
			timeProvider.setTime(startTime + 150_000);
			await flushPromises();
			timeProvider.setTime(startTime + 180_000);
			await flushPromises();
			expect(clientManager.getShare).toHaveBeenCalledTimes(6);
		} finally { random.mockRestore(); }
	});

	test.each([null, "changed"])("escalates mixed share failures after a healthy share (%s)", async (watermark) => {
		const random = jest.spyOn(Math, "random").mockReturnValue(0.5);
		let failing = true;
		try {
			clientManager.getShare.mockImplementation(async (_server, shareId) => {
				if (shareId === "failing" && failing) throw new Error("Request timed out");
				return makeShare(watermark) as any;
			});
			poller.registerShare("healthy", SERVER_ID);
			poller.registerShare("failing", SERVER_ID);
			poller.start();
			for (const elapsed of [30_000, 60_000, 90_000]) {
				timeProvider.setTime(startTime + elapsed);
				await flushPromises();
			}
			expect(clientManager.getShare).toHaveBeenCalledTimes(4);
			failing = false;
			timeProvider.setTime(startTime + 120_000);
			await flushPromises();
			expect(clientManager.getShare).toHaveBeenCalledTimes(6);
			failing = true;
			for (const elapsed of [150_000, 180_000]) {
				timeProvider.setTime(startTime + elapsed);
				await flushPromises();
			}
			expect(clientManager.getShare).toHaveBeenCalledTimes(10);
		} finally { random.mockRestore(); }
	});

	test("unregisterShare stops polling for that share", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();
		poller.unregisterShare(SHARE_ID);

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(clientManager.getShare).not.toHaveBeenCalled();
		expect(fileDownloader.downloadShare).not.toHaveBeenCalled();
	});

	test("start is idempotent (second call does not double-register interval)", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();
		poller.start(); // second call should be a no-op

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		// downloadShare should fire exactly once, not twice
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);
	});

	test("destroy clears interval so no further polls occur", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();
		poller.destroy();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(clientManager.getShare).not.toHaveBeenCalled();
		expect(fileDownloader.downloadShare).not.toHaveBeenCalled();
	});
});

// ─── InboundFileDownloader ────────────────────────────────────────────────────

describe("InboundFileDownloader", () => {
	let clientManager: ReturnType<typeof makeMockClientManager>;
	let webSyncManager: { isOutboundSyncing: boolean };
	let vault: ReturnType<typeof makeMockVault>;
	let fileManager: Pick<FileManager, "trashFile"> & {
		trashFile: jest.Mock<FileManager["trashFile"]>;
	};
	let downloader: InboundFileDownloader;

	beforeEach(() => {
		jest.clearAllMocks();
		mockGenerateHash.mockResolvedValue("hash-aabbcc");
		clientManager = makeMockClientManager();
		webSyncManager = { isOutboundSyncing: false };
		vault = makeMockVault();
		fileManager = { trashFile: jest.fn<FileManager["trashFile"]>().mockResolvedValue(undefined) };
		downloader = new InboundFileDownloader(vault, fileManager as unknown as FileManager, clientManager as any, webSyncManager as any);
	});

	test("skips download when outbound sync is in flight", async () => {
		webSyncManager.isOutboundSyncing = true;
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "abc", size: 10, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		expect(clientManager.getFilesIndex).not.toHaveBeenCalled();
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("downloads and writes new sync-artifact items to vault", async () => {
		const content = new ArrayBuffer(8);
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(content);
		vault.getAbstractFileByPath.mockReturnValue(null);

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		expect(clientManager.downloadFile).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "note.md");
		expect(vault.adapter.writeBinary).toHaveBeenCalledWith(
			`${SHARE_PATH}/note.md`,
			content,
		);
	});

	test("skips items whose sha256 is unchanged since last download", async () => {
		const content = new ArrayBuffer(8);
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(content);
		vault.getAbstractFileByPath.mockReturnValue(null);

		// First download — writes the file
		await downloader.downloadShare(SHARE_ID, SERVER_ID);
		expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1);

		jest.clearAllMocks();

		// Second download — same sha256, must skip
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);

		await downloader.downloadShare(SHARE_ID, SERVER_ID);
		expect(clientManager.downloadFile).not.toHaveBeenCalled();
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("downloads and writes when sha256 changes (updated item)", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		vault.getAbstractFileByPath.mockReturnValue(null);

		// First: sha-001
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		jest.clearAllMocks();

		// Second: sha-002 (updated)
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-002", size: 12, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
		]);
		const newContent = new ArrayBuffer(12);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(newContent);
		// File now exists in vault
		const existingFile = new TFile(`${SHARE_PATH}/note.md`);
		vault.getAbstractFileByPath.mockReturnValue(existingFile);
		// Local hash matches what we last wrote (sha-001), so not user-edited
		mockGenerateHash.mockResolvedValue("sha-001");

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		expect(clientManager.downloadFile).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "note.md");
		expect(vault.adapter.writeBinary).toHaveBeenCalledWith(`${SHARE_PATH}/note.md`, newContent);
	});

	test("skips user-edited files (local hash differs from last-written hash)", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		vault.getAbstractFileByPath.mockReturnValue(null);

		// First download establishes last written hash = sha-001
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		jest.clearAllMocks();

		// Second download: server has sha-002, file exists, local hash = user-edited-hash (≠ sha-001)
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-002", size: 12, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
		]);
		const existingFile = new TFile(`${SHARE_PATH}/note.md`);
		vault.getAbstractFileByPath.mockReturnValue(existingFile);
		// Account edited the file — local hash differs from what we last wrote
		mockGenerateHash.mockResolvedValue("user-edited-hash");

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		expect(clientManager.downloadFile).not.toHaveBeenCalled();
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("filters out non-sync-artifact items from the index", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "web-doc.md", sha256: "sha-doc", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "web-doc" },
			{ path: "artifact.md", sha256: "sha-art", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			{ path: "no-type.md", sha256: "sha-none", size: 4, updated_at: "2026-01-01T00:00:00Z" }, // no type = treated as sync-artifact
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
		vault.getAbstractFileByPath.mockReturnValue(null);

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		// Only artifact.md and no-type.md should be downloaded (not web-doc.md)
		expect(clientManager.downloadFile).toHaveBeenCalledTimes(2);
		expect(clientManager.downloadFile).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "artifact.md");
		expect(clientManager.downloadFile).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "no-type.md");
		expect(clientManager.downloadFile).not.toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "web-doc.md");
	});

	test.each([new RelayHttpError(503, "unavailable"), new Error("Request timed out"),
		Object.assign(new Error("Socket failed"), { code: "ETIMEDOUT" })])(
		"stops the remaining batch after a transient download failure: %s", async (failure) => {
			const persistedHashes = new Map<string, Record<string, string>>();
			downloader = new InboundFileDownloader(vault, fileManager as unknown as FileManager,
				clientManager as any, webSyncManager as any, persistedHashes);
			clientManager.getFilesIndex.mockResolvedValue([
				{ path: "one.md", sha256: "hash-aabbcc", size: 4, updated_at: "now", type: "sync-artifact" },
				{ path: "two.md", sha256: "hash-aabbcc", size: 4, updated_at: "now", type: "sync-artifact" },
				{ path: "three.md", sha256: "hash-aabbcc", size: 4, updated_at: "now", type: "sync-artifact" },
			]);
			clientManager.downloadFile.mockResolvedValueOnce(new ArrayBuffer(4)).mockRejectedValueOnce(failure);
			await expect(downloader.downloadShare(SHARE_ID, SERVER_ID)).rejects.toThrow(failure);
			expect(clientManager.downloadFile).toHaveBeenCalledTimes(2);
			expect(persistedHashes.get(SHARE_ID)).toEqual({ "one.md": "hash-aabbcc" });
			expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
			// Completed files remain in the manifest, so recovery starts with the
			// failed file rather than re-downloading the whole share.
			clientManager.downloadFile.mockResolvedValue(new ArrayBuffer(4));
			await downloader.downloadShare(SHARE_ID, SERVER_ID);
			expect(clientManager.downloadFile).toHaveBeenCalledTimes(4);
			expect(persistedHashes.get(SHARE_ID)).toEqual({
				"one.md": "hash-aabbcc", "two.md": "hash-aabbcc", "three.md": "hash-aabbcc",
			});
		},
	);

	test("does nothing when files index is empty", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([]);

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("handles share path resolution failure gracefully", async () => {
		(clientManager.getShare as jest.Mock).mockRejectedValue(new Error("Not found"));

		await expect(downloader.downloadShare(SHARE_ID, SERVER_ID)).resolves.toBe("ran");
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("handles files index fetch failure gracefully", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockRejectedValue(new Error("Server error"));

		await expect(downloader.downloadShare(SHARE_ID, SERVER_ID)).resolves.toBe("ran");
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("handles download failure for individual file gracefully (other files still written)", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "fail.md", sha256: "sha-fail", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			{ path: "ok.md", sha256: "sha-ok", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		vault.getAbstractFileByPath.mockReturnValue(null);
		(clientManager.downloadFile as jest.Mock)
			.mockRejectedValueOnce(new Error("Download failed"))
			.mockResolvedValueOnce(new ArrayBuffer(4));

		await expect(downloader.downloadShare(SHARE_ID, SERVER_ID)).resolves.toBe("ran");
		expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
		expect(vault.adapter.writeBinary).toHaveBeenCalledWith(`${SHARE_PATH}/ok.md`, expect.any(ArrayBuffer));
	});

	describe("echo-loop guard (isInboundWriting)", () => {
		test("isInboundWriting returns true during vault write, false after", async () => {
			const vaultPath = `${SHARE_PATH}/note.md`;
			let writingDuringWrite = false;

			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
			vault.getAbstractFileByPath.mockReturnValue(null);

			vault.adapter.writeBinary = jest.fn().mockImplementation(async (path: string) => {
				writingDuringWrite = downloader.isInboundWriting(path);
			}) as any;

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(writingDuringWrite).toBe(true);
			expect(downloader.isInboundWriting(vaultPath)).toBe(false);
		});

		test("isInboundWriting returns false when no write is in progress", () => {
			expect(downloader.isInboundWriting("any/path.md")).toBe(false);
		});

		test("writingPaths is cleared even when writeBinary throws", async () => {
			const vaultPath = `${SHARE_PATH}/error.md`;

			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "error.md", sha256: "sha-err", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
			vault.getAbstractFileByPath.mockReturnValue(null);
			vault.adapter.writeBinary = jest.fn().mockRejectedValue(new Error("Disk full")) as any;

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			// Guard must be cleared in finally block
			expect(downloader.isInboundWriting(vaultPath)).toBe(false);
		});
	});

	test("skips file when readBinary throws (avoid data loss)", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		vault.getAbstractFileByPath.mockReturnValue(null);

		// First download: write file, establishing lastHash = "sha-001"
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		jest.clearAllMocks();

		// Second download: new sha-002, file exists, readBinary throws
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-002", size: 8, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
		]);
		const existingFile = new TFile(`${SHARE_PATH}/note.md`);
		vault.getAbstractFileByPath.mockReturnValue(existingFile);
		vault.readBinary.mockRejectedValue(new Error("IO error"));

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		// Should skip rather than risk overwriting the file
		expect(clientManager.downloadFile).not.toHaveBeenCalled();
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("destroy clears internal state", () => {
		downloader.destroy();
		// After destroy, no in-flight paths remain
		expect(downloader.isInboundWriting("any/path.md")).toBe(false);
	});

	describe("path-traversal guard", () => {
		test("rejects relativePath that escapes sharePath (../../etc/passwd)", async () => {
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "../../etc/passwd", sha256: "sha-evil", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			vault.getAbstractFileByPath.mockReturnValue(null);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
		});

		test("rejects relativePath targeting .obsidian/plugins", async () => {
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "../../.obsidian/plugins/evil.js", sha256: "sha-evil2", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			vault.getAbstractFileByPath.mockReturnValue(null);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
		});

		test("allows valid relative paths inside sharePath", async () => {
			const content = new ArrayBuffer(4);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "subdir/note.md", sha256: "sha-ok", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(content);
			vault.getAbstractFileByPath.mockReturnValue(null);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(vault.adapter.writeBinary).toHaveBeenCalledWith(
				`${SHARE_PATH}/subdir/note.md`,
				content,
			);
		});

		test("rejects traversal but still processes safe files in same batch", async () => {
			const content = new ArrayBuffer(4);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "../../etc/passwd", sha256: "sha-evil", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
				{ path: "safe.md", sha256: "sha-safe", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(content);
			vault.getAbstractFileByPath.mockReturnValue(null);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			// Only the safe file should be written
			expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
			expect(vault.adapter.writeBinary).toHaveBeenCalledWith(`${SHARE_PATH}/safe.md`, content);
		});

		test("fails closed when server-supplied sharePath is empty", async () => {
			(clientManager.getShare as jest.Mock).mockResolvedValue({ ...makeShare(), path: "" });
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "../../etc/passwd", sha256: "sha-evil", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
				{ path: "note.md", sha256: "sha-ok", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			vault.getAbstractFileByPath.mockReturnValue(null);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			// An empty sharePath must reject everything, not implicitly allow root-relative paths.
			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
		});
	});

	// ─── persisted hash manifest survives a "restart" ────────
	describe("persisted hash manifest", () => {
		test("REGRESSION: a user edit is still detected after the manifest is reloaded from a persisted store (simulated restart)", async () => {
			// A plain Map here stands in for VaultScopedMap — the point under test is
			// that the manifest OUTLIVES the InboundFileDownloader instance, not the
			// specific persistence backend.
			const persistedStore = new Map<string, Record<string, string>>();

			const firstSession = new InboundFileDownloader(
				vault,
				fileManager as unknown as FileManager,
				clientManager as any,
				webSyncManager as any,
				persistedStore,
			);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
			vault.getAbstractFileByPath.mockReturnValue(null);
			await firstSession.downloadShare(SHARE_ID, SERVER_ID);
			expect(persistedStore.get(SHARE_ID)).toEqual({ "note.md": "sha-001" });

			jest.clearAllMocks();
			noticeMock.mockClear();

			// "Restart": brand-new InboundFileDownloader instance (in-memory state
			// gone, exactly like a plugin reload), but wired to the SAME persisted
			// store — this is what main.ts does via VaultScopedMap across a real restart.
			const secondSession = new InboundFileDownloader(
				vault,
				fileManager as unknown as FileManager,
				clientManager as any,
				webSyncManager as any,
				persistedStore,
			);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "note.md", sha256: "sha-002", size: 12, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
			]);
			const existingFile = new TFile(`${SHARE_PATH}/note.md`);
			vault.getAbstractFileByPath.mockReturnValue(existingFile);
			// The user edited the file locally while Obsidian was closed.
			mockGenerateHash.mockResolvedValue("user-edited-hash");

			await secondSession.downloadShare(SHARE_ID, SERVER_ID);

			// The pre-fix bug: a fresh in-memory manifest reads as "no history", the
			// `if (lastHash)` guard never fires, and this call overwrites the user's
			// edit unconditionally. Fixed: the persisted manifest survives the
			// "restart" so the edit is still detected and the file is left alone.
			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
			expect(noticeMock).toHaveBeenCalledTimes(1);
			expect(noticeMock.mock.calls[0][0]).toContain("note.md");
		});

		test("shows a Notice when skipping a user-edited (or unknown-provenance) file", async () => {
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "note.md", sha256: "sha-002", size: 12, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
			]);
			const existingFile = new TFile(`${SHARE_PATH}/note.md`);
			vault.getAbstractFileByPath.mockReturnValue(existingFile);
			mockGenerateHash.mockResolvedValue("some-other-hash");

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(noticeMock).toHaveBeenCalledTimes(1);
			const [message] = noticeMock.mock.calls[0];
			expect(message).toContain("note.md");
			expect(message.toLowerCase()).toContain("skipped");
		});

		test("REGRESSION: a local file with NO recorded history is no longer silently overwritten if it differs from the server", async () => {
			// Fresh manifest (no prior download at all — not just a restart), and a
			// local file that already exists with content the downloader has never
			// seen. The old `if (lastHash)` guard skipped the whole safety check in
			// this case and downloaded straight over it.
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "preexisting.md", sha256: "sha-server", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			const existingFile = new TFile(`${SHARE_PATH}/preexisting.md`);
			vault.getAbstractFileByPath.mockReturnValue(existingFile);
			mockGenerateHash.mockResolvedValue("hash-of-unrelated-local-content");

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
			expect(noticeMock).toHaveBeenCalledTimes(1);
		});

		test("a local file with no history that ALREADY matches the server content is accepted (no false-positive skip)", async () => {
			const content = new ArrayBuffer(4);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "preexisting.md", sha256: "sha-server", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			const existingFile = new TFile(`${SHARE_PATH}/preexisting.md`);
			vault.getAbstractFileByPath.mockReturnValue(existingFile);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(content);
			// Local content happens to already match what the server has.
			mockGenerateHash.mockResolvedValue("sha-server");

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(noticeMock).not.toHaveBeenCalled();
		});

		test("destroy() does NOT clear an injected (persisted) hash manifest", async () => {
			const persistedStore = new Map<string, Record<string, string>>();
			const persistentDownloader = new InboundFileDownloader(
				vault,
				fileManager as unknown as FileManager,
				clientManager as any,
				webSyncManager as any,
				persistedStore,
			);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
			vault.getAbstractFileByPath.mockReturnValue(null);
			await persistentDownloader.downloadShare(SHARE_ID, SERVER_ID);
			expect(persistedStore.size).toBe(1);

			persistentDownloader.destroy();

			// The whole point of injecting a persisted store is that plugin
			// unload/reload does not wipe it — only in-memory-only state does.
			expect(persistedStore.size).toBe(1);
			expect(persistedStore.get(SHARE_ID)).toEqual({ "note.md": "sha-001" });
		});
	});

	// ─── Sync conflict dedup + resolution ──────────────────────────
	//
	// Bug: the skip-and-notify branch above fired a Notice(..., 0) — an
	// eternal toast — on EVERY sync cycle for the same unresolved conflict,
	// with no way to act on it. Fixed: dedup by (localHash, serverHash) pair
	// so an unchanged conflict re-notifies at most once, a finite timeout
	// instead of 0, and getConflicts()/resolveTakeServer()/resolveKeepLocal()
	// for the "Show sync conflicts" command to act on it.
	describe("sync conflict dedup + resolution", () => {
		function conflictSetup() {
			clientManager.getShare.mockResolvedValue(makeShare());
			clientManager.getFilesIndex.mockResolvedValue([
				{ path: "note.md", sha256: "server-hash-1", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			const existingFile = new TFile(`${SHARE_PATH}/note.md`);
			vault.getAbstractFileByPath.mockReturnValue(existingFile);
			mockGenerateHash.mockResolvedValue("local-edit-hash");
		}

		test("REGRESSION: does not re-notify on repeated cycles while the conflict is unchanged", async () => {
			conflictSetup();

			await downloader.downloadShare(SHARE_ID, SERVER_ID);
			await downloader.downloadShare(SHARE_ID, SERVER_ID);
			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			// Pre-fix: this was 3 (one per cycle, stack grows forever).
			expect(noticeMock).toHaveBeenCalledTimes(1);
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
		});

		test("uses the common bundle timeout (8000ms), not an eternal Notice(0)", async () => {
			conflictSetup();

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(noticeMock.mock.calls[0][1]).toBe(8000);
		});

		test("dedup is not silent: a server-side change re-notifies", async () => {
			conflictSetup();
			await downloader.downloadShare(SHARE_ID, SERVER_ID);
			expect(noticeMock).toHaveBeenCalledTimes(1);

			clientManager.getFilesIndex.mockResolvedValue([
				{ path: "note.md", sha256: "server-hash-2", size: 8, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
			]);
			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(noticeMock).toHaveBeenCalledTimes(2);
		});

		test("getConflicts() lists the unresolved conflict", async () => {
			conflictSetup();
			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			const conflicts = downloader.getConflicts();
			expect(conflicts).toHaveLength(1);
			expect(conflicts[0]).toMatchObject({
				shareId: SHARE_ID,
				relativePath: "note.md",
				vaultPath: `${SHARE_PATH}/note.md`,
				localHash: "local-edit-hash",
				serverHash: "server-hash-1",
			});
		});

		test("resolveTakeServer() uses FileManager.trashFile and clears the conflict", async () => {
			conflictSetup();
			await downloader.downloadShare(SHARE_ID, SERVER_ID);
			expect(downloader.getConflicts()).toHaveLength(1);
			const localFile = vault.getAbstractFileByPath(`${SHARE_PATH}/note.md`);
			if (!localFile) throw new Error("Expected the conflicting local file");

			await downloader.resolveTakeServer(SHARE_ID, "note.md");

			expect(fileManager.trashFile).toHaveBeenCalledTimes(1);
			expect(fileManager.trashFile).toHaveBeenCalledWith(localFile);
			expect(vault.delete).not.toHaveBeenCalled();
			expect(downloader.getConflicts()).toHaveLength(0);
		});

		test("resolveTakeServer() retains the conflict when trashFile fails", async () => {
			conflictSetup();
			await downloader.downloadShare(SHARE_ID, SERVER_ID);
			const error = new Error("Trash unavailable");
			fileManager.trashFile.mockRejectedValueOnce(error);

			await expect(downloader.resolveTakeServer(SHARE_ID, "note.md")).rejects.toThrow(error);

			expect(downloader.getConflicts()).toHaveLength(1);
			expect(vault.delete).not.toHaveBeenCalled();
		});

		test("resolveTakeServer() then the next sync cycle downloads the server version", async () => {
			conflictSetup();
			await downloader.downloadShare(SHARE_ID, SERVER_ID);
			await downloader.resolveTakeServer(SHARE_ID, "note.md");

			// File is gone now — next cycle sees no local file at all.
			vault.getAbstractFileByPath.mockReturnValue(null);
			const content = new ArrayBuffer(4);
			clientManager.downloadFile.mockResolvedValue(content);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(clientManager.downloadFile).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "note.md");
			expect(vault.adapter.writeBinary).toHaveBeenCalledWith(`${SHARE_PATH}/note.md`, content);
		});

		test("resolveKeepLocal() does NOT touch the local file and clears the conflict", async () => {
			conflictSetup();
			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			downloader.resolveKeepLocal(SHARE_ID, "note.md");

			expect(vault.delete).not.toHaveBeenCalled();
			expect(fileManager.trashFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
			expect(downloader.getConflicts()).toHaveLength(0);
		});

		test("resolveKeepLocal() then an unchanged server hash does not re-conflict or re-download", async () => {
			conflictSetup();
			await downloader.downloadShare(SHARE_ID, SERVER_ID);
			downloader.resolveKeepLocal(SHARE_ID, "note.md");
			jest.clearAllMocks();

			// Same server hash as before — downloadShare's own `lastHash ===
			// serverSha256` short-circuit should now fire immediately.
			clientManager.getShare.mockResolvedValue(makeShare());
			clientManager.getFilesIndex.mockResolvedValue([
				{ path: "note.md", sha256: "server-hash-1", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(noticeMock).not.toHaveBeenCalled();
			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
			expect(downloader.getConflicts()).toHaveLength(0);
		});

		test("resolveKeepLocal() then a genuinely NEW server change re-surfaces as a fresh conflict", async () => {
			conflictSetup();
			await downloader.downloadShare(SHARE_ID, SERVER_ID);
			downloader.resolveKeepLocal(SHARE_ID, "note.md");
			jest.clearAllMocks();

			// Server moved again since the acknowledged hash — local content
			// (still the same edit) is now a fresh mismatch.
			clientManager.getShare.mockResolvedValue(makeShare());
			clientManager.getFilesIndex.mockResolvedValue([
				{ path: "note.md", sha256: "server-hash-2", size: 8, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
			]);
			const existingFile = new TFile(`${SHARE_PATH}/note.md`);
			vault.getAbstractFileByPath.mockReturnValue(existingFile);
			mockGenerateHash.mockResolvedValue("local-edit-hash");

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(noticeMock).toHaveBeenCalledTimes(1);
			expect(downloader.getConflicts()).toHaveLength(1);
		});

		test("resolving a conflict that doesn't exist is a no-op (no throw)", async () => {
			await expect(downloader.resolveTakeServer("no-such-share", "nope.md")).resolves.toBeUndefined();
			expect(() => downloader.resolveKeepLocal("no-such-share", "nope.md")).not.toThrow();
			expect(vault.delete).not.toHaveBeenCalled();
			expect(fileManager.trashFile).not.toHaveBeenCalled();
		});

		test("getConflicts() is empty when there are no conflicts", () => {
			expect(downloader.getConflicts()).toEqual([]);
		});
	});
});

// ─── persisted lastUpdatedAt survives a "restart" ──────────
describe("InboundSyncPoller persisted lastUpdatedAt", () => {
	let timeProvider: MockClock;
	let clientManager: ReturnType<typeof makeMockClientManager>;
	let webSyncManager: ReturnType<typeof makeMockWebSyncManager>;
	let fileDownloader: jest.Mocked<Pick<InboundFileDownloader, "downloadShare" | "isInboundWriting">>;
	let startTime: number;

	beforeEach(() => {
		jest.clearAllMocks();
		timeProvider = new MockClock();
		startTime = timeProvider.now();
		clientManager = makeMockClientManager();
		webSyncManager = makeMockWebSyncManager();
		fileDownloader = {
			downloadShare: jest.fn<() => Promise<"ran" | "skipped">>().mockResolvedValue("ran"),
			isInboundWriting: jest.fn<() => boolean>().mockReturnValue(false),
		};
	});

	test("REGRESSION: registerShare seeds lastUpdatedAt from the persisted store instead of always null, so an unchanged share does not re-download on restart", async () => {
		const ts = "2026-06-08T10:00:00Z";
		const persistedStore = new Map<string, string>([[SHARE_ID, ts]]);
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			fileDownloader as any,
			30_000,
			persistedStore,
		);
		// Server content is unchanged since the persisted watermark.
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare(ts));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		// Pre-fix bug: registerShare always started at lastUpdatedAt=null, so this
		// first poll would read as "bumped" and trigger a full re-download even
		// though nothing changed server-side. Fixed: seeded from the persisted
		// watermark, so an unchanged share stays skipped.
		expect(fileDownloader.downloadShare).not.toHaveBeenCalled();
	});

	test("a genuinely new share (not in the persisted store) still downloads on first poll", async () => {
		const persistedStore = new Map<string, string>();
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			fileDownloader as any,
			30_000,
			persistedStore,
		);
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(fileDownloader.downloadShare).toHaveBeenCalledWith(SHARE_ID, SERVER_ID);
	});

	test("advancing lastUpdatedAt writes through to the persisted store, not just the in-memory copy", async () => {
		const persistedStore = new Map<string, string>();
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			fileDownloader as any,
			30_000,
			persistedStore,
		);
		const ts = "2026-06-08T10:00:00Z";
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare(ts));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(persistedStore.get(SHARE_ID)).toBe(ts);
	});

	test("a skipped download (outbound sync in flight) does NOT advance the persisted watermark", async () => {
		const persistedStore = new Map<string, string>();
		fileDownloader.downloadShare = jest
			.fn<() => Promise<"ran" | "skipped">>()
			.mockResolvedValue("skipped");
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			fileDownloader as any,
			30_000,
			persistedStore,
		);
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(persistedStore.has(SHARE_ID)).toBe(false);
	});
});

describe("InboundSyncPoller: shares checked from the share list", () => {
	let timeProvider: MockClock;
	let clientManager: ReturnType<typeof makeMockClientManager>;
	let webSyncManager: ReturnType<typeof makeMockWebSyncManager>;

	beforeEach(() => {
		jest.clearAllMocks();
		timeProvider = new MockClock();
		clientManager = makeMockClientManager();
		webSyncManager = makeMockWebSyncManager();
	});

	test("two list loads close together download a share once at a time, and the watermark never moves back", async () => {
		const store = new Map<string, string>();
		let releaseFirst!: () => void;
		const order: string[] = [];
		const downloadShare = jest
			.fn<() => Promise<"ran" | "skipped">>()
			.mockImplementationOnce(() => {
				order.push("start-1");
				return new Promise((resolve) => (releaseFirst = () => { order.push("end-1"); resolve("ran"); }));
			})
			.mockImplementation(async () => {
				order.push("start-n");
				return "ran";
			});
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			{ downloadShare, isInboundWriting: () => false } as any,
			30_000,
			store,
		);

		const first = poller.checkListedShare("remote", SERVER_ID, "2026-06-08T10:00:00Z");
		const second = poller.checkListedShare("remote", SERVER_ID, "2026-06-08T11:00:00Z");
		await flushPromises();
		expect(order).toEqual(["start-1"]);
		releaseFirst();
		await Promise.all([first, second]);

		expect(order).toEqual(["start-1", "end-1", "start-n"]);
		expect(store.get("remote")).toBe("2026-06-08T11:00:00Z");

		// An older listing seen later does not pull the watermark back.
		await poller.checkListedShare("remote", SERVER_ID, "2026-06-08T10:00:00Z");
		expect(downloadShare).toHaveBeenCalledTimes(2);
		expect(store.get("remote")).toBe("2026-06-08T11:00:00Z");
	});

	test("a share that turns local while its listed check runs is not polled over it, and keeps the newer watermark", async () => {
		const store = new Map<string, string>();
		let releaseListed!: () => void;
		const downloadShare = jest
			.fn<() => Promise<"ran" | "skipped">>()
			.mockImplementationOnce(() => new Promise((resolve) => (releaseListed = () => resolve("ran"))))
			.mockResolvedValue("ran");
		(clientManager.getShare as unknown as jest.Mock<() => Promise<unknown>>).mockResolvedValue(makeShare("2026-06-08T11:00:00Z"));
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			{ downloadShare, isInboundWriting: () => false } as any,
			30_000,
			store,
		);

		poller.track("s", SERVER_ID, false, "2026-06-08T10:00:00Z");
		await flushPromises();
		poller.track("s", SERVER_ID, true, null);
		poller.start();
		timeProvider.setTime(timeProvider.now() + 30_000);
		await flushPromises();
		// Not polled while the listed download is still running.
		expect(clientManager.getShare).not.toHaveBeenCalled();

		releaseListed();
		await flushPromises();
		timeProvider.setTime(timeProvider.now() + 30_000);
		await flushPromises();
		expect(clientManager.getShare).toHaveBeenCalledTimes(1);
		expect(store.get("s")).toBe("2026-06-08T11:00:00Z");
	});

	test("a listed download that finishes after a newer poll does not pull the watermark back", async () => {
		const store = new Map<string, string>();
		let releaseListed!: () => void;
		const downloadShare = jest
			.fn<() => Promise<"ran" | "skipped">>()
			.mockImplementationOnce(() => new Promise((resolve) => (releaseListed = () => resolve("ran"))));
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			{ downloadShare, isInboundWriting: () => false } as any,
			30_000,
			store,
		);

		const listed = poller.checkListedShare("s", SERVER_ID, "2026-06-08T10:00:00Z");
		await flushPromises();
		store.set("s", "2026-06-08T11:00:00Z"); // a poll of the share got there first
		releaseListed();
		await listed;

		expect(store.get("s")).toBe("2026-06-08T11:00:00Z");
	});

	test("a check from the share list waits for a poll of the same share already running, and keeps its watermark", async () => {
		const store = new Map<string, string>();
		let releasePoll!: () => void;
		const order: string[] = [];
		const downloadShare = jest
			.fn<() => Promise<"ran" | "skipped">>()
			.mockImplementationOnce(() => {
				order.push("poll-start");
				return new Promise((resolve) => (releasePoll = () => { order.push("poll-end"); resolve("ran"); }));
			})
			.mockImplementation(async () => {
				order.push("listed");
				return "ran";
			});
		(clientManager.getShare as unknown as jest.Mock<() => Promise<unknown>>).mockResolvedValue(makeShare("2026-06-08T11:00:00Z"));
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			{ downloadShare, isInboundWriting: () => false } as any,
			30_000,
			store,
		);

		poller.registerShare("s", SERVER_ID);
		poller.start();
		timeProvider.setTime(timeProvider.now() + 30_000);
		await flushPromises();
		expect(order).toEqual(["poll-start"]);

		const listed = poller.checkListedShare("s", SERVER_ID, "2026-06-08T10:00:00Z");
		await flushPromises();
		expect(order).toEqual(["poll-start"]);
		releasePoll();
		await listed;

		// The older listed timestamp is not downloaded over the poll's newer one.
		expect(order).toEqual(["poll-start", "poll-end"]);
		expect(store.get("s")).toBe("2026-06-08T11:00:00Z");
	});

	test("a poll answering an older timestamp than a listed download does not pull the watermark back", async () => {
		const store = new Map<string, string>();
		const downloadShare = jest.fn<() => Promise<"ran" | "skipped">>().mockResolvedValue("ran");
		(clientManager.getShare as unknown as jest.Mock<() => Promise<unknown>>).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			{ downloadShare, isInboundWriting: () => false } as any,
			30_000,
			store,
		);

		poller.registerShare("s", SERVER_ID);
		await poller.checkListedShare("s", SERVER_ID, "2026-06-08T11:00:00Z");
		expect(downloadShare).toHaveBeenCalledTimes(1);
		poller.start();
		timeProvider.setTime(timeProvider.now() + 30_000);
		await flushPromises();

		expect(downloadShare).toHaveBeenCalledTimes(1);
		expect(store.get("s")).toBe("2026-06-08T11:00:00Z");
	});

	test("retainOnly stops polling the shares it rejects", async () => {
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			{ downloadShare: jest.fn(), isInboundWriting: () => false } as any,
			30_000,
		);
		(clientManager.getShare as unknown as jest.Mock<() => Promise<unknown>>).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));
		poller.registerShare("kept", SERVER_ID);
		poller.registerShare("unshared", SERVER_ID);

		poller.retainOnly((id) => id === "kept");
		poller.start();
		timeProvider.setTime(timeProvider.now() + 30_000);
		await flushPromises();

		expect((clientManager.getShare as jest.Mock).mock.calls.map((c) => c[1])).toEqual(["kept"]);
	});
});
