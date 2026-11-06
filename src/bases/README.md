# Bases content client foundation

These modules implement the guarded server content protocol, durable local state,
reconciliation worker and native file adapter. They are **not yet connected to
`AttachmentFile` or `VaultShare`**. There is no native Bases sync setting,
lifecycle scheduler or conflict dialog yet.
Do not enable guarded Bases publication for the current native client.

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
automatic eviction discards recovery data. Export and explicit reclamation UI
are still required. The store acknowledges transaction completion, not just an
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
remain separate. Hosts without that primitive pause safely. Actual desktop/mobile
lock availability, file creation races and native write behavior still need
acceptance evidence; current file-adapter tests use a controlled Vault port.

The host integration must still:

- Require the managed manifest's enabled content protocol and `recovery: true`.
- Bypass generic timestamp/attachment metadata publication for guarded files,
  including files renamed away from `.base`.
- Supply the runner's current-account, entry/path, access, settings and structural
  conflict guards, and invoke every sync/review action through the shared lock.
- Bind native file creation to the share's parent-folder reconciliation. Coordinate
  accepted content metadata with the managed index's rename/delete publication.
- Add lifecycle scheduling, bounded retry/backoff and cancellation; coalesce
  inventory changes and edits rather than fetching every file on every poll.
- Provide review/export controls for conflicts, denied operations, invalid
  configuration and exhausted local quota, including retained work after a
  server stops accepting new publication.

The automated tests use actual IndexedDB transactions through fake-indexeddb.
The opt-in `realBaseContent.test.ts` drives the actual plugin transport/store/runner
against a disposable Python API; its fixture lives in the control-plane repo.
It proves restart persistence, lost accepted responses, exact receipt recovery,
concurrent-editor conflict, late-send withdrawal, both review choices and
comment-only read access. Its worker disk port is explicitly in-memory.
It does not prove native disk replacement, desktop/mobile UX or Bases comments.
