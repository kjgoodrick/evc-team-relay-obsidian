# Multiple presence observations: transport and note panes

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

## Different-note embedded-image panes

The native host now connects visible Reading and Live Preview panes of different
notes to the negotiated API. Up to eight passive note panes use their existing
live document bindings; duplicate note scopes share a subscription. Each pane
uses its own authenticated awareness identities, source-relative occurrence,
share-specific image proof and native rendered-image verification. A pointer
cannot migrate to an identical embed in another note. Passive panes never publish
local positions or open another presence socket. A directly opened image or saved
Base may own the foreground while these note observers remain visible.

Denial clears only the affected passive note and exposes Retry. Normal refreshes
do not bypass denial. Hidden panes, disconnected bindings, changed document or
account identity, logout and host shutdown release observers and listeners.
Privacy hides local publication while preserving authorized observation.

Native validation and the delayed-binding regression exposed two lifecycle gaps. A late CodeMirror binding now notifies
presence explicitly, so a passive pane does not need another pointer event to
start rendering. Subscription changes withdraw obsolete scopes immediately but
coalesce new watches for 120 ms. This avoids subscribing to intermediate pane/mode
states that exhausted the existing server input budget (close code 4429, followed
by a 30-second backoff). Old IDs are ignored immediately; the server rate limit
has not been raised. Regression tests cover delayed binding, 100 rapid desired-
set changes, late old frames and shutdown with a pending reconciliation timer.

Native Obsidian 1.13.7 used `/private/tmp/evc-multiple-note-native-20261107`, two
synthetic notes with two identical image embeds each, and a read-only protocol
peer publishing only the second occurrence in `Second.md`:

- An active Reading pane for `Note.md` remained unmarked while the passive
  `Second.md` pane displayed movement on its exact second occurrence.
- Passive Live Preview, hidden owner presence and full app reload passed.
  Independent protocol awareness showed no owner publication while hidden.
- Rapid Reading/Live Preview switching reproduced the rate-limit failure before
  subscription coalescing and passed the same native sequence afterward.
- Remote withdrawal cleared the passive pointer; resumption restored it.
- Both Markdown files and the image retained their original hashes. The test vault
  is closed, the original vault window restored, and the synthetic peer and local
  services stopped. No live-vault installation or production deployment occurred.

Local evidence is recorded in `/private/tmp/multiple-note-native-evidence.json`
and `/private/tmp/multiple-note-native-peer.log`. Synthetic relay credentials were
renewed during the test; expiry is distinguished from pane lifecycle results.

Final verification passes **3,285 plugin tests / 250 suites** (22 environment-
specific tests skipped), build/main types with 15 existing warnings, frozen test
types at 206 errors / 45 signatures, and changed-source lint without warnings.
The actual-service suite passes seven tests in six suites after coalescing; its
disposable HTTP process and SQLite fixture are removed. No server code changed
in this host checkpoint.

Different direct-image/Bases passive panes, broader cross-share/native two-client
coverage, physical mobile/touch, resource and accessibility acceptance remain.
