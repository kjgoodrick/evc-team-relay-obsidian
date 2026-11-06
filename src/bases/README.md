# Bases content sync preview

These modules implement the guarded server content protocol, durable local state,
reconciliation worker and native file adapter. `BaseSyncHost` now connects them to
`AttachmentFile` and `VaultShare`, with an explicit per-share Bases setting and
native review/export controls. This is a development sync preview, **not usable
Bases commenting or a release-ready file lifecycle**. Production enablement and
mobile acceptance remain separate gates.

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
of that exact request is fenced. No mutation is automatically replaced or retried.

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

Remaining sync work includes remote/local deletion and restore review, durable
protection for renamed-away entries after deletion/restart, parent-folder and
native rename races, quota reclamation, and mobile/resource acceptance. The current
remote-deletion guard retains recognized Bases files instead of applying generic
trash. It is a preservation fallback, not completed deletion synchronization.

Native testing on November 6, 2026 used a disposable vault and actual local
Python/Rust services. A UI column change reached the server; a conditional server
edit reached the local file. Pausing the Bases setting while making divergent
fixture edits produced a reviewable conflict. Both choices converged exact bytes;
the second conflict survived a native reload. Export contained both reviewed
copies and stayed outside server inventory. This exercises paused sync, not the
complete native offline/network-loss matrix. Renaming a selected view externally
can leave Obsidian showing its old view name as missing; saved-view identity and
navigation integration must address this before Bases comments are complete.

Validation: 1,821 plugin tests passed (nine opt-in tests skipped), including 73
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
