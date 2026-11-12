# Moving discussion targets and stable comment rendering — 0.4.5

Click **Move target**, select text, then click **Move here** beside the selection. The normal workflow opens no modal and requires no Enter shortcut; clicking away does not commit a move. Cancel is available beside the selection and in the sidebar. Whole-note and whole-saved-view targets remain available. Blocks, images and Bases continue to use their target-specific comment actions while moving. An uncertain previous request still opens recovery so retrying cannot silently create a different operation.

Draft autosave remains durable and silent on success. Save errors remain visible. The ordinary saving/saved prose, including picture-save success prose, is removed.

Editor comment widgets survive the short gap between editor and synchronized-text updates, using mapped positions until the matching text arrives. Invalid bindings and lost permissions still clear markers. Unrelated thread activity no longer recreates marker widgets. Reading-view overlays reuse their SVG and rectangles when geometry is unchanged, and target-selection instructions/buttons rebuild only when their mode or scope changes.

## Validation

Native Obsidian 1.15.0 with a disposable local server and vault: moved an existing discussion by selecting text and clicking Move here in editing and reading views; both completed without an introductory modal. Typed into the note and confirmed the existing marker remained mounted. Typed into a new discussion and confirmed no saving/saved status appeared.

Automated regressions cover direct target submission, pending-request recovery, retained selection-toolbar nodes, marker survival through the editor/sync timing gap, unchanged reading-overlay nodes, and durable text/picture draft writes. TypeScript and production build pass; the build retains 15 pre-existing Svelte warnings. Full-suite counts and release asset verification are recorded in the services release log. Native mobile has not been tested.

Client-only release; no server deployment or restart is required.
