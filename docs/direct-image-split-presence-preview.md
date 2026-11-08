# Direct-image presence in same-file split panes

November 7, 2026. Up to eight additional visible panes displaying the foreground
managed image now receive its remote pointers and viewports. The foreground
pane owns the authenticated connection, subscription, publication and navigation;
passive panes reuse the roster and version proof without another socket or HTTP
image-context request. Each pane independently verifies its actual native image
resource, decoded dimensions, local bytes and authorized inventory identity.
Shared digest caching avoids re-reading unchanged bytes on pointer movement.

Observers close on hidden/disconnected panes, image/context/account changes,
permission denial, backgrounding and unload. Replacement native resources cannot
inherit another pane's proof. Privacy withdraws local publication while keeping
remote observation available. A failed passive verification exposes the existing
explicit Retry control without repeatedly fetching on ordinary refreshes.

## Validation

- 3,277 plugin tests pass across 250 suites; 22 environment-specific tests skip.
- Build/main types pass with the existing 15 warnings. Test types remain within
  the frozen baseline: 206 errors / 45 signatures versus 207 / 46 allowed.
- Changed-source lint passes without errors or warnings.
- Host tests verify one socket/watch/context read, no passive pointer publication,
  unchanged-byte reuse, hidden-pane recovery, resource replacement, privacy,
  permission denial, byte changes, blur and logout cleanup.

Native Obsidian 1.13.7 used a disposable vault, local Python/Rust services and an
authenticated synthetic read-only Bob peer. Two directly opened image panes show
matching remote movement, retain correct normalized positions at unequal pane
widths, and survive active-pane changes. Jump reports success; Follow starts and
manual scrolling stops it. This image fits the viewport, so these native checks
do not establish distant scrolling behavior.

Hiding local presence preserves both Bob pointers; an independent read-only
protocol observer confirms the owner's removal from the image roster. Full app
reload preserves privacy and restores both overlays. Bob's withdrawal removes
both pointers, and resuming restores them. The source note and image hashes stay
unchanged. The disposable vault is closed, the original vault window restored,
and all local test services and protocol peers stopped.

Local evidence is in `/private/tmp/direct-image-split-native-evidence.json` and
`/private/tmp/direct-image-split-native-observer.log`; regression/build/type/lint
logs use `/private/tmp/direct-image-split-*.log`.

## Remaining scope

This change observes extra panes of the foreground image only. Simultaneous
observation of different notes/images needs bounded multiple subscriptions on the
existing connection, with separate authorization and stale-event handling. Bases
split panes, two native clients, physical mobile/touch, large images, transforms,
distant navigation and broader performance/accessibility acceptance remain. No
production deployment or live-vault plugin installation is included.
