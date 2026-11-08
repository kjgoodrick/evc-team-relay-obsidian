# Source startup admission

`admitSourceStartup(vault, path, scope, options, prepare?)` closes tracked native admission
synchronously before its first asynchronous journal read for a new/same-root
startup. A held old location uses the verified relocation path described below.
It drains already
admitted saves, opens a journal-selected context, rechecks the durable choice and
the caller's current configuration, then releases the hold and returns that
context. The optional preparation callback runs under the hold; its failure
keeps the hold. The journal and caller context are checked again afterward.
The gate never opens a source cache or writes a native file itself.

A restored source also requires an exact match with the journal's committed
`nativeRoot` before the preparation callback runs. An older unbound preview
choice, stale original-folder setting or changed location stays held for review;
it cannot open the restored cache against the wrong native folder. Legacy
choices keep their existing path behavior. This path binding is an activation
record, not a fresh integrity check on legitimate subsequent offline edits.

A pending, unavailable, blocked or corrupt journal leaves the hold in place.
Cancellation, a drain timeout or a changed caller context does the same; a
candidate context opened before failure is closed. The drain timeout controls
native operations; journal reads retain their own bounded storage timeouts.
A later successful retry reuses the held source, even after a module reload in
the same host realm. Concurrent checks cannot release each other's hold, and a
different server/endpoint cannot release a hold through a different scope.
Changing a paused source's native location requires a committed installation
instead of a settings-only change. Other folders and vaults remain usable.

After a reload, a hold may still name the original folder even though activation
committed its replacement. Startup opens a fresh selection and requires the exact
committed destination, then `releaseRetiredSourceHold` independently rereads its
revision/root before releasing the old hold. The locations must be safe and
disjoint. Pending/legacy/unbound choices, a different destination, competing
review, account change or busy installer cannot release it. Startup immediately
holds and drains the selected destination afterward. A preparation failure there
keeps the destination paused for retry. This changes no files or caches.

`borrowPausedSourceHold` gives the installer exclusive use of an existing
source's barrier without creating a second overlapping hold. It requires the
exact scope and one of the verified plan's original/destination locations,
excludes simultaneous startup/recovery checks, and cannot release the underlying
barrier. A destination lease admits only writes inside its held root. The
drain-only wrapper remains available for callers that need no write capability.
Ending the lease leaves the source paused. The materialization coordinator uses
these leases after validating its prepared journal/plan; otherwise it creates
temporary holds. Final activation can explicitly hand off a paused original
location, or let startup reconcile its committed relocation after a reload. See the
[mapping restart behavior](source-installation-mapping-preview.md).

The location/lease checkpoint passes the full plugin regression: **4,487 tests
across 307 suites**, with 41 tests in 27 opt-in suites skipped. The final exact-root
revalidation change passes **197 focused tests**. Coverage includes transactional
root/receipt rollback, unsafe roots, stale original-folder settings, older
unbound choices, exclusive drain leases and materialization after paused startup.
Main types, changed-source lint, unchanged test-type ratchet and the production
preview build pass (15 existing warnings). No activation UI or new native/mobile
acceptance is enabled by these guards.

Main startup, login restore, discovery and all share-creation/connection screens
now await this gate through `prepareFolderSource` and the prepared registry API.
Server attribution and connection settings are persisted under the hold before
constructing a legacy provider. For a committed source, startup instead verifies
the exact source/path and memory/disk mapping read-only: it cannot recreate a
removed row or overwrite an intervening settings change. Retry forces a disk comparison even when an earlier
failed save already changed memory. Folder movement, account/mode changes and
unload refuse late preparation. Root shares use the same checks.

The registry serializes competing creations, checks native/mount identity across
awaits, closes unused contexts, and restores unrelated folders after an error.
A replacement stops its previous session **before** startup admission drains
native writes. Its old settings and cache history survive preparation failure;
old settings are removed only after construction succeeds. Cleanup failures
pause the replacement. Explicit retry or a later login restore resumes that
replacement instead of reopening the old settings row.

Login restore also handles a committed new-folder mapping while the old instance
still exists. It opens a fresh journal from that instance's captured source,
checks the exact managed-folder/server identity, committed destination, disjoint
roots and persisted mapping, then stops the old instance. Ordinary authenticated
preparation must return the same selected source/revision; mapping, journal and
mount identity are rechecked before constructing a fresh instance. It never
relabels the old provider or reuses its cache. A failed handoff retains the saved
destination and reports a retryable startup failure; unrelated folders continue.

The relocation increment passes **114 focused tests**, including module-reload
handoff, competing reviews, missing/changed disk mappings, unsafe locations,
failed admission/retry and selected-source startup without settings writes.
These are automated host/IndexedDB/settings checks, not native UI acceptance.
Its full regression passes **4,558 tests across 308 suites**, with 41 tests in
27 opt-in suites skipped. Main types, changed-source lint, the unchanged test-type
ratchet and preview build pass (15 existing warnings).

Relay settings show paused folders, the reason, and a serialized Retry control.
Retry checks startup admission; it does not approve pending recovery, discard
work, select a new generation or install files. The registry refuses synchronous
construction when a preparer is installed. Shared-folder teardown closes its
context and fences late native callbacks.
The gate's successful read is not continuous permission to write: existing
providers, other windows, older binaries and external editors still require
quiescence or isolation before an installer can change native files. No automatic
restore activation is enabled.

The full regression passes **4,111 tests across 294 suites** (40 tests/26 suites
skipped). The final login/cleanup-retry refinement also passes the 19-test
registry selection, including disconnection when an existing session's journal
changes. Real IndexedDB and settings persistence tests cover held
saves, pending journals, failed saves/retry, changed folders/accounts/modes and
unload; the compiled settings component covers errors, duplicate clicks and
successful retry. Main/Svelte types, the unchanged test-type ratchet, Svelte
event reachability and the preview build pass (15 existing build warnings).
Changed TypeScript lint has no errors and three existing sentence-case warnings.
The historical i18n parity script cannot read its old default baseline ref;
it is not counted as passing. Native/mobile startup acceptance remains.
