# Discussion search preview

Open **Search and filter comments** in the comments sidebar. Search the current
note/saved Bases view or the connected shared folder; filter open/resolved state,
matching comments written by you, or matching comments mentioning you. Leave the
text empty to use the other filters alone. Search matches all words in current
comments and opens the matching message through the authorized discussion-link
path. The normal composer and its drafts remain available.

Search requires a connection and the server's `discussion_search` capability.
It does not persist results or search terms. The panel sends only on submission,
coalesces replacement requests, rechecks visible results every 15 seconds and
stops polling when hidden or disposed. Known access loss clears excerpts
immediately. Plain-text rendering and strict scope/identity validation precede
navigation. Empty bounded-scan pages can offer **Continue searching**.

See the [server contract and validation evidence](../../evc-team-relay/docs/discussion-search-preview.md)
for migration `202611070002`, enablement, authorization, pagination, index tradeoffs
and limits. Loaded discussion target filters are documented separately in the
[target-status preview](comment-target-status-preview.md). Share-wide target
discovery and the remaining native/mobile/accessibility acceptance are unfinished.
No live-vault installation or deployment occurred.

## Native desktop verification, November 7

Obsidian 1.13.7 with plugin `587101b` and disposable actual services verifies:

- Searching `Aurora` finds three synthetic current comments.
- Mentions me finds only the reviewer comment mentioning the signed-in owner.
- Written by me finds the two owner comments.
- Written by me plus Resolved finds only the owner's resolved discussion.
- Open matching comment focuses that exact message and shows Send and reopen.

The fixture contains an open reviewer mention, an open owner discussion and a
resolved owner discussion. These checks cover current-note search; shared-folder
and Bases scopes, native revocation/refresh/pagination, keyboard/touch/mobile and
resource acceptance remain. The services are stopped and the original window
restored. Local evidence is
`/private/tmp/comment-inbox-search-native-evidence.json`.
