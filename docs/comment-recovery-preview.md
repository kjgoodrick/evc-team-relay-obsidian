# Saved comment recovery preview

The **Saved on this device** cards now offer **Review delivery and edit** for
queued or rejected discussions, replies and own edits. Recovery first asks the
server whether the exact original request was accepted. An accepted request is
retired locally without creating a duplicate. Otherwise the server permanently
cancels that operation ID before the client exposes an editable draft.

The recovered draft retains rich text, mentions, picture originals, its original
thread/message identities and target. It can be closed and reopened, including
offline after cancellation is confirmed. Opening, reconnecting or choosing a
replacement target never sends it. Explicit Send creates a replacement operation
and atomically reconnects waiting replies. Parents and replies can both be under
review without losing their dependency ordering.

For a rejected edit, **Review current comment** reads the current authorized
message. When the saved revision differs, the composer shows the current body
beside the draft and requires **Use this revision for my edit**. The eventual
send still carries a revision expectation, so another intervening edit rejects
safely. Initial offline reopening permits local editing but keeps Send disabled
until the current revision has been reviewed. Typing pauses while the comparison
is loading to avoid replacing text entered during that read.

New-discussion recovery also supports **Choose replacement target**, reusing
the note, block, image, Bases and Time & Line capture controls within the same
note or saved view. **Use entire note** and **Use entire saved view** are explicit
alternatives. Target capture changes only the saved draft, using a revision
check; it cannot overwrite another window's draft or submit the comment.
Replies and edits keep their original discussion.

Storage version 21 closes older database handles and prevents older workers from
opening the new database. A `review` outbox state is not deliverable. The original
wire payload remains immutable; late worker results cannot discard a review
draft. Replacement, draft removal, dependency updates and picture-reference
transfers commit together. Removed/refreshed picture uploads are retired only
when no other draft or active command needs them. A group capture that has never
persisted its prepared anchor can be fenced locally; a late capture cannot send
a thread. Prepared group requests require normal server cancellation.

## Validation

- Automated storage and lifecycle coverage includes competing windows, late
  workers, close during cancellation, authentication loss, version-20 upgrade,
  picture ownership/accounting, dependent reply ordering and group capture races.
- DOM and host tests cover explicit submission, revision acknowledgement,
  offline reopening, read revocation, target selection, whole-note replacement
  and editor disposal. The final plugin suite passes **3,005 tests / 236 suites**
  with **21 opt-in tests / 17 suites skipped**. Build/main types pass; test types
  remain within the frozen baseline (206 errors / 45 signatures, baseline
  207 / 46). Svelte has zero errors; changed-source lint has zero errors and two
  existing sentence-case warnings in the host.
- The disposable real HTTP fixture verifies lost cancellation responses,
  rejection of delayed old requests, edited replacement plus dependent reply,
  already-accepted recovery and stale-edit recovery through revision 3.
- Native Obsidian 1.13.7 on macOS: a synthetic message was edited concurrently
  from revision 1 to 2; the native stale send retained its draft. Recovery showed
  both versions and disabled Send. Editing, closing and reopening preserved the
  corrected text. Explicit revision acknowledgement and Send produced one
  message at revision 3, confirmed independently by the server. The temporary
  vault was closed and the local service stopped. This native run preceded the
  small typing-pause refinement described above.

## Remaining work

This is an implemented preview, not full recovery/release acceptance. Explicit
abandonment and dependent-work review, inaccessible/deleted-target recovery,
cache and backup/export/restore controls, native interrupted-response and
multiwindow/picture/target/mobile cases, and resource/accessibility validation
remain. Picture refresh can retain shared originals intentionally. A large
dependency fan-out above the bounded recovery limit is retained for further
review rather than partially rewritten. No production service or live vault
installation is part of this preview.
