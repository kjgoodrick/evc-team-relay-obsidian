# Bases content sync preview

These modules implement the guarded server content protocol, durable local state,
reconciliation worker and native file adapter. `BaseSyncHost` now connects them to
`AttachmentFile` and `VaultShare`, with an explicit per-share Bases setting and
native review/export controls. This is a development sync preview, **not usable
Bases commenting or a release-ready file lifecycle**. Production enablement and
mobile acceptance remain separate gates.

## Saved-view association preview

The file menu now offers **Review Bases views** for synchronized standalone
definitions. `BaseRegistryTransport` validates bounded server snapshots, history
pages and exact repair receipts. `BaseRegistryStore` keeps a separate 8 MiB
server/account/vault/share IndexedDB cache. It reserves space before accepting a
pending repair and commits the exact request, operation ID and original reviewed
mapping before transmission. Quota failure preserves existing state; no automatic
eviction removes pending work or repair history.

`BaseViewsController` uses the same per-entry lock as file synchronization.
Inspection requires synchronized local bytes and current authorized inventory.
Read-only members may inspect; edits require current file-write access and a
fresh registry revision. Associations are one-to-one; choosing a new identity,
archiving an earlier identity and restoring an archived association never edit
the `.base` bytes. Ambiguous renamed/copied views require explicit choices.

`BaseViewsModal` shows current/unmatched/archived associations, pages earlier
views, rejects duplicate assignments, preserves keyboard focus after selection,
and disables edits while offline or when review has become stale. A failed send
retains the original choices. Opening or refreshing the dialog does not resend
them; **Check repair delivery** retries the exact saved request. An old accepted
receipt records success without rolling back a newer cached mapping. A newer
server revision can fence a rejected pending CAS request; the recorded status
is superseded, not proof that it was never accepted. Account changes clear the
dialog and prevent old-account response delivery.

Local recovery export includes a transactionally consistent view-registry
snapshot and immutable repair history in `saved-views.json`. It is a diagnostic
export; complete cross-store backup/restore remains separate work. Inspection
is explicit, with no background registry polling. Cached associations remain
reviewable offline; new identity repair requires connectivity.

Validation: 1,884 plugin regression tests passed (ten opt-in tests skipped).
Both actual HTTP fixtures passed separately, covering read-only inspection,
unambiguous/ambiguous changes, exact retry after response loss, restart, later
repairs, stale revisions and archive navigation. Native Obsidian 1.13.7 verified
new identity, archive, reassociation, stale-review rejection, rename, reload,
export and offline cached review in `/private/tmp/evc-bases-views-20261106`.
Build/lint/main TypeScript and Svelte/test-type gates passed with existing
baselines. This is **not Bases commenting**: inline definitions, provisional
offline identities, native target adapters, target permissions and discussion
bindings remain. Native reviewer/mobile and complete resource/lifecycle
acceptance also remain.

## Guarded file synchronization and recovery

`BaseContentProtocol.ts` validates entry/path/generation/version identity,
bounded bytes and SHA-256. Three-way comparison uses the last synchronized
content, local bytes and current remote bytes; device timestamps never choose
a winner. A differing local file without a baseline becomes a conflict. Only
an explicitly known new claim may initialize unpublished content. Local deletion
and changed restore generations are explicit decisions, not automatic overwrites.

`BaseContentTransport.ts` makes one bounded authenticated attempt per call.
It captures immutable request bytes before token refresh, checks account identity
before sending and after response delivery, verifies accepted digests and exact
operation identity, and sanitizes failures. A timeout leaves acceptance unknown.
`withdraw` either returns an accepted receipt or confirms that every later send
of that exact request is fenced. The transport never retries on its own.

`status` checks an exact historical receipt using current read access, including
when edit access or new publication is disabled. Accepted and withdrawn receipts
are distinguished from unknown. A missing receipt does not establish that an old
request never committed. The native **Check saved result** control only displays
this observation: it does not acknowledge inventory, settle local pending work,
change disk, publish, withdraw, or trigger sync. Original pending bytes remain
available for explicit recovery. Account/record changes fence late observations;
read-only users cannot use the separate withdrawal control. Removed identities
still use their existing local recovery flow. Native acceptance of this new
receipt control and full restore reconciliation remain outstanding.

`BaseSyncStore.ts` uses a separate IndexedDB namespace per server/account/vault/
share. Baselines, pending requests, prepared downloads and conflict copies are
committed before external work. Revision preconditions serialize competing local
decisions; operation/download identity prevents late completion replacing newer
work. A confirmed withdrawal archives the original request and baseline before
clearing it and requiring review; a subsequent sync cannot silently resubmit the
withdrawn edit. A failed conditional disk replacement retains both the prepared
download and the newer local edit. Conflict resolution atomically archives the
original conflict and current reviewed copies before preparing a new save or
download. Later local edits made before review are therefore recoverable too.

