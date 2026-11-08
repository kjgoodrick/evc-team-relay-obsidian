# Multiple presence observations: transport, note and image panes

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

## Different directly opened images

Visible managed-image panes now use their own authorized image scope while a note,
another image or a saved Base owns the foreground. Same-file foreground copies
reuse its proof; different images independently fetch and verify their current
generation and content hash. Duplicate panes share a bounded proof cache and one
subscription. Notes and images share an eight-passive-pane budget, with stable
note priority; there is still only one presence socket and no passive publication.

Each image scope has separate roster/state caches and denial/retry handling.
Foreground roster updates cannot overwrite a different image's participants.
Changed native resources, files, accounts and hidden/disconnected panes release
their surfaces. Ordinary foreground changes preserve still-eligible image panes
and their subscriptions, avoiding verification and subscription churn. Logout and
backgrounding clear them. Explicit Retry obtains fresh authorization and ignores
late deliveries from the denied subscription.

Native Obsidian 1.13.7 used `/private/tmp/evc-different-image-native-20261107` with
two managed images containing identical bytes but different entry identities.
Only passive `Other.png` displayed Bob while `chart.png` was active. Movement,
foreground Live Preview/Reading notes, repeated image-to-note transitions, hidden
owner presence, full reload and remote withdrawal/resumption pass. Initial native
transition gaps prompted preservation of eligible passive observers; the final
build passes the repeated sequence. A separate deterministic rendering regression
also exposed a hidden layer measuring itself at zero size: restoring visibility
before measurement now allows recovery when valid image geometry returns.

The final note and both image hashes match their originals. The disposable vault
is closed, the original vault window restored and the peer/local services stopped.
Evidence: `/private/tmp/different-image-native-evidence.json`; validation logs:
`/private/tmp/different-image-*.log`. Temporary read-only diagnostics were cleared
by full reload. No live-vault installation or production deployment occurred.

Final validation: **3,289 plugin tests / 250 suites**, 22 environment-specific
skips; build/main types pass with 15 existing warnings; test types remain at 206
errors / 45 signatures within the frozen baseline; changed-source lint passes.
The 62 focused host/motion tests include shared pane limits, duplicate proof/byte
reuse, foreground isolation, denial/retry, preserved subscriptions, no passive
publication and hidden-layout recovery. Server code is unchanged.

Passive Bases panes, broader cross-share/native two-client coverage, physical
mobile/touch, resource and accessibility acceptance remain.
