import * as Y from "yjs";
import type { RelayCredentialCache } from "../RelayCredentialCache";
import type { RestoreBinding } from "../collaboration/RestoreGeneration";
import { YSweetProvider } from "./provider";

export interface ManagedSourcePreview {
	update: Uint8Array;
	stateVector: Uint8Array;
	downloadedAt: string;
	check(): void;
}

/** Download into an empty, private document using an explicit read grant.
 * No user mapping, retained updates, awareness publication, broadcast channel
 * or local persistence is attached to this disposable preview. */
export function readManagedSource(credentials: RelayCredentialCache, documentId: string, filePath: string,
	serverId: string | undefined, binding: RestoreBinding, options: { signal?: AbortSignal; check?: () => void; timeoutMs?: number; maxBytes?: number } = {}): Promise<ManagedSourcePreview> {
	const timeout = options.timeoutMs ?? 20_000, maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
	if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
		return Promise.reject(new Error("Invalid source preview limits"));
	}
	return new Promise((resolve, reject) => {
		const doc = new Y.Doc({ gc: false });
		let provider: YSweetProvider | undefined, settled = false, invalidated = false, received = 0, grantCheck: (() => void) | undefined;
		const cancelled = () => Object.assign(new Error("Source comparison was cancelled"), { name: "AbortError" });
		const inputCheck = () => { if (invalidated) throw new Error("Source comparison is no longer active"); if (options.signal?.aborted) throw cancelled(); options.check?.(); };
		const check = () => { inputCheck(); grantCheck?.(); };
		const finish = (error?: Error, preview?: ManagedSourcePreview) => {
			if (settled) return;
			settled = true; invalidated = !!error; window.clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
			try { provider?.destroy(); } catch (failure) { error ??= failure instanceof Error ? failure : new Error("Unable to close source preview"); }
			doc.destroy();
			if (error) reject(error); else resolve(preview!);
		};
		const abort = () => finish(cancelled());
		const timer = window.setTimeout(() => finish(new Error("The source comparison timed out. Local work is retained; retry when connected.")), timeout);
		options.signal?.addEventListener("abort", abort, { once: true });
		doc.on("update", (update: Uint8Array) => {
			received += update.byteLength;
			if (received > maxBytes) finish(new Error("This source is too large for an inline comparison. Local work is retained."));
		});
		const active = () => { if (settled) throw new Error("Source comparison is no longer active"); check(); };
		const run = async () => {
			active();
			const selected = await credentials.requestSourceInspectionToken(documentId, filePath, serverId, binding, inputCheck);
			grantCheck = selected.check; active();
			const grant = selected.grant, url = new URL(grant.url);
			if (!["ws:", "wss:"].includes(url.protocol) || !/\/v1\/managed\/socket\/?$/.test(url.pathname)
				|| !grant.token || !grant.expiryTime || grant.expiryTime <= Date.now()) throw new Error("The source preview grant is invalid or expired");
			provider = new YSweetProvider(grant.url, grant.docId, doc, { connect: false, disableBc: true, maxConnectionErrors: 1,
				params: { token: grant.token }, beforeConnect: () => { try { active(); return grant.expiryTime! > Date.now(); } catch { return false; } } });
			provider.awareness.setLocalState(null);
			provider.on("sync", synced => {
				if (!synced || settled) return;
				try {
					active(); const update = Y.encodeStateAsUpdate(doc);
					if (update.byteLength > maxBytes) throw new Error("This source is too large for an inline comparison. Local work is retained.");
					finish(undefined, { update, stateVector: Y.encodeStateVector(doc), downloadedAt: new Date().toISOString(), check });
				} catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
			});
			provider.on("connection-error", () => finish(new Error("Unable to read the restored source. Refresh the comparison and retry.")));
			provider.on("connection-close", event => finish(new Error(event.code === 4412
				? "The server was restored again. Refresh the inventory before comparing content."
				: "The source connection closed before comparison completed. Refresh and retry.")));
			provider.connect();
		};
		void run().catch(error => finish(error instanceof Error ? error : new Error(String(error))));
	});
}
