# Discussion links preview

Updated November 7, 2026. This is a development preview. Native URI dispatch,
clipboard behavior, popout windows and mobile acceptance remain required.

Saved threads expose **Copy discussion link**, and individual saved messages
expose **Copy comment link**. The plugin registers the public Obsidian protocol
handler `evc-team-relay-comment`. The **Open comment link** command provides a
paste entry point when the operating system opens the wrong vault.

Links contain a version, a SHA-256 fingerprint of the normalized configured
server endpoint, shared-folder ID, managed file ID, thread ID, surface kind,
and optional message ID. Bases links also require the original saved-view ID.
Links contain no account ID, credential, local vault name, file path or comment
body. The server fingerprint is a matching key, not a secret or permission.

Opening uses only a matching, already configured shared folder and its current
signed-in account. It never connects to a server supplied in a link, adds a
share, creates a local file or signs in automatically. Different aliases for
the same server are intentionally not treated as equivalent. Changing a server
endpoint requires a newly copied link; alias migration is not implemented.

## Target behavior

- Resolve managed file identity to the recipient's current local path. Renames
  and different local folder mounts do not alter the link.
- Recheck current read access. Comment and edit permissions are not required
  to open an authorized discussion. Possession of a link grants no access.
- Keep Bases discussions attached to the original saved view. Set only the
  account-local discussion-view preference; use the existing guarded target
  navigation rather than editing saved view definitions.
- A missing or ambiguous local file can still show an authorized cached or
  server-returned discussion, with a clear explanation. Target navigation is
  unavailable until its unique managed file is present.
- Fetch an individual reply through the existing authorized message endpoint,
  including replies outside the first page. Focus that reply and keep a path
  back to the first page. A missing message falls back to the original thread
  with an explanation, without substituting an unrelated message.
- Offline opening uses the current account's existing permission/cache state.
  Uncached threads are unavailable offline. It does not claim fresh server
  authorization when disconnected.
- Cancel pending navigation on a newer link, manual input in the primary
  window, account/server/file changes, access loss, modal cancellation or
  unload. Native Bases navigation rechecks the supplied guard across awaits.

The cache uses the existing scope-generation fence and per-entity event
revision. Targeted reads cannot restore a cleared generation, overwrite newer
entities or invent a synchronization cursor. URI parsing rejects unknown fields,
duplicate URI query keys, invalid identities, unsupported versions and oversized
values. Native protocol parameter objects receive the same schema validation;
duplicate query keys already collapsed by the host cannot be reconstructed.

Thread reads use one request; message reads use one request with at most one
thread fallback after a missing-message response. Existing scope subscription
and synchronization behavior still applies. Inbox target reads reuse the same
authorized path, but linking does not require the inbox feature.

## Verification

- Full plugin regression: 2,845 tests in 222 suites passed; 17 tests in 16
  opt-in suites skipped. No new test-type errors beyond the frozen baseline
  (206 errors / 45 signatures versus baseline 207 / 46).
- Preview build and main TypeScript compilation passed, retaining 15 existing
  Svelte warnings. Changed-file lint has no errors; host/test convention
  warnings remain.
- Real disposable Python service/TypeScript client test passed for linked
  message reads, missing-message fallback and offline reopening alongside the
  existing inbox projection, retry and access-revocation scenario.
- Focused tests cover endpoint isolation, malformed links, renamed/missing/
  duplicate files, saved-view identity, account/access/cancellation races,
  generation fencing, newer cached revisions, older-reply focus, pagination,
  clipboard disposal and immediate remote-content removal after access loss.

No server protocol, database migration or Time & Line implementation changed.
No live-vault installation or production deployment was performed. Native
desktop/mobile URI opening, two-user sharing, popout interaction, unavailable
targets, accessibility and clipboard acceptance remain unverified while the Mac
is locked. Rich editing, final history/permission UI, search/filtering and the
remaining collaboration release scope are separate unfinished work.
