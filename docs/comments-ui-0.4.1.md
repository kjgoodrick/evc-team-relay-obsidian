# Comments UI 0.4.1

- Removed the live discussion-count paragraph and healthy target-location messages. Location problems remain visible; diagnostic filters are behind the filter icon.
- Inbox/search/filter use icons; export, removed-comment review, local recovery, and manual refresh are in the ellipsis menu. Comments still update automatically.
- Thread and message actions, formatting, send/discard use labeled icons. Replies use a directional chevron beside Replies.
- Reaction picker exposes supported reactions; only already-used reactions appear as counted chips.
- Pictures use existing paste support; @ opens a participant menu in plain and rich editors. Persistent picture and member selectors are hidden.
- Profile names/photos come from the enabled identity provider through the existing permission-scoped participant directory. No profile means the existing identifier plus initials fallback. Minute-resolution timestamps.
- Follow controls explain that unfollow still permits mentions, while mute suppresses all discussion notifications.
- Hover and keyboard focus styles cover comments and the updater; repository AGENTS.md now requires them.

## Evidence

Native Obsidian 1.13.7, disposable vault `/private/tmp/relay-comments-ui-20261110`: compact pane, ellipsis actions, reaction menu and counted thumbs-up chip, reply chevron, @ picker inserting Bob, formatting preserving the mention, successful reply send, no count paragraph or routine anchor status. Screenshot reviewed at a narrow sidebar width.

Automated: 41 comments/editor tests, 115 final affected tests including pictures, inbox, discard and recovery; 83 server discussion tests. Broad client run: 316 suites passed; the four failures were incomplete icon mocks/text-only selectors and Node missing from subprocess PATH, all covered by the successful affected rerun. 27 fixture-dependent suites skipped. TypeScript and production build passed (15 existing Svelte warnings).

Server: 6334fb8ccd2c1e9f4a777746eaa5fd74a87930d7, healthy API, no database migration. Native mobile verification is not claimed.
