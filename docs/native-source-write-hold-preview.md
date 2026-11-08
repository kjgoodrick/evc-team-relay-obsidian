# Native source write holds

`holdNativeSourceWrites(vault, path)` closes admission synchronously for writes
registered through the native-write tracker in the current host realm. Its
explicit `wait` drains already-admitted operations before an installer can write.
Cancelling or timing out that wait leaves the hold and the native operations
intact. A context check or cancellation cannot undo an OS write already started.

The hold covers a folder and its descendants, or the vault root when passed an
empty path. Other folders and vaults remain usable. Overlapping holds are
refused. Case and Unicode-normalized aliases are treated conservatively so that
a common case-insensitive filesystem cannot bypass a hold through spelling.
Unsafe relative paths are rejected before the native callback runs.

The owner may use `hold.write(path, callback)` for a replacement inside its held
namespace after existing writes have drained. These writes stay tracked too;
another installation write or release is refused until they finish. Ordinary
writers remain paused throughout installation. The owner explicitly releases
the hold after its coordinator's verification, or after cancelling a preparation
that did not change native files. Released owners cannot write again. Failed
native operations report failure and release their pending-write entry, while
leaving the recovery hold itself in place.

Both admitted writes and holds survive a plugin module reload in the same host
realm. This does not coordinate another process/realm, an older binary that does
not use the hold, another plugin or an external editor. A module reload is not a
substitute for proving those writers have stopped or isolating replacement paths.

Current production write paths registered with this tracker are document saves,
shared-folder text writes (including Canvas source), attachment binary downloads,
and the attachment text-write/append methods. The latter now await native
completion before hashing or reporting success. Attachment operations recheck
their captured context after completion; a changed/unloaded source cannot
acknowledge that write as current. Structural moves/trash, folder creation,
conflict-copy writes, Bases-specific writes and other remaining mutations still
need integration before a whole-folder installer may rely on the hold.

No restore UI or automatic activation invokes this hold yet. The installation
coordinator still needs to connect the durable selection journal, verify recovery
and installation artifacts, stop all relevant writers, perform guarded native
replacement and verify the result before committing/releasing. The hold alone
does not authorize a generation switch or native-file replacement.

Verification: 134 focused native-write/attachment/source-recovery tests and the
full regression (4,033 tests across 287 suites; 40 tests/26 suites skipped) pass.
Tests cover admission/drain ordering, cancelled/timed-out waits, namespace aliases,
module reload, failed installation writes, and attachment completion/context
checks. Main types, changed-source lint and the preview build pass (15 existing
build warnings). The frozen test-type ratchet remains 205 errors/44 signatures
against 207/46. Native/mobile acceptance and whole-installer integration remain.
