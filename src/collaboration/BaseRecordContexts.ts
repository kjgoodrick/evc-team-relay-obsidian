import { isId, isRecord, parseBaseTargetContext, type BaseTargetContext } from "./DiscussionProtocol";

export type BaseRecordContexts = BaseTargetContext & {
	records: { record_id: string; record_generation: string | null }[];
};

export function baseRecordIds(ids: readonly string[]): string[] {
	if (!ids.length || ids.length > 100 || ids.some(id => !isId(id)) || new Set(ids).size !== ids.length) throw new Error("Invalid record identity batch");
	return [...ids].sort();
}

/** A complete response accounts for every requested record. Missing or denied
 * identities never prove that the target was deleted. */
export function parseBaseRecordContexts(value: unknown, entryId: string, viewId: string, ids: readonly string[]): BaseRecordContexts {
	const expected = baseRecordIds(ids), context = parseBaseTargetContext(value, entryId, viewId);
	if (!isRecord(value) || !Array.isArray(value.records) || value.records.length !== expected.length) throw new Error("Incomplete record identity batch");
	const records = value.records.map(record => {
		if (!isRecord(record) || !isId(record.record_id) || record.record_generation !== null && !isId(record.record_generation)) throw new Error("Invalid record identity");
		return { record_id: record.record_id, record_generation: record.record_generation as string | null };
	}).sort((a, b) => a.record_id.localeCompare(b.record_id));
	if (records.some((record, index) => record.record_id !== expected[index])) throw new Error("Unexpected record identity");
	return { ...context, records };
}
