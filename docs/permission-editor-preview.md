# File and comment permission editor

The share settings and share-management modal now open a combined permission
editor. The server must provide the versioned permission API described in the
[server contract](../../evc-team-relay/docs/permission-editor-preview.md), behind
`COLLABORATION_POLICY_ENABLED`. This is an implemented preview, not completed
desktop/mobile release acceptance.

## Behavior

- Share owners have a management entry point. Other accounts receive one only
  after a current authorized policy read; this exposes server administrators
  without interpreting cached role labels as server authority.
- Choose a member and a canonical relative file/folder path, or the whole share.
  File overrides are hidden/read/edit/inherit; comment overrides are
  allow/deny/inherit. Removing an override restores inheritance.
- Presets provide read and comment, read only without comments, edit and comment,
  and hidden access. Both rule lists are saved in one conditional transaction.
- More-specific exceptions are retained by default. Explicitly replacing them
  removes only the selected member's narrower file/comment overrides. The review
  lists each removal as well as additions and changes.
- An exact-file preview explains which file and comment rules win. Comment
  allowance cannot overcome missing read access; absent a comment override,
  editors may comment and readers may not. The preview checks rules, not file
  existence or all dependencies of a Bases target.
- Adding/updating builds a local proposal. Review shows the difference from the
  loaded policy before Save applies it. Unapplied fields must be applied or
  discarded before review; editing a different row does not silently discard
  them. Removing another row retains those fields. Closing unsaved work asks
  whether to keep editing or discard it.
- Rules, reviews and conflicts are paged in groups of 50. Labels use text
  rendering, controls have accessible names and mobile controls have minimum
  touch dimensions. Native touch and complete keyboard/screen-reader acceptance
  remain required.

## Conflicts and interrupted saves

The form retains its observed base and proposal. A stale-save conflict first
requires a fresh server read. A structural three-way merge preserves unrelated
server changes and asks for a choice when both administrators changed the same
rule differently. It also handles deletion versus modification. The result
returns to editing for effective-access inspection and a new review; resolving
conflicts never saves automatically. Independently edited parent/child rules can
interact without a structural conflict, so the interface explicitly calls out
that review requirement.

An interrupted or invalid response does not prove that a save failed. The form
disables further saving until it reads the current policy. If it matches the
proposal, the UI reports that the desired rules are present, without asserting
which administrator wrote them. Otherwise it offers comparison/merge. A failed
read leaves recovery available and does not resubmit a write. There is no offline
permission queue.

The binding captures the selected server, provider, client and account. It never
falls back to the active/default server when the selected client is missing.
Account/provider/client/endpoint changes, disabled integration, modal closure
and plugin unload fence late requests and clear displayed policies. Closing while
credentials refresh prevents a later write dispatch; a request already sent may
still commit. Server checks remain authoritative on every operation.

If the combined API is unavailable, the UI explains that limit and offers the
existing file-only editor as an explicit choice. That legacy endpoint remains
unversioned and does not edit comment rules. The combined editor never silently
falls back to two separate writes.

## Verification and remaining acceptance

- 2,959 plugin tests in 231 suites pass; the general run skips 20 opt-in tests
  in 17 suites. The 21 new model, DOM and binding cases cover inheritance,
  exceptions, meaningful merge conflicts, interrupted saves, preservation of
  unsaved fields, account/server changes and delayed credentials/responses.
- All three real Python-service/TypeScript-client scenarios pass. The permission
  scenario uses the actual preset model, verifies read/comment without edit,
  sends a reviewer comment and checks lost-response reconciliation, stale-save
  rejection and account changes.
- Preview build/main types, Svelte type check, changed-file lint and the frozen
  test-type gate pass. Existing 15 build warnings, four changed-file lint warnings
  and 206 known test-type errors across 45 signatures remain. The final small
  binding/form hardening also passes the 21 focused tests and a rebuilt preview.
- A disposable native vault, `/private/tmp/evc-permissions-native-20261107`, ran
  the preview in Obsidian 1.13.7 on macOS against a newly created loopback
  Python/Rust stack with synthetic accounts. Native observations confirm the
  settings entry point, member and independent controls, read-only preview,
  preserved hidden `Budget.md` exception, one-rule review and Escape/Keep editing
  protection. These observations precede the final small binding/form hardening.
- After explicit user approval on November 7, the rebuilt preview passed native
  read-only Save and reopen. A competing local API write removed only Bob's root
  comment override, leaving his read permission and hidden-file exception intact.
  Saving the stale native proposal was rejected. Read current permissions showed
  the conflicting inherited value; the user-facing choice and another review
  were required before the final native Save restored read-and-comment access.
  Independent server reads verified `read=true`, `comment=true`, `edit=false`,
  `moderate=false` for `Note.md` and HTTP 403 for `Budget.md`. No rejected action
  was sent before approval. Test windows were closed and the original vault
  window restored afterward.
- Reopening correctly lists saved rules, but its new-rule fields start with a
  reviewer draft. Edit rule loads the actual saved overrides. Clarify this initial
  field behavior before release so it cannot be mistaken for saved access.

Native interrupted-response recovery acceptance, non-owner administrator entry,
the alternate share-management entry point, mobile/popout/screen-reader/touch
coverage and resource measurements remain. No live-vault plugin installation or
production deployment/restart is part of this checkpoint. The broader comments,
reattachment, target coverage, recovery/backup and release work remains in the
[project status](../../../docs/Plans/obsidian-presence-comments-status.md).
