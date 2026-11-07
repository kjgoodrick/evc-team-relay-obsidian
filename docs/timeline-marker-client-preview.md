# Shared timeline marker client preview

The client now understands `timeline_marker` discussion anchors and verified
saved-view marker catalogs. This is a development foundation, not a complete
native milestone interface. Keep the server's marker creation flag disabled
outside disposable tests until the remaining interface and renderer work lands.

## Available behavior

- Strict decoding retains the marker UUID/revision, captured label/color and
  exact point/range coordinates together with the saved view and axis identity.
  Points require one closed coordinate; labels never become identities.
- `DiscussionTransport.timelineMarkers` loads bounded, revision-pinned catalog
  pages, including archived placements for historical status. Mixed revisions,
  duplicate IDs, mismatched placements and forged redundant targets are refused.
- `DiscussionSession.readTimelineMarkers` stores verified metadata in the
  existing account/server/vault/share cache, under the saved-view scope. Only
  retryable connection failures may use the last verified catalog. Denials,
  invalid responses and generation changes invalidate that proof. Store tickets
  prevent late responses from overwriting another verification or cache reset.
- `captureTimelineMarker` compares the selected revision with the verified
  catalog and current saved view/axis, with comment permission checked again after
  asynchronous work. Capture copies the selection before awaiting. An edited,
  archived, detached or rebound marker requires reselection.
- Captured anchors use the existing durable draft/outbox path. Offline restart,
  queueing, exact retries and historical reads/replies preserve the original
  target. Existing comments do not follow a marker to its new position.
- Composer/draft/thread labels identify marker targets. Thread status distinguishes
  changed or archived markers from the captured revision. Inline marker navigation
  is still unavailable; no marker is treated as a record or ordinary range target.
- Cache version 19 preserves all stores and fences older workers that cannot
  decode marker targets. Revocation clears cached marker metadata while retaining
  unsent local work for recovery.

Marker creation requires both the target kind and feature flag in capabilities.
Existing anchors remain decodable when creation is disabled. An inactive
placement may retain an old axis incompatible with the marker's latest content;
its metadata remains readable but cannot become a new comment target.

## Verification

Focused tests exercise malformed/cross-scope catalogs, pagination and revision
changes, point precision, offline reopen, account isolation, archive/detach/edit
and axis changes, authoritative denial, read-only access and late-response fencing.

The control-plane `tests/integration/base_content_client.py` fixture now runs
`realTimelineMarkerStack.test.ts` against disposable loopback HTTP and SQLite.
It uses the actual transport/session/store/delivery/outbox, synthetic owner and
commenter accounts, and both Timeline/calendar and Sequence/exact-decimal targets.
It verifies offline capture after reopening, draft consumption, a lost accepted
response, another cache reopen, metadata edit/archive before exact retry,
historical replies and stale new-capture rejection. The `.base` state is unchanged
by marker metadata and comments. This is not native Obsidian or server-restart
acceptance; the separate server PostgreSQL tests cover transaction serialization.

## Remaining work

Native marker selection and rendering, current-versus-captured navigation,
metadata refresh/change delivery, online management receipts/UI, local marker
promotion and explicit matching remain. The Time & Line fork has not changed in
this increment. Native desktop/mobile, accessibility, recovery UI and resource
acceptance remain before enabling this feature for users.
