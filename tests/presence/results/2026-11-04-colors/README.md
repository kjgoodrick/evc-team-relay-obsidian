# Consistent presence colors — verification 2026-11-04

Runtime release: 0.2.6, source `d919a62aa550612af757e4681e7091de5f3446d5`.
The exact published bytes were installed with the existing plugin's real
**Check for updates → Update to 0.2.6** buttons. The vault was backed up first,
its open editor was confirmed saved, and Obsidian was reloaded. Running 0.2.6
was then confirmed in settings.

## Actual Obsidian integration

Obsidian 1.13.7 on the Mac mini: the same account's outgoing awareness was
`#ee6352` and its rendered avatar border was `rgb(238, 99, 82)` in two different
existing notes. Sync remained connected and tracking, and editor text matched
the live document. The color remained identical after further host reloads.

With `app.emulateMobile(true)` and the DevTools device toolbar, checks passed at
390×844 and 844×390. The actual avatar stack and active-user popover agreed,
profile pictures decoded, and the open popover survived rotation. These were
read-only checks in the existing vault, not a new disposable vault. Screenshots
contain real profile/note information and are retained only in the private
`.knowledge-base-build/presence-color-0.2.6/` directory.

No new product console errors appeared. An initial mistyped verification probe
caused a SyntaxError; the corrected probe passed before reload. The existing
live-instance-registry debug warning and existing "Not tracking" toolbar
message remain; the actual view registry reports tracking and connected.
Desktop mode was restored with `app.emulateMobile(false)`, device emulation
was disabled, and DevTools was closed.

All six Markdown note hashes and raw `data.json` bytes matched before/after.
All three installed runtime files match the public release. The saved login
continued working. No server restart or configuration change was needed.

## iOS WebKit

Device: iPhone 17 Pro Simulator, iOS 26.5, UDID
`18FD30FF-28D2-4EA1-9B27-CF376BC3143E`; Safari 26.5. Safari's user-agent reports
an iOS 18_7 compatibility token; the simulator runtime is 26.5.

| Orientation / appearance | CSS viewport | Assertions | Captured runtime errors |
| --- | --- | --- | --- |
| Portrait / light | 402×714 | 14/14 | 0 |
| Landscape / dark | 750×292 | 14/14 | 0 |

The harness bundles the real production presence components, production CSS
and real Yjs awareness. Two independent notes advertise different colors for
the same identities; the rendered borders match. Checks include picture
loading, failure, replacement, removal, long names, overflow and the user list.
The intentional missing-image request returns 404 to exercise fallback.

Actual Simulator taps opened the second note's user list and activated picture
removal/replacement; the open list survived device rotation. Light/dark
appearance and matching borders were visually checked. The simulator was
restored to portrait/light. See the separate JSON results and screenshots here.

## Limits

The WebKit harness substitutes `activeDocument` with the browser document; the
components need no other Obsidian host API. It does not run the full plugin or
its real vault/sync services. Remote CodeMirror cursor rendering is covered by
the production-extension regression test, not the Safari harness.

Touch scrolling remains unverified because this automation's drags do not
produce usable Safari swipe gestures. There are no changed forms, date/time
controls, keyboard flows, saved drafts or Undo actions in this color change.
This pass does not establish native iPhone Obsidian plugin loading, vault
access, native UI, background/resume, keyboard behavior or device performance.
