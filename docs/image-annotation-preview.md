# Inline image annotation preview

The **Comment on image** control on a verified rendered image opens annotation
mode in its current pane. This applies to mapped image embeds in Live Preview
and Reading view, and to directly opened managed image files. The command and
Source-mode workflow retain the larger placement dialog.

Choose **Whole image**, **Pin**, or **Region**. Click/drag to place a pin or draw a
region; drag the region to move it, and use its four corner handles to resize it.
Arrow keys on the annotation move it by one percent of the intrinsic image;
shift + arrow moves ten percent. Arrow keys on corner handles resize that corner.
The larger preview provides numeric coordinates and retains the selected
geometry and intrinsic dimensions. A dimensions change during that handoff
requires selecting the image again.

**Add comment** hands the confirmed target to the existing local selection-draft
path and opens the comment sidebar. It does not publish a thread or change the
Markdown/image file. Moving a new selection does not move an existing thread's
saved anchor. Editing or reattaching previously posted anchors is separate work.
Cancel/Escape closes annotation mode; Escape during a drag cancels that gesture
first. Unconfirmed pointer gestures are not persisted as drafts.

## Identity and geometry

- Capture starts from the existing verified occurrence/file overlay. It never
  finds a target by filename, URL equality across the document, or DOM ordinal.
  Repeated embeds retain distinct relative source anchors.
- Existing asset/version/access checks remain in force. Permission, document
  generation, source mapping, rendered element, image resource or intrinsic-size
  changes invalidate the surface. Old detached controls cannot save a target.
- Coordinates are normalized against orientation-corrected intrinsic pixels.
  The existing geometry adapter handles object-fit, object-position, axis-aligned
  scale/zoom and ancestor clipping. Letterboxing is not part of the image.
  Drag endpoints stay inside visible image content. Layout/scroll changes during
  a gesture roll it back instead of interpreting coordinates in a new frame.
- Rotated/reflected/perspective rendering remains outside the inline adapter's
  support; the existing command/larger-preview workflow remains available.
- External image contents can change without a detectable URL/dimensions change.
  The surface labels version evidence as unknown; it does not promise immutable
  external bytes or introduce a server fetch/proxy.

## Lifecycle and resource bounds

One placement surface is active per plugin instance. On entry it freezes the
already decoded image into a canvas with a maximum side of 2048 pixels (at most
about 16 MiB of RGBA pixel storage). Animation is frozen for placement only;
there is no frame-specific annotation protocol. External canvas pixels are
displayed but never read back or exported.

Scrolling/layout uses DOM geometry and the cached snapshot; it does not hash,
load, parse source or fetch assets. Repainting is coalesced with animation frames.
Pointer capture, observers, listeners, scheduled frames and canvas pixels are
released on close, access loss, target invalidation and unload. Touch scrolling
outside annotation mode's image/toolbar remains available. Pin/region mode uses
pointer capture and disables touch panning only over its active image surface.
Mobile controls/handles have 44-pixel minimum targets.

## Evidence and outstanding acceptance

Automated checks exercise drawing, movement, resize, keyboard input, crop and
letterbox mapping, cancellation/lost capture, layout changes during dragging,
permission/target invalidation, failed/pending save handling, fallback to the
larger preview, bounded snapshot allocation and cleanup. The capture fixture
uses the actual authoring/controller/anchor code and IndexedDB store to verify
embedded and direct-file targets survive reopen; its host and asset verification
are mocked, so it is not native or end-to-end server evidence.

Native desktop/mobile acceptance remains: toolbar placement in small panes,
physical touch/pinch/scroll, screen readers, popouts and split panes, common
formats/EXIF/animation, crop/zoom themes, high-DPI rendering and resource/battery
measurements. Test Add comment, Cancel, failed local storage, source rerender,
asset replacement and revoke while a gesture or save is in progress. Existing
posted-anchor reattachment, additional transform adapters and attachment repair
are not completed by this increment.
