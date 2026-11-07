# Discussion target status and filters

The comments sidebar can filter the loaded page by **Targets needing review**,
**Unanchored targets**, or **Waiting or unchecked targets**. Each discussion
explains the evidence behind its classification. Counts describe the current
page; older pages use the existing navigation. These filters do not scan every
note in the shared folder or extend server text search.

Text and block targets use the synchronized Yjs document and the captured
dependency snapshot. Missing updates stay waiting; deleted selections are
unanchored; different generations and invalid saved positions need review.
Checks never search for matching text and silently move a discussion. Embedded
images additionally verify the exact Markdown occurrence and recorded asset
identity/version. Direct image targets compare current managed identity and
version without fetching image bytes. External URLs cannot prove remote content
has remained unchanged and are explicitly unchecked.

Bases definitions, timeline axes and shared markers use complete account-scoped
catalogs. One page performs at most one read per needed catalog type. Fresh HTTP
proof is distinguished from cached retry fallback; absence from an old cache is
not proof of deletion. Changed definitions/axes/markers retain the captured
target and request review. Cells, records, properties, group membership and lane
membership remain unchecked where authoritative existence evidence is missing.
Being filtered out of a saved view is never treated as deletion.

Checks run in the background while cached comments remain available. A page
shares a single immediate Yjs snapshot and at most one Markdown image parse.
Target edits, host changes, registry changes and manual refresh invalidate the
result. Late results are fenced by account/session/scope/read access. Filtering
hides retained cards instead of disposing reply composers, preserving drafts.
Direct discussion navigation returns the filter to All targets before focusing.

## Verification

The full plugin suite passes **3,095 tests / 246 suites**, with 22 opt-in tests /
17 suites skipped. Subsequent label-isolation and render-key refinements pass
the final **108 tests / 4 suites** focused set. Final preview build/main types
pass; the frozen test-type gate passes with 206 errors / 45 signatures against
its 207 / 46 baseline. Changed-source lint has no errors; two existing host
sentence-case warnings and fifteen existing build warnings remain.

Native Obsidian 1.13.7 on macOS, in a new disposable vault with actual temporary
FastAPI/Rust services, verifies:

- A selected-word discussion and whole-note control initially report attached.
- Deleting the selected word makes its discussion unanchored without removing
  the comment; the unanchored filter shows one of two discussions.
- Returning to All targets preserves the hidden control's unsent reply exactly.
- Native Undo restores source bytes but recreates CRDT content; it does **not**
  restore the original comment attachment. Explicit reviewed Move target to the
  restored word succeeds and returns the unanchored count to zero.
- Independent server readback confirms two discussions with one posted message
  each and one reviewed target revision. The reply draft was not posted.

The earlier recovery vault was unsuitable for this test because its restored
source identity was not synchronized with its retired server. Its disabled
filter was an access-gate observation only; the fresh fixture supplies the
positive native evidence above.

Native image/Bases classification, complete record/property/group/lane identity
verification, share-wide target discovery, multiwindow/mobile behavior and
resource acceptance remain. Native Undo attachment needs further design and
validation across the editor binding; automatic text matching is not a safe
substitute. No live vault installation or production deployment was performed.

## Authentication recovery follow-up

Definition, timeline-axis and marker catalog reads now capture their
authentication lifetime. A response started before authentication loss is
rejected even if sign-in recovers before it arrives. An authentication denial
locks the session and stops subsequent catalog requests until a successful
capability check. An offline failure cannot clear that sign-in requirement.
Cached marker metadata observes the same lifetime checks.

Catalog commits also receive the caller's access guard inside the existing
IndexedDB verification transaction. It checks before reads, before replacement
and after the write; loss after the write aborts the transaction and preserves
the old proof. Existing cross-window tickets and cache-generation fences remain.
No schema migration or service change is required.

Three delayed-response regression cases failed before this correction and pass
after it. Additional tests cover authentication denials, failed/successful
recovery and all three transaction stages. The final focused run passes **248
tests / 6 suites**; the full suite passes **3,104 tests / 246 suites**, with 22
tests / 17 suites skipped. Build/main types, frozen test types and changed-source
lint pass. This is automated follow-up to the native evidence above; the newer
build has not been installed in a live vault.
