# Mobile verification harness

This browser harness imports the production permission/conflict dialogs, managed
inventory transport, recovery algorithms, backup preparation, and native OAuth
handler. It includes the plugin's actual `styles.css`. It is a substitute host,
not a second implementation of those features or a native Obsidian build.

With the project's dependencies installed:

```sh
node tests/mobile/serve.mjs
```

The server builds the harness and listens only on `127.0.0.1:4177`. After a source
change, run the following in another terminal and reload Safari:

```sh
node tests/mobile/serve.mjs --build-only
```

The running server reads the rebuilt files for each request. Outputs are under
the ignored `dist/mobile-harness/` directory. No extra package installation is
needed. Stop the server with Ctrl-C.

## Simulator

Use an installed Xcode and iOS Simulator runtime. If the global developer
directory points to CommandLineTools, set `DEVELOPER_DIR` for these commands
without changing the machine's global selection:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcrun simctl list devices available
xcrun simctl boot <IPHONE-UDID> # only if shut down
xcrun simctl bootstatus <IPHONE-UDID> -b
open -a Simulator
xcrun simctl openurl <IPHONE-UDID> http://127.0.0.1:4177/
xcrun simctl io <IPHONE-UDID> screenshot /absolute/path/to/evidence.png
```

Run assertions in each orientation. Separately tap through the production
dialogs, type with the software keyboard, rotate an unfinished draft, dismiss
the keyboard, save and reopen permissions, and try both conflict choices and a
failed backup. Check light/dark appearance and long unbroken paths. The page
displays viewport sizes, layout measurements, assertion results, and captured
runtime errors. The latest assertion results are also saved to localStorage.

`Test: scroll up/down` are **harness navigation aids**, added because this test
environment's automated Simulator drags did not produce touch-move events.
They are not plugin features and do not verify touch scrolling. The touch-move
counter helps distinguish actual gestures from these aids.

## Substitute boundaries

- `obsidian-adapter.mjs` implements only the DOM helpers, Modal, Notice and
  Setting controls needed by the imported components. Host CSS approximates
  Obsidian. Native sheets, focus management, accessibility, keyboard avoidance,
  icons, settings navigation and editor behavior require actual-host tests.
- `fixture-network.mjs` replaces only `platformFetch`. It models inventory
  preconditions and a proof-bound OAuth completion. It does not run Pocket ID,
  enforce the complete server policy, open an authentication browser, or model
  native `requestUrl`, TLS, cookies, passkeys or background suspension.
- The conflict share adapter calls the real `ManagedIndexTransport.resolve`
  and `prepareRecoveryBackup`. File bytes, CRDT updates and unsaved buffers are
  synthetic. Writes are in memory/localStorage. It cannot reproduce real vault
  I/O, IndexedDB shutdown, Obsidian's editor bridge, filesystem archiving or OS
  failures; the desktop integration and real-stack tests cover other layers.
- There are no date/time inputs or drag-to-reorder controls in these changed
  components. Permission and recovery decisions have no Undo command. Test
  editor Undo/Redo in actual Obsidian instead.

All credentials and notes are fixtures. No real backend is contacted from this
harness. To reset it, clear this origin's browser storage. Do not use it with
private vault data.

See the [2026-11-03 report](results/2026-11-03/README.md) for actual coverage and
remaining native-device checks.
