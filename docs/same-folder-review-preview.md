# Saved whole-folder recovery review

`SameFolderReview` and `SameFolderReviewPreparation` bind explicit native-file
choices to a verified version-2 same-folder source plan and original-work archive.
The saved review is immutable and survives restart. This is an internal recovery
component; it does not enable a recovery UI or activate a source by itself.

## Review and ordered operations

The comparison fingerprint includes the plan ID/digest, root and complete observed
native tree. Saving rechecks that observation and requires every current file to
match its verified archive copy, including files already equal to selected server
content. A newly edited file requires a fresh backup and review. Untracked work
cannot disappear merely because a refreshed comparison shows it.

Every changed path requires an explicit choice: use the selected source result
where it has an entry, or archive a local-only entry. Unchanged or unknown paths
cannot receive fabricated choices. This component implements the explicitly
reviewed restoration of selected bytes. Keeping/merging post-backup local edits
remains a separate required part of the complete recovery workflow.

The review reconstructs a deterministic recipe from the plan and native tree:

1. Retain/remove local files that obstruct selected directories or have no
   selected file at the same path.
2. Remove obsolete directories, deepest first.
3. Create required directories, shallowest first.
4. Create or replace changed selected files.

Each operation has a durable UUID. Parsing rebuilds this recipe and checks every
operation's order, path, kind, source entry and before/after content descriptor.
Missing, extra, reordered or duplicate operations cannot verify. Recipes cover
file/directory transitions and case-only changes; a directory executor is still
required before those recipes can be physically applied.

The artifact is exclusively created at
`Relay Recovery (local only)/Source reviews/<UUID>/review.json`, read back,
hash-checked, and bound to the prepared source journal using revision comparison.
An adapter reopened after restart can read it but cannot overwrite it. Two
reviewers cannot both save against the same revision. Choices may be replaced by
a new immutable review before installation starts; older artifacts remain.

Limits are 100,000 native entries/operations, 1,000,000 path components, 64 GiB of
native file content, 256 MiB per file and 16 MiB of encoded review metadata.
Unsupported/hidden native paths fail review validation rather than being omitted.
This limitation needs resolution in the full recovery workflow. Preparation and
verification have bounded waits and cancellation/context checks; late metadata
creation after cancellation does not authorize native writes or activation.

## Journal progress is separate from filesystem proof

The journal saves the review ID, digest and operation count. Starting with a saved
review initializes completion to zero. Each completion must name that same review
and exactly the next index. Exact receipt retries are idempotent; superseded
receipts cannot roll progress backwards. Native review/progress commands cannot
consume the reserved activation IDs.

When a review is attached, commit refuses until every operation has been recorded
complete. The journal does not inspect disk: a completion counter is not evidence
that a folder is ready. The coordinator must verify real operation receipts,
current files, the complete final tree, current access and writer isolation before
activation. Older preparation without a native review retains its existing
journal behavior; the same-folder coordinator must require a saved review.

The verification API rechecks the selected source, archive and review after
restart. It does not claim that the current native tree still matches the saved
before-state, nor does it change caches, settings, provider/editor bindings or
normal source admission.

## Evidence and remaining work

Real temporary-filesystem and IndexedDB tests cover immutable preparation/reopen,
fresh comparison and backup requirements, type/case transition recipes, invalid
choices and corrupt recipes, competing reviewers, lost responses, aborted
transactions, ordered/retryable progress, reserved IDs, superseded reviews and
zero-operation activation metadata.

The checkpoint passes **25 review tests**, **94 focused recovery tests**, and
**4,682 tests across 312 suites** in the full plugin regression (41 tests in 27
opt-in suites skipped). Main types, changed-source lint, browser bundles and the
production build pass; the build retains 15 existing warnings. The test-type
ratchet remains at 205 errors/44 signatures against the frozen 207/46 baseline.

The actual HTTP/Rust and HTTP/MinIO fixtures download selected content, save and
reopen a complete file-only review, apply every reviewed file operation with the
production desktop primitive, verify preserved originals, record ordered progress
and reopen the journal. A later edit at the original path survives a retry.
The fixture deliberately remains `applying`; it does not claim complete-folder
cache/editor activation or native Obsidian acceptance.

Remaining: directory execution, full operation coordinator and final tree
verification, recovery of retained/merged local changes, private packaged archive
storage, same-root cache/editor/registry handoff, recovery UI and native
desktop/mobile acceptance. No live vault or production service was changed.

Related: [native comparison](same-folder-source-inspection-preview.md),
[native file operations](same-folder-native-operations-preview.md),
[source journal](source-selection-journal-preview.md).
