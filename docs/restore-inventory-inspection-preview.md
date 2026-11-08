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

This does not compare Markdown/Canvas contents, file bytes, unsaved text or
untracked files. Matching inventory metadata therefore never means the local
and server contents match. The current inventory may belong to a newer restore
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

Native desktop/mobile acceptance is pending. This is the inventory stage of
review, not a completed activation flow: source-content comparison, durable
selection, inventory/source-buffer switching, native replacement and complete
outbox reconciliation remain separate work.
