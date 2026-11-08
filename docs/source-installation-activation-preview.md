# Verified source activation coordinator

This is an internal desktop recovery component, not a released restore action.
It connects the existing new-folder materializer, generation-specific cache
import and persisted mapping to a journal commit. It does not create writer
isolation, start providers, or authorize a production restore.

## Transaction boundary

`activateSourceInstallation` captures the source, operation IDs, authenticated
context checks and host methods before asynchronous work. It requires an explicit
generation and separate start/commit UUIDs. Preparation now stores those IDs with
the reviewed archive/plan. `sourceActivationRequest` reloads them with the current
reviewed journal revision, including after an interrupted applying installation.
A different review/source or changed operation IDs cannot reuse the operation.

Older prepared/applying previews can reserve the pair with one compare-and-swap
journal transition. This changes no artifacts or source choices. Existing intent
cannot be replaced; used/equal operation IDs and late-aborted reservations are
refused. A lost reservation reply requires rereading its saved revision and IDs,
not allocating replacement operations. A completed activation is discovered
through the ordinary selected-root state; an in-flight caller can also reconcile
its captured exact commit receipt.

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

Recovery UI and integrated resume/registry acceptance, server
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

Durable activation intent adds **166 focused passing tests** across the selected
storage/recovery set. Coverage includes IDs saved atomically with preparation,
reopen, older-preview reservation, collision/refusal, late rollback, restart
after native materialization, lost reservation response and unchanged postcommit
reconciliation. These are automated checks; the recovery UI is still unfinished.
The full intent regression passes **4,568 tests across 308 suites**, with 41 tests
in 27 opt-in suites skipped. Main types, changed-source lint, unchanged test-type
ratchet and preview build pass (15 existing warnings).

## HTTP and object-storage integration

The opt-in `realManagedAttachments` fixture now runs the attachment-only recovery
pipeline against actual loopback HTTP and disposable MinIO: authenticated bounded
downloads, verified original-work backup, preparation with durable intent,
exclusive native publication, selected inventory import, saved mapping and final
activation. A fresh selected inventory transport then reads the actual server
without a restore pause, conflicts or changed records. Both legacy and current
attachment bytes match their captured revisions. Retrying after a later native
edit preserves that edit. The server's object inventory proves that activation
created no extra uploads; original local work remains unchanged.

The fixture exposed and now covers legacy records with a verified hash but no
MIME type/sync timestamp. Plan validation preserves those optional fields rather
than requiring fabricated metadata, while retaining required attachment hashes,
metadata validation and unknown-field rejection. The focused plan/content/staging
set passes **107 tests**; the actual HTTP/MinIO proof passes separately.

This fixture owns its sole server writer and temporary native directory. It does
not demonstrate production writer isolation, Canvas source installation,
a native Obsidian UI, or mobile filesystem behavior. Its HTTP
process, database, bucket and rootless container are removed after completion.
The final full regression passes **4,574 tests across 308 suites** (41 tests in
27 opt-in suites skipped); main types, changed-source lint, unchanged test-type
ratchet and preview build pass with the existing 15 warnings.

## Editing-history service integration

The actual FastAPI/Rust WebSocket generation-rotation fixture now also performs
full Markdown installation through read-only source downloads, preparation,
native files, selected document/inventory caches, persisted mapping, activation
and startup admission. It uses a member whose `Budget.md` is inaccessible: only
the visible `Note.md` is downloaded and materialized. The installed native text
and full cached editing history agree before the ordinary provider connects.

After admission, that provider sends a new member edit which an independent
read-only peer observes. Original-generation clients remain paused and retain
their distinct offline edits; those edits never enter the new source. A later
native edit still survives exact activation-receipt retry. The fixture owns the
writer sessions and temporary native directory and cleans up its HTTP/Rust
processes. This is service/cache evidence, not native editor or OS isolation
acceptance. Canvas and multi-process installation remain unverified.

Both actual service fixtures pass after sharing the installation harness. The
test-type ratchet stays at 205 errors/44 signatures versus 207/46. Production
implementation is unchanged from the 4,574-test regression checkpoint above.

## Edits arriving after preparation

The actual HTTP/Rust fixture now changes the server document after preparation
has captured its complete editing history, while inventory metadata remains
unchanged. It covers both appended text and a deliberate clear. Activation
installs the captured native bytes and sync base; the ordinary selected provider
then merges the newer changes. The real transfer queue, backed by the selected
cache and temporary native files, delivers the updated text without a conflict
copy or replaying the captured text to other users. An independent peer also
observes a subsequent edit from the installed member.

The clear case exposed an existing upload-path bug: an empty but previously
initialized document could be treated as a new empty document and reseeded from
the unchanged native file. The upload path now uses retained text items or the
initialization marker to distinguish a deliberate clear from a never-initialized
document, after the existing incomplete-history guard. A matching native sync
base permits delivery of the clear. A local edit during the final native read
remains local work and is reconciled rather than overwritten. Regression tests
also cover reloaded deletion history.

The actual service proof and **113 focused synchronization tests** pass. This is
evidence for same-generation Markdown updates; it does not remove the current
host isolation requirement. Concurrent inventory changes, Canvas behavior,
cross-process native admission and the integrated recovery UI still require
their own acceptance. Server backup/restore maintenance remains a separate
operation from restoring one client into a new folder.

The full regression passes **4,577 tests across 308 suites**, with 41 tests in
27 opt-in suites skipped. Main types, changed-source lint and the preview build
pass; the existing 15 build warnings remain. The test-type ratchet stays at
205 errors/44 signatures against the frozen 207/46 baseline. The failing
pre-fix HTTP clear case and passing post-fix service proof were both observed
in isolated fixtures; their processes and data were cleaned up.

## Existing Canvas sync compatibility

The HTTP/Rust restore fixture now includes an existing Canvas alongside the
Markdown note. It verifies pre-restore Canvas history surviving the relay
restart, authorized full-history download, native installation and selected
cache reopening. Changes made after preparation include card movement, added
text and an intentional clear. The ordinary selected provider merges them, and
the real Canvas fetch/transfer path writes the current JSON into the temporary
native file. A separate read-only peer sees the same state. The original
generation's offline Canvas edits remain in its disconnected document.

This exposed a second clear bug: Canvas export fell back to the node's older
metadata whenever its text was empty, and editor initialization could reseed
that text. Both now distinguish a card without any text history from a card
whose retained items were deleted. Legacy metadata-only cards still export and
initialize normally. Automated tests cover editor access, cache round trips,
source installation and unchanged encoded history after inspection.

The service proof passes with **34 focused Canvas/content tests**. Canvas JSON
is compared structurally across Rust/JavaScript peers because object key order
can change; installation still verifies exact captured artifact/native bytes.
This does not add Canvas comments. It also does not establish native Canvas
view acceptance, protection of concurrent native Canvas edits, or cross-process
writer isolation; those remain distinct from the verified cache/provider path.

The full regression passes **4,581 tests across 308 suites**, with 41 tests in
27 opt-in suites skipped. Main types, changed-source lint, test-type ratchet
(205/44 versus frozen 207/46) and the preview build pass; 15 existing build
warnings remain. The extended Python fixture passes lint/format checks and the
actual HTTP/Rust proof; owned processes and temporary stores are cleaned up.
