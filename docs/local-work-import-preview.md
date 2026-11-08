# Local-work recovery import preview

November 7, 2026. Comment storage now offers **Review a recovery copy**. Enter a
completed recovery folder's path relative to the current vault, inspect it, then
choose an ordinary draft to restore as a separate local copy. The review shows
rich content, captured target, original-picture counts and references whose
originals are absent. It pages ten drafts at a time. The matching server, account
and shared folder are required; a different source vault is allowed for recovery
on another device. Imported copies can be opened, edited, copied or discarded in
**Saved comment work**, even when the old note is inaccessible.

This is a partial import feature. Choosing a destination discussion and sending
an imported draft remain unfinished. Waiting commands, unconfirmed online actions
and server-cancellation recovery drafts are not applied by this panel. They may
already have reached the server and need exact receipt/withdrawal reconciliation.
No import read or write contacts the server, resumes delivery, populates shared
caches or claims that a saved request has not already been accepted. Native
desktop/mobile import acceptance is still pending.

## Applying an ordinary draft

The review requires a supported draft/target shape and valid mention spans. Rich
content supplies its own text projection. Saved targets and edit-base revisions
are preserved as captured evidence, not authority to publish or overwrite an edit.
Account, scope and supported-target consistency are checked before copying.

Restore rechecks the whole completed archive and requires the reviewed manifest
hash. Only originals referenced by the selected draft are retained in memory.
Each gets a fresh picture ID, remapped through the rich body, active-picture list
and retained Undo references. References with no original remain references in
the same scope, are counted explicitly in review, and cause no shared fetch.

The new `imported:<uuid>` draft, picture ownership/bytes, provenance and import
receipt commit in one IndexedDB transaction. Quota, identity collisions or an
account/window change roll back that transaction. Receipts identify the source
manifest/snapshot/draft/scope inside the destination account's isolated store.
Two windows importing the same source create one copy. Reimport does not overwrite
an edited copy or recreate a discarded copy. The receipt remains until explicit
account cleanup; source files are never changed. Imports emit cache-invalidation
signals only, without waking the delivery queue.

`importedDraft:` provenance is included in future recovery captures while the
corresponding draft still exists; receipts are destination-local. The format
version remains 1: the action field is extensible, but older strict preview
validators reject this added action prefix. This metadata is untrusted provenance,
not a grant of remote permission.

## File validation and resource limits

`inspectLocalWorkRecovery` accepts a selected relative vault directory, a local
read adapter and an account/window guard. It checks the completion marker,
manifest hash/byte count, supported format/storage versions, snapshot identity,
record shapes, unique IDs and captured dependency references. It rejects duplicate
decoded JSON keys, nonfinite numbers, excessive nesting and malformed metadata.
Original pictures use only canonical numbered paths; hashes and byte counts are
verified one at a time. The completion marker is reread at the end. The returned
metadata is deeply frozen and contains no picture bytes.

Limits match the existing capture format: 8 MiB of manifest metadata, 5,000
records, 10 MiB per picture and 100 MiB of original pictures. JSON additionally
caps depth at 48 and values at 250,000. A cooperative 60-second budget and
account/window checks run between asynchronous steps. Local adapter errors are
sanitized; errors contain no file contents, credentials or private paths.

The read adapter must remain local and check file sizes before allocating reads.
The preflight rechecks actual lengths afterward. These checks catch changed
files but cannot impose streaming memory bounds on a public vault API that reads
a whole file, or independently guarantee filesystem symlink isolation. A desktop
adapter with stronger file-opening guarantees can enforce those separately.
No manifest-supplied path can escape the selected directory. Applying a draft
retains its selected originals and then clones them for the atomic store write;
peak memory can exceed the 100 MiB source quota. Streaming/staged import and
physical-mobile memory acceptance remain; this preview does not promise a hard
mobile memory ceiling. Unselected picture buffers are checked sequentially and
released.

Checksums establish integrity of the captured bytes, not origin, account
authority, current permissions or delivery status. Pending payloads and actions
are retained as data and must not be passed directly to delivery workers. Exact
receipt reconciliation and an explicit destination/permission review must precede
any future sending workflow.

## Verification

The final plugin regression passes **3,489 tests across 260 suites** (29 tests in
20 opt-in suites skipped). The focused import/export/storage group passes **98
tests**. Preview build/main types and changed-source lint pass; the existing 15
build warnings remain. Test types report 206 errors/45 signatures against the
frozen 207/46 baseline, with no new errors.

Verification includes actual store exports, immutable inspection, malformed and
corrupt archives, missing completion, unsupported versions, duplicate IDs/keys,
invalid dependencies, unsafe picture paths, oversized/growing files, cancellation,
changed completion and sanitized I/O failures. Actual IndexedDB tests additionally
cover independent draft/picture/provenance writes, concurrent deduplication,
edited/discarded copies, account/scope mismatch, quota/collision/cancellation
rollback, malformed receipts, rich/Undo picture remapping, unchanged outbox and
source files, changed-after-review archives and provenance export. DOM tests use
the real session and store to verify explicit inspection, rich previews, bounded
pages, blocked unconfirmed/foreign-account drafts, cancellation and no transport
send or worker wake. Saved-work editor tests verify the imported label, local
editing and no target conversion.

An independent bundled-core adapter also restores both previously created native
Obsidian recovery copies into disposable IndexedDB stores, verifies repeated
imports create no second draft and leaves all source files unchanged. Both copies
contain one text draft and no pictures; picture coverage comes from exporter/store
tests. This filesystem proof is not native UI or physical-mobile acceptance.
