# Bases deletion and recovery checks

November 7, 2026. Local deletion uses the existing managed inventory path and
retains synchronized/pending copies in the private Bases cache. Once the server
confirms retirement, recovery can create a separate new Base; it does not revive
the retired identity or transfer its discussions.

This checkpoint fixes two gaps. A cached record whose local tracked entry is
gone no longer reports “Up to date”; it explains that saved copies are retained
and directs the user to check removal/access changes. Native delete events also
notify the recovery UI. Creation now rechecks the returned file's path and exact
object identity, together with the current account/context, after `Vault.create`.
The restoration controller retains the original parent-folder object across
intent persistence, permission reads and native creation.

If a delete, rename, replacement, account change or parent-folder replacement
races a native create, the durable intent stays prepared. No unrelated file is
overwritten or deleted, and successful creation is not falsely acknowledged.
`Vault.create` has no cancellable transaction callback: an already-started write
may still leave its copy on disk. Explicit **Check restoration** can acknowledge
the exact saved bytes after restart without writing again; a changed destination
requires review. These guards do not claim to make host filesystem operations
atomic with server permissions.

## Native desktop evidence

Obsidian **1.13.7**, disposable vault
`/private/tmp/evc-base-deletion-native-20261107`, synthetic local accounts and
Python/Rust services on loopback. The test follows the real vault delete event,
managed inventory transport, recovery modal, native creation and guarded sync.

1. `Team/Groups.base` has a synchronized baseline and reports Up to date.
2. **Delete current file** moves it to system trash. The server records the old
   managed ID as deleted/retired and the shared-path copy stays absent.
3. Shared-folder **Review Bases sync** retains the baseline and offers
   **Restore as new file** even though the original file is missing.
4. Restoration creates `Groups (restored).base`. Independent managed-inventory
   and content API reads confirm a distinct ID and exactly the baseline bytes.
5. Full reload preserves the original retirement and completed restoration;
   the restored file remains Up to date. Independent readback finds no extra
   identity, no resurrection of the old ID, and unchanged source Markdown.

The fixture is closed and its services stopped. Local evidence:
`/private/tmp/base-deletion-native-evidence.json`.

## Verification and remaining work

**3,309 tests / 251 suites** pass, with production build/main types and the frozen
test-type gate. Changed-source lint has no errors and two existing sentence-case
warnings. Eight new regressions cover create-result deletion/rename/replacement/
account changes, parent replacement at three asynchronous boundaries, and an
untracked cache record's status. Controlled races complement native ordinary
deletion/restoration; they are not native crash-race evidence.

Offline local deletion/reconnect, arbitrary external renames, nested-folder
deletion/moves, broader restore races, cache reclamation and mobile acceptance
remain. The prior native remote-deletion/offline-edit recovery checks remain
separate evidence. Production and live-vault behavior have not been exercised.
