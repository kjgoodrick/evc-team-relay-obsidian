import type { RelayCredentialCache } from "../RelayCredentialCache";
import type { RestoreBinding } from "../collaboration/RestoreGeneration";
import { sha256Hex } from "../contentDigest";
import { sourceCacheEndpoint } from "../storage/source-document-cache";

export interface ManagedAttachmentPreview {
	content: ArrayBuffer;
	downloadedAt: string;
	check(): void;
}
export interface ManagedAttachmentReadOptions {
	signal?: AbortSignal;
	check?: () => void;
	timeoutMs?: number;
	maxBytes?: number;
	/** Must supply a streaming, abortable Response and honor redirect: "error".
	 * Obsidian's buffering platformFetch adapter does not satisfy this contract. */
	fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}
class InspectionFailure extends Error {}
const MAX_TRANSFER = 25 * 1024 * 1024; // Managed attachment server limit.

/** Read one captured revision with a fresh read-only grant. No file/cache write,
 * upload, renewal subscription or ordinary attachment object is involved. The
 * default browser transport requires the server to allow the native host origin;
 * there is deliberately no fallback to an unbounded buffering adapter. */
export async function readManagedAttachment(credentials: RelayCredentialCache, documentId: string, fileHash: string,
	serverId: string | undefined, binding: RestoreBinding, options: ManagedAttachmentReadOptions = {}): Promise<ManagedAttachmentPreview> {
	const timeout = options.timeoutMs ?? 30_000, requestedLimit = options.maxBytes ?? MAX_TRANSFER;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000
		|| !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 256 * 1024 * 1024) throw new InspectionFailure("Invalid attachment inspection limits");
	const limit = Math.min(requestedLimit, MAX_TRANSFER), signal = options.signal, inputCheck = options.check;
	const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
	const context = credentials.captureDocumentSourceContext(serverId);
	if (!context) throw new InspectionFailure("The attachment server is unavailable");
	const endpoint = sourceCacheEndpoint(context.controlPlaneUrl), controller = new AbortController();
	let ended = false, invalidated = false, timer: number | undefined;
	let grantCheck: (() => void) | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const cancelled = () => Object.assign(new InspectionFailure("Attachment inspection was cancelled"), { name: "AbortError" });
	const inputCurrent = () => {
		if (invalidated) throw new InspectionFailure("Attachment inspection is no longer valid");
		if (signal?.aborted) throw cancelled();
		context.check(); inputCheck?.();
	};
	const check = () => { inputCurrent(); grantCheck?.(); };
	const active = () => { if (ended) throw new InspectionFailure("Attachment inspection has ended"); check(); };
	const credentialCurrent = () => { if (ended) throw new InspectionFailure("Attachment inspection has ended"); inputCurrent(); };
	const closeReader = () => {
		if (!reader) return;
		void reader.cancel().catch(() => {});
		try { reader.releaseLock(); } catch { /* A pending read is fenced by ended. */ }
		reader = undefined;
	};
	let abort: (() => void) | undefined;
	const interrupted = new Promise<never>((_resolve, reject) => {
		abort = () => { ended = true; controller.abort(); closeReader(); reject(cancelled()); };
		signal?.addEventListener("abort", abort, { once: true });
		timer = window.setTimeout(() => {
			ended = true; controller.abort(); closeReader();
			reject(new InspectionFailure("Attachment inspection timed out. Retry when connected."));
		}, timeout);
	});
	const run = async (): Promise<ManagedAttachmentPreview> => {
		active();
		const selected = await credentials.requestFileInspectionToken(documentId, fileHash, "application/octet-stream", context.serverId, binding, credentialCurrent);
		grantCheck = selected.check; active();
		const grant = selected.grant;
		const base = new URL(grant.baseUrl ?? "");
		const expected = `${endpoint}/shares/${grant.folder}/files/${grant.docId}`;
		if (base.href !== expected || base.username || base.password || base.search || base.hash) throw new InspectionFailure("The attachment grant points outside the selected source");
		const url = `${expected}/content?token=${encodeURIComponent(grant.token)}`;
		const current = () => { active(); if (grant.expiryTime <= Date.now()) throw new InspectionFailure("The attachment inspection grant expired"); };
		current();
		const response = await fetcher(url, { method: "GET", signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
		try { current(); }
		catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
		// Attach the reader before validation so every rejected response is closed.
		reader = response.body?.getReader();
		if (response.status !== 200 || response.redirected || response.url && response.url !== url) throw new InspectionFailure("The attachment download was refused or redirected");
		const length = response.headers.get("Content-Length"), encoding = response.headers.get("Content-Encoding");
		if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
			throw new InspectionFailure("The attachment response has an unsupported size");
		}
		// Fetch exposes decoded bytes. A compressed Content-Length measures the
		// wire body, so only identity responses can use it as the exact size.
		const expectedSize = length !== null && (!encoding || encoding.toLowerCase() === "identity") ? Number(length) : undefined;
		let content = new Uint8Array(expectedSize ?? Math.min(limit, 64 * 1024));
		if (!reader && expectedSize !== 0) throw new InspectionFailure("This host cannot stream the attachment download");
		let offset = 0;
		if (reader) {
			let chunks = 0;
			for (;;) {
				// A buffered stream can resolve reads entirely in microtasks. Yield
				// periodically so cancellation, deadlines and the host UI can run.
				if (++chunks % 128 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
				current(); const part = await reader.read(); current();
				if (part.done) break;
				const needed = offset + part.value.byteLength;
				if (needed > limit || expectedSize !== undefined && needed > expectedSize) throw new InspectionFailure("The attachment exceeds its declared size or download limit");
				if (needed > content.byteLength) {
					const larger = new Uint8Array(Math.min(limit, Math.max(needed, content.byteLength * 2)));
					larger.set(content); content = larger;
				}
				content.set(part.value, offset); offset += part.value.byteLength;
			}
		}
		if (expectedSize !== undefined && offset !== expectedSize) throw new InspectionFailure("The attachment does not match the captured revision");
		if (offset !== content.byteLength) content = content.slice(0, offset);
		if (await sha256Hex(content.buffer) !== fileHash) throw new InspectionFailure("The attachment does not match the captured revision");
		current(); return { content: content.buffer, downloadedAt: new Date().toISOString(), check: inputCurrent };
	};
	try { return await Promise.race([run(), interrupted]); }
	catch (error) {
		invalidated = true;
		if (error instanceof InspectionFailure) throw error;
		// Fetch/URL/stream failures can contain the query credential. Never expose
		// their messages or causes in UI/network diagnostics.
		throw new InspectionFailure("Could not inspect the attachment. Refresh the source and retry.");
	} finally {
		ended = true; window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort);
		controller.abort(); closeReader();
	}
}
