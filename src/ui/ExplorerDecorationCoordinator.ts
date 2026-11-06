// Keeps the shared-folder decorations (status pills, sync/live/connection
// CSS classes) on Obsidian's built-in file-explorer view in sync with plugin
// state. This file owns *when* and *how often* a re-decoration pass happens;
// the actual per-row decision logic lives in treeDecorations.ts, and the
// tree-walking mechanics live in FileExplorerWalker.ts.
import { TFolder, Vault, Workspace, WorkspaceLeaf } from "obsidian";
import { VaultShare, ShareRegistry } from "../VaultShare";
import type { TransferQueue } from "src/TransferQueue";
import { withAnyToggle, withToggle } from "src/featureToggleState";
import { featureKey } from "src/featureToggles";
import { ExplorerTreeWalker } from "./FileExplorerWalker";
import type { Disposable, TreeRowVisitor, TeardownFn } from "./treeVisitor";
import {
	FileUploadPillVisitor,
	DocumentConnectionStatusVisitor,
	FolderLiveIndicatorVisitor,
	FolderStatusPillVisitor,
	UnsyncedFilePillVisitor,
	SyncQueueIndicatorVisitor,
} from "./treeDecorations";

export class ExplorerDecorationCoordinator {
	// Only the non-constructor-supplied bookkeeping is declared here; obsidianVault/
	// obsidianWorkspace/syncedFolders/transferQueue are declared as TS parameter
	// properties on the constructor below instead of being repeated as both
	// a field and an assignment.
	folderChangeTeardown: () => void;
	docsetTeardownByFolder: Map<VaultShare, () => void>;
	layoutChangeTeardown: () => void;
	walkersByLeaf: Map<WorkspaceLeaf, ExplorerTreeWalker>;
	layoutSettled: boolean = false;
	unsubscribes: TeardownFn[];
	private destroyed = false;
	private watchedFolders = new Set<VaultShare>();

	constructor(
		public obsidianVault: Vault,
		public obsidianWorkspace: Workspace,
		public syncedFolders: ShareRegistry,
		public transferQueue: TransferQueue,
	) {
		this.walkersByLeaf = new Map<WorkspaceLeaf, ExplorerTreeWalker>();
		this.unsubscribes = [];
		this.docsetTeardownByFolder = new Map();

		this.obsidianWorkspace.onLayoutReady(() => {
			if (this.destroyed) return;
			this.layoutSettled = true;
			this.refreshAllRows();
		});
		this.subscribeToTransferQueue(transferQueue);
		this.folderChangeTeardown = this.subscribeToFolderChanges();
		this.layoutChangeTeardown = this.listenForLayoutChange();
	}

	// A quick re-decoration pass is enough for anything transferQueue
	// reports -- it changes pill/status state on already-rendered rows,
	// never which rows exist.
	private subscribeToTransferQueue(transferQueue: TransferQueue): void {
		this.unsubscribes.push(
			transferQueue.activeUploads.subscribe(() => this.refreshExistingRows()),
			transferQueue.activeFetches.subscribe(() => this.refreshExistingRows()),
			transferQueue.batches.subscribe(() => this.refreshExistingRows()),
		);
	}

	// Whenever the set of shared folders changes, re-wire per-folder
	// listeners for the folders we haven't seen before and do a full
	// refresh (a folder appearing/disappearing can add/remove rows, so
	// refreshExistingRows -- which only touches existing rows -- isn't enough
	// here).
	private subscribeToFolderChanges(): () => void {
		return this.syncedFolders.subscribe(() => {
			if (this.destroyed) return;
			this.syncedFolders.each((folder) => this.watchFolder(folder));
			this.refreshAllRows();
		});
	}

	private watchFolder(folder: VaultShare): void {
		if (this.destroyed || this.watchedFolders.has(folder)) return;
		this.watchedFolders.add(folder);
		withAnyToggle([featureKey.enableDocumentStatus], () => {
			const docsetListener = this.docsetTeardownByFolder.get(folder);
			if (!docsetListener) {
				this.docsetTeardownByFolder.set(
					folder,
					folder.pathSet.on(() => {
						// A move that crosses a shared-folder boundary changes row
						// membership, so refreshExistingRows alone wouldn't catch it.
						this.refreshAllRows();
					}),
				);
			}
		});
		void folder.awaitReady().then(() => {
			this.refreshAllRows();
		}).catch(() => { /* A removed folder or plugin teardown may cancel readiness. */ });
		this.unsubscribes.push(
			folder.attachmentSettings.subscribe(() => {
				this.refreshExistingRows();
			}),
		);
		this.unsubscribes.push(
			folder.subscribe(this, () => {
				this.refreshExistingRows();
			}),
		);
		this.unsubscribes.push(
			folder.folderIndex.subscribe(() => {
				this.refreshExistingRows();
			}),
		);
	}

