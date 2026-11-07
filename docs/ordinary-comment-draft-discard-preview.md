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
No native discard result is claimed for this increment, and no live vault or
production service was changed.
