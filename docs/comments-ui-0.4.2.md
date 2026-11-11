# Comments UI 0.4.2

- Use Obsidian’s tooltip only; remove duplicate HTML title tooltips from comment icons.
- Put Replies below the first comment, keep the main ellipsis last, and move saved-draft recovery into that menu.
- Remove routine “up to date,” syncing, and empty-discussion messages so background updates do not change the pane height. Connection and access problems remain visible.
- Remove the persistent link-copy success message.
- Match reply/new-discussion editor styling, put discard at the left and send at the right, distinguish the formatting icon from reveal-text, and make disabled undo/redo visibly dimmer.
- Hide the entire-note draft selector when there are no alternative saved targets. This is a whole-note discussion, not an extra step users need to complete.
- Compare rich drafts canonically when reviewing discard. Storage orders object keys; key order is not a competing edit. Revision checks and final atomic snapshot checks still protect genuine concurrent changes.
- Add searchable Unicode emoji selection with 3,781 choices, skin tones and sequences. The search field accepts emoji from the operating system keyboard. Obsidian’s installed public API has no native emoji-picker entry point. Render 80 choices initially and expand on demand.

## Protocol and compatibility

The catalog is generated from [Unicode Emoji 16.0 emoji-test.txt](https://unicode.org/Public/emoji/16.0/emoji-test.txt), fully-qualified entries only, preserving the original eight wire keys. Unicode license is bundled into main.js and included beside server data. Both sides validate exact catalog membership. Each message supports up to 64 distinct reaction choices; adding more fails without modifying existing reactions.

Server discovery advertises `reaction_catalog: unicode-16.0`; the client retains that capability for offline use. New clients send `X-Relay-Reaction-Catalog: unicode-16.0`. Older clients keep reading messages with their original eight reaction types. Export containing newer reactions requires an updated client rather than silently producing an incomplete export. Server backup validation accepts the complete catalog. No database migration.

## Verification

Native Obsidian 1.15.0, disposable vault `/private/tmp/relay-comments-ui-20261110`: full picker, emoji input and saved fox reaction, replies beneath the comment, compact toolbar with ellipsis last, absent routine status/empty text, matching composer boxes, send at right, formatting transition and discard review without a false conflict.

Automated verification includes formatted draft discard, real concurrent draft protection, picker search/system-emoji input, bounded message reaction parsing, server catalog validation, old/new client read negotiation, and export refusing incomplete legacy results. Native mobile testing is not claimed.

Results: broad client run passed 318 suites/4,783 tests; its two failures (outdated recovery-button selector and forbidden CSS importance override) were corrected. Final affected reruns passed 109 tests and 122 tests, including both corrections. Server discussions/export/archive validation: 178 passed. TypeScript and production build passed (15 existing Svelte warnings). Final native reload also verified recovery in the main ellipsis, compact format action, restored rich reply, clearly dimmed undo/redo, left discard and right send.
