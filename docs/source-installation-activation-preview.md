# Verified source activation coordinator

This is an internal desktop recovery component, not a released restore action.
It connects the existing new-folder materializer, generation-specific cache
import and persisted mapping to a journal commit. It does not create writer
isolation, start providers, or authorize a production restore.

## Transaction boundary

`activateSourceInstallation` captures the source, operation IDs, authenticated
context checks and host methods before asynchronous work. It requires an explicit
generation and separate start/commit UUIDs. The caller must retain those IDs and
reread the journal's current revision before resuming an interrupted applying
installation. A different review or source cannot reuse the operation.

The materializer holds registered native writers at both the original and new
locations until the entire activation continuation settles. It verifies the
prepared recovery archive and plan, claims only an owned new destination, resumes
only matching files and records `applying` before writing. The continuation then:

1. Refuses selected-generation saved document buffers or pending upload state.
2. Seeds only empty selected caches, or verifies their exact unchanged seeds.
3. Saves the new mapping and reads it back from memory and persistent storage.
4. Verifies the native tree, then obtains a fresh authenticated inventory for the
   captured endpoint/account/share/generation. Visible records and permissions
   must still match the staged snapshot.
5. Rechecks native bytes, the already-saved mapping and selected local work. The
   final mapping check is read-only and cannot repair an intervening user edit.
6. Checks the journal revision and isolation guard, then atomically commits the
   generation, native root and operation receipt. The isolation/context check
   runs again inside the IndexedDB transaction immediately before writes.

Native mutations and settings writes are awaited before holds are released.
Read-only network/settings waits are bounded and cancellable; late results cannot
resume the continuation. Failures preserve original files, recovery artifacts,
existing buffers and changed caches. A partially applied installation stays
paused. Selected buffer checks use exact-key counts, without loading their text
or inspecting other generations. Empty saved buffers also block activation.

## Lost responses and handoff

`SourceSelectionJournal.reconcileCommit` performs a read-only receipt lookup. It
accepts only the exact current commit, review, explicit generation and committed
native root. Missing, superseded, malformed and older rootless receipts fail.
It does not replay a command, write data or broadcast a change notification.

If a commit reports failure after persisting, the coordinator checks that receipt
once. If a later invocation finds an already-committed source, it only reconciles
the receipt: **it does not reinstall or inspect native content, cached histories,
saved buffers or the server inventory**. Those may now contain legitimate work.
A subsequent review supersedes the old receipt and prevents its reuse.

An installed session's verification callbacks expire when its continuation
settles. Returned inspection snapshots cannot change its internal revision,
verification targets or ownership binding.

`releaseRetiredSourceHold` separately reopens the durable selection and checks
the exact committed revision and destination before releasing the original
location's paused startup hold. It refuses overlapping or unexpected locations
and a hold still borrowed by installation. A hold already at the destination is
left for ordinary startup admission. Repeating a completed handoff is harmless.
The registry must stop the old instance and create a fresh instance at the
committed location; this helper does not do that itself. Ordinary login restore
now performs that guarded retargeting when an old instance survives the mapping
change. Startup also reconciles a held original location after module reload;
see [source startup admission](source-startup-admission-preview.md).

## Required host integration and limits

The caller's `checkIsolation` must represent real writer isolation throughout
preparation and activation: local providers/editors, other windows/processes,
and server writers. Registered native holds cover this plugin's tracked writes
in one host realm. A fresh inventory read is **not** a remote writer lease;
document CRDT edits need not change inventory metadata. The coordinator must not
be exposed as a ready-to-use restore action until that admission protocol exists.

Recovery UI, durable operation-intent/resume flow, integrated registry acceptance, server
maintenance/client admission, off-host backup and physical desktop/mobile
acceptance remain. Mobile still needs a host-supported exclusive-publication
adapter. Cache seeds retain the existing Canvas sync format; Canvas comments
remain out of scope. No live vault or production service was changed.

## Evidence

The focused activation/storage set passes **154 tests**. It uses real temporary
filesystem directories, the production desktop installation adapters, a
filesystem-backed Settings backend and actual IndexedDB transaction scheduling
through fake-indexeddb. Server revalidation and the isolation lease are synthetic
in this set; it is not evidence of production maintenance or native UI acceptance.

Cases include both held locations through revalidation, selected cache/native
agreement, lost commit responses, interrupted commit retry, preserving subsequent
native/CRDT/buffer edits, changed generation/permissions/settings/native bytes,
new pending uploads and empty saved buffers, lost isolation during transaction
reads, slow-read cancellation, invalid operation IDs, exact-root handoff and
read-only receipt reconciliation across journal reopen.

The full regression passes **4,542 tests across 308 suites**; 41 tests in 27
opt-in suites remain skipped. Main TypeScript, changed-source lint, an isolated browser bundle and the preview
build pass. The existing 15 build warnings remain. The test-type ratchet is
unchanged at 205 errors/44 signatures versus the frozen 207/46 baseline.
