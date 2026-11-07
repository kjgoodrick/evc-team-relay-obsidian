/** @jest-environment jsdom */
import type { App } from "obsidian";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { CommentStoragePicker, type CommentStorageSource } from "../../src/collaboration/ui/CommentStoragePicker";
jest.mock("obsidian", () => ({ Modal: class {
	contentEl = document.createElement("div"); setTitle() {}
	close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); } });
const source = (shareId: string, label: string): CommentStorageSource => ({ label, session: {
	identity: { serverId: "https://relay.test", accountId: "account", vaultId: "vault", shareId },
} as DiscussionSession });
function fixture() {
	let sources = [source("one", "Server · Team one"), source("two", "Server · Team two")];
	const choose = jest.fn(), modal = new CommentStoragePicker({} as App, () => sources, choose);
	document.body.append(modal.contentEl); modal.onOpen();
	return { modal, choose, sources, set: (next: CommentStorageSource[]) => { sources = next; },
		open: () => Array.from(modal.contentEl.querySelectorAll("button")).find(button => button.textContent === "Open storage")!.click(),
		close: () => { modal.onClose(); modal.contentEl.remove(); } };
}
test("selection is identity-bound across label/reorder changes and opens only after an explicit choice", () => {
	const f = fixture();
	try {
		const select = f.modal.contentEl.querySelector("select")!; select.value = JSON.stringify(f.sources[1].session.identity);
		f.set([{ ...f.sources[1], label: "Renamed team" }, f.sources[0]]); f.modal.validate();
		expect(select.value).toBe(JSON.stringify(f.sources[1].session.identity)); expect(f.choose).not.toHaveBeenCalled();
		f.open(); expect(f.choose).toHaveBeenCalledWith(f.sources[1].session); expect(f.modal.contentEl.textContent).toBe("");
	} finally { f.close(); }
});
test.each([false, true])("account/folder loss closes rather than silently switching storage (notify first %s)", notify => {
	const f = fixture();
	try {
		f.set([f.sources[1]]); if (notify) f.modal.validate(); else f.open();
		expect(f.modal.contentEl.textContent).toBe(""); expect(f.choose).not.toHaveBeenCalled();
	} finally { f.close(); }
});
