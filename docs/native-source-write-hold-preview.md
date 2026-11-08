# Native source write holds

`holdNativeSourceWrites(vault, path)` closes admission synchronously for writes
registered through the native-write tracker in the current host realm. Its
explicit `wait` drains already-admitted operations before an installer can write.
Cancelling or timing out that wait leaves the hold and the native operations
intact. A context check or cancellation cannot undo an OS write already started.

The hold covers a folder and its descendants, or the vault root when passed an
empty path. Mutations of an ancestor directory also overlap a descendant hold.
`trackNativeSourceMutation` registers every affected path (including both ends of
a move) before invoking native I/O; failure releases all registrations without
hiding the native error. Every path is validated before any registration or I/O.
Other folders and vaults remain usable. Overlapping holds are
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

Current production paths include document/shared-folder text saves (including
Canvas source), attachment downloads/text writes/appends, structural moves and
trash (including duplicate/discarded-folder cleanup), folder creation,
conflict-copy/recovery writes, Bases creation/atomic replacement/retirement,
discussion archives, inbound web downloads and native merge-editor saves.
Attachment completion precedes hashing and rechecks its captured source context.
Bases retains the synchronous identity/content/context checks inside the native
atomic process callback. A held retirement keeps its durable prepared move and
original file; it can retry after release. Held inbound downloads propagate a
recognizable pause so their poller does not advance its completion watermark.
Logging/configuration writes are outside this source-write contract. Host/editor,
other-plugin, older-client and cross-realm admission still need coordination.

Shared-folder mutations additionally capture their live folder session before
native I/O and check it again afterward. Delayed moves and owned-folder creation
also retain that check across their preceding asynchronous work. Teardown closes
the folder's selection context. A callback reaching admission after teardown is
refused; an operation already admitted stays drainable but cannot acknowledge an
obsolete document or adopt a late-created folder. Its completed native result is
retained rather than deleted by the closed session. Recovery-move event markers
are installed only after native admission succeeds.

No restore UI or automatic activation invokes this hold yet. The installation
coordinator still needs to connect the durable selection journal, verify recovery
and installation artifacts, stop all relevant writers, perform guarded native
replacement and verify the result before committing/releasing. The hold alone
does not authorize a generation switch or native-file replacement.

Verification: 204 focused tests pass. The full run passes 4,052 tests across
287 suites; its three version-bump tests fail because the child-process `node`
binary is absent from PATH. All eight follow-up tests pass with the explicit
toolchain PATH: the version tests and structural caller tests after their
type-only fixture fix.
There are 40 tests/26 suites intentionally skipped. Tests cover two-ended moves,
ancestor directories, retained retirement intent, inbound retries, native merge
saves, admission/drain ordering, cancellation, aliases, reload and failure.
Main types and changed-source lint pass (two pre-existing sentence-case warnings),
as does the preview build (15 existing warnings). The frozen test-type ratchet
remains 205 errors/44 signatures against 207/46. Native/mobile acceptance and
whole-installer integration remain.

The subsequent lifecycle increment passes 265 focused tests and the full
regression (4,082 tests across 290 suites; 40 tests/26 suites skipped). Main types,
changed-source lint, the unchanged test-type ratchet and preview build pass
(15 existing build warnings). The separate
[startup admission gate](source-startup-admission-preview.md) additionally has
focused cancellation, restart, scope-isolation and retry evidence.
