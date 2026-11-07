# Saved comment work browser preview

The offline Comment Storage panel now includes **Browse saved work**. It lists
this account's saved drafts and waiting changes for the selected connected shared
folder, including work whose original note or saved view cannot be opened.

Drafts can be opened, edited and copied locally. Ordinary draft discard retains
its explicit review/confirmation and ownership checks. Saved targets and edit
base revisions remain attached. Sending, changing targets, picking new members,
adding pictures and checking delivery stay in the original discussion workflow.
Unconfirmed online sends are read-only, and recovered drafts retain their separate
dependent-work discard requirements. Queued commands are inspectable/copyable but
cannot be replayed or mutated from this browser.

Pages contain ten items, with a maximum API page size of twenty. Draft reads use
a primary-key range; waiting changes use the existing state index, seek past the
last primary key, and skip accepted/withdrawn history. Listing does not clone
picture blobs. Pages reflect current state, so refresh restarts after concurrent
changes rather than claiming a historical snapshot. No schema migration is needed.

The editor checks that the saved draft still exists, retains its target and uses
revision comparisons for saves. Context checks before and after the save
transaction prevent account changes from committing stale edits. Existing
cross-window discard invalidations still protect open editors. Back navigation
flushes saves and retains an editor with failed saves so its text can be copied.
Closing/account loss removes listeners, displayed pictures and modal contents.

A strict local picture mode reads only retained original bytes. Missing originals
do not fall back to downloaded cache or HTTP, even if shared access is available.
The usual discussion picture loader remains unchanged outside this mode. Rich
mention IDs remain stable; this browser does not look up shared member names.
Delivery recovery also now announces completion after the editor's controls have
settled; an already-sent targeted reply remains paused during navigation.

## Verification

- 73 focused checks across seven suites: local editing with inaccessible targets,
  uncertain sends, vanished drafts, local discard, account invalidation, rich and
  plain original-only pictures, queued-command read-only behavior, pagination
  through active states, deleted boundaries and context rollback.
- Complete plugin suite: **3,072 tests / 244 suites pass**; 21 opt-in tests / 17
  suites skipped. Build/main types and the frozen test-type gate pass. Changed
  source lint has zero errors and one existing URL-placeholder sentence-case
  warning. The build retains fifteen existing Svelte warnings.
- Native Obsidian 1.13.7, disposable `evc-recovery-native-20261107`, stopped service,
  no active note: command → storage → browser showed the retained draft. Editing,
  returning to the list and reopening preserved the changed text. Restoring its
  original text also persisted; waiting changes remained empty. Send, member
  picker, attachment upload and delivery-retry controls were absent. The original
  user window was restored afterward, without edits to the live vault.
- Native build SHA-256:
  `3087080ef3858ecc5dc69a21b8e568e362574f6db57b2c966e4f898f309e94ee`.

Native pagination, picture-only recovery, uncertain-send and discard flows,
physical mobile/touch, popouts and broader accessibility acceptance remain.
Removing the entire shared-folder connection still removes its session from the
storage chooser; historical disconnected-store recovery needs a separate design.
Reviewed import, recovery to a different target, standalone reaction cleanup and
coherent shared-discussion/service backup/restore also remain. This preview is
not the complete collaboration feature's testing-ready release.
