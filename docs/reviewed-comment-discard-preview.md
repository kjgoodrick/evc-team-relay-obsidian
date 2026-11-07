# Discarding reviewed local comments

After **Review delivery and edit** has confirmed server cancellation, the recovery
modal offers **Review discard**. This is local saved-work cleanup, not deletion of
a posted comment. It works offline once cancellation has been confirmed.

The review lists the current recovered draft and all active dependent changes,
including transitive waiting replies and independently recovered child drafts.
Editing/sending pauses while the review is open. Nothing is discarded until the
user acknowledges the list and selects **Discard reviewed local work**. Cancelling
the review returns to editing. The user can first save a local recovery copy from
the storage panel. Discard itself has no local undo command.

One transaction rereads the complete dependent graph, draft contents/revisions,
operation states and recovery mappings. Any changed draft, added dependent,
replacement send, account/window change or uncertain attempted dependent rejects
the operation without partial cleanup. An attempted dependent needs its own
delivery review; it is never assumed unsent. Traversal is limited to 100 active
operations and 8 MiB of serialized review content, checked while collecting.

Success removes the reviewed recovery drafts/mappings and leaves withdrawn
operation tombstones with the original payloads. Old worker acknowledgements and
stale composer saves cannot resurrect them. Posted changes and predecessors
outside the reviewed dependent group remain unchanged. Picture ownership is
released atomically. Other drafts, active operations and retained recovery copies
keep their originals; obsolete unreferenced upload work is retired. Server staging
cleanup handles any already-uploaded unattached bytes.

## Evidence and remaining work

The 41-case focused run covers dependency traversal, nested review drafts,
competing edits/new dependents/replacement sends, uncertain worker state, stale
callbacks, transaction rollback, other-draft/export picture ownership and modal
confirmation/cancellation. The actual HTTP fixture confirms server withdrawal,
explicit group discard, cancelled dependent reply, delayed original rejection and
absence of the discarded thread. Build/main types and the frozen test-type gate
pass; changed-source lint has no errors or warnings. The full suite passes
**3,042 tests / 240 suites**, with **21 opt-in tests / 17 suites skipped**.

Native desktop/mobile discard acceptance remains. Standalone reaction cleanup,
ordinary unsent-draft cleanup, inaccessible/deleted-target recovery, reviewed
import and coherent backup/restore remain separate unfinished work. The full
release is not ready for acceptance testing. No live vault or production service
was changed.
