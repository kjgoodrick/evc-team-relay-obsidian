# Source startup admission

`admitSourceStartup(vault, path, scope, options, prepare?)` closes tracked native admission
synchronously before its first asynchronous journal read. It drains already
admitted saves, opens a journal-selected context, rechecks the durable choice and
the caller's current configuration, then releases the hold and returns that
context. The optional preparation callback runs under the hold; its failure
keeps the hold. The journal and caller context are checked again afterward.
The gate never opens a source cache or writes a native file itself.

A pending, unavailable, blocked or corrupt journal leaves the hold in place.
Cancellation, a drain timeout or a changed caller context does the same; a
candidate context opened before failure is closed. The drain timeout controls
native operations; journal reads retain their own bounded storage timeouts.
A later successful retry reuses the held source, even after a module reload in
the same host realm. Concurrent checks cannot release each other's hold, and a
different server/endpoint cannot release a hold through a different scope.
Changing a paused source's native location requires review instead of silently
reassigning its hold. Other folders and vaults remain usable.

Main startup, login restore, discovery and all share-creation/connection screens
now await this gate through `prepareFolderSource` and the prepared registry API.
Server attribution and connection settings are persisted under the hold before
constructing a provider. Retry forces a disk comparison even when an earlier
failed save already changed memory. Folder movement, account/mode changes and
unload refuse late preparation. Root shares use the same checks.

The registry serializes competing creations, checks native/mount identity across
awaits, closes unused contexts, and restores unrelated folders after an error.
A replacement stops its previous session **before** startup admission drains
native writes. Its old settings and cache history survive preparation failure;
old settings are removed only after construction succeeds. Cleanup failures
pause the replacement. Explicit retry or a later login restore resumes that
replacement instead of reopening the old settings row.

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
