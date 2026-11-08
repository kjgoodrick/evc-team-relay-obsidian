import { sha256Hex } from "./contentDigest";
import type { RecoveryArchiveReader } from "./ManagedRecoveryArchive";
import { installationSourceBytes } from "./SourceInstallationContent";
import { sourceInstallationPath, verifySourceInstallationPlan, type SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import { SOURCE_CACHE_IDENTITY } from "./storage/document-cache-binding";
import { sourceDocumentCacheSync, sourceInventoryCacheSync, type SourceCacheDescriptor } from "./storage/source-document-cache";
import type { SourceSelectionJournal } from "./storage/source-selection-journal";
import type { SourceMaterializationRequest } from "./SourceInstallationMaterialization";

const SEED = "sourceInstallationSeed";
const unchanged = () => new Error("The destination source cache contains unreviewed or changed history. It was not replaced or merged.");

function openCache(name: string, check: () => void): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		let finished = false;
		const request = indexedDB.open(name, 1);
		const fail = (error: unknown) => { if (finished) return; finished = true; window.clearTimeout(timer); reject(error); };
		const timer = window.setTimeout(() => fail(new Error("Opening the installation cache timed out")), 5000);
		request.onblocked = () => fail(new Error("The installation cache is blocked by another window"));
		request.onupgradeneeded = () => {
			try {
				if (finished) { request.transaction!.abort(); return; }
				check(); request.result.createObjectStore("updates", { autoIncrement: true }); request.result.createObjectStore("custom");
			} catch (error) { request.transaction!.abort(); fail(error); }
		};
		request.onerror = () => fail(request.error ?? new Error("Unable to open the installation cache"));
		request.onsuccess = () => {
			if (finished) { request.result.close(); return; }
			try {
				check();
				if (request.result.objectStoreNames.length !== 2 || !request.result.objectStoreNames.contains("updates") || !request.result.objectStoreNames.contains("custom")) throw unchanged();
				const tx = request.result.transaction(["updates", "custom"]), updates = tx.objectStore("updates"), custom = tx.objectStore("custom");
				if (!updates.autoIncrement || updates.keyPath !== null || custom.autoIncrement || custom.keyPath !== null
					|| updates.indexNames.length || custom.indexNames.length) throw unchanged();
				request.result.onversionchange = () => request.result.close();
				finished = true; window.clearTimeout(timer); resolve(request.result);
			} catch (error) { request.result.close(); fail(error); }
		};
	});
}

/** One atomic cache import. A retry accepts only the exact untouched seed. It
 * never appends to a populated cache, clears metadata, or opens a live provider. */
async function seedCache(descriptor: SourceCacheDescriptor, update: Uint8Array, receipt: string,
	syncBase: string | undefined, check: () => void, signal?: AbortSignal): Promise<"created" | "resumed"> {
	check(); const db = await openCache(descriptor.name, check);
	try {
		check();
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(["custom", "updates"], "readwrite"), custom = tx.objectStore("custom"), updates = tx.objectStore("updates");
			const expected = new Map<string, unknown>([[SOURCE_CACHE_IDENTITY, descriptor.identity], [SEED, receipt], ["serverSync", 1], ["origin", "remote"]]);
			if (syncBase !== undefined) expected.set("syncBase", syncBase);
			let failure: unknown, outcome: "created" | "resumed";
			const abort = (error: unknown) => { failure ??= error; try { tx.abort(); } catch { /* Already completed; the caller rechecks its context. */ } };
			const safely = (action: () => void) => { try { check(); action(); } catch (error) { abort(error); } };
			const cancelled = () => abort(Object.assign(new Error("Source cache installation was cancelled"), { name: "AbortError" }));
			const timer = window.setTimeout(() => abort(new Error("Source cache installation timed out")), 5000);
			signal?.addEventListener("abort", cancelled, { once: true });
			const count = updates.count(), metadata = custom.count();
			metadata.onsuccess = () => safely(() => {
				if (count.result === 0 && metadata.result === 0) {
					for (const [key, value] of expected) custom.add(value, key);
					updates.add(update); outcome = "created"; return;
				}
				if (count.result !== 1 || metadata.result !== expected.size) throw unchanged();
				let remaining = expected.size;
				for (const [key, value] of expected) {
					const saved = custom.get(key);
					saved.onsuccess = () => safely(() => {
						if (saved.result !== value) throw unchanged();
						if (--remaining) return;
						const record = updates.openCursor();
						record.onsuccess = () => safely(() => {
							const bytes = record.result?.value;
							if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== "[object Uint8Array]"
								|| bytes.byteLength !== update.byteLength || !new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).every((byte, i) => byte === update[i])) throw unchanged();
							outcome = "resumed";
						});
					});
				}
			});
			const cleanup = () => { window.clearTimeout(timer); signal?.removeEventListener("abort", cancelled); };
			tx.oncomplete = () => { cleanup(); try { if (failure !== undefined) throw failure; check(); if (!outcome) throw unchanged(); resolve(outcome); } catch (error) { reject(error); } };
			tx.onabort = () => { cleanup(); reject(failure ?? tx.error ?? new Error("Source cache installation was not committed")); };
			tx.onerror = () => { /* onabort reports the failure */ };
			if (signal?.aborted) cancelled();
		});
	} finally { db.close(); }
}

