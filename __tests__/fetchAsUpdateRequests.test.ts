/**
 * Regression test: under a bulk sync every fetched relay-linked doc sent
 * `GET <relay>/d/<docId>/<docId>/as-update`, got a 404, logged an error and
 * only then fell back to the WebSocket sync that actually delivers the doc.
 *
 * Two defects, both covered here:
 * - endpointBase() appended the doc id to a relay URL that already carries
 *   it (`wss://<host>/d/<docId>/ws`), so the path was wrong.
 * - fetchDocument()/fetchCanvas() made the HTTP request at all for
 *   relay-linked docs, whose content comes over the WebSocket anyway.
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import { requestUrl } from "obsidian";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import { CanvasDocument } from "../src/CanvasDocument";
import { RemoteCanvasAddress, RemoteDocumentAddress } from "../src/ResourceAddress";
import type { DocumentGrant } from "../src/relay/TokenShapes";
import * as Y from "yjs";
import { MockClock } from "./mocks/MockClock";

const DOC_ID = "0a543bf2-1a47-4bb9-829d-91225ae7fe11";
const RELAY_ID = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const FOLDER_ID = "165a1157-9bae-426d-b11e-34093f01ccb2";

async function flushMicrotasks(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

function grant(url: string): DocumentGrant {
	return { token: "cwt", url, docId: DOC_ID } as DocumentGrant;
}

function makeRelayLinkedDoc<T extends Document | CanvasDocument>(proto: object, address: unknown) {
	const writeContents = jest
		.fn<(doc: unknown, content: unknown) => Promise<void>>()
		.mockResolvedValue(undefined);
	const doc = Object.create(proto) as T;
	Object.defineProperty(doc, "entryPath", { value: "note.md" });
	Object.defineProperty(doc, "entityGuid", { value: DOC_ID });
	Object.defineProperty(doc, "editLock", { value: false, writable: true });
	Object.defineProperty(doc, "resourceAddress", { value: address });
	Object.defineProperty(doc, "crdtDoc", { value: new Y.Doc() });
	Object.defineProperty(doc, "requestProviderToken", {
		value: async () => grant(`wss://relay.example/d/${DOC_ID}/ws`),
	});
	Object.defineProperty(doc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(doc, "content", { get: () => "real content from the relay" });
	Object.defineProperty(doc, "canvasJson", { get: () => '{"nodes":[],"edges":[]}' });
	Object.defineProperty(doc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(doc, "bringOnline", { value: async () => true });
	Object.defineProperty(doc, "onceEverSynced", { value: async () => {} });
	Object.defineProperty(doc, "onceFreshlySynced", { value: async () => {} });
	Object.defineProperty(doc, "goOffline", { value: () => {} });
	Object.defineProperty(doc, "getSyncBase", { value: async () => undefined });
	Object.defineProperty(doc, "setSyncBase", { value: async () => {} });
	Object.defineProperty(doc, "vaultShare", {
		value: {
			workspaceId: "test-relay-id",
			absolutePath: (p: string) => p,
			readContents: async () => {
				throw new Error("file does not exist");
			},
			writeContents,
			isDeletePending: () => false,
			hasFile: async () => false,
			folderIndex: { tracks: () => true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});
	return { doc, writeContents };
}

type QueueInternals = {
	fetchDocument: (doc: Document, retry?: number, wait?: number) => Promise<void>;
	fetchCanvas: (canvas: CanvasDocument) => Promise<void>;
	endpointBase: (token: DocumentGrant, entity: unknown) => string;
	error: (...args: unknown[]) => void;
};

function makeQueue(clock = new MockClock()) {
	const queue = new TransferQueue({} as never, clock, {} as never) as unknown as QueueInternals;
	const error = jest.spyOn(queue, "error").mockImplementation(() => {});
	return { queue, clock, error };
}

/** Runs `call` to completion, stepping the clock past uploadDocumentViaSocket()'s grace delay. */
async function settle(clock: MockClock, call: Promise<void>): Promise<void> {
	await flushMicrotasks();
	clock.setTime(clock.now() + 5000);
	await flushMicrotasks();
	await call;
}

describe("as-update requests for relay-linked docs", () => {
	beforeEach(() => {
		(requestUrl as jest.Mock).mockReset();
		(requestUrl as jest.Mock).mockImplementation(async () => ({
			status: 404,
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		}));
	});

	test("fetchDocument syncs over the WebSocket without an HTTP as-update request or an error log", async () => {
		const address = new RemoteDocumentAddress(RELAY_ID, FOLDER_ID, DOC_ID);
		const { doc, writeContents } = makeRelayLinkedDoc<Document>(Document.prototype, address);
		const { queue, clock, error } = makeQueue();

		await settle(clock, queue.fetchDocument(doc, 0, 1000));

		expect(requestUrl).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(writeContents).toHaveBeenCalledWith(doc, "real content from the relay");
	});

	test("fetchCanvas syncs over the WebSocket without an HTTP as-update request or an error log", async () => {
		const address = new RemoteCanvasAddress(RELAY_ID, FOLDER_ID, DOC_ID);
		const { doc, writeContents } = makeRelayLinkedDoc<CanvasDocument>(
			CanvasDocument.prototype,
			address,
		);
		const { queue, clock, error } = makeQueue();

		await settle(clock, queue.fetchCanvas(doc));

		expect(requestUrl).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(writeContents).toHaveBeenCalled();
	});

	test("a Canvas editor keeps ownership of its native file during background fetch", async () => {
		const { doc, writeContents } = makeRelayLinkedDoc<CanvasDocument>(CanvasDocument.prototype, new RemoteCanvasAddress(RELAY_ID, FOLDER_ID, DOC_ID));
		doc.editLock = true;
		const { queue, clock, error } = makeQueue();
		await settle(clock, queue.fetchCanvas(doc));
		expect(writeContents).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
	});

	test("incomplete Canvas editing history cannot overwrite its native file", async () => {
		const { doc, writeContents } = makeRelayLinkedDoc<CanvasDocument>(CanvasDocument.prototype, new RemoteCanvasAddress(RELAY_ID, FOLDER_ID, DOC_ID));
		const author = new Y.Doc(); author.getMap("seed").set("identity", "unavailable prefix");
		const before = Y.encodeStateVector(author); author.getMap("nodes").set("card", { id: "card", text: "pending" });
		Y.applyUpdate(doc.crdtDoc, Y.encodeStateAsUpdate(author, before)); author.destroy();
		expect(doc.crdtDoc.store.pendingStructs).not.toBeNull();
		const { queue, clock, error } = makeQueue();
		await settle(clock, queue.fetchCanvas(doc));
		expect(writeContents).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining("history is incomplete") }));
	});
});

describe("endpointBase", () => {
	test("does not repeat the doc id already present in a control-plane relay URL", () => {
		const { queue } = makeQueue();
		const base = queue.endpointBase(grant(`wss://tr.example/d/${DOC_ID}/ws`), {});
		expect(base).toBe(`https://tr.example/d/${DOC_ID}`);
	});

	test("still appends the doc id to a relay URL without one", () => {
		const { queue } = makeQueue();
		const base = queue.endpointBase(grant("wss://tr.example/doc/ws"), {});
		expect(base).toBe(`https://tr.example/doc/${DOC_ID}`);
	});

	test("prefers an explicit baseUrl", () => {
		const { queue } = makeQueue();
		const token = { ...grant(`wss://tr.example/d/${DOC_ID}/ws`), baseUrl: "https://files.example/b/" };
		expect(queue.endpointBase(token, {})).toBe("https://files.example/b");
	});
});
