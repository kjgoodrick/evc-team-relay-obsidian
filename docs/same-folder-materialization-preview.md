# Applying the reviewed tree at the existing path

`withMaterializedSameFolder` now executes the saved whole-folder native recipe
under a registered-writer hold, records durable progress and verifies the exact
selected tree and retained originals. It leaves the source journal **applying**.
This is an internal native coordinator, not complete recovery or an enabled UI.

## Directory operations

`applyDesktopSameFolderDirectoryOperation` complements the file primitive. Its
descriptor binds the operation UUID, source-plan digest, review, root, path and
create/remove action. Its durable intent also binds vault, root, parent and
control-directory identities. Metadata uses exclusive publication and directory
flushes; known private temporary links can be reconciled after restart.

- Creation uses nonrecursive, exclusive `mkdir`, then records the observed empty
  directory identity in `applied.json`. An existing destination is never
  overwritten. Node documents the existing-directory rejection for nonrecursive
  [`fsPromises.mkdir`](https://nodejs.org/api/fs.html#fspromisesmkdirpath-options).
- Removal first checks emptiness and records the directory identity in
  `captured.json`. It moves the actual directory to `before.dir`, verifies its
  identity and emptiness again, and records completion. It never recursively
  deletes native content. A racing writer's contents remain retained and cause
  review instead of successful completion.
- Exact receipt retries verify the result without repeating the mutation. Later
  native arrivals, replacement directories and changed retained originals are
  preserved and refused.

An interruption between `mkdir` and its receipt is deliberately ambiguous:
the empty directory may belong to the interrupted operation or another writer.
Retry retains it and requires explicit review. The complete recovery UI still
needs the action that resolves this case. Likewise, an operation-control folder
without a valid intent is not automatically adopted. Node's mkdir does not return
the created inode; the first empty-directory observation after success still
requires the caller's isolation from external writers. These checks are not an
OS lock against arbitrary directory substitution between system calls.

## Whole-folder coordinator

The coordinator requires a saved verified native review and matching prepared or
applying journal, source identity, revision and reserved start operation.

1. Verify the source, original-work archive and immutable review.
2. Acquire/drain the native hold, or borrow an existing paused-startup hold.
   Pin the root identity for the session. Before the first mutation, compare a
   fresh native observation with the approved before-state; later local work
   requires a refreshed archive/review.
3. Start the durable applying state and execute only the unrecorded suffix of
   the ordered recipe. Each completed native operation is followed by its
   idempotent, revision-checked journal completion. A lost response before progress
   is recorded resumes that exact operation. A saved completion is not replayed.
4. Check the complete current tree against selected paths, kinds and content
   hashes. Unexpected local/hidden files and changes to otherwise unchanged
   files prevent success. Historical archived spellings do not invalidate a
   correctly installed case-only change.
5. Recheck every operation's intent/receipt and retained file hashes or empty
   directory identity. This detects later writes through an external handle to
   a retained inode, even when the selected tree is correct. Reverify the archive,
   source and review as well.
6. Run the continuation while the hold remains active. Its current-state and
   full-verification methods expire when the continuation settles. OS mutations
   are always awaited before releasing the hold, including on cancellation.

The desktop host uses fresh child inspectors after legitimate directory changes
and a separate root guard across the whole session. Retained-operation reads use
the same bounded no-follow inspection code, restricted to the fixed operation
area for one plan. Recovery storage still cannot become a native sync root.

File/folder transitions and case-only renames are applied through the reviewed
retain/remove/create recipe, not by overwriting occupied destinations. Native
paths can be temporarily absent; editor/watcher isolation is still required.
The journal counter alone never proves successful recovery.

## Evidence and remaining work

Real temporary files cover directory creation/removal, inode/mode retention,
restart boundaries, ambiguous creation, concurrent arrivals, hidden/nonempty
directories, capture races, context loss, linked/corrupt controls and writer
holds. The coordinator physically applies an 11-operation file/folder/case
transition recipe, verifies preserved originals, resumes lost progress responses,
rejects a substituted root, awaits cancellation, and rejects later native or
retained edits despite a complete progress counter.

The HTTP/Rust and HTTP/MinIO fixtures now call the production coordinator with
actual downloaded source bytes/attachments and retained nested local work. They
verify final bytes, retained files/directories, journal reopen and protection of
a later local edit. Their journal stays applying; no source cache/editor handoff
or native Obsidian acceptance is claimed.

Validation: **121 focused recovery tests**, including **26 directory-operation
tests**, and **4,721 tests across 313 suites** in the full regression pass (41
tests in 27 opt-in suites skipped). Main types, changed-source lint, browser
bundles and the production build pass; the build retains 15 existing warnings.
The test-type ratchet remains 205 errors/44 signatures against the frozen 207/46
baseline. Both actual-service fixtures pass and clean up their owned services.

Remaining: same-root cache/mapping/registry/editor activation, user-facing
reconciliation of retained/merged local work and ambiguous operations, private
packaged archive storage, host/server writer isolation, mobile filesystem
capability and native desktop/mobile acceptance. This executes explicit choices
to restore selected bytes; it does not replace the agreed local-edit recovery
workflow. No live vault or production service was changed.

Related: [saved review](same-folder-review-preview.md),
[file operations](same-folder-native-operations-preview.md),
[source activation](source-installation-activation-preview.md).
