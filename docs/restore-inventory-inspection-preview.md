# Inspecting a restored share before activation

The restored-share dialog now offers **Compare server inventory** alongside
**Save local recovery copy**. It reads the inventory currently visible to the
selected account and compares entry identities and locations with the retained
local inventory. This is an explicit GET; it does not apply the returned snapshot,
adopt its restore generation, restore write permissions, start synchronization,
replay queued changes, move files or clear the pending review.

The comparison distinguishes unchanged identity/location, different recorded
metadata, moved entries, locally retained entries absent from the visible server
inventory, and server entries absent from local inventory. Different identities
at the same path remain separate and are called out. Duplicate identities or
changed entry kinds require manual review. Absence from the server is described
as removed **or no longer accessible**, since this account cannot distinguish
those cases. Fifty entries render per page.

The inventory rows alone do not compare contents or untracked files. Matching
inventory metadata therefore never means local and server contents match. The
current inventory may belong to a newer restore
than the originally observed review; inspecting it still leaves that original
review intact. The checked time identifies the read, not a promise that the
server has stopped changing.

The read captures account, server, endpoint/token, shared-folder and review
context. It rejects results after changes during the request or body parsing.
A missing selected server cannot reuse an old inventory credential. Local
inventory changes and account notifications withdraw a displayed comparison;
later actions recheck its captured context. Closing/reopening the dialog cannot
adopt a previous pending response. Failed reads remain retryable. The inventory
request suppresses response content and URL diagnostics.

Automated tests exercise comparison semantics, prototype-looking paths, bounded
pages, failures, pending-response invalidation, dialog close/reopen, account
changes and preservation of local state. The actual disposable HTTP restore
fixture verifies that a paused client reads later server changes while its old
offline move and synchronization pause remain intact.

## Captured source-text comparison

An unambiguous visible note or existing Canvas source now has **Compare source
text**. It opens an explicit read-only server snapshot alongside separately
captured local editing history, an unsaved buffer and the native file, where
available. Selecting a local version changes the comparison; it never combines
that version with the restored source. Small differences have semantic insertion
and deletion highlights and a textual legend. Larger originals have bounded
16,000-character pages. All source text is inert text, including HTML, image
markup and links. Identical text does not establish interchangeable histories.

The server read requests a new read grant with the inspected generation. It
does not reuse or overwrite a cached writer grant. Its disposable empty Yjs
document has no persistence, retained updates, broadcast channel, user mapping
or published awareness. It closes on synchronization, cancellation, failure or
the 20-second download deadline. Accumulated applied updates and the final
encoded snapshot are capped at 16 MiB; this is not a transport-frame or total
memory bound. Local native bytes are limited to 2 MiB and decoded as strict
UTF-8. Each retained/server text is limited to 2 Mi characters. Full differences
run only for combined text up to 48,000 characters, with a 20-ms computation
deadline and edit-distance cap. Larger or complex differences retain the paged
originals. Large-history resource acceptance remains outstanding.

Inline local cache reads use a readonly cursor transaction, capped at 16 MiB of
update backing buffers and 50,000 rows, with a five-second transaction deadline.
They read only the two association metadata keys and do not enumerate/load
unrelated custom metadata. Cache opening has its existing ten-second deadline;
abort while waiting prevents any late database creation. Size/count/deadline
failures leave the full original history available to the separate recovery
export, whose capture is not silently truncated to these preview limits.

Both retained and restored documents must have all insertion/deletion
dependencies applied before text is displayed. Otherwise the comparison fails
instead of presenting partial/empty text as a full version. Captured live history
may supply a missing local dependency in the temporary comparison document;
persisted bytes still remain unchanged. The checks do not establish that a
previously unsynchronized cache contains every remote change. They establish
that the captured updates can be applied together without unresolved parts.

Local cache reads preserve cache metadata and pending update bytes and do not
create missing databases. Known local inventory
identity, cache association and live document ownership/kind are checked before
overlaying live edits into a temporary local document. Ambiguous identities,
changed kinds, unsafe paths, invalid UTF-8, changed account/folder/review context
and changed inventory reject the comparison. Local native-file moves during
reading reject it too. The server download rechecks the same context before
transmission and before returning. Closing/hiding the modal or receiving account
or inventory changes aborts pending work and removes displayed text; stale
responses cannot repopulate a closed or reopened dialog. Later display actions
recheck the captured context.

The local snapshots precede the server download; they are not a coordinated
snapshot, and later source edits require refresh. The current inline local
selection covers the automatic client's original history/buffer, not all
explicitly bound source-generation caches. Those histories remain separately
available in verified recovery copies. A server-only entry has no inferred
local association, and a currently inaccessible entry has no server download
action. Canvas support here is existing-sync source recovery, not Canvas
commenting.

Automated temporary-filesystem/IndexedDB tests verify distinct text versions,
unchanged persisted updates/native bytes/buffers, absent-cache preservation,
live-only edits, Canvas source export, association/path/encoding/size failures
and changing contexts. Cursor tests verify bounded reads, cancellation, metadata
selectivity, preserved export inputs, missing caches and late opens. Incomplete
insertions/deletions are withheld, and a live dependency can complete a retained
preview without rewriting its cache. DOM tests cover safe rendering, bounded pages, selection,
inventory-to-source navigation, cancellation, errors and modal reopen. The
actual FastAPI/Rust document-restore fixture reads the selected restored source
without altering its history while the original source remains paused. This
fixture tests generation isolation, not a coherent service restore of bytes.

Native desktop/mobile acceptance is pending. Durable selection,
inventory/source-buffer switching, native replacement and complete outbox
reconciliation remain separate work; this preview has no activation action.
