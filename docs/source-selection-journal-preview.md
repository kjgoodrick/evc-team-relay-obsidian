# Durable source selection journal

`SourceSelectionJournal` records a device's choice of source-cache generation
separately from server observations. Its identity includes the vault/app ID,
configured server, canonical control-plane endpoint and canonical folder address.
The journal uses a separate `relay-selection-v1-<sha256>` database; credentials
and transient login sessions do not belong in its identity.

Automatic shared-folder startup now reads this journal through
[startup admission](source-startup-admission-preview.md), and its context selects
folder/document/Canvas/buffer namespaces. Pending journals remain paused with a
visible startup reason and Retry control. Native installation and a reviewed
activation action are still unfinished. The journal itself never opens,
imports, removes or relabels an existing source cache.

| State | Source admission | Next step |
| --- | --- | --- |
| No decision | Original legacy choice, with a null journal revision | A reviewed restore may begin. |
| Review pending | Paused | Prepare recovery and a native installation plan, or cancel. |
| Prepared | Paused | Reverify the referenced artifacts and quiesce writers before starting installation, or cancel. |
| Applying | Paused | Finish/recover installation and verify its result before committing. Cancellation is refused. |
| Committed | Only the exact recorded choice and revision | Open its separate inventory/document/buffer namespaces. |

Preparation stores an archive path/manifest hash and installation-plan ID/hash.
Recording these references does **not** verify their files or quiesce native
writers. The installation coordinator must perform those checks before the
corresponding transitions. A pending phase survives close/reopen, including a
crash between native writes and the final journal commit; startup must resume
recovery instead of treating that phase as permission to synchronize.

Every change has a unique operation ID and expected revision. The selection and
retry receipt commit in the same IndexedDB transaction. Only transaction
completion reports success. Exact retry after a lost acknowledgment returns the
same current decision; reused IDs with different bodies and superseded receipts
are refused. Competing reviewers cannot overwrite each other's decisions.
Cancelling review/preparation preserves the previous active choice but advances
the revision, so earlier admission checks cannot be reused.

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

The native installer, cross-window writer coordination,
selection-journal recovery export and user-facing recovery flow remain to be
connected. A separate [native source write hold](native-source-write-hold-preview.md)
now fences and drains registered text/attachment writes in one host realm;
structural, attachment, Bases and inbound mutations also use that admission.
The installer is not yet connected. The journal
is not a filesystem lock and cannot stop another process,
older plugin binary or external editor from writing a vault path.

Verification: 26 journal tests and 209 focused source/inventory/recovery tests
pass using actual `fake-indexeddb` transactions, including late aborts of the
initial decision and final commit, a blocked-read timeout and cross-connection
revision races. Main types and new-source lint pass. The frozen test-type
ratchet stays at 205 errors/44 existing signatures against 207/46. These checks
cover the persistence API; native integration and installer acceptance remain.
