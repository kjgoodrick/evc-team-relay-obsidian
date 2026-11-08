import { ResourceAddress } from "../ResourceAddress";
import type { RestoreBinding } from "../collaboration/RestoreGeneration";
import { SourceSelectionJournal, type SourceChoice, type SourceSelectionState } from "./source-selection-journal";
import { sourceCacheEndpoint, sourceDocumentCacheSync, sourceInventoryCacheSync, type SourceCacheDescriptor, type SourceInventoryIdentity } from "./source-document-cache";
import { watchSourceSelection } from "./source-selection-events";

export type SourceSelectionScope = Omit<SourceInventoryIdentity, "restoreGeneration">;

/** An immutable, journal-read cache choice for one folder session. It neither
 * installs native files nor activates a pending choice. Callers must recheck
 * assertCurrent at asynchronous admission boundaries; synchronous descriptor
 * access is not evidence that another window has left the journal unchanged. */
export class SourceSelectionContext {
	readonly scope: Readonly<SourceSelectionScope>;
	readonly revision: string | null;
	readonly choice: Readonly<SourceChoice>;
	readonly binding: Readonly<RestoreBinding> | undefined;
	readonly inventory: Readonly<SourceCacheDescriptor> | undefined;
	private unavailable = false;
	private invalidationListeners = new Set<() => void>();
	private detachChanges?: () => void;
	private checkingChange = false;
	private checkAgain = false;
	private constructor(private readonly journal: SourceSelectionJournal, scope: SourceSelectionScope, state: SourceSelectionState) {
		this.scope = Object.freeze(scope); this.revision = state.revision; this.choice = Object.freeze({ ...state.active });
		this.binding = this.choice.kind === "source" ? Object.freeze({ restoreGeneration: this.choice.restoreGeneration }) : undefined;
		this.inventory = this.binding ? sourceInventoryCacheSync({ ...this.scope, ...this.binding }) : undefined;
		this.detachChanges = watchSourceSelection(journal.name, () => this.selectionChanged());
	}
	static async open(input: SourceSelectionScope): Promise<SourceSelectionContext> {
		// Capture only durable fields before the first await; caller mutation must
		// not swap the scope between its journal read and descriptor construction.
		const scope = { hostAppId: input.hostAppId, serverId: input.serverId,
			controlPlaneUrl: sourceCacheEndpoint(input.controlPlaneUrl), s3rn: input.s3rn };
		sourceInventoryCacheSync({ ...scope, restoreGeneration: null });
		const journal = await SourceSelectionJournal.open(scope);
		try {
			const state = await journal.read();
			if (state.pending) throw new Error("This source is awaiting recovery. Finish reviewing it before synchronization.");
			const context = new SourceSelectionContext(journal, scope, state);
			// Close the gap between the first read and installing the listener.
			try { await context.assertCurrent(); return context; }
			catch (error) { context.close(); throw error; }
		} catch (error) { journal.close(); throw error; }
	}
	check(): void {
		if (this.unavailable) throw new Error("The source selection session changed or closed. Reopen it before synchronization.");
	}
	async assertCurrent(): Promise<void> {
		this.check();
		try { await this.journal.assertActive(this.revision, this.choice); this.check(); }
		catch (error) { this.close(); throw error; }
	}
	private selectionChanged(): void {
		if (this.unavailable) return;
		this.checkAgain = true;
		if (this.checkingChange) return;
		this.checkingChange = true;
		void (async () => {
			try {
				while (this.checkAgain && !this.unavailable) { this.checkAgain = false; await this.assertCurrent(); }
			} catch { /* assertCurrent closes every provider sharing this context. */ }
			finally { this.checkingChange = false; }
		})();
	}
	onInvalidated(listener: () => void): () => void {
		if (this.unavailable) { listener(); return () => {}; }
		this.invalidationListeners.add(listener);
		return () => { this.invalidationListeners.delete(listener); };
	}
	/** Validate the full scope even for legacy choices, which have no identity
	 * metadata in their original caches. Never construct a cross-folder child. */
	assertFolder(hostAppId: string, serverId: string | undefined, s3rn: string): void {
		this.check();
		if (this.scope.hostAppId !== hostAppId || this.scope.serverId !== serverId || this.scope.s3rn !== s3rn) throw new Error("The selected source belongs to another folder or server.");
	}
	document(s3rn: string): Readonly<SourceCacheDescriptor & { bufferKey: string }> | undefined {
		const descriptor = this.documentDescriptor(s3rn);
		return this.binding ? descriptor : undefined;
	}
	/** Verification metadata also fences a legacy choice to its captured server
	 * endpoint. It does not relabel or change the legacy cache's storage key. */
	identityFor(s3rn: string): string {
		this.check();
		return s3rn === this.scope.s3rn
			? sourceInventoryCacheSync({ ...this.scope, ...this.binding }).identity
			: this.documentDescriptor(s3rn).identity;
	}
	private documentDescriptor(s3rn: string): Readonly<SourceCacheDescriptor & { bufferKey: string }> {
		this.check();
		const address = ResourceAddress.parse(s3rn);
		if (!("documentGuid" in address || "canvasGuid" in address) || ResourceAddress.serialize(address) !== s3rn
			|| !(s3rn.startsWith(this.scope.s3rn + ":doc:") || s3rn.startsWith(this.scope.s3rn + ":canvas:"))) throw new Error("The selected source belongs to another folder.");
		return sourceDocumentCacheSync({ ...this.scope, ...this.binding, s3rn });
	}
	get pendingUploadsKey(): string {
		this.check();
		if (this.inventory) return this.inventory.name + "/pendingUploads";
		const address = ResourceAddress.parse(this.scope.s3rn);
		if (!("folderGuid" in address)) throw new Error("Invalid selected folder");
		return `${this.scope.hostAppId}-evc-team-relay/folders/${address.folderGuid}/pendingUploads`;
	}
	close(): void {
		if (this.unavailable) return;
		this.unavailable = true; this.detachChanges?.(); this.detachChanges = undefined; this.journal.close();
		const listeners = [...this.invalidationListeners]; this.invalidationListeners.clear();
		for (const listener of listeners) {
			try { listener(); } catch (error) { console.warn("Unable to disconnect a closed source session", error); }
		}
	}
}
