# Mobile verification — preview 0.2.2

Tested on November 3, 2026, America/Denver (some evidence timestamps are
November 4 UTC). This run began from plugin commit
`9181fe8cbba0d3ab20faa8f25157bf2e9ea711c4` and validated the 0.2.2 changes in
the commit containing this report. The real test backend used server commit
`c78359aec66700b47c1f3a5f13e372a7765c612c`.

Both requested approaches ran. Desktop Obsidian verified host integration;
Simulator Safari verified real iOS WebKit with a substitute host. **Neither
establishes behavior inside native Obsidian on an iPhone.**

## Results by orientation

| Environment | Portrait | Landscape |
| --- | --- | --- |
| Obsidian 1.13.7, macOS Chromium, `emulateMobile(true)` | [390×844 results](obsidian-portrait.md) | [844×390 results](obsidian-landscape.md) |
| iPhone 17 Pro Simulator, iOS 26.5 (23F77), Safari | [402×714 results](ios-portrait.md) | [874×292 results](ios-landscape.md) |

Xcode 26.6 (17F113) was already installed and usable. Simulator UDID:
`18FD30FF-28D2-4EA1-9B27-CF376BC3143E`. Safari's frozen user-agent reports
iPhone OS 18_7 / AppleWebKit 605.1.15 / Safari 26.5; the installed runtime is
iOS 26.5. Viewports above exclude Safari chrome, not device screen pixels.

## Problems found and fixed

1. The fork's text source/issue links still used upstream icon-sized boxes,
   causing overlap in mobile settings. They now wrap and have 44px targets.
2. Very long unbroken paths overflowed permission/conflict dialogs. Text now
   wraps, controls can shrink/wrap, and action buttons are at least 44px tall.
   Final dialog widths were 350/350px in portrait and 618/618px in landscape
   (`scrollWidth/clientWidth`), with no horizontal overflow.
3. Removing an existing permission rule discarded an unfinished new-rule
   draft. All fields now survive re-rendering; added rules copy the draft so
   subsequent edits cannot mutate an earlier rule. Regression tests cover both.
4. The new recovery action compressed the portrait local-folder label into
   broken words. The connection information now occupies its own row.
5. Inventory polling incorrectly marked locally generated Yjs operations as
   remote. This repeatedly rotated the client ID and flooded the console.
   Snapshot installation and claim updates now use local transactions while
   retaining their origin to suppress outbox echoes. The regression test
   failed before the fix and passed afterward. The warning did not recur in
   the final Obsidian session.

The harness also gained text-size normalization and accurate appearance/layout
telemetry. These are substitute-host improvements, not production fixes.

## Automated validation

- Full plugin suite: **133 suites / 1,370 tests passed**, one opt-in real-stack
  case skipped by the regular suite and then run separately.
- Real control-plane/Rust relay integration: **passed**, including concurrent
  text, offline merge, persisted state, structural recovery and authorization.
- WebKit: **13 production-code assertions passed in each orientation**, with
  **zero captured runtime errors**. Includes safe rebase, competing-move
  detection, both decisions, unsaved text and binary preservation, failed
  backup, late edit rejection, encoded conflict reload, WebCrypto PKCE/polling
  completion, and permission draft preservation.
- Production preview build/TypeScript passed; 15 inherited Svelte build
  warnings. Svelte type gate: zero errors. Test-type gate passed against its
  frozen baseline (206 existing errors / 45 signatures, below baseline).
- An initial sandboxed full-suite run failed on prohibited loopback listeners;
  the complete suite passed when rerun with the required localhost access.

## Interaction evidence and limits

Actual Simulator taps, typing, native select menus, software keyboard opening
and dismissal, rotation, save and successful/failed recovery were exercised.
The user manually swiped the permission dialog and confirmed scrolling; the
harness observed **65 touch-move events** and unchanged form fields. Automated
Simulator drags/scrolls generated zero touch-move events, so subsequent action
navigation used clearly labelled harness scroll buttons. These aids do not
count as gesture coverage. Landscape touch scrolling and horizontal panning
remain unverified; corrected dialogs do not require horizontal panning.

In landscape Safari, the software keyboard obscures most of the substitute
dialog. The native Done/checkmark control remained reachable; dismissing the
keyboard exposed the unchanged draft and form actions. This is a recorded
adapter/viewport limitation, not a claim about native Obsidian keyboard handling.

Obsidian's console had no runtime errors after the final reload. Two earlier
pre-login sync-timeout warnings were observed. Chromium still reports the
existing provider's deprecated `unload` listener; no lifecycle migration was
made in this mobile validation task. The harness captures page errors,
unhandled rejections and `console.error`; expected backup failure is rendered
by the production dialog and is not an uncaught runtime error.

No date/time controls apply. Recovery and permissions have no Undo action.
Actual Obsidian editor Undo/Redo was tested. No performance benchmark, blanket
accessibility audit or full mobile regression claim is made.

## Remaining native-device checks

Before relying on this preview on an iPhone or Android device, verify:

- Plugin installation/loading in native Obsidian and its actual mobile version.
- Real vault access, native host dialogs/settings, keyboard avoidance, focus,
  icons, touch scrolling/panning and read-only editor behavior.
- Real Pocket ID passkeys and browser return, cancellation, timeout and token
  refresh; Safari harness OAuth responses were synthetic.
- Background/resume, offline app termination, interrupted backup/archive,
  disk-full/rename failures, attachments and Canvas.
- Device memory/CPU/battery and large-vault performance.

The desktop disposable vault is `/private/tmp/evc-mobile-desktop-20261103`.
Recovery output includes the original offline marker in the file backup,
archived original, readable document history and server-path note. Mobile
emulation was restored with `this.app.emulateMobile(false)` and the desktop UI
visibly returned. All data was synthetic; production services were unchanged.
The disposable vault window was then closed and the original `docs` vault
restored. Both temporary servers stopped, their three loopback ports closed,
and the fixture credentials were removed by the integration harness. A fresh
relay peer also confirmed the exact recovered offline text before shutdown.
