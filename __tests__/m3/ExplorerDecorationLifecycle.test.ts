import type { Vault, Workspace } from "obsidian";
import type { ShareRegistry } from "../../src/VaultShare";
import type { TransferQueue } from "../../src/TransferQueue";
import { ExplorerDecorationCoordinator } from "../../src/ui/ExplorerDecorationCoordinator";

jest.mock("../../src/VaultShare", () => ({}));
jest.mock("../../src/featureToggleState", () => ({ withAnyToggle: (_keys: string[], callback: () => void) => callback(), withToggle: () => {} }));
jest.mock("../../src/ui/FileExplorerWalker", () => ({ ExplorerTreeWalker: class {} }));
jest.mock("../../src/ui/treeDecorations", () => ({}));

test.each([false, true])("late layout/folder readiness after teardown is inert, including rejected readiness (%s)", async rejected => {
	let layout!: () => void, folders!: () => void, ready!: () => void, fail!: (error: Error) => void;
	const readiness = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
	const subscribe = jest.fn(() => jest.fn());
	const folder = { awaitReady: () => readiness, pathSet: { on: subscribe }, attachmentSettings: { subscribe }, subscribe, folderIndex: { subscribe } };
	const workspace = { onLayoutReady: (fn: () => void) => { layout = fn; }, on: jest.fn(), offref: jest.fn(), iterateAllLeaves: jest.fn() };
	const registry = { subscribe: (fn: () => void) => { folders = fn; return jest.fn(); }, each: (fn: (value: unknown) => void) => fn(folder) };
	const observable = { subscribe: jest.fn(() => jest.fn()) };
	const coordinator = new ExplorerDecorationCoordinator({} as Vault, workspace as unknown as Workspace,
		registry as unknown as ShareRegistry, { activeUploads: observable, activeFetches: observable, batches: observable } as unknown as TransferQueue);
	layout(); folders(); folders();
	expect(subscribe).toHaveBeenCalledTimes(4); // One watcher per source, not per registry notification.
	coordinator.dismantle(); const walks = workspace.iterateAllLeaves.mock.calls.length;
	if (rejected) fail(new Error("Readiness cancelled")); else ready();
	await Promise.resolve(); await Promise.resolve();
	expect(() => { layout(); folders(); coordinator.refreshAllRows(); coordinator.refreshExistingRows(); coordinator.dismantle(); }).not.toThrow();
	expect(workspace.iterateAllLeaves).toHaveBeenCalledTimes(walks);
	expect(coordinator.layoutSettled).toBe(false); expect(coordinator.findFileExplorerLeaves()).toEqual([]);
});
