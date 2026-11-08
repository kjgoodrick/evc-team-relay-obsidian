# Comment history preview

The comment **History** action now opens the current revision beside its
predecessor. Previous/next controls, a revision-number input and **Latest
revision** navigate without downloading the entire history. The first revision
is labeled as the original. Each full revision includes its author and timestamp.
Removed comments retain their ordinary tombstone but no History action.

The text comparison preserves whitespace, treats HTML as text, and labels
insertions/removals with both semantic markup and non-color styling. Both full
structured revisions remain visible for formatting, links, mentions, lists,
code and pictures. A text comparison is not a picture-content or formatting
diff. Large/divergent comparisons fall back to the two full revisions: the
inline comparison accepts at most 24,000 UTF-16 units in total and uses the
existing diff library's 20 ms / 500-edit bounds.

## Reads and authorization

History requires a connection and current read access. Opening a window first
reads the current message through the existing authorized, saved-view-aware
path, then requests at most two adjacent immutable revisions. The ordinary
history endpoint rejects removed messages for everyone, including authors and
moderators. The client does not grant history access from a cached excerpt or
revision number.

The session fences delayed results against authentication changes, document and
cache generations, known thread removal, known message deletion and newer
cached revisions. The view clears its bodies on known access loss, logout,
backgrounding, closure and read failure. Cached message/thread checks catch
known removal while the window is open, including the author's own comments and
moderator sessions. Deletion disposes picture views and decoded URLs. Revision bodies stay in the open view;
picture data uses the existing authorized picture loader/cache.

A successful response from an older sync or initialization request can no
longer undo a newer authentication failure. That failure stops discussion
workers and blocks the inbox; only a subsequent successful capability check
can resume the session. Failed/offline recovery retains the sign-in-required
state. History, links and search started before that failure remain invalid
even after successful reauthentication.

## Lifecycle and resources

The view keeps only the selected revision and predecessor. Navigation coalesces
behind one active request. Refresh runs every 15 seconds while the document is
visible and retains an explicitly selected old revision; **Latest revision**
follows subsequent edits. Unchanged results keep their DOM and focus. A changed
result preserves an active revision input and does not move focus from outside
the history. Navigation disposes prior picture views and blob URLs.

The November 7 deletion-access correction also closes the corresponding service
history, thread and picture-read exceptions. It changes no message schema or
draft format. Separately authorized, audited moderation recovery and retention
remain unfinished. The subsequent
[rich editor preview](rich-comment-editor-preview.md) adds structured authoring
and editing; its native acceptance remains separate.

## Verification

Automated coverage includes revision navigation, bounded comparison, safe rich
rendering, whitespace changes, author/removal metadata, picture disposal,
focus, coalesced requests, backgrounding, account/access changes and delayed
responses. Session tests deterministically exercise simultaneous late sync and
initialization responses after authentication loss, failed recovery and a
later successful reauthentication.

The actual Python service/TypeScript client fixture verifies selected revision
windows, rich body preservation, author access after deletion and denied reader
history, alongside existing outbox retry/reaction/moderation behavior. Final
regression/build/typecheck counts are recorded in the
[project status](../../../docs/Plans/obsidian-presence-comments-status.md).
The final full plugin run passes 2,901 tests in 225 suites; 19 opt-in tests in
17 suites are skipped. Both real-service scenarios pass separately. Preview
build/main types, changed-file lint and the frozen test-type gate pass, with the
existing 15 Svelte warnings, test lint warnings and 206 known test-type errors
across 45 signatures.

Native desktop Obsidian 1.13.7 with plugin `076ffe3` now verifies adjacent
revision comparison (Removed “Native” / Added “Updated”), complete bold/link
rendering, Previous revision to the original, and Latest revision back to the
edited message. Independent temporary-service readback confirms both immutable
rich bodies. No code change was needed for this native increment. The Mac is
available; broader desktop cases, mobile/popout, touch, screen-reader and resource
acceptance remain required.
No live-vault installation or production deployment occurred.

## Removed-content boundary (November 7)

Ordinary History is now limited to live messages in live threads for every
role. The sidebar omits History on a tombstone. The session refuses a deleted
message before requesting revisions and discards late revisions after a known
deletion, including for the author or a moderator. Open history panels clear
their contents and release picture listeners/blob URLs on deletion. The removal
dialog describes this behavior without promising unaudited recovery access.

Validation: 97 focused session/history/sidebar tests and 3,383 plugin tests in
254 suites pass (29 tests in 20 opt-in suites skipped). Production build/main
types pass with 15 existing warnings; test types remain 206 errors across 45
signatures against the frozen 207/46 baseline, without new signatures. Changed
source lint passes. Actual HTTP tests verify rich live history followed by
author/moderator denial and visible tombstones. Actual HTTP/MinIO tests verify
picture metadata, content and thumbnails are denied after deletion to both the
author and moderator. Disposable services/containers were stopped and removed.
Native deletion while a history window is open, mobile and restricted recovery
acceptance remain; this does not claim those checks are complete.
