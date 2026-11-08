# Source startup admission

`admitSourceStartup(vault, path, scope, options)` closes tracked native admission
synchronously before its first asynchronous journal read. It drains already
admitted saves, opens a journal-selected context, rechecks the durable choice and
the caller's current configuration, then releases the hold and returns that
context. It never opens a source cache or writes a native file itself.

A pending, unavailable, blocked or corrupt journal leaves the hold in place.
Cancellation, a drain timeout or a changed caller context does the same; a
candidate context opened before failure is closed. The drain timeout controls
native operations; journal reads retain their own bounded storage timeouts.
A later successful retry reuses the held source, even after a module reload in
the same host realm. Concurrent checks cannot release each other's hold, and a
different server/endpoint cannot release a hold through a different scope.
Changing a paused source's native location requires review instead of silently
reassigning its hold. Other folders and vaults remain usable.

This gate is still internal. The main startup and share-creation paths do not yet
call it. Integration must await source preparation before constructing a folder,
handle interrupted journals visibly, retain previous connections/settings when
preparation fails, serialize competing creations and close contexts on teardown.
Shared-folder teardown now closes its context and fences late native callbacks.
The gate's successful read is not continuous permission to write: existing
providers, other windows, older binaries and external editors still require
quiescence or isolation before an installer can change native files. No automatic
restore activation is enabled.

Eight new startup cases and the combined 68-test constructor/native-admission
selection pass. These cover an earlier native save, pending-journal module
reload, cancelled/timed-out drains, a caller changing after journal reads,
concurrent checks, foreign scopes and an unavailable journal. Main types, lint
and the unchanged test-type ratchet pass. The preceding folder-lifecycle full
regression passes 4,082 tests across 290 suites; the newly added startup suite is
verified separately. Native/mobile startup acceptance and the main-factory wiring
remain.
