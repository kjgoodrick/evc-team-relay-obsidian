import { v5 as uuidFromName } from "uuid";
import { isId, protocolJson } from "./DiscussionProtocol";
import { pictureIds, prepareLocalPicture, type LocalPicture } from "./PictureProtocol";
import { reviewedDraftBody, reviewedDraftTarget } from "./SavedDraftReview";
import type { LocalDiscussionAnchor } from "./LocalDiscussionAnchor";
import type { DiscussionStore, Draft } from "./storage/DiscussionStore";
import { commentBodyText } from "./ui/CommentBody";

export interface SavedDraftCopyReview {
	source: Draft; destinationScope: string; target: LocalDiscussionAnchor; activeDraft?: string;
	originals: Omit<LocalPicture, "bytes">[]; missingOriginals: string[];
}
function checkCurrent(current: () => boolean): void { if (!current()) throw new Error("The destination or draft review changed. Nothing was copied."); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

/** Own work may be recovered without old-target access. Shared picture references
 * stay scoped; a missing original must be omitted explicitly before crossing scopes. */
export async function reviewSavedDraftCopy(store: DiscussionStore, sourceId: string, destinationScope: string, value: unknown,
	activeDraft: string | undefined, current: () => boolean): Promise<SavedDraftCopyReview> {
	checkCurrent(current);
	const target = reviewedDraftTarget(destinationScope, JSON.parse(JSON.stringify(value))), source = await store.getDraft(sourceId); checkCurrent(current);
	if (!source) throw new Error("This saved draft is no longer available.");
	if (source.id.startsWith("recovery:") || await store.preference("online:" + source.id) || await store.preference("recovery:" + source.id)) throw new Error("Check the saved request's delivery before copying this draft.");
	const body = reviewedDraftBody(source.body), originals: SavedDraftCopyReview["originals"] = [], missingOriginals: string[] = [];
	for (const id of pictureIds(body, true)) {
		checkCurrent(current); const original = await store.pictureSource(id, source.scopeId); checkCurrent(current);
		if (original) originals.push({ id, scopeId: original.scopeId, size: original.size, sha256: original.sha256 }); else missingOriginals.push(id);
	}
	checkCurrent(current);
	return freeze({ source, destinationScope, target, ...(activeDraft === undefined ? {} : { activeDraft }), originals, missingOriginals });
}

/** The destination ID identifies this explicit copy intent. Deterministic fresh
 * picture IDs allow safe repeat completion without overwriting a later edit. */
export async function copySavedDraft(store: DiscussionStore, reviewed: SavedDraftCopyReview, destinationId: string, omitMissing: boolean, current: () => boolean) {
	const review = JSON.parse(JSON.stringify(reviewed)) as SavedDraftCopyReview;
	checkCurrent(current);
	const prefix = "selection:" + review.destinationScope + ":", copyId = destinationId.slice(prefix.length);
	if (!destinationId.startsWith(prefix) || !isId(copyId)) throw new Error("Choose a new discussion draft for this copy.");
	const target = reviewedDraftTarget(review.destinationScope, review.target), body = reviewedDraftBody(review.source.body);
	const ids = pictureIds(body, true), originals = new Map(review.originals.map(original => [original.id, original]));
	if (ids.some(id => !originals.has(id) && !review.missingOriginals.includes(id))) throw new Error("Picture recovery review changed.");
	if (review.source.scopeId !== review.destinationScope && review.missingOriginals.length && !omitMissing) throw new Error("Some pictures have no retained original. Choose to omit those pictures before copying to another discussion.");
	const replacements = new Map<string, string>(), pictures: { originalId: string; source: LocalPicture }[] = [];
	for (const original of review.originals) {
		if (!ids.includes(original.id)) throw new Error("Picture recovery review changed.");
		checkCurrent(current); const retained = await store.pictureSource(original.id, review.source.scopeId); checkCurrent(current);
		if (!retained || retained.sha256 !== original.sha256 || retained.size !== original.size) throw new Error("An original picture changed after review. Review this draft again.");
		const id = uuidFromName(original.id, copyId), source = await prepareLocalPicture(id, review.destinationScope, retained.bytes); checkCurrent(current);
		if (source.sha256 !== original.sha256 || source.size !== original.size) throw new Error("An original picture could not be verified.");
		replacements.set(original.id, id); pictures.push({ originalId: original.id, source });
	}
	const keep = (picture: { picture_id: string }) => !omitMissing || !review.missingOriginals.includes(picture.picture_id);
	const replace = (picture: { picture_id: string }) => { picture.picture_id = replacements.get(picture.picture_id) ?? picture.picture_id; };
	body.pictures = (body.pictures ?? []).filter(keep); body.undoPictures = body.undoPictures?.filter(keep);
	if (body.rich) {
		body.rich.blocks = body.rich.blocks.filter(block => block.type !== "picture" || keep(block));
		if (!body.rich.blocks.length) body.rich.blocks.push({ type: "paragraph", children: [] });
		for (const block of body.rich.blocks) if (block.type === "picture") replace(block);
	}
	for (const picture of body.pictures) replace(picture);
	for (const picture of body.undoPictures ?? []) replace(picture);
	if (body.rich) body.text = commentBodyText(body.rich, () => "Member");
	delete body.editBaseRevision;
	if (body.undoPictures === undefined) delete body.undoPictures;
	if (target.type === "base_group_pending") target.capture.operation_id = uuidFromName("group-capture", copyId);
	const draft: Draft = { id: destinationId, scopeId: review.destinationScope, revision: 0, target: protocolJson(target), body: protocolJson(body) };
	return store.copyDraftForTarget(review.source, draft, pictures, review.activeDraft, current);
}
