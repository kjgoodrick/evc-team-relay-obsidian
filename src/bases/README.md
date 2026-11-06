# Bases content client foundation

These modules implement the guarded server content protocol and durable local
state. They are **not yet connected to `AttachmentFile` or `VaultShare`**. There
is no native Bases sync setting, worker, disk adapter or conflict dialog yet.
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
clearing it. A failed conditional disk replacement retains both the prepared
download and the newer local edit. Conflict review archives the previous copies.

The 64 MiB byte quota covers active and archived state. Failed quota checks roll
back the whole transaction, including archive writes and pending removal. No
automatic eviction discards recovery data. Export and explicit reclamation UI
are still required. The store acknowledges transaction completion, not just an
individual IndexedDB request succeeding.

The host integration must still:

- Require the managed manifest's enabled content protocol and `recovery: true`.
- Bypass generic timestamp/attachment metadata publication for guarded files,
  including files renamed away from `.base`.
- Persist the pending operation before HTTP and reconcile its receipt before
  advancing to another operation. Preserve later local edits while older work
  is pending; do not infer withdrawal from a failed request.
- Prepare download state before a conditional native file replacement, then
  acknowledge only the matching intent. Check foreground account, file identity,
  structural conflicts and local contents at the actual write boundary.
- Recover interrupted downloads by comparing current disk bytes with the saved
  before/after copies. Preserve ambiguity rather than overwrite it.
- Coordinate concurrent native actors and provide review/export controls for
  conflicts, denied operations, invalid configuration and exhausted local quota.

The automated tests use actual IndexedDB transactions through fake-indexeddb.
The opt-in `realBaseContent.test.ts` drives the actual plugin transport/store
against a disposable Python API; its fixture lives in the control-plane repo.
It proves restart persistence, lost accepted responses, exact receipt recovery,
concurrent-editor conflict, late-send withdrawal and comment-only read access.
It does not prove native disk replacement, desktop/mobile UX or Bases comments.
