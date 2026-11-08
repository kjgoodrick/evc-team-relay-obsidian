import type { App } from "obsidian";
import type { UnsavedFileStore } from "./UnsavedFile";
import { parseSourceInstallationPlan, type SourceInstallationPlan, type SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import { sourceDocumentCacheSync, sourceInventoryCacheSync } from "./storage/source-document-cache";

/** Read-only preflight for the destination generation. Never constructs a live
 * upload map (whose startup cleanup may mutate it), reads old-generation text,
 * or clears anything. The caller must keep source admission closed and perform
 * this check again at the activation boundary. */
export async function assertNoInstallationLocalWork(app: Pick<App, "loadLocalStorage">, buffers: Pick<UnsavedFileStore, "countSavedBuffers">,
	input: SourceInstallationPlan, options: SourcePlanVerificationOptions = {}): Promise<void> {
	const plan = parseSourceInstallationPlan(input), load = app.loadLocalStorage.bind(app), inspect = buffers.countSavedBuffers.bind(buffers);
	const checkContext = options.check, signal = options.signal, timeoutMs = options.timeoutMs;
	const check = () => { if (signal?.aborted) throw Object.assign(new Error("Source local-work inspection was cancelled"), { name: "AbortError" }); checkContext?.(); };
	const key = sourceInventoryCacheSync(plan.source).name + "/pendingUploads";
	const checkUploads = () => {
		check(); const value: unknown = load(key); check();
		if (value === null || value === undefined) return;
		if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) throw new Error("The destination source has pending or unrecognized upload state. Retain it for review before activation.");
	};
	const keys = plan.entries.filter(entry => entry.source).map(entry => sourceDocumentCacheSync({ ...plan.source,
		s3rn: `${plan.source.s3rn}:${entry.record.type === "canvas" ? "canvas" : "doc"}:${entry.record.id}` }).bufferKey);
	checkUploads(); const count = await inspect(keys, { check, signal, timeoutMs }); checkUploads();
	if (count !== 0) throw new Error("The destination source has saved local buffers. Retain them for review before activation.");
	check();
}
