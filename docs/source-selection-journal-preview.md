# Durable source selection journal

`SourceSelectionJournal` records a device's choice of source-cache generation
separately from server observations. Its identity includes the vault/app ID,
configured server, canonical control-plane endpoint and canonical folder address.
The journal uses a separate `relay-selection-v1-<sha256>` database; credentials
and transient login sessions do not belong in its identity.

Automatic shared-folder startup now reads this journal through
[startup admission](source-startup-admission-preview.md), and its context selects
folder/document/Canvas/buffer namespaces. Pending journals remain paused with a
visible startup reason and Retry control. New-folder desktop installation and
separate cache imports now have tested coordinators; the reviewed activation
action is still unfinished. The journal itself never opens,
imports, removes or relabels an existing source cache.

| State | Source admission | Next step |
| --- | --- | --- |
| No decision | Original legacy choice, with a null journal revision | A reviewed restore may begin. |
| Review pending | Paused | Prepare recovery and a native installation plan, or cancel. |
| Prepared | Paused | Reverify the referenced artifacts and quiesce writers before starting installation, or cancel. |
| Applying | Paused | Finish/recover installation and verify its result before committing. Cancellation is refused. |
| Committed | Only the exact recorded choice, revision and native root | Open its separate inventory/document/buffer namespaces at the installed location. |

Preparation stores an archive path/manifest hash and installation-plan ID/hash.
Recording these references does **not** verify their files or quiesce native
writers. The installation coordinator must perform those checks before the
corresponding transitions. The [archive verifier](recovery-archive-verification-preview.md)
can now reopen the saved archive against its recorded digest. A hash-bound
[installation plan](source-installation-plan-preview.md) can also be reopened and
checked against the journal's source/review/archive, including every staged byte,
complete editing-history dependencies and agreement with native content.
A [preparation coordinator](source-installation-preparation-preview.md) now
stages artifacts, rechecks current inventory and records the verified references
with an expected journal revision. Production downloads, desktop staging,
[resumable native copying](source-installation-materialization-preview.md) and
[selected-cache imports](source-installation-caches-preview.md) are implemented.
Mapping and final activation now have internal coordinators. External-writer
isolation and the recovery UI remain.
A pending phase survives close/reopen, including a
crash between native writes and the final journal commit; startup must resume
recovery instead of treating that phase as permission to synchronize.

Every change has a unique operation ID and expected revision. The selection and
retry receipt commit in the same IndexedDB transaction. Only transaction
completion reports success. Exact retry after a lost acknowledgment returns the
same current decision; reused IDs with different bodies and superseded receipts
are refused. Competing reviewers cannot overwrite each other's decisions.
Cancelling review/preparation preserves the previous active choice but advances
the revision, so earlier admission checks cannot be reused.

Preparation now also saves distinct start/commit operation IDs in its optional
`activation` field. The journal binds the corresponding transitions to those
IDs; its transaction refuses IDs already used by another receipt. Older prepared
or applying preview records can add this field once with `reserve-activation`,
without changing their archive, plan, phase or active choice. Reservation uses
the same revision/receipt transaction and cannot replace existing intent.
`sourceActivationRequest` reloads the saved pair after restart. Lost reservation
responses are recovered by rereading the durable state before continuing.
Older strict readers reject preparations containing this new field; they must
not silently discard it or activate the source with new operation IDs.

The commit command can additionally bind `destinationRoot`, validated with the
same native-path rules as installation plans. Its canonical path is stored as
`nativeRoot` in the same transaction as the active generation and receipt.
Changing that path on an exact retry is refused. Native startup requires a
matching committed root before its preparation callback can run, preventing stale
settings from attaching the original folder to a restored source cache. The
coordinator must verify the plan, native files, caches and current admission
before supplying this location; the journal does not inspect the filesystem.

Older preview choices without a root remain readable for recovery, but cannot
start a native restored folder. A commit from an old caller cannot inherit a
previous generation's root. Older readers reject the new field as unsupported
instead of ignoring it. Legacy choices continue through their existing startup
path. Relocation of an activated folder and controlled handoff of an original
paused hold still require the activation/recovery workflow.

Successful transaction completion emits a scoped change hint, including when a
near-commit timeout left the caller uncertain. Aborted transactions emit none.
Other open contexts reread the durable state before invalidating their providers;
notifications cannot select a source or release an installation hold. See
[context notification coverage](source-selection-context-preview.md).

After a new source selection commits, its predecessor is retired. Later decisions
cannot reactivate that old generation or reuse the already-active cache as a new
selection. A server rollback must therefore use a new generation, matching the
server restore contract. Original legacy caches remain separately retained.
The journal bounds the retired list at 1,024; it refuses another transition at
that boundary before beginning a new review, rather than silently forgetting a
retired identity or discovering the limit after native files were replaced.

The reader rejects malformed, noncanonical, unknown-version or wrong-scope state.
A missing state row with existing receipts cannot become an empty legacy choice.
A newer database schema closes older handles and cannot be opened by downgrading.
Open/read/write waits are bounded; a timeout never grants fallback authority.
An operation that timed out near commit is reconciled through its exact receipt.
Input objects and returned snapshots cannot mutate stored state by reference.

The [native activation coordinator](source-installation-activation-preview.md)
now combines verified file/cache/mapping installation with the final journal
commit. Cross-window writer coordination, selection-journal recovery export and
the user-facing recovery flow remain. A separate [native source write hold](native-source-write-hold-preview.md)
now fences and drains registered text/attachment writes in one host realm;
structural, attachment, Bases and inbound mutations also use that admission.
The new-folder installer can drain a paused startup hold without releasing its
original barrier. Ordinary startup can reconcile its committed new location
after reload, and the registry creates a fresh instance there. The journal
is not a filesystem lock and cannot stop another process,
older plugin binary or external editor from writing a vault path.

Verification: 26 journal tests and 209 focused source/inventory/recovery tests
pass using actual `fake-indexeddb` transactions, including late aborts of the
initial decision and final commit, a blocked-read timeout and cross-connection
revision races. Main types and new-source lint pass. The frozen test-type
ratchet stays at 205 errors/44 existing signatures against 207/46. These checks
cover the persistence API; native integration and installer acceptance remain.
