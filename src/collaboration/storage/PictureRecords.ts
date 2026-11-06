import { PICTURE_SOURCE_QUOTA, pictureIds, type LocalPicture } from "../PictureProtocol";

export const PICTURE_STORES = ["pictureSources", "pictureReferences", "preferences"];
type Reference = { pictureId: string; kind: "draft" | "outbox"; ownerId: string; scopeId: string };
function request<T>(operation: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		operation.onsuccess = () => resolve(operation.result);
		operation.onerror = () => reject(operation.error ?? new Error("Could not save this picture"));
	});
}

async function sourceBytes(tx: IDBTransaction): Promise<number> {
	const value = await request(tx.objectStore("preferences").get("pictureSourceBytes")) ?? 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid picture storage accounting");
	return value;
}

export async function putPictureSources(tx: IDBTransaction, sources: LocalPicture[], scopeId: string, ids: string[]): Promise<void> {
	const store = tx.objectStore("pictureSources");
	let bytes = await sourceBytes(tx);
	for (const source of sources) {
		if (source.scopeId !== scopeId || !ids.includes(source.id)) throw new Error("Picture does not belong to this draft");
		const uploaded = await request(tx.objectStore("outbox").get(source.id));
		if (uploaded && (uploaded.type !== "picture.upload" || uploaded.scopeId !== scopeId ||
			uploaded.payload?.sha256 !== source.sha256 || uploaded.payload?.size !== source.size)) throw new Error("Picture identity was already used");
		const existing: LocalPicture | undefined = await request(store.get(source.id));
		if (existing) {
			if (existing.scopeId !== source.scopeId || existing.sha256 !== source.sha256 || existing.size !== source.size) throw new Error("Picture identity was already used");
			continue;
		}
		bytes += source.size;
		if (bytes > PICTURE_SOURCE_QUOTA) throw new Error("Unsent pictures exceed 100 MiB on this device. Send or remove pictures before adding more.");
		await request(store.add(source));
	}
	await request(tx.objectStore("preferences").put(bytes, "pictureSourceBytes"));
}

/** References make a draft-to-outbox transfer atomic and prevent a second pane
 * or pending reply losing its bytes when another message is acknowledged.
 */
export async function setPictureReferences(tx: IDBTransaction, kind: Reference["kind"], ownerId: string, scopeId: string, ids: string[]): Promise<void> {
	const store = tx.objectStore("pictureReferences"), sources = tx.objectStore("pictureSources");
	const previous: Reference[] = await request(store.index("owner").getAll([kind, ownerId]));
	for (const id of ids) {
		const source: LocalPicture | undefined = await request(sources.get(id));
		if (source && source.scopeId !== scopeId) throw new Error("A picture belongs to another note");
		await request(store.put({ pictureId: id, kind, ownerId, scopeId } satisfies Reference));
	}
	let bytes = await sourceBytes(tx);
	for (const ref of previous) {
		if (ref.scopeId !== scopeId) throw new Error("Picture references changed scope");
		if (ids.includes(ref.pictureId)) continue;
		await request(store.delete([ref.pictureId, kind, ownerId]));
		if (await request(store.index("picture").count(ref.pictureId))) continue;
		const source: LocalPicture | undefined = await request(sources.get(ref.pictureId));
		if (source) { bytes -= source.size; await request(sources.delete(source.id)); }
	}
	if (bytes < 0) throw new Error("Invalid picture storage accounting");
	await request(tx.objectStore("preferences").put(bytes, "pictureSourceBytes"));
}

export function commandPictures(payload: unknown): string[] {
	return payload && typeof payload === "object" && "body" in payload ? pictureIds(payload.body) : [];
}
