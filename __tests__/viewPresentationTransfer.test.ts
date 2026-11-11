/** @jest-environment jsdom */
import { DocumentViewBinding, ViewActionsMount } from "../src/ViewBindings";
import { mountComponent } from "../src/svelteMount";
jest.mock("jose", () => {
 const { TextEncoder, TextDecoder } = require("node:util");
 Object.assign(window, { TextEncoder, TextDecoder });
 return jest.requireActual("jose");
});
jest.mock("../src/components/EditorStatusActions.svelte", () => ({}));
jest.mock("../src/svelteMount", () => ({ mountComponent: jest.fn() }));
jest.mock("../src/PresenceTitleDecorator", () => ({}));
jest.mock("../src/y-codemirror.next/LiveEditPlugin", () => ({}));
jest.mock("../src/y-codemirror.next/RemoteSelections", () => ({}));
jest.mock("../src/editorExtensions/ExternalLinkExtension", () => ({}));

test("tracking controls transfer without removing DOM and retire the old document listener", () => {
 const containerEl = document.createElement("div"), actions = containerEl.appendChild(document.createElement("div"));
 actions.className = "view-actions"; actions.appendChild(document.createElement("button")); document.body.append(containerEl);
 const hostView = { containerEl }, share = {}, listeners = [new Set<Function>(), new Set<Function>()];
 const docs = listeners.map(set => ({ vaultShare: share, connectionState: { status: "connected" }, subscribe: (_: unknown, fn: Function) => { set.add(fn); return () => set.delete(fn); } }));
 const bindings = docs.map(boundDocument => Object.assign(Object.create(DocumentViewBinding.prototype), { hostView, boundDocument, _actions: new ViewActionsMount(), _isTracking: true }));
 const icon = document.createElement("button"); icon.className = "evc-relay-view-action";
 const update = jest.fn(), destroy = jest.fn(() => icon.remove());
 jest.mocked(mountComponent).mockImplementation((_component, options) => { options.target.appendChild(icon); return { update, destroy }; });
 try {
  bindings[0].renderActionsPill();
  bindings[0].transferPresentationTo(bindings[1]);
  expect(icon.isConnected).toBe(true); expect(mountComponent).toHaveBeenCalledTimes(1); expect(destroy).not.toHaveBeenCalled();
  expect(listeners[0].size).toBe(0); expect(listeners[1].size).toBe(1);
  bindings[0].clearActionsPill();
  expect(icon.isConnected).toBe(true);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ liveView: bindings[1] }));
  bindings[1].clearActionsPill(); expect(icon.isConnected).toBe(false); expect(listeners[1].size).toBe(0);
 } finally { containerEl.remove(); }
});
