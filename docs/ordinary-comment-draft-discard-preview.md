# Discarding ordinary comment drafts

The comment composer offers **Discard draft** for a saved ordinary draft. The
review pauses editing and provides **Keep editing** and **Discard saved draft**.
Discard is local, works offline and leaves posted comments unchanged. It has no
local undo; a recovery copy can be saved from the storage panel first.

An unconfirmed online Send-and-reopen draft cannot use this shortcut. A draft
created by cancelled-command recovery also uses the separate dependent-work
review instead. The database checks those protections again during deletion.

Confirmation compares the complete stored draft, including its revision, scope,
body and target, in the same transaction that removes it and releases picture
ownership. Changed or recreated drafts, closed review windows and changed account
epochs leave the saved work intact. Pictures still owned by another draft,
queued command or retained recovery copy remain available.

Same-account windows receive a draft-ID invalidation only, with no content or
credentials. Stale editors become read-only, preserve visible text for copying,
and cannot send or recreate the deleted draft. The database comparison also
protects the interval before that invalidation arrives. Listener cleanup follows
composer/session disposal; another account's channel receives no signal.

A completed target draft also stays paused while the host switches views after
send or discard. Quick typing cannot recreate the retired selection during that
transition. Ordinary whole-note drafts can start fresh after discard.

Validation covers plain/rich confirmation and cancellation, stale competing
edits, recreated draft identity, protected online/recovery records, picture/export
ownership, fresh ordinary drafts, same-account cross-window delivery and account
isolation. Native desktop/mobile cleanup and the full recovery matrix remain
separate acceptance work. Standalone reaction cleanup, browsing/editing
inaccessible saved work, disconnected-folder recovery, reviewed import and
coherent service backup/restore remain unfinished.

The full suite passes **3,056 tests / 242 suites**, with **21 opt-in tests / 17
suites skipped**. A final target-transition guard follows that run; its send and
discard regressions pass in the **110-case focused run**. Final build/main types,
frozen test-type gate and changed-source lint pass. The build retains 15 existing
warnings; test types remain 206 errors / 45 signatures versus the 207 / 46 baseline.
No native discard result was claimed for that increment. No live vault or
production service was changed.

## Native desktop follow-up, November 7

The user explicitly approved discarding the synthetic reply “Preserve this reply
while target filters hide it” in `/private/tmp/evc-targets-native-20261107`.
Obsidian 1.13.7 on macOS, with the fixture services stopped, displayed the exact
retained reply and the final review. **Discard saved draft** cleared the editor
and reported success. A full native reload and reopening the same reply composer
left it empty with no Discard draft control. All three previously posted
discussions, including the rich edited message, remained visible from cache.
The earlier **Keep editing** check preserved the same draft.

This check used the existing `076ffe3` preview build. Its local evidence is in
`/private/tmp/target-status-native-evidence.json` and
`/private/tmp/comment-rich-history-native-evidence.json`. The original Knowledge
Base window was restored. Native mobile, multiwindow and picture-ownership
acceptance remain; this result covers ordinary offline text-draft discard only.
