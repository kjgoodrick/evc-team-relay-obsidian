# Comment layout and navigation follow-up

Validated for the 0.4.3 client release. Production server is unchanged.

## Requested changes

- Draft discard review contains only Keep editing and Discard draft, with an explicit 8px gap. Draft revision/snapshot checks remain intact.
- Thread controls and follow/mute controls share one wrapping flex row. Related comment buttons use an 8px gap; mobile notification actions retain 44px touch targets.
- Thread and comment headers share one renderer for avatar, You/display name, and minute-resolution timestamp. Thread status is below that author line.
- Same-view, same-share note changes transfer tracking and avatar presentation rather than destroying/recreating it. The new binding owns subscriptions; clearing the old binding cannot remove the new controls.
- Presence controls retain their nodes across open views and temporary binding gaps. Their SVG is updated only when the icon actually changes.
- Own-avatar presentation uses the current authenticated profile independently from transient local awareness publication. Remote participants come exclusively from the current note. Logout hides the avatar stack. Rebinding unsubscribes the previous awareness.
- Picture avatars do not briefly paint initials while loading. Failed images still fall back to initials; already-loaded images survive same-view navigation.

## Current evidence

Full client regression: 321 suites and 4,788 tests passed, 27 fixture suites/41 tests skipped. Final affected run: 56 tests passed. TypeScript and production build passed (15 existing Svelte warnings).

Tests explicitly assert the same loaded image node survives awareness changes, old peers disappear, old listeners unsubscribe, presence controls retain DOM across views/binding gaps, and tracking controls transfer without DOM removal or old-owner cleanup removing their successor. Comment tests assert identical header presentation, shared action-row membership, and confirmation containing only the two requested labels.

Native verification completed in Obsidian 1.15.0 using the disposable vault `/private/tmp/relay-comments-ui-20261110` and a loopback-only test server. Verified the two-button discard prompt with visible spacing, matching avatar/name/time headers with status below, and all five thread controls on one row. Repeated Note.md ↔ Second.md navigation retained the own-avatar image and tracking/presence controls in the observed native states; the saved draft returned intact. No routine sync or empty-comments status paragraph appeared. Fine-grained node-retention assertions above cover transitions between native observations; screenshots alone do not establish frame-by-frame timing.

The resumed fixture log is `/private/tmp/comments-043-native-resumed.log`. All data and the synthetic avatar used for native testing belong to the disposable fixture. No production server changes or restart are required.
