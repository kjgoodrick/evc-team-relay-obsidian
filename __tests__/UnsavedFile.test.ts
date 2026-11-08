import { UnsavedFileStore } from "src/UnsavedFile";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { testGlobal } from "./mocks/testGlobal";

// Use real IndexedDB transaction scheduling and keyPath semantics, including
// late aborts after an individual request reports success.
function installFakeIndexedDB(): void {
	(testGlobal as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
}

describe("UnsavedFileStore (: guid wire-format guard)", () => {
	beforeEach(() => {
		installFakeIndexedDB();
	});

	it("round-trips a saved buffer by guid", async () => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("doc-guid-1", "unsaved contents");

		const readBack = await store.readUnsaved("doc-guid-1");

		expect(readBack).toBe("unsaved contents");
	});

	it("stores the record under a field literally named 'guid', matching the on-disk keyPath", async () => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("doc-guid-2", "other contents");

		// The only way readUnsaved() can find this record at all is if the
		// object persistUnsaved() wrote had a `guid` field equal to the key --
		// exactly the shorthand-object-literal behavior in persistUnsaved()
		// (`store.put({ guid, contents })`) that a renamed parameter would break.
		const readBack = await store.readUnsaved("doc-guid-2");
		expect(readBack).not.toBeNull();

		const missing = await store.readUnsaved("some-other-guid");
		expect(missing).toBeNull();
	});

	it("discardUnsaved removes the buffer so a later read returns null", async () => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("doc-guid-3", "to be discarded");

		await store.discardUnsaved("doc-guid-3");

		expect(await store.readUnsaved("doc-guid-3")).toBeNull();
	});
});


describe("UnsavedFileStore transaction durability", () => {
	beforeEach(installFakeIndexedDB);
	afterEach(() => jest.restoreAllMocks());

	it.each(["put", "delete", "get"] as const)("a late %s abort is reported and preserves the last committed buffer", async operation => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("retained", "COMMITTED TEXT");
		const original = IDBObjectStore.prototype[operation]; let succeeded = false;
		const spy = jest.spyOn(IDBObjectStore.prototype, operation).mockImplementation(function (this: globalThis.IDBObjectStore, ...args: unknown[]) {
			const request = Reflect.apply(original, this, args) as IDBRequest;
			const transaction = this.transaction;
			request.addEventListener("success", () => {
				succeeded = true;
				queueMicrotask(() => transaction.abort());
			}, { once: true });
			return request;
		});
		const action = operation === "put" ? store.persistUnsaved("retained", "UNCOMMITTED TEXT")
			: operation === "delete" ? store.discardUnsaved("retained") : store.readUnsaved("retained");
		await expect(action).rejects.toThrow(); expect(succeeded).toBe(true);
		spy.mockRestore();
		expect(await store.readUnsaved("retained")).toBe("COMMITTED TEXT");
		await store.persistUnsaved("retained", "RETRIED TEXT");
		expect(await store.readUnsaved("retained")).toBe("RETRIED TEXT");
	});

	it("an invalid record fails without stranding the next transaction", async () => {
		const store = new UnsavedFileStore();
		await expect(store.persistUnsaved(undefined as unknown as string, "invalid key")).rejects.toThrow();
		await store.persistUnsaved("valid", "retained");
		expect(await store.readUnsaved("valid")).toBe("retained");
	});
});
