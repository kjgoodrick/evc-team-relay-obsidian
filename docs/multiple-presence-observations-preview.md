# Multiple presence observations: transport foundation

November 7, 2026. The optional `presence_multi_watch_preview` capability allows
up to eight additional note/image/saved-view subscriptions on the existing
version-two presence socket, alongside its foreground watch and Follow.
`observe` and `unobserve` are additive; older servers/clients retain the existing
single-watch behavior. Note observations carry embedded-image state, while text
positions and authenticated participant names continue to use managed awareness.

`LocationChannel.observe()` validates and deduplicates the complete desired set
before changing subscriptions. Editor/Reading copies of the same note count as
one scope. Passive events have their own typed callback; they do not replace the
foreground roster or publish local activity. Scope removal and transport reset
clear local observations. Removed IDs cannot accept late deliveries. Denied
scopes remain denied through ordinary refreshes; explicit Retry and reconnect
obtain fresh subscription IDs and authorization.

The server bounds the number of observations, rechecks each scope separately and
removes only the denied subscription. Foreground and passive subscriptions can
share a room without stealing each other's ownership. Two fixed delivery workers
process per-subscription dirty bits and keep latest state rather than queued
movements. Output comparisons retain 32-byte fingerprints. Per-frame limits and
a combined 1 MiB/second, 2 MiB burst budget protect the connection; overload closes
with 4429 and the existing client backoff applies. These limits still need resource
acceptance on real small-group/mobile workloads.

Validation: 3,282 plugin tests / 250 suites pass (22 environment-specific tests
skip); build/main types pass with 15 existing warnings; frozen test types pass
at 206 errors / 45 signatures; changed-source lint passes. Server validation is
244 presence tests plus 11 capability/policy tests. The disposable actual-service
suite passes seven tests across six suites, including simultaneous foreground
Bases and passive image/note streams on one socket, exact embed delivery and
cleanup. No native vault is used by this transport test.

The native host currently still registers only the foreground scope. Connecting
visible panes of different documents to this API, independent local proofs,
participant identities, permission/lifecycle cleanup, native/mobile acceptance
and broader performance/accessibility checks remain. Same-note and same-image
split panes already reuse the foreground subscription in their separate
checkpoints. This foundation alone does not complete different-document panes.
