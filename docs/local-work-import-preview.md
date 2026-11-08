# Local-work recovery import preview

November 7, 2026. Comment storage now offers **Review a recovery copy**. Enter a
completed recovery folder's path relative to the current vault, inspect it, then
choose an ordinary draft to restore as a separate local copy. The review shows
rich content, captured target, original-picture counts and references whose
originals are absent. It pages ten drafts at a time. The matching server, account
and shared folder are required; a different source vault is allowed for recovery
on another device. Imported copies can be opened, edited, copied or discarded in
**Saved comment work**, even when the old note is inaccessible.

Choose a destination in the comments sidebar, then **Use saved work at this
target** to turn recovered content into a new discussion draft. This also works
for ordinary local drafts. Review and send from the normal composer. Saved replies
or edits are copied as new discussions; applying their old request identities is
a separate recovery operation.

This is a partial import feature. Waiting commands, unconfirmed online actions
and server-cancellation recovery drafts are not applied by this panel. They may
already have reached the server and need exact receipt/withdrawal reconciliation.
Ordinary draft import reads/writes remain local. A separate, explicit request
receipt check can contact the server as described below; it never resumes delivery,
populates shared caches or claims that a missing receipt proves a request was
never accepted. Native
desktop/mobile import acceptance is still pending.

## Reviewing waiting requests

After local archive inspection, **Review waiting requests** pages ten saved
requests at a time, showing rich bodies, captured targets and dependency counts.
Opening the page performs no network request. **Check server receipt** is enabled
only while connected to a server advertising receipt inspection. It submits the
exact saved request to the read-only status API for the matching server/account/
shared folder. A different source vault is allowed; a foreign account/share/server
cannot be checked through the selected identity.

Accepted, cancelled and unknown results appear in the selected card. They do not
modify the archive, copy requests into the destination, acknowledge an outbox
operation, cancel a command, create a draft, fetch picture bytes or wake delivery.
An inaccessible target or failed read remains an error; missing receipts are
unknown and never trigger replay. Current server read authorization applies even
if the original note is not available locally or comment permission was revoked.
Closing the review, changing accounts or losing its active context discards late
results. Status is transient, not stored as durable acceptance evidence.

The ordinary **Saved comment work → Waiting changes** browser also exposes
**Check server receipt**, including requests held after a restore. It uses the
same exact-request session API without requiring the original note to be open
or present locally. Current server read permission still applies; inaccessible
targets remain errors. Picture uploads and unprepared group requests explain
their separate receipt requirements. The browser remains a local, paged read
until the user explicitly checks a receipt.

Receipt results include the check time and explain that acceptance is not proof
the current discussion still contains the change. Neither accepted nor unknown
results change the local operation, its original generation or dependencies.
The button follows connection/capability availability; one check per card can
run at a time. Page/account/connection/restore-context changes and close/reopen
invalidate late results. Changing context also withdraws a displayed status.
No picture download, participant lookup, resend, withdrawal, draft conversion
or dependent replay is performed by these controls. Full restored-command and
dependent reconciliation remains unfinished.

Ordinary creation, reply, edit and reaction requests can be checked. A saved
Bases group request can be checked only when its exact prepared target is already
in the archive; inspection never acquires a fresh target. Supported lane ranges
and group summaries preserve that evidence. Picture uploads and unprepared group
requests show an explanation. Separate saved online actions, reattachments and
marker changes are not yet included. Original-request import, explicit
withdrawal/replacement, dependent recovery and restore-epoch fencing remain
unfinished. Checking the frozen reviewed payload requires no file mutation;
ordinary draft restoration still revalidates the archive before copying bytes.

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

## Local copies of requests held after restore

**Saved comment work → Waiting changes → Make local draft copy** now preserves
the body of a restore-held creation, reply, edit or group request as a separate
editable draft. It works offline once this account/share has learned a nonnull
restore generation. It requires an unchanged original request from a different
generation, held as rejected or already withdrawn for review with
`restore_generation_changed`. Reactions and picture-upload commands are not body
drafts. An unprepared group body can be copied without acquiring a group target.

The copy preserves the rich body, mention identities and picture references;
retained originals gain draft references without being duplicated or uploaded.
The new draft has **no selected target**, does not appear in the ordinary
selection-draft list and cannot send from the saved-work editor. To use its
content, explicitly open the destination comments, choose **Use saved work at
this target**, review that destination and create a new discussion draft. The
original request, receipt uncertainty, old generation and dependent operations
remain unchanged. A prior accepted change may already exist in the current
discussion; receipt inspection and current-discussion review remain important.

