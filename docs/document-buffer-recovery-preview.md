# Document buffers and source session closure

An explicitly closed or invalidated source context immediately disconnects every
folder/Markdown/Canvas provider that shares it. Dismantled providers detach their
listeners. This covers the current session; cross-window and old-client admission
still require the restore coordinator.

Document-buffer operations now run in order. Saving is awaited and failures
propagate; the latest in-memory text is retained instead of being replaced by
older disk text. Store opening is bounded, reports blocked storage, and retries
after a transient failure. A successful request is not reported as saved until
its IndexedDB transaction commits.

Buffer saves and clears compare their expected stored contents inside the same
read/write transaction. A concurrent session's different text is preserved.
Reading an existing buffer does not rewrite that snapshot over a newer save.
Clearing also checks the exact in-memory review object and only releases it after
the conditional delete commits. A stale review cannot edit or clear its
replacement. Clearing and teardown do not blank text still held by a review.

The merge UI awaits buffer writes and clears, preserves its retry controls on
storage errors and reports failed actions. Partial merge edits use the same
durable buffer writer. Closing an unresolved review no longer invokes the merge
confirmation callback; completed/equivalent merges invoke it explicitly.

A failed persistence operation is **not durable**: its text remains in the live
document/review, while the previous or concurrent committed buffer stays on
disk. A storage failure or conflicting session must be resolved, or the live
text copied/exported, before closing Obsidian. These changes do not implement a
multi-version buffer conflict UI or make external editors part of admission.
Existing source recovery capture can include live and stored buffer evidence.

Automated coverage includes actual Document/Canvas constructors, immediate
invalidation of both children, listener teardown, save/clear failure and retry,
stale review actions, competing store transactions, late transaction rollback,
read/save races, partial edits and unresolved-review closure. Native/mobile
merge acceptance remains pending.

Verification: the full regression passes **4,127 tests across 294 suites**
(40 tests/26 suites skipped). After the final malformed-record guard, the focused
source/buffer/merge/provider/recovery selection passes **148 tests**. Main types,
changed-source lint and the preview build pass (15 existing build warnings).
The unchanged test-type ratchet remains 205 errors/44 signatures against its
207/46 baseline. Malformed stored text is retained and rejected rather than
treated as an absent buffer.
