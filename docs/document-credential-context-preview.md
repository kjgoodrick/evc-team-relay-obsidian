# Document credential contexts

Document grants, in-flight requests and renewal subscriptions now use a private
memory namespace containing the selected server, provider login session, local
invalidation epoch, document identity and requested restore generation. A default
server selection also retains its selection epoch. Identical document IDs on two
servers can acquire and reuse their own grants without coalescing requests or
replacing each other's callbacks.

The provider and file path are captured before waiting behind another request.
The context is checked after authentication, throttling, networking and response
parsing, including the read-only fallback. Clearing credentials, changing the
default/mode, replacing/removing a provider or changing its account/endpoint
invalidates old work. An explicitly selected unavailable server fails rather than
falling through to a default provider or legacy file-token API.

Short-lived document grants are memory-only. Existing unscoped persisted grants
are ignored; their old storage is not imported into the new cache. Account sign-in
remains managed separately by `AuthSession`. A restart therefore obtains fresh
document grants without changing the retained source caches or requiring a new
account login when that session remains valid.

Access refusals and network stalls remain scoped to the relevant server/session/
share/generation. Requests serialize within their active context. A new request
after invalidation does not wait for an obsolete authentication operation, and
late failure cannot recreate a purged cache entry. Invalid contexts are pruned
at identity/configuration changes; ordinary acquisition does not scan every
cached document. Routine JWT refresh in the same login session retains the cache.

The grant retains a private association with its issuing context. `ProviderBacked`
checks it when applying a grant and before reusing it for a connection. Offline
unsubscribe and manual refusal reset include the selected server. Restore pauses
are retained per document/server/generation, independently of clearing credentials.
An explicit low-level request for another generation has a distinct cache slot;
that API does not select a new generation for an existing source document.

Tests cover matching IDs on two servers, simultaneous requests, account/endpoint
changes, delayed results, missing providers, mode/default cycles, clear/retry,
restore bindings, refusal isolation, ignored legacy grants and acquisition cost
with unrelated cached documents. Existing renewal/backoff/unsubscribe checks also
run. The disposable FastAPI/Rust scenario obtains a selected-generation grant
through the actual cache for a new low-level peer while the original automatic
source client and its offline edits remain paused.

This isolates credentials. An explicitly selected source can now use a
[separate generation cache](source-cache-generation-preview.md) through the
normal provider; automatic source clients still retain their original caches.
Reviewed native-file replacement, safe activation, minimum client gates and
coordinated restore remain separate requirements. Native/mobile acceptance is
still pending; this checkpoint does not enable automatic resumption.