	private listenForLayoutChange(): () => void {
		const ref = this.obsidianWorkspace.on("layout-change", () => this.refreshExistingRows());
		return () => {
			this.obsidianWorkspace.offref(ref);
		};
	}

	// Deliberately walks every leaf rather than calling getLeavesOfType --
	// the make.md community plugin overrides that method to hand back its
	// own folder-explorer replacement instead of Obsidian's built-in one.
	findFileExplorerLeaves(): WorkspaceLeaf[] {
		const fileExplorers: WorkspaceLeaf[] = [];
		if (this.destroyed) return fileExplorers;
		this.obsidianWorkspace.iterateAllLeaves((leaf) => this.collectFileExplorerLeaf(leaf, fileExplorers));
		return fileExplorers;
	}

	private collectFileExplorerLeaf(leaf: WorkspaceLeaf, into: WorkspaceLeaf[]): void {
		if (leaf.view.getViewType() !== "file-explorer") return;
		if (!into.includes(leaf)) {
			into.push(leaf);
		}
	}

	private getOrCreateWalker(fileExplorer: WorkspaceLeaf): ExplorerTreeWalker {
		const existing = this.walkersByLeaf.get(fileExplorer);
		if (existing) return existing;
		const walker = new ExplorerTreeWalker(
			fileExplorer,
			this.syncedFolders,
			this.assembleVisitors(),
		);
		this.walkersByLeaf.set(fileExplorer, walker);
		return walker;
	}

	// Shared by refreshExistingRows/refreshAllRows below: both want "walk
	// these root folders in every open file-explorer" and only differ in
	// which roots. `roots` is re-evaluated per file-explorer, matching the
	// previous behavior of re-resolving each shared-folder path from the
	// vault once per explorer.
	private walkEachExplorer(roots: () => TFolder[]) {
		if (this.destroyed || !this.layoutSettled) return;
		for (const fileExplorer of this.findFileExplorerLeaves()) {
			const walker = this.getOrCreateWalker(fileExplorer);
			for (const root of roots()) {
				walker.traverse(root);
			}
		}
	}

	// The document-status visitors are gated behind a featureKey, so they're built
	// up separately from the always-on visitor set and spread into it below
	// -- a declarative visitor LIST rather than an imperative push sequence.
	private documentStatusVisitors(): TreeRowVisitor<Disposable>[] {
		const visitors: TreeRowVisitor<Disposable>[] = [];
		withToggle(featureKey.enableDocumentStatus, () => {
			visitors.push(
				new DocumentConnectionStatusVisitor(),
				new SyncQueueIndicatorVisitor(
					this.transferQueue.activeUploads,
					this.transferQueue.activeFetches,
				),
			);
		});
		return visitors;
	}

	assembleVisitors(): TreeRowVisitor<Disposable>[] {
		return [
			new FolderLiveIndicatorVisitor(),
			new FolderStatusPillVisitor(),
			...this.documentStatusVisitors(),
			new FileUploadPillVisitor(),
			new UnsyncedFilePillVisitor(),
		];
	}

	refreshExistingRows() {
		this.walkEachExplorer(() =>
			this.syncedFolders
				.collect((folder) => this.obsidianVault.getAbstractFileByPath(folder.path))
				.filter((file): file is TFolder => file instanceof TFolder),
		);
	}

	refreshAllRows() {
		this.walkEachExplorer(() => {
			const root = this.obsidianVault.getAbstractFileByPath("/");
			return root instanceof TFolder ? [root] : [];
		});
	}

	dismantle() {
		if (this.destroyed) return;
		this.destroyed = true; this.layoutSettled = false;
		this.folderChangeTeardown?.();
		this.docsetTeardownByFolder.forEach((off) => off());
		this.docsetTeardownByFolder.clear();
		this.unsubscribes.forEach((unsub) => unsub());
		this.unsubscribes.length = 0;
		this.walkersByLeaf.forEach((walker) => {
			walker.destroy();
		});
		this.walkersByLeaf.clear();
		this.watchedFolders.clear();
		this.layoutChangeTeardown();

		this.obsidianVault = null as unknown as Vault;
		this.obsidianWorkspace = null as unknown as Workspace;
		this.syncedFolders = null as unknown as ShareRegistry;
		this.transferQueue = null as unknown as TransferQueue;
		this.folderChangeTeardown = null as unknown as () => void;
	}
}
