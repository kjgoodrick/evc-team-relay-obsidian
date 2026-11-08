# Embedded-image presence in same-note split panes

November 7, 2026. Visible Reading and Live Preview panes of the foreground note
can display remote image pointers together. The publisher, account and note
subscription remain owned by the foreground pane. Passive panes never publish,
start Follow, open a socket or load another note. Up to eight additional visible
panes reuse the current authenticated embed event and note-peer identities.

Each pane resolves the exact relative image occurrence through its own current
Reading or CodeMirror binding. Duplicate image URLs cannot substitute for source
identity. Asset inventory, generation, content digest, decoded dimensions and
source lineage are independently checked before display. The shared image
verifier reuses byte digests; pure pointer movement does not re-read image bytes.
Observers release their overlays on hidden/disconnected panes, mode/identity
changes, account loss, unavailable subscriptions and unload. Delayed work checks
its original text and context before drawing.

## Validation

The final regression passes 3,273 plugin tests in 250 suites (22 environment-
specific tests skipped). Build/main types pass with the 15 existing warnings;
test types remain within the frozen baseline at 206 errors / 45 signatures;
changed-source lint has no errors or warnings. Focused tests cover both Reading
and actual CodeMirror widgets, passive-publication exclusion, one socket/watch,
repeated refresh without new byte reads, hidden-pane recovery, binding access
loss, focus transfer, account loss and independent source-bound image mapping.

Native Obsidian 1.13.7 used a disposable vault, local Python/Rust services and an
authenticated synthetic read-only Bob peer:

- Both Reading panes show Bob only on the second of two identical image embeds.
- A passive Live Preview pane and active Reading pane both receive changed
  normalized pointer positions on that same occurrence.
- Jump scrolls the active pane to the image position. Follow responds to movement
  and stops when the user scrolls manually.
- Hiding local presence leaves Bob's pointers visible. An independent awareness
  observer confirms the owner's publication disappears.
- A full reload preserves hidden presence and restores both overlays. Remote
  image-location withdrawal clears both pointers; resuming restores them.
- Markdown bytes remain unchanged. The test vault is closed, the original vault
  window restored, and all local test services and synthetic peers stopped.

Local evidence: `/private/tmp/split-image-native-evidence.json` and
`/private/tmp/split-image-native-peer.log`. The native checks preceded an additional
captured-text identity guard; focused regression and build/type checks cover that
guard.

## Remaining scope

This original checkpoint shares the foreground note's existing subscription.
Different-note Reading/Live Preview observation now has a separate
[transport and native-host checkpoint](multiple-presence-observations-preview.md).
Other surface kinds, physical mobile/touch, two native clients and broader
performance/accessibility acceptance remain. No production deployment or
live-vault plugin installation is included.

Same-file direct-image split panes are now covered by the
[direct-image checkpoint](direct-image-split-presence-preview.md).
