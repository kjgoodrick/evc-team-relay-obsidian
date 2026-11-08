import { restoreMetadata } from "./RestoreGeneration";
import { DiscussionFailure, type DiscussionSender, type DiscussionTransport } from "./DiscussionTransport";
import { parsePictureUpload } from "./PictureProtocol";
import { parsePendingBaseGroupCommand, prepareBaseGroupCommand } from "./LocalDiscussionAnchor";
import { protocolJson } from "./DiscussionProtocol";
import type { DiscussionStore, OutboxOperation, QueuedCommand } from "./storage/DiscussionStore";

/** The normal outbox owns ordering, leases and retry policy for uploads too.
 * Upload commands never reach the discussion command endpoint.
 */
export class DiscussionDelivery implements DiscussionSender {
	readonly identity;
	constructor(private store: DiscussionStore, private transport: DiscussionTransport, private canUpload: () => boolean = () => true, private canCaptureGroup: () => boolean = () => true) { this.identity = transport.identity; }
	async send(operation: QueuedCommand | OutboxOperation, current: () => boolean = () => true) {
		if (operation.type === "base.group.create") {
			if (!("lease" in operation) || !operation.lease) throw new DiscussionFailure("pause", "group_capture_lease_required");
			const active = () => { if (!current()) throw new DiscussionFailure("retry", "local_operation_stopped"); };
			active();
			let saved = await this.store.prepareBaseGroup(operation.operationId, operation.lease);
			if (!saved) throw new DiscussionFailure("retry", "local_operation_changed");
			active();
			if (saved.preparedAnchor === undefined) {
				if (!this.canCaptureGroup()) throw new DiscussionFailure("pause", "restore_guard_unavailable");
				const pending = parsePendingBaseGroupCommand(saved);
				const anchor = await this.transport.captureBaseGroup(saved.scopeId, pending.anchor.capture, restoreMetadata(saved), current);
				active();
				saved = await this.store.prepareBaseGroup(saved.operationId, operation.lease, protocolJson(anchor));
				if (!saved) throw new DiscussionFailure("retry", "local_operation_changed");
			}
			active();
			return this.transport.send(prepareBaseGroupCommand(saved, saved.preparedAnchor), current);
		}
		if (operation.type !== "picture.upload") return this.transport.send(operation, current);
		if (!this.canUpload()) throw new DiscussionFailure("reject", "pictures_disabled");
		let upload;
		try { upload = parsePictureUpload(operation.payload); } catch { throw new DiscussionFailure("reject", "invalid_local_picture"); }
		if (upload.picture_id !== operation.operationId) throw new DiscussionFailure("reject", "invalid_local_picture");
		const source = await this.store.pictureSource(upload.picture_id, operation.scopeId);
		if (!source) throw new DiscussionFailure("reject", "picture_source_unavailable");
		if (source.sha256 !== upload.sha256 || source.size !== upload.size) throw new DiscussionFailure("reject", "picture_digest_mismatch");
		await this.store.requireRestoreBinding(operation);
		return this.transport.uploadPicture(operation.scopeId, upload, source.bytes, restoreMetadata(operation), current);
	}
}
