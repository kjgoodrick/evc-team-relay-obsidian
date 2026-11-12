# Comments and note-loading follow-up — 0.4.4

## Changes

- Reactions open in a button-anchored popover with an arrow, nine Unicode categories, search across all categories, bounded batches, keyboard category navigation, Escape/outside dismissal, and focus return. The picker closes when its owning comment disappears. Category boundaries come from the same Unicode 16.0 emoji-test data as the existing catalog; wire keys and the server protocol are unchanged.
- Successful draft discard clears the editor without success prose. Discussion header actions have 16px separation from the first comment.
- Presence controls survive temporary null active-view/file states during navigation; publishing presence still stops immediately. Leaving a share or closing the view removes the control. Tracking uses a stable icon color while its accessible status remains accurate.
- Editor changes are forwarded to Y.Text only when they belong to the observed document and their starting text matches its current content. Loading already-synchronized text is not another insertion. Genuine edits on a divergent buffer are persisted for merge review, rather than applied using invalid offsets.

## Duplication investigation

The local real-vault Welcome.md was exactly nine identical 203-byte copies (1,827 bytes). The laptop was reported to have the same symptom. A regression reproduces the file-loading failure mode: repeatedly applying an empty-editor-to-existing-note load used to append additional copies to an already populated Y.Text. The guard prevents this, preserves ordinary edits, rejects stale document bindings, and retains divergent edits for review. This establishes a concrete duplication path; no historical client trace was available to prove which event produced each existing copy.

The original and proposed one-copy repair are backed up outside source control in `.backups/team-relay-welcome-20261111/`, with checksums. No general deduplication of notes is performed.

## Verification

Native Obsidian 1.15.0, disposable loopback fixture: anchored arrow/popover, category switching, selecting an animal reaction and its counted chip, silent discard, extra header spacing, and repeated Note/Second navigation. A real editor edit was independently read back through an authenticated Yjs client; the relay contained the edit and one copy of the note. Automated tests cover null-view chrome retention without presence publication, category/search/dismissal behavior, stale bindings, repeated file loads, and divergent-buffer preservation.

TypeScript and production build passed (15 existing Svelte warnings). Focused regression passed 100 tests; final picker/version checks passed 33 tests. Full regression result and release verification are recorded in the services release log. Native mobile was not tested.

No server deployment or restart is required. Clients should update together so an older client cannot continue using the defective file-loading path.
