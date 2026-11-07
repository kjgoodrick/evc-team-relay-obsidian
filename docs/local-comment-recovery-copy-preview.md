# Local comment recovery copies

This preview adds **Save recovery copy** to **Comment storage on this device**.
It works offline for the current account, vault and shared folder. Team Relay
writes a new folder beneath `Relay Recovery (local only)` and verifies every
written file before reporting success. No source draft or waiting change is
sent, edited or discarded by export.

## Contents and boundaries

The versioned JSON preserves saved rich drafts, targets, queued/sending/rejected/
review commands, original operation identities and dependencies, relevant
Send-and-reopen and editing-recovery records, unconfirmed target moves, and
pending/rejected timeline marker actions. Terminal predecessor records identify
their local outcome without copying server receipt bodies or worker leases.
Original locally retained pictures are separate binary files with SHA-256 hashes
and lengths. Rich picture references without retained local bytes remain references.

The copy excludes remote discussion caches/history, permission and participant
caches, credentials, inbox preferences and downloaded picture renditions. Server
URL credentials, query parameters and fragments are removed from the identifying
metadata. It is a plain, unencrypted local file copy. Team Relay excludes this
folder from its own sync; other backup/sync software may still copy it.

This is **not** shared-discussion export, a service backup, or an automatically
replayable outbox. Some captured operations may already have reached the server.
This preview provides no import command. Future import must reconcile delivery,
account/scope identity and authorization, then require content/target review.
The README inside every complete copy explains these limits.

## Consistency, interruption and resource use

Storage version 23 adds one retained export capture per account/shared folder
and fences older clients. Existing drafts, requests and cache settings survive
the upgrade. One transaction captures bounded metadata and pins the original
picture records. Normal editing and delivery can continue; acknowledgements
cannot delete picture bytes required by the captured version. Export pins do
not keep obsolete picture upload commands active.

Metadata is limited to 5,000 records and 8 MiB; the existing original-picture pool
is limited to 100 MiB, with at most 10 MiB per picture. Capture and file writing
process one picture at a time rather than collecting the entire pool in memory.
Limits fail the capture atomically without removing saved work. Original-picture
usage includes bytes retained solely by an unfinished capture.

The writer uses generated file names, never note paths or comment text. It reads
back each picture and checks its hash/length, then checks the metadata and README.
`COMPLETE.json`, written last, records the manifest hash and length. Successful
verification releases only the export's picture ownership; normal draft/outbox
ownership remains intact. Explicit account cleanup also clears retained captures.

An interrupted copy keeps its immutable capture across reloads. **Retry retained
recovery copy** writes the same captured version to a fresh folder; later edits
remain in the working database. Partial folders are preserved and are incomplete
unless they have a valid completion record. The user can instead acknowledge
that the retained capture is no longer needed and release it. This may release
older versions/pictures retained only for export, but does not remove current
drafts, waiting changes or files already written. Competing windows cannot replace
the capture, and a stale release cannot remove a newer one. Closing the panel or
changing accounts stops subsequent writes and leaves the capture available.

## Evidence — November 7, 2026

- 45 focused tests cover real IndexedDB ownership, dependency/review records,
  account isolation, URL redaction, migration, concurrent windows, failed and
  corrupt file writes, interrupted retry, UI controls and source retention.
- Full plugin regression: **3,031 tests / 239 suites passed**, with **21 opt-in
  tests / 17 suites skipped**. Build/main types pass with 15 existing build
  warnings. Changed-source lint has no errors or warnings. Test types remain
  within the frozen baseline: 206 errors / 45 signatures versus 207 / 46.
- Native macOS Obsidian 1.13.7, using only the disposable
  `evc-recovery-native-20261107` vault with its service stopped, retains the
  existing offline draft and disabled picture-cache setting after upgrade.
  The storage command saves a verified recovery copy. Independent filesystem
  verification confirms the manifest hash/length and the single expected draft.
  Closing the panel leaves the draft intact; the original vault window was
  restored. Evidence: `/private/tmp/comment-export-native-evidence.json`.

Native picture export, interrupted native disk writes, physical mobile/resource
acceptance, reviewed import, deliberate saved-work abandonment, inaccessible
targets, broader cache controls and coherent service backup/restore remain.
No live vault installation or production deployment occurred.