/** Seed only the selected generation's inactive caches while its durable journal
 * is applying. Each cache is atomic and independently resumable. The old legacy/
 * generation caches, document buffers and pending uploads are never read or
 * changed. This does not verify native installation or activate the source. */
export async function seedSourceInstallationCaches(journal: SourceSelectionJournal, io: RecoveryArchiveReader,
	input: Omit<SourceMaterializationRequest, "operationId">, options: SourcePlanVerificationOptions = {}) {
	const request = { ...input, source: { ...input.source } }, checkContext = options.check, signal = options.signal, timeoutMs = options.timeoutMs;
	const check = () => { if (signal?.aborted) throw Object.assign(new Error("Source cache installation was cancelled"), { name: "AbortError" }); checkContext?.(); };
	if (journal.scopeIdentity !== sourceInventoryCacheSync({ ...request.source, restoreGeneration: null }).identity) throw new Error("The installation journal belongs to another source");
	check(); const state = await journal.read(); check();
	if (state.revision !== request.revision || state.pending?.phase !== "applying" || state.pending.reviewId !== request.reviewId
		|| state.pending.restoreGeneration !== request.source.restoreGeneration || !state.pending.preparation) throw new Error("The applying source selection changed");
	const preparation = state.pending.preparation;
	const confirm = async () => { check(); const current = await journal.read(); check(); if (current.revision !== state.revision) throw new Error("The source selection changed during cache installation"); };
	const verified = await verifySourceInstallationPlan(io, preparation.plan, { source: request.source, reviewId: request.reviewId, archive: preparation.archive }, { check, signal, timeoutMs });
	const { plan } = verified, root = sourceInstallationPath(plan.id);
	const records = [{ descriptor: sourceInventoryCacheSync(plan.source), path: "inventory.yjs", artifact: plan.inventory, kind: "inventory" },
		...plan.entries.filter(entry => entry.source).map(entry => ({ descriptor: sourceDocumentCacheSync({ ...plan.source,
			s3rn: `${plan.source.s3rn}:${entry.record.type === "canvas" ? "canvas" : "doc"}:${entry.record.id}` }),
			path: `sources/${entry.record.id}.yjs`, artifact: entry.source!, kind: entry.record.type }))];
	let created = 0, resumed = 0;
	for (const record of records) {
		await confirm(); const name = `${root}/${record.path}`, stat = await io.stat(name); await confirm();
		if (stat?.type !== "file" || stat.size !== record.artifact.bytes) throw new Error("The staged source cache artifact changed");
		const bytes = await io.readBinary(name); await confirm();
		if (bytes.byteLength !== record.artifact.bytes || await sha256Hex(bytes) !== record.artifact.sha256) throw new Error("The staged source cache artifact digest changed");
		const update = new Uint8Array(ArrayBuffer.prototype.slice.call(bytes, 0) as ArrayBuffer);
		const syncBase = record.kind === "markdown" ? new TextDecoder("utf-8", { fatal: true }).decode(installationSourceBytes("markdown", update)) : undefined;
		const receipt = JSON.stringify({ format: "team-relay-source-cache-seed", version: 1, plan: verified.reference, artifact: record.artifact });
		await confirm();
		const result = await seedCache(record.descriptor, update, receipt, syncBase, check, signal); await confirm();
		if (result === "created") created++; else resumed++;
	}
	await confirm(); return { reference: verified.reference, revision: state.revision, created, resumed };
}
