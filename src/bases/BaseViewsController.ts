import { v4 as uuidv4 } from "uuid";
import { BaseContentFailure } from "./BaseContentTransport";
import { copyBaseViewRepair, type BaseRegistrySnapshot, type BaseViewPage, type BaseViewRepair } from "./BaseRegistryProtocol";
import { BaseRegistryStore, type BaseRegistryRecord } from "./BaseRegistryStore";
import type { BaseRegistryTransport } from "./BaseRegistryTransport";
import type { BaseSyncLock } from "./BaseSyncRunner";

export interface BaseViewsSource { path: string; sha256: string; generation?: string }
export interface BaseViewsAccess {
	/** Fresh synchronized local bytes and current authorized inventory. */
	read(): Promise<BaseViewsSource>;
	current(source: BaseViewsSource): boolean;
	writable(source: BaseViewsSource): boolean;
}
type Transport = Pick<BaseRegistryTransport, "inspect" | "reconcile" | "views">;

/** View associations are explicit metadata decisions. Inspection may reconcile
 * unambiguous server mappings, but never retries a client's pending repair. */
export class BaseViewsController {
	constructor(readonly store: BaseRegistryStore, private transport: Transport, private lock: BaseSyncLock) {}
	private check(access: BaseViewsAccess, source: BaseViewsSource, edit = false): void {
		if (!access.current(source)) throw new BaseContentFailure("pause", "base_context_changed");
		if (edit && !access.writable(source)) throw new BaseContentFailure("reject", "base_editor_required");
	}
	private async inspect(entryId: string, access: BaseViewsAccess, source: BaseViewsSource): Promise<BaseRegistrySnapshot> {
		this.check(access, source);
		const snapshot = await this.transport.inspect(entryId, source.sha256, source.generation); this.check(access, source);
		await this.store.cache(entryId, snapshot); this.check(access, source); return snapshot;
	}
	async refresh(entryId: string, access: BaseViewsAccess): Promise<BaseRegistryRecord | undefined> {
		return this.lock(entryId, async () => {
			const source = await access.read(); await this.inspect(entryId, access, source);
			const record = await this.store.get(entryId); this.check(access, source); return record;
		});
	}
	async page(entryId: string, access: BaseViewsAccess, reviewed: BaseRegistrySnapshot, state: "unmatched" | "archived", after?: string): Promise<BaseViewPage | undefined> {
		return this.lock(entryId, async () => {
			const source = await access.read(); this.check(access, source);
			const page = await this.transport.views(entryId, state, after); this.check(access, source);
			const snapshot = await this.inspect(entryId, access, source);
			if (snapshot.definition_id !== reviewed.definition_id || snapshot.revision !== reviewed.revision) throw new BaseContentFailure("pause", "base_review_changed");
			return page;
		});
	}
	async repair(entryId: string, access: BaseViewsAccess, reviewed: BaseRegistrySnapshot, bindings: BaseViewRepair["bindings"], archive: string[]): Promise<BaseRegistryRecord | undefined> {
		// Capture the selected association before asynchronous refreshes.
		const request = copyBaseViewRepair({ operation_id: uuidv4(), content_sha256: reviewed.content_sha256, expected_revision: reviewed.revision, bindings, archive });
		return this.lock(entryId, async () => {
			const source = await access.read(); this.check(access, source, true);
			const snapshot = await this.inspect(entryId, access, source), record = await this.store.get(entryId);
			if (snapshot.definition_id !== reviewed.definition_id || snapshot.generation !== reviewed.generation || snapshot.revision !== reviewed.revision || snapshot.content_sha256 !== request.content_sha256) throw new BaseContentFailure("pause", "base_review_changed");
			this.check(access, source, true);
			await this.store.stage(entryId, record.revision, { definitionId: snapshot.definition_id, generation: snapshot.generation, request });
			return this.send(entryId, access, source);
		});
	}
	async checkDelivery(entryId: string, access: BaseViewsAccess): Promise<BaseRegistryRecord | undefined> {
		return this.lock(entryId, async () => {
			const source = await access.read(); return this.send(entryId, access, source);
		});
	}
	private async send(entryId: string, access: BaseViewsAccess, source: BaseViewsSource): Promise<BaseRegistryRecord> {
		this.check(access, source, true);
		const record = await this.store.get(entryId), pending = record.pending;
		if (!pending) return record;
		this.check(access, source, true);
		try {
			const result = await this.transport.reconcile(entryId, pending); this.check(access, source);
			await this.store.settle(entryId, pending.request.operation_id, result, "accepted");
		} catch (error) {
			if (!(error instanceof BaseContentFailure) || !["stale_base_revision", "base_definition_not_synced", "base_definition_changed"].includes(error.code)) throw error;
			// A newer observed revision fences a delayed request at the server's
			// compare-and-swap boundary. This does not claim the old request never
			// committed; it records that its result can no longer replace current work.
			const current = await this.inspect(entryId, access, source);
			if (current.revision <= pending.request.expected_revision) throw error;
			await this.store.settle(entryId, pending.request.operation_id, current, "superseded");
		}
		const result = await this.store.get(entryId); this.check(access, source); return result;
	}
}