The local copy is idempotent per request/observed generation. Repeated or
competing clicks open the existing copy, including subsequent edits. If that
copy was discarded, repeat clicks report its removal rather than recreating it.
A later observed restore has a separate copy identity. Creation checks the
persisted restore context and exact original record in the same transaction as
the draft, original-picture references and provenance. Account/review changes,
identity collisions and quota/write failures leave the original work untouched
and roll back incomplete copies. Late completion cannot open an editor after
navigation, account changes or another restore.

Verified recovery exports include `restoredDraft:` provenance alongside the
draft and original request. The provenance contains a digest of the reviewed
source record and source/copy generations; it grants no server authority.
Current readers accept it, while older strict readers reject that new action
prefix instead of silently dropping it. The envelope remains version 1,
storageVersion 23, as with the existing optional restore metadata. Copy receipts
remain local and are retained after draft discard; they are not remote command
receipts or proof of server cancellation.

This is explicit content recovery into a new discussion. Full reconciliation
that retains original thread/reply structure, resolves old waiting records,
replays reviewed dependents, or safely resumes source synchronization remains
unfinished. No old operation is automatically resent or assigned the current
generation.

## Verification

The restored-request draft checkpoint passes **3,951 tests across 283 suites**
(39 tests in 25 opt-in suites skipped), **102 focused storage/copy/import/UI
tests**, and **four actual restored-service HTTP tests** (the optional picture
service scenario is skipped). The ordinary session copies a quarantined body
offline, preserves the original request and deduplicates the second copy.
Store tests cover competing windows, edited/discarded copies, changed requests
or generations, transactional quota/cancellation rollback, original pictures,
unchanged dependent work and export provenance. DOM tests cover offline editing,
repeat copying, removed copies and late results after context changes. Main
types, frozen test-type baseline, changed-source lint and the preview build pass
with the existing 15 build warnings. Native/mobile acceptance remains pending.

Earlier request/import verification passed **3,536 tests across 264 suites** (29 tests in
20 opt-in suites skipped). The request-review/session/group/transport checks pass
**114 tests**; an additional focused storage/import/transport run passes **66**
overlapping tests after removing a network-layer import from the local review
model. Actual HTTP checks verify session-level receipt reads after comment
revocation and unchanged local rejected requests. Late responses after a review
context change are discarded. The earlier destination-copy/session/import/UI
group passed 142 tests; the import/export/storage checkpoint passed 98.
Preview build/main types and changed-source lint pass; the existing 15
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

## Copying saved content to a chosen target

The sidebar offers copying for a current commentable target. Text/image/saved-view
selections use their exact captured anchor; an invalid selection cannot fall back
to a whole note. Image and Bases start controls first create a selection, then
expose copying at that target. The active composer must save before the picker
opens. The picker pages ten local drafts, excludes pending delivery/recovery,
and shows content, destination and picture availability before creating a draft.

The copy can use own work whose old target is missing or inaccessible. Within the
same account/share, retained originals receive fresh IDs in the destination scope.
Server-only references may remain in the same scope; crossing scopes requires an
explicit choice to omit references without retained originals. The source stays
unchanged. Copied edits lose their old edit-base revision because the destination
is a new discussion. Pending group captures get a fresh request identity while
preserving exact saved-view, lane and range evidence.

The source revision/body, pending-action flags, original-picture identity and
active destination choice are rechecked inside the transaction. Draft, picture
references/bytes, copy receipt and activation commit together. Source edits or
discard, newly pending sends, competing destination choices, quota failures and
context loss cannot leave a partial copy. Repeating the same copy intent cannot
overwrite an edited copy or recreate a removed copy. The new draft survives reload
in the ordinary selection list. Copy receipts remain until local account cleanup.

Copying reads local work and does not wake delivery. A separate Send uses the
existing queue and current server authorization, including target dependencies
and picture checks. Automated coverage includes exact Bases cells, image pins and
timeline lane ranges. Real HTTP/MinIO checks prove no upload while copying,
successful explicit sending with a fresh picture identity, and preservation of
the source draft/bytes. Native desktop/mobile copying remains unverified while
the Mac is locked. Original-request reconciliation, cross-account/share recovery,
copying into existing replies/edits, and physical-mobile resource acceptance
remain unfinished.
