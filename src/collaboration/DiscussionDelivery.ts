import { DiscussionFailure, type DiscussionSender, type DiscussionTransport } from "./DiscussionTransport";
import { parsePictureUpload } from "./PictureProtocol";
import type { DiscussionStore, QueuedCommand } from "./storage/DiscussionStore";

/** The normal outbox owns ordering, leases and retry policy for uploads too.
 * Upload commands never reach the discussion command endpoint.
 */
export class DiscussionDelivery implements DiscussionSender {
	readonly identity;
	constructor(private store: DiscussionStore, private transport: DiscussionTransport, private canUpload: () => boolean = () => true) { this.identity = transport.identity; }
	async send(operation: QueuedCommand) {
		if (operation.type !== "picture.upload") return this.transport.send(operation);
		if (!this.canUpload()) throw new DiscussionFailure("reject", "pictures_disabled");
		let upload;
		try { upload = parsePictureUpload(operation.payload); } catch { throw new DiscussionFailure("reject", "invalid_local_picture"); }
		if (upload.picture_id !== operation.operationId) throw new DiscussionFailure("reject", "invalid_local_picture");
		const source = await this.store.pictureSource(upload.picture_id, operation.scopeId);
		if (!source) throw new DiscussionFailure("reject", "picture_source_unavailable");
		if (source.sha256 !== upload.sha256 || source.size !== upload.size) throw new DiscussionFailure("reject", "picture_digest_mismatch");
		return this.transport.uploadPicture(operation.scopeId, upload, source.bytes);
	}
}
