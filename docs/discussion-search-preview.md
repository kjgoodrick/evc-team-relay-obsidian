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
and limits. The unanchored-target filter and native desktop/mobile/accessibility
acceptance remain unfinished. No live-vault installation or deployment occurred.