The 64 MiB byte quota covers active and archived state. Failed quota checks roll
back the whole transaction, including archive writes and pending removal. No
automatic eviction discards recovery data. Export is available; explicit
reclamation UI remains required. The store acknowledges transaction completion, not just an
individual IndexedDB request succeeding.

`BaseSyncRunner.ts` performs a bounded reconciliation under a shared exclusive
lock. It retries exact pending operations, recovers accepted-but-lost responses,
and fences rejected concurrent saves before releasing their local request.
Downloads persist their intent before disk writes. Restart recovery acknowledges
an already-written result without another write; changed local/remote copies
become reviewable conflicts. Read-only local edits are retained rather than
uploaded. Review fetches fresh copies, and applying a choice rechecks both copies,
local file identity and the persisted record revision. A concurrent edit requires
a fresh review. Unchanged baselines are not rewritten on every poll.

`NativeBaseFile.ts` uses [Obsidian's atomic `Vault.process` API](https://docs.obsidian.md/Plugins/Vault)
for existing files. It checks current contents, the `TFile` object, its path and
the host-provided context guard inside the synchronous update callback. New files
use `Vault.create`, which must refuse an existing destination. Writes require
round-trippable UTF-8 and preserve BOM/CRLF/Unicode. The lock wrapper uses Web
Locks; accounts sharing the same on-disk entry share its lock, while their caches
remain separate. Hosts without that primitive pause safely. Desktop Obsidian
1.13.7 has passed publication, guarded download, conflict/reload and both review
choices. Mobile, native concurrent-window creation races and the broader file
lifecycle matrix remain unverified.

`BaseSyncHost.ts` provides:

- Managed protocol/recovery capability checks; Bases never fall through to generic
  timestamp arbitration or blob upload when disabled or unavailable.
- Current-account, entry/path, access, settings and structural-conflict guards.
  Existing guarded versions and tracked files retain guarded routing after a
  rename away from `.base`.
- At most two active reconciliations, change fingerprints, bounded retry/backoff,
  and account/server cancellation. Unchanged successful files do not trigger
  repeated HTTP reads on the one-second inventory scan.
- Accepted-content metadata coordination with the managed inventory, preserving
  an in-flight local rename and ignoring older receipts.
- Main settings, share-modal and file-menu access to native conflict review,
  explicit delivery checks/withdrawal, retry and local recovery export. Exports
  retain exact bytes without credentials under the excluded recovery folder.

`BaseRetirement.ts` handles explicit server removal. The server's guarded retired
ID/path marker must match its ordinary tombstone; an absent/hidden file is not a
deletion. The current account must already have durable state for that identity.
The initial local bytes, baseline and pending requests are retained atomically.
Review reads fresh local contents, checks current inventory/permissions, and can
move the entire file to the excluded local recovery folder. Move intent and the
reviewed snapshot commit before native rename. An interrupted move can acknowledge
its verified destination after restart without moving twice. Stale reviews,
replacement files, occupied destinations and quota failures preserve the originals.
A final native rename also preserves an edit arriving after its final read.

The removed identity cannot resume old publication or be reclaimed. Its pending
requests remain available for export; deletion never pretends to confirm their
delivery or withdrawal. Another identity at the same path blocks removal review.
Recognized removed files stay in place until that explicit recovery choice.

`BaseRestoration.ts` provides **Restore as new file**. The user previews and
selects the current retained file, observed removal copy, baseline, pending edit
or retained conflict/download bytes. Creation requires current source visibility,
destination write access, a new `.base` path and an existing parent folder. A
replacement at the former path cannot become the old identity's source. All
originals remain intact. The exact destination and reviewed bytes commit locally
before `Vault.create`; existing files are never replaced. The ordinary guarded
sync flow assigns and publishes the new identity. The UI distinguishes local
creation from confirmed synchronization; it never transfers old discussions.

Interrupted creation offers explicit **Check restoration** and **Stop
restoration**. Checking can acknowledge the exact bytes already present without
writing again, or retry creation if absent and currently permitted. Changed or
occupied destinations remain untouched. Stopping archives the exact intent and
does not remove any resulting file. A subsequent restore archives the previous
intent. These archives account for their bytes without duplicating unrelated
retained state; stopping does not require extra byte quota. IndexedDB version 2
preserves version-one records and closes older workers whose quota accounting
does not include restore bytes. Export remains available through the current
preview; downgrading to a version-one worker cannot reopen that cache.

Obsidian 1.13.7 verified restoration after a closed-vault local edit and server
deletion, occupied-destination refusal, choosing the earlier synchronized copy,
two separate new managed IDs with exact server/local bytes, recovery export,
cache upgrade/reopen and rendering the restored definition. The original remained
deleted and no duplicate appeared on reopen. Interrupted creation and competing
windows use controlled Vault tests; mobile and native crash/race acceptance remain.

Native Obsidian 1.13.7 verified a server-directed rename away from `.base`, restart,
remote deletion while the vault was closed, retention of an offline local edit,
and review/move/export. The server entry remained deleted; the recovery directory
was absent from inventory. Native checks precede the final extra guard against
startup reclaim attempts, which has regression coverage. A separate external
filesystem rename to `.txt` was reported as deletion by Obsidian; the renamed
bytes remained on disk but their managed identity was not preserved.

Remaining sync work includes coherent backup/identity restore, complete local
deletion recovery, unsupported external renames,
parent-folder and native rename races, quota reclamation, and mobile/resource
acceptance. No Bases comment targets are available yet.

Restoration validation: **1,860 plugin tests passed**, nine opt-in tests skipped,
including 112 Bases unit tests. Preview build, main TypeScript, changed-source
lint and the test-type gate passed with existing warning/type baselines. The
disposable vault is `/private/tmp/evc-bases-restore-20261106`; it retains the two
restored files and exported originals. The local services/database were stopped
and removed. No production deployment or live-vault installation occurred.

Native testing on November 6, 2026 used a disposable vault and actual local
Python/Rust services. A UI column change reached the server; a conditional server
edit reached the local file. Pausing the Bases setting while making divergent
fixture edits produced a reviewable conflict. Both choices converged exact bytes;
the second conflict survived a native reload. Export contained both reviewed
copies and stayed outside server inventory. This exercises paused sync, not the
complete native offline/network-loss matrix. Renaming a selected view externally
can leave Obsidian showing its old view name as missing; saved-view identity and
navigation integration must address this before Bases comments are complete.

Removal-recovery validation: **1,835 plugin tests passed**, with nine opt-in tests
skipped and 87 Bases unit tests included. Forty server content/managed-share tests
passed. Preview build, main TypeScript, changed-source lint and test-type gates
passed with the existing warning/type baselines. The disposable native services
and temporary database were removed; the test vault and local recovery artifacts
remain at `/private/tmp/evc-bases-retirement-20261106`. No live vault or production
deployment was changed.

Native-sync checkpoint validation: 1,821 plugin tests passed (nine opt-in tests skipped), including 73
focused Bases unit tests; the actual HTTP fixture passed separately. Preview
build, main TypeScript, Svelte type/event gates and changed-source lint passed.
The existing 15 build warnings and test-type baseline remain (206 errors across
45 signatures versus 207/46 allowed). Native services/database were stopped and
removed; the disposable vault and local recovery exports were retained. No live
vault or production service was changed.

The automated tests use actual IndexedDB transactions through fake-indexeddb.
The opt-in `realBaseContent.test.ts` drives the actual plugin transport/store/runner
against a disposable Python API; its fixture lives in the control-plane repo.
It proves restart persistence, lost accepted responses, exact receipt recovery,
concurrent-editor conflict, late-send withdrawal, both review choices and
comment-only read access. Its worker disk port is explicitly in-memory.
Its disk port remains in-memory; the separate native checks above establish the
listed desktop behavior. Neither establishes complete mobile UX or Bases comments.


## Restore generation

Content snapshots retain the advertised restore context separately from their
canonical content state. Pending requests retain `restoreGeneration` separately
from the immutable wire body. Each entry observes the context under its native
lock with a revision captured before the HTTP read; stale observations and a
known restored generation reverting to an unsupported/original server are
rejected. Older pending saves retain their original binding across reopening.

The runner reads the current context before retrying pending work. Old requests
cannot publish or withdraw, and late acknowledgments cannot settle local state
or update managed inventory after a newer observation. Local edits from an older
baseline require review; an unfinished old download becomes a retained conflict,
including if its bytes already reached disk. Fresh initialization with no proven
baseline on a restored share requires an explicit local choice. Reviewed choices
capture the current snapshot binding; retries keep it through lost responses.

Bases storage version 3 preserves all existing pending/recovery bytes and closes
older workers that would discard this metadata. The UI disables retry and
withdrawal for older pending generations while keeping read-only receipt checks
and recovery export available. Native acceptance, registry/inventory restore
fencing, explicit reconciliation of historical pending work and full coordinated
restore/rollback remain separate unfinished work.
