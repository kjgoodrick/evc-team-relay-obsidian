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

## Offline deletion and competing edits

A second native Obsidian **1.13.7** fixture at
`/private/tmp/evc-base-offline-native-20261107` verifies the explicit shared-folder
**Relay: disconnect/connect** workflow. This control takes sync offline; the
separate Disconnect button in share management unlinks a local folder and is
not used for this test.

1. Start with a synchronized Base, disconnect the share, then delete the Base
   through the native file command. Independent API readback confirms the server
   still holds the original while the local file is absent.
2. Fully reload Obsidian. The share remains disconnected, the local deletion
   persists and the server remains unchanged.
3. Reconnect. The original identity is retired, the local file stays absent,
   and Bases recovery offers the retained synchronized copy.
4. **Restore as new file** creates a distinct managed identity with identical
   bytes. The source note remains unchanged.
5. Disconnect again and delete that restored file. Publish a competing edit
   through the real content API before reconnecting. Native Obsidian reports
   **Deleted locally** versus the current server path; the conflict survives a
   full reload and the server's newer bytes remain intact.
6. **Use server layout** resolves the structural conflict and writes its private
   recovery record. Bases content still requires explicit **Review copies →
   Use server** because the local file is missing. This second review displays
   the competing edit; after acceptance the file is Up to date and byte-for-byte
   equal to the unchanged server snapshot. Layout selection alone is not content
   restoration.

This fixture is closed and its services stopped. Local evidence:
`/private/tmp/base-offline-native-evidence.json`.

Five opt-in integration cases in `__tests__/bases/realBaseLifecycle.test.ts` also
pass against disposable actual HTTP services, the private Yjs inventory and the
IndexedDB store. They cover lost accepted deletion responses across two client
restarts; retained baseline and unsent bytes after retirement; deletion versus a
newer content version; a fresh identity at a retired path; a new remote child
blocking an offline folder deletion; and a concurrent move preventing deletion
of the moved Base. The missing-file host port and IndexedDB runtime are test
adapters; those cases do not substitute for the native checks above.

From the control-plane directory, run with the plugin dependencies and relay
binary available:

```sh
.venv/bin/python tests/integration/managed_stack.py \
  --plugin /path/to/evc-team-relay-obsidian --base-lifecycle
```

## Verification and remaining work

**3,309 tests / 251 suites** pass, with production build/main types and the frozen
test-type gate. Changed-source lint has no errors and two existing sentence-case
warnings. Eight new regressions cover create-result deletion/rename/replacement/
account changes, parent replacement at three asynchronous boundaries, and an
untracked cache record's status. Controlled races complement native ordinary
deletion/restoration; they are not native crash-race evidence.

The added five real-service cases, frozen test-type gate and harness Ruff checks
pass. This increment changes acceptance coverage rather than runtime behavior.
Arbitrary external renames, native nested-folder deletion/moves, broader restore
races, cache reclamation and mobile acceptance remain. The prior native
remote-deletion/offline-edit recovery checks remain
separate evidence. Production and live-vault behavior have not been exercised.
