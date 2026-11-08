import * as Y from "yjs";
import { canvasSourceData } from "./canvasSourceData";
import { assertCompleteComparisonSource } from "./client/ManagedRestoreText";
import type { ManagedManifest } from "./client/ManagedIndexTransport";
import { same } from "./client/managedRecovery";
import { parseSourceInstallationPlan, type SourceInstallationPlan } from "./SourceInstallationPlan";

const MAX_UPDATE = 16 * 1024 * 1024;
function isolated<T>(input: Uint8Array, inspect: (doc: Y.Doc) => T): T {
	if (!input || !Number.isSafeInteger(input.byteLength) || input.byteLength > MAX_UPDATE || input.byteLength < 2) throw new Error("Invalid or oversized installation history");
	const doc = new Y.Doc({ gc: false });
	try {
		Y.applyUpdate(doc, new Uint8Array(input)); assertCompleteComparisonSource(doc, "The staged source");
		return inspect(doc);
	} finally { doc.destroy(); }
}
function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function expectedRecords(plan: SourceInstallationPlan) {
	return Object.fromEntries(plan.entries.map(entry => [entry.path, entry.record]));
}
function manifestFor(plan: SourceInstallationPlan, value: unknown): ManagedManifest {
	if (!object(value) || !object(value.records) || !same(value.records, expectedRecords(plan)) || !object(value.permissions) || !object(value.activity)
		|| typeof value.owner !== "boolean" || value.restore_guard !== true || value.restore_generation !== plan.source.restoreGeneration) {
		throw new Error("The staged inventory differs from the selected source plan");
	}
	const names = new Set(plan.entries.map(entry => entry.path)), ids = new Set(plan.entries.map(entry => entry.record.id));
	if (Object.keys(value.permissions).length !== names.size || Object.entries(value.permissions).some(([name, permission]) => !names.has(name) || !["read", "write"].includes(String(permission)))
		|| Object.entries(value.activity).some(([id, value]) => !ids.has(id) || typeof value !== "string" || value.length > 256)) {
		throw new Error("The staged inventory contains inconsistent access or activity metadata");
	}
	// Fresh synchronization fetches optional server catalogs again. Do not carry
	// old deletion receipts, Bases request/recovery state or unknown metadata
	// into a newly selected history.
	return { records: expectedRecords(plan), permissions: { ...value.permissions } as ManagedManifest["permissions"],
		activity: { ...value.activity } as ManagedManifest["activity"], owner: value.owner,
		restore_guard: true, restore_generation: plan.source.restoreGeneration };
}

/** Build fresh local inventory state from the explicitly captured visible
 * server manifest. No retained inventory edits, conflicts or requests enter it.
 * This validates structure/binding, not current server authorization. */
export function buildInstallationInventory(input: SourceInstallationPlan, snapshot: ManagedManifest): Uint8Array {
	const plan = parseSourceInstallationPlan(input), manifest = manifestFor(plan, snapshot), doc = new Y.Doc({ gc: false });
	try {
		const records = doc.getMap("filemeta_v0"), flat = doc.getMap("docs"), activity = doc.getMap("docactivity_v0");
		doc.transact(() => {
			for (const entry of plan.entries) { records.set(entry.path, entry.record); if (entry.record.type === "markdown") flat.set(entry.path, entry.record.id); }
			for (const [id, value] of Object.entries(manifest.activity)) activity.set(id, value);
			doc.getMap("managed_base_v1").set("snapshot", manifest);
		});
		const update = Y.encodeStateAsUpdate(doc);
		if (update.byteLength > MAX_UPDATE) throw new Error("The staged inventory is too large");
		return update;
	} finally { doc.destroy(); }
}

/** Canonical metadata for a fresh visible-inventory comparison. Optional old
 * server catalogs do not enter this selected source's local inventory. */
export function installationManifest(input: SourceInstallationPlan, snapshot: ManagedManifest): ManagedManifest {
	return manifestFor(parseSourceInstallationPlan(input), snapshot);
}

/** Check all visible inventory maps, not only plausible file names. Unknown
 * roots and restore/conflict state must never enter a fresh selected cache. */
export function validateInstallationInventory(input: SourceInstallationPlan, update: Uint8Array): ManagedManifest {
	const plan = parseSourceInstallationPlan(input);
	return isolated(update, doc => {
		if ([...doc.share.keys()].some(key => !["filemeta_v0", "docs", "docactivity_v0", "managed_base_v1"].includes(key))) throw new Error("The staged inventory contains retained or unsupported state");
		const base = doc.getMap("managed_base_v1"), snapshot = base.get("snapshot"), manifest = manifestFor(plan, snapshot);
		const flat = Object.fromEntries(plan.entries.filter(entry => entry.record.type === "markdown").map(entry => [entry.path, entry.record.id]));
		if (base.size !== 1 || !same(snapshot, manifest) || !same(doc.getMap("filemeta_v0").toJSON(), manifest.records)
			|| !same(doc.getMap("docs").toJSON(), flat) || !same(doc.getMap("docactivity_v0").toJSON(), manifest.activity)) {
			throw new Error("The staged inventory contains pending or inconsistent changes");
		}
		return manifest;
	});
}

/** Use exactly the existing native save projection, in a disposable document
 * without persistence, providers, awareness or retained local updates. */
export function installationSourceBytes(kind: "markdown" | "canvas", update: Uint8Array): ArrayBuffer {
	if (kind !== "markdown" && kind !== "canvas") throw new Error("Unsupported source installation kind");
	return isolated(update, doc => {
		const text = kind === "markdown" ? doc.getText("contents").toString() : JSON.stringify(canvasSourceData(doc), null, 2);
		const bytes = new TextEncoder().encode(text).buffer;
		if (bytes.byteLength > MAX_UPDATE) throw new Error("The staged source projection is too large");
		return bytes;
	});
}
