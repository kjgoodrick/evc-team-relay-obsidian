import { RECOVERY_FOLDER } from "../conflictCopyPath";
import { pictureHash } from "./PictureProtocol";
import type { DiscussionStore } from "./storage/DiscussionStore";

export interface LocalWorkIO {
	mkdir(path: string): Promise<void>;
	write(path: string, text: string): Promise<void>;
	writeBinary(path: string, bytes: ArrayBuffer): Promise<void>;
	read(path: string): Promise<string>;
	readBinary(path: string): Promise<ArrayBuffer>;
}
const encoded = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;
const explanation = `Local comment recovery copy

This contains this account's saved drafts, waiting changes, unconfirmed comment
actions, and retained original pictures at the captured time. It is not a backup
of shared discussions, note content, permissions, or other participants' work.
Pictures already stored only on the server are references, not included files.

Some waiting changes may already have reached the server. Do not replay these
requests or replace a live database with this copy. Delivery must be reconciled
and content reviewed before any future send. Comment storage can inspect this
folder and restore ordinary drafts as separate local copies for editing. It does
not resume waiting requests or unconfirmed actions. The JSON preserves rich
content, targets and original request identities for reviewed recovery.

COMPLETE.json records the verified manifest hash. A folder without it is incomplete.
The manifest records original picture hashes and lengths. Keep the folder together.
Team Relay excludes this recovery folder from its own sync. Other backup or sync
software may copy it. This is a plain, unencrypted local copy of your saved work.
`;

/** One picture at a time; immutable metadata and durable pins keep the captured
 * version available across normal sends, draft edits, failed writes and reloads. */
export async function saveLocalWorkRecovery(store: DiscussionStore, io: LocalWorkIO, current: () => boolean,
	retainedId?: string, progress: (text: string) => void = () => {}): Promise<string> {
	const check = () => { if (!current()) throw new Error("Recovery copy stopped because its account or window changed. The retained capture can be retried."); };
	check();
	const snapshot = retainedId ? await store.localWorkSnapshot(retainedId) : await store.captureLocalWork(crypto.randomUUID());
	if (!snapshot) throw new Error("This retained capture was completed or released in another window.");
	check();
	// Never overwrite a previous partial or complete folder, including concurrent
	// retries in other windows. No paths are derived from body text or note paths.
	const path = `${RECOVERY_FOLDER}/Comments-${crypto.randomUUID()}`;
	await io.mkdir(RECOVERY_FOLDER); check(); await io.mkdir(path); check();
	await io.mkdir(`${path}/pictures`); check();
	const pictures = [];
	for (let index = 0; index < snapshot.pictures.length; index++) {
		check(); progress(`Saving original picture ${index + 1} of ${snapshot.pictures.length}…`);
		const picture = snapshot.pictures[index], source = await store.pictureSource(picture.id, picture.scopeId);
		check();
		if (!source || source.sha256 !== picture.sha256 || source.size !== picture.size || source.bytes.byteLength !== picture.size ||
			await pictureHash(source.bytes) !== picture.sha256) throw new Error("An original picture is unavailable or changed. The recovery copy is incomplete; saved work is retained.");
		const file = `pictures/${String(index + 1).padStart(5, "0")}.bin`;
		check(); await io.writeBinary(`${path}/${file}`, source.bytes); check();
		const written = await io.readBinary(`${path}/${file}`); check();
		if (written.byteLength !== picture.size || await pictureHash(written) !== picture.sha256) throw new Error("A recovery picture could not be verified. Retry the retained capture.");
		pictures.push({ ...picture, file });
	}
	const manifest = JSON.stringify({ ...snapshot, pictures });
	check(); progress("Verifying the recovery copy…");
	await io.write(`${path}/manifest.json`, manifest); check();
	if (await io.read(`${path}/manifest.json`) !== manifest) throw new Error("Recovery metadata could not be verified. Retry the retained capture.");
	check(); await io.write(`${path}/README.txt`, explanation); check();
	if (await io.read(`${path}/README.txt`) !== explanation) throw new Error("Recovery instructions could not be verified. Retry the retained capture.");
	const completion = JSON.stringify({ format: "team-relay-local-comment-work-complete", version: 1, snapshotId: snapshot.id,
		manifest: "manifest.json", manifestSha256: await pictureHash(encoded(manifest)), manifestBytes: encoded(manifest).byteLength }, null, 2);
	check();
	if ((await store.localWorkSummary())?.id !== snapshot.id) throw new Error("The retained capture changed in another window. This folder is incomplete.");
	check(); await io.write(`${path}/COMPLETE.json`, completion); check();
	if (await io.read(`${path}/COMPLETE.json`) !== completion) throw new Error("Recovery completion could not be verified. Retry the retained capture.");
	check(); await store.releaseLocalWork(snapshot.id);
	return path;
}
