# Comment layout and navigation follow-up

Implementation is ready for native visual verification; no new release has been published.

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

Native verification remains outstanding because the Mac is locked. Must inspect button spacing, headers, the single action row, and repeated note-switching for visible flicker before declaring completion or publishing.

A disposable local fixture was started with inbox/presence enabled. Its log is `/private/tmp/comments-043-native.log`; fixture identity is `/var/folders/8c/wjjnpp396gs3yf079kl932xw0000gn/T/evc-managed-integration-c94f7alj/fixture.json`. Synthetic owner profile has a loopback image, and Note.md/Second.md are seeded. Do not use the fixture file's bearer tokens outside this local test stack. Revalidate process liveness before using/restarting the fixture.

Scratch build is in `dist`, labeled 0.4.3 for testing. Release manifests/source remain at 0.4.2 until native validation is complete. Production server is unchanged.
