import { v4 as uuid } from "uuid";
import { inspectLocalWorkRecovery, type InspectedLocalWork, type LocalWorkImportIO } from "./LocalWorkImport";
import { protocolJson } from "./DiscussionProtocol";
import type { LocalDiscussionAnchor } from "./LocalDiscussionAnchor";
import { pictureIds, type LocalPicture } from "./PictureProtocol";
import { importOrigin } from "./storage/ImportedDrafts";
import type { DiscussionStore, Draft, StoreIdentity } from "./storage/DiscussionStore";
import type { CommentDraft } from "./ui/CommentDraft";
import { reviewedDraftBody, reviewedDraftTarget } from "./SavedDraftReview";

export interface RecoveryDraftReview { source: Draft; body: CommentDraft; target?: LocalDiscussionAnchor; originalPictures: number; missingPictures: number }

/** Never silently turn an unknown format or damaged mentions into a partial draft. */
export function recoveryDraftReview(copy: InspectedLocalWork, draftId: string, destination: Readonly<StoreIdentity>): RecoveryDraftReview {
	const source = copy.snapshot.drafts.find(draft => draft.id === draftId);
	if (!source) throw new Error("This draft is no longer in the recovery copy.");
	importOrigin({ version: 1, manifestSha256: copy.manifestSha256, snapshotId: copy.snapshot.id, draftId, scopeId: source.scopeId, identity: copy.snapshot.identity }, destination);
	if (draftId.startsWith("recovery:") || copy.snapshot.actions.some(action => action.key === "online:" + draftId || action.key === "recovery:" + draftId) ||
		copy.snapshot.operations.some(operation => operation.reviewDraftId === draftId)) throw new Error("This draft has a saved delivery or recovery action. Check its delivery before restoring; request recovery is not available here yet.");
	const body = reviewedDraftBody(source.body), target = source.target === undefined ? undefined : reviewedDraftTarget(source.scopeId, source.target);
	const ids = pictureIds(body, true), pictures = new Map(copy.snapshot.pictures.map(picture => [picture.id, picture]));
	let originalPictures = 0;
	for (const id of ids) {
		const picture = pictures.get(id);
		if (picture && picture.scopeId !== source.scopeId) throw new Error("A saved picture belongs to another discussion target.");
		if (picture) originalPictures++;
	}
	return { source, body, target, originalPictures, missingPictures: ids.length - originalPictures };
}

/** Revalidate files after review. Retain only selected originals in memory;
 * copy no delivery states or pending preferences into the live store. */
export async function restoreLocalDraft(store: DiscussionStore, io: LocalWorkImportIO, reviewed: InspectedLocalWork, draftId: string,
	current: () => boolean, progress: (text: string) => void = () => {}) {
	const initial = recoveryDraftReview(reviewed, draftId, store.identity), ids = new Set(pictureIds(initial.body, true));
	const wanted = new Set(reviewed.snapshot.pictures.filter(picture => ids.has(picture.id)).map(picture => reviewed.directory + "/" + picture.file));
	const bytes = new Map<string, ArrayBuffer>();
	const fresh = await inspectLocalWorkRecovery({ stat: path => io.stat(path), read: path => io.read(path), readBinary: async path => {
		const content = (await io.readBinary(path)).slice(0);
		if (wanted.has(path)) bytes.set(path, content);
		return content;
	} }, reviewed.directory, current, progress);
	if (fresh.manifestSha256 !== reviewed.manifestSha256) throw new Error("The recovery copy changed after review. Inspect it again before restoring.");
	const review = recoveryDraftReview(fresh, draftId, store.identity), body = review.body;
	const replacements = new Map<string, string>(), sources: LocalPicture[] = [];
	for (const picture of fresh.snapshot.pictures) {
		if (!ids.has(picture.id)) continue;
		const content = bytes.get(fresh.directory + "/" + picture.file);
		if (!content) throw new Error("An original picture changed after review. Inspect the recovery copy again.");
		const id = uuid(); replacements.set(picture.id, id);
		sources.push({ id, scopeId: picture.scopeId, sha256: picture.sha256, size: picture.size, bytes: content });
	}
	const replace = (picture: { picture_id: string }) => { picture.picture_id = replacements.get(picture.picture_id) ?? picture.picture_id; };
	for (const picture of body.pictures ?? []) replace(picture);
	for (const picture of body.undoPictures ?? []) replace(picture);
	for (const block of body.rich?.blocks ?? []) if (block.type === "picture") replace(block);
	const origin = { version: 1 as const, manifestSha256: fresh.manifestSha256, snapshotId: fresh.snapshot.id, draftId, scopeId: review.source.scopeId, identity: fresh.snapshot.identity };
	const draft: Draft = { id: "imported:" + uuid(), scopeId: review.source.scopeId, revision: 0, body: protocolJson(body),
		...(review.source.target === undefined ? {} : { target: review.source.target }) };
	progress("Saving the local draft and its original pictures…");
	return store.importLocalDraft(origin, draft, sources, current);
}
