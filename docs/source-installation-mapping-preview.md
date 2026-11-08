# Staging the restored-folder mapping

`stageSourceInstallationMapping` persists the reviewed destination path while
the source-selection journal is still `applying`. Startup remains paused. The
function reopens the exact installation plan/archive and requires the expected
source, review and journal revision before touching settings.

It accepts only one settings row for the exact managed folder, relay and server.
Its path must be the original or reviewed destination. Another shared folder at,
inside or above the destination is refused, including case/Unicode aliases and
vault-root shares. Unknown per-folder settings and all other settings are kept.

The settings layer now supports reading persisted state without hydrating it
over current memory. Before writing, the coordinator compares both views. Only
the selected row's original/destination path may differ; other changes require
reload/review. Its synchronous updater also refuses changes that occurred while
the disk read was pending. After saving, it reads the persisted namespace again
and checks both disk and memory against the intended result.

This covers two uncertain-save cases: a failed disk write can leave memory at
the new path while disk still has the old path, or the write can succeed before
its response is lost. Retrying rechecks the journal and disk rather than undoing
the mapping or blindly trusting memory. Successful-but-inaccurate saves cannot
pass readback. Read waits support cancellation/timeouts; admitted settings writes
are awaited through settlement because cancellation cannot undo file I/O.

Recovery can now borrow a paused startup hold at either of the plan's two roots.
If a restart uses an already-persisted destination, the installer writes remaining
files through that destination's hold and leaves its barrier in place afterward.
A hold for an unexpected third location is refused. This is restricted to the
verified plan's original/destination pair, not an arbitrary location change.

Mapping staging does not attest native/cache completeness or activate a source.
The final coordinator must stop other writers, verify the destination and caches,
inspect selected-generation buffers/uploads, confirm current server admission,
commit the journal with the exact destination root and hand off any original
startup hold. The recovery/activation UI remains unfinished. Settings-file
readback is not a cross-process filesystem lock; other Obsidian processes must
remain isolated during the final workflow.

Focused tests exercise actual Settings/SettingsScope persistence, lost responses,
failed/inaccurate saves, unrelated settings preservation, competing memory/disk
changes, collisions, stale journals, corrupt artifacts and cancellation before
and during I/O. Real temporary-directory tests cover resuming file installation
under the destination hold after a mapping restart.

All 62 focused mapping/materialization/startup tests pass. Main types,
changed-source lint, unchanged test-type ratchet, production preview build and
an isolated mapping-module browser bundle pass (15 existing build warnings).
The preceding full-regression checkpoint is 4,487 tests across 307 suites.
