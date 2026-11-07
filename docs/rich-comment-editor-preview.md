# Rich comment editor preview

The composer retains simple text entry and adds **Format comment**. Formatting
preserves the current text, explicit mentions and selection. Editing an existing
message opens its full structured body, including pictures between paragraphs;
it no longer refuses rich messages or flattens them into a textarea.

Available controls include bold, italic, strikethrough, inline code, flat bulleted
and numbered lists, code blocks with an optional language, HTTP(S) links,
Undo/Redo and the existing authorized member picker. Link editing at a caret
updates the complete link; opening a link panel preserves its selection through
intervening editor transactions. A mention remains an atomic user reference.
Code conversion refuses to silently erase a mention's identity.

Pictures use the existing picker/paste, private storage, upload dependencies and
authorized renderer. New pictures enter at the selected position without
deleting selected text. Pictures inside a list are inserted after that list.
Description, Remove, Move up and Move down controls operate on the actual body.
Insertion, removal and movement have separate Undo boundaries, including when
performed quickly. Fully blank comments cannot send; blank paragraphs within a
nonempty message remain blank lines.

## Local editor and persistence

ProseMirror runs only inside the local comment composer. It does not replace the
CodeMirror note editor, join the Yjs note document, add live collaborative draft
editing or change the server message protocol. Its schema matches the existing
version-one paragraphs, flat lists, code, marks, safe links, mentions and picture
blocks. The library APIs used are the
[editor state](https://github.com/ProseMirror/prosemirror-state),
[view](https://github.com/ProseMirror/prosemirror-view),
[model](https://github.com/ProseMirror/prosemirror-model),
[history](https://github.com/ProseMirror/prosemirror-history) and
[list commands](https://github.com/ProseMirror/prosemirror-schema-list).
Direct dependencies are pinned in `package.json`; the lockfile pins the complete
dependency graph. Existing package versions were not changed.

Rich drafts retain the complete body, a selectable recovery-text projection,
active picture references and the edit's original message revision. The existing
account-isolated IndexedDB compare-and-swap and draft-to-outbox transaction remain
the persistence boundary. A second window cannot overwrite a newer draft.
Queued edits continue to carry an expected server revision.

An edit draft opened against a different known message revision displays that
revision beside the retained draft and requires an explicit **Use this revision
for my edit** action. Legacy edit drafts with no saved base revision use the same
review. The button acknowledges the revision shown when the editor opened;
another server edit after that still causes a revision conflict, preserving the
rejected work. It is not an automatic merge or last-writer-wins overwrite.

The local database version increases from 19 to 20 to fence older clients that
cannot preserve rich draft fields and Undo picture references. The migration
preserves existing stores, drafts, queued operations and cached data. An older
build cannot reopen this newer cache; rollback must retain/export unsent work
and use a compatible build rather than deleting the database.

## Pictures, Undo and recovery

Removing an unsent picture keeps its local original while this editor's Undo
can restore it. Active pictures remain limited to ten; active and inactive Undo
references together are limited to 100 distinct IDs and the existing 100 MiB
local-original quota. Only active body pictures enter an outgoing command.
Sending atomically releases inactive references and transfers active ones to
upload/message dependencies. Other drafts' references still protect their bytes.

Reopening an editable draft starts a new Undo session and releases its inactive
references. An unconfirmed online send is kept unchanged and locked until the
existing delivery-check workflow settles it. Closing without reopening can keep
inactive originals referenced by that draft; this is bounded by the same quota,
not a persisted Undo history. Picture refresh atomically remaps IDs throughout
the rich body, active references and retained references, preserving the target,
text and expected edit revision. Refresh resets the current editor's Undo history.

## Input safety and resource bounds

Supported pasted HTML becomes schema nodes. It cannot create a private picture
reference or authenticated mention from a class, attribute or copied label.
Copied labels remain readable text; mentions are created through the member
picker. Unsafe links, scripts and unsupported active content do not become
rendered message nodes. Clipboard file pictures go directly through existing
byte staging before their HTML is parsed. Ordinary paste is rejected above
65,536 UTF-16 text units or 262,144 HTML units before creating a clipboard DOM.
Final message validation still enforces the existing 32 KiB body and node limits;
a rejected transaction retains the previous body rather than truncating it.

The editor configures a 100-event Undo history and disposes its view, picture
observers and decoded URLs on closure. Composition checks protect formatting,
mention insertion, attachment operations and sending. Draft controls lock while
saving an attachment, after a storage conflict or during an unconfirmed online
send. Desktop/mobile composition and clipboard behavior still require native
acceptance; DOM tests are not that evidence.

The preview bundle grows by approximately 232 KiB uncompressed from the
1,827,657-byte prior build. This is a deliberate cost for a maintained editor
with selection, history, clipboard and composition handling. No existing
dependency version was upgraded. The dependency audit reports no advisory for
the editor packages or their added dependencies; the repository-wide audit
still reports 33 other advisories. Native startup, typing and memory measurements
remain release work.

## Verification and remaining work

Automated tests cover full node/mark round trips, code-point and body limits,
HTML safety, list split/switch/lift, link editing, atomic mentions, composition
guards, picture insertion/movement/Undo, bounded clipboard input, rich draft
reload, exact outbox bodies, stale edit review, multiwindow conflicts, inactive
picture reclamation, rich picture recovery and the version-19 upgrade fence.

The actual Python HTTP service accepts the output of a real editor-model
transaction, preserves its rich revisions and rejects an edit with a stale base
revision. Author-only history after removal remains enforced. The service fixture
uses synthetic accounts and a disposable loopback process that is stopped after
verification. Final regression/build/type results are recorded in the
[project status](../../../docs/Plans/obsidian-presence-comments-status.md).
The final full plugin run passes 2,926 tests in 227 suites, with 19 opt-in tests
in 17 suites skipped; both real-service scenarios pass separately. Preview build,
main types, changed-file lint and the frozen test-type gate pass. Existing
15 Svelte warnings and 206 test-type errors/45 signatures remain. Changed-file
lint reports zero errors and 11 warnings. The final bundle is 2,065,487 bytes.

Native desktop/mobile/popout, physical clipboard/IME, keyboard/touch,
screen-reader, performance and lifecycle acceptance remain. The latest native
availability check reports that the Mac is locked. No live vault installation or
production deployment has occurred. Other release work—reattachment, remaining
Bases/timeline targets, permission-management UI and complete recovery/backup—
is tracked independently in the project status.
