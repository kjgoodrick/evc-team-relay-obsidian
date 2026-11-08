import type { RelayCredentialCache } from "../RelayCredentialCache";
import type { RestoreBinding } from "../collaboration/RestoreGeneration";
import { restoreContext, restoreMetadata } from "../collaboration/RestoreGeneration";
import { sourceCacheEndpoint } from "../storage/source-document-cache";
import type { ManagedManifest } from "./ManagedIndexTransport";
import type { ManagedAttachmentReadOptions } from "./readManagedAttachment";

const MAX_BYTES = 16 * 1024 * 1024;
class InventoryInspectionFailure extends Error {}

/** Fresh read-only inventory inspection. It creates no index Y.Doc, performs no
 * reconciliation and never adopts the response's generation. Entry semantics
 * are validated against the captured installation plan by preparation. */
export async function readManagedInventory(credentials: RelayCredentialCache, documentId: string, serverId: string | undefined,
	binding: RestoreBinding, options: ManagedAttachmentReadOptions = {}): Promise<ManagedManifest> {
	binding = Object.freeze(restoreMetadata(binding));
	const timeout = options.timeoutMs ?? 30_000, limit = options.maxBytes ?? MAX_BYTES;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BYTES) {
		throw new InventoryInspectionFailure("Invalid inventory inspection limits");
	}
	const signal = options.signal, inputCheck = options.check, fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
	const context = credentials.captureDocumentSourceContext(serverId);
	if (!context) throw new InventoryInspectionFailure("The inventory server is unavailable");
	const endpoint = sourceCacheEndpoint(context.controlPlaneUrl), controller = new AbortController();
	let ended = false, timer: number | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const cancelled = () => Object.assign(new InventoryInspectionFailure("Inventory inspection was cancelled"), { name: "AbortError" });
	const active = () => { if (ended) throw new InventoryInspectionFailure("Inventory inspection has ended"); if (signal?.aborted) throw cancelled(); context.check(); inputCheck?.(); };
	const close = () => { if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Pending reads are fenced. */ } reader = undefined; } };
	let abort: (() => void) | undefined;
	const interrupted = new Promise<never>((_resolve, reject) => {
		abort = () => { ended = true; controller.abort(); close(); reject(cancelled()); };
		signal?.addEventListener("abort", abort, { once: true });
		timer = window.setTimeout(() => { ended = true; controller.abort(); close(); reject(new InventoryInspectionFailure("Inventory inspection timed out")); }, timeout);
	});
	const run = async () => {
		active(); const selected = await credentials.requestInventoryInspectionToken(documentId, context.serverId, binding, active);
		const grant = selected.grant;
		const current = () => { active(); selected.check(); if (!grant.expiryTime || grant.expiryTime <= Date.now()) throw new InventoryInspectionFailure("The inventory inspection grant expired"); };
		current();
		if (grant.url !== endpoint + "/v1/managed/index") throw new InventoryInspectionFailure("The inventory grant points outside the selected source");
		const url = `${grant.url}/${grant.folder}`;
		const response = await fetcher(url, { method: "GET", headers: { Authorization: `Bearer ${grant.token}` }, signal: controller.signal,
			redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
		try { current(); } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
		reader = response.body?.getReader();
		if (response.status !== 200 || response.redirected || response.url && response.url !== url || !reader) throw new InventoryInspectionFailure("The inventory cannot be streamed from the selected source");
		const length = response.headers.get("Content-Length");
		if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) throw new InventoryInspectionFailure("The inventory exceeds its download limit");
		let bytes = new Uint8Array(Math.min(limit, 64 * 1024)), offset = 0, chunks = 0;
		for (;;) {
			if (++chunks % 128 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
			current(); const part = await reader.read(); current(); if (part.done) break;
			const needed = offset + part.value.byteLength;
			if (needed > limit) throw new InventoryInspectionFailure("The inventory exceeds its download limit");
			if (needed > bytes.length) { const larger = new Uint8Array(Math.min(limit, Math.max(needed, bytes.length * 2))); larger.set(bytes); bytes = larger; }
			bytes.set(part.value, offset); offset = needed;
		}
		const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)));
		const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
		if (!object(raw) || !object(raw.records) || !object(raw.permissions) || !object(raw.activity) || typeof raw.owner !== "boolean"
			|| Object.keys(raw.records).length > 10_000) throw new InventoryInspectionFailure("The inventory response is invalid or too large");
		const restored = restoreContext(raw.restore_guard, raw.restore_generation);
		if (restored?.supported !== true || restored.generation !== (binding.restoreGeneration ?? null)) throw new InventoryInspectionFailure("The inventory source was restored again. Refresh the review.");
		current(); return raw as unknown as ManagedManifest;
	};
	try { return await Promise.race([run(), interrupted]); }
	catch (error) { if (error instanceof InventoryInspectionFailure) throw error; throw new InventoryInspectionFailure("Could not inspect the inventory. Refresh the source and retry."); }
	finally { ended = true; window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); controller.abort(); close(); }
}
