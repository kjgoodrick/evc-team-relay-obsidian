# Reading presence preview

Authorized, already bound Reading panes now show remote selections and editor
carets through the same relative Yjs positions as Source/Live Preview. A reader's
selection also appears in editing views with a **Reading** identity label; it
does not become an editing caret. Reading capture preserves backward selections.

Every visible Reading pane in the focused window can render its bound note's
peers. Only the existing foreground controller publishes local presence. Hiding
your presence does not prevent you from seeing authorized collaborators. These
display observers do not open a connection, fetch a note, change selection,
modify Markdown or require comment/edit permission.

## Identity, mapping and navigation

`presencePeers` validates the gateway-stamped user/session fields and position
shape. Identity determines colors; labels use text nodes. Reading observations
remain tied to the exact tracked view, authorized account, file, provider and
CRDT binding. Disconnect, revoke, logout, window backgrounding and binding removal
clear visible state. An inactive pane can resume display on its existing
provider's reconnect without becoming a local publisher.

Rendered mappings verify section source, full view source and current DOM text.
Repeated words are matched through source order/positions, not quote search.
Source updates clear old geometry immediately; it returns after the renderer
matches the current text. Invisible markup, partially selected entities and
split surrogate pairs do not acquire invented visible carets or highlights.
Unmapped content retains roster/navigation context without fabricated precision.

Jump and Follow use the exact rendered text rectangle when available, including
the last caret in a note and nested horizontal code/table scrollers inside a
vertical pane. Scroll deltas account for axis-aligned scaling. Navigation keeps
the receiver's native selection and view mode. Existing source-line materialization
handles distant sections; the verified section fallback remains for syntax that
has no exact visible text boundary. Changed text, canceled navigation and unload
still fence delayed materialization.

## Rendering and resource bounds

Modern hosts use the native CSS Highlight registry for selected text, with
unique per-pane/per-peer names that do not interfere with comment highlights.
Other hosts use clipped overlay rectangles. Both have display-only identity
labels; editor carets are projected only at exact visible boundaries.

- Reuse each shared text's source parse and each section's verified mapping.
  Close/change drops unused source snapshots; no source or asset fetches run
  during scrolling.
- Coalesce remote updates to approximately 10 Hz and layout work with animation
  frames. Reuse unchanged peers' mapped ranges. Viewport keys change when a
  large table/list exposes different leaves, while ordinary paragraph scrolling
  can reuse its ranges.
- Skip offscreen leaves before constructing selection ranges. Limit each peer
  to at most 64 native ranges, distributed within a 512-range budget per pane.
  Existing peer decoding caps rooms at 128 rendered peers.
- Fallback drawing has a 256-rectangle budget and a 4,096-rectangle scan budget
  per paint. Identity labels/carets remain separate from that paint budget.
  Pathological density can omit some selection paint; the roster retains peers.
- Unload releases observers, provider subscriptions, timers, frames, overlay DOM,
  per-pane styles and owned native highlights. Rendering never publishes state.

## Validation and outstanding acceptance

Tests use actual Yjs awareness/relative positions, source-to-DOM mapping and
CodeMirror rendering with host/layout fixtures. They cover repeated selections,
backward ranges, invisible syntax, Unicode/entity boundaries, split-pane observer
ownership, one publisher, privacy, stale renders, reconnect/revoke/leave, native
highlight isolation, fallback clipping, range budgets and precise nested scrolling.
These are automated browser-DOM fixtures, not native Obsidian acceptance.

Native two-client desktop, mobile, popout, screen-reader, touch, long-note and
resource/battery measurements remain. Unsupported third-party Markdown rendering,
folded content and dense overlapping labels still need the full release matrix.
Image/Bases/timeline presence, wider reconnect/backpressure work and the optional
full-note pointer feature remain separate unfinished work. The server and presence
wire protocol are unchanged by this client increment.
