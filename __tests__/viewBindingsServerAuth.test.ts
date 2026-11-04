import { ViewBindingRegistry, SignedOutViewBinding } from "../src/ViewBindings";
import { moment } from "obsidian";

// UI rendering is outside these auth/routing checks. The registry methods are real.
jest.mock("../src/components/EditorStatusActions.svelte", () => ({}));
jest.mock("../src/svelteMount", () => ({}));
jest.mock("../src/PresenceTitleDecorator", () => ({}));
jest.mock("../src/y-codemirror.next/LiveEditPlugin", () => ({}));
jest.mock("../src/y-codemirror.next/RemoteSelections", () => ({}));
jest.mock("../src/editorExtensions/ExternalLinkExtension", () => ({}));
jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), moment: { utc: () => ({ diff: () => 0 }) } }));

function fixture(active: boolean, loggedIn: string[]) {
	const registry = Object.create(ViewBindingRegistry.prototype) as ViewBindingRegistry;
	const auth = { isAuthenticated: active, isLoggedInToServer: jest.fn((id: string) => loggedIn.includes(id)), presentLoginPage: jest.fn() };
	Object.assign(registry, { authSession: auth, logInfo: jest.fn(), logWarn: jest.fn() });
	return { registry, auth };
}

test.each([
	[false, ["kb"], "kb", true],
	[true, ["other"], "kb", false],
	[true, [], undefined, true],
	[false, [], undefined, false],
] as const)("view auth uses its share's server: active=%s loggedIn=%s server=%s", (active, loggedIn, server, allowed) => {
	const { registry } = fixture(active, [...loggedIn]);
	const folder = { isPrepared: true, config: { onpremServerId: server } };
	const live = {};
	const makeLive = jest.fn(() => live);
	const views: unknown[] = [];
	(registry as any).pushResolvedView(views, folder, "Note.md", {}, "doc", makeLive);
	expect(makeLive).toHaveBeenCalledTimes(allowed ? 1 : 0);
	if (allowed) expect(views).toEqual([live]);
	else expect(views[0]).toBeInstanceOf(SignedOutViewBinding);
});

test("refresh connects only authenticated share servers without disconnecting a logged-in non-default share", async () => {
	const { registry } = fixture(false, ["kb"]);
	const folders = ["kb", "signed-out"].map(server => ({
		config: { onpremServerId: server }, bringOnline: jest.fn(), goOffline: jest.fn(),
	}));
	Object.assign(registry, {
		serviceHealth: { isOnline: true }, shareRegistry: { each: (cb: (f: unknown) => void) => folders.forEach(cb) },
		awaitOpenFoldersReady: async () => folders, collectOpenViews: () => [], findOpenFolders: () => folders,
		reconcileViewSets: () => [[], []], trackedViews: [], attachMatchingOrReadyViews: async () => [], installExtensions: jest.fn(),
	});
	await registry._executeRefreshPass("regression", moment.utc());
	expect(folders[0].bringOnline).toHaveBeenCalledTimes(1);
	expect(folders[0].goOffline).not.toHaveBeenCalled();
	expect(folders[1].goOffline).toHaveBeenCalledTimes(1);
	expect(folders[1].bringOnline).not.toHaveBeenCalled();
});
