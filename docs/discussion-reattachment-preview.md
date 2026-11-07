# Moving discussion targets

The sidebar now offers **Move target** when the server enables reattachment.
The move keeps the discussion's replies, reactions, history and resolved state.
It uses the existing capture controls for note text/blocks, embedded/direct
images, saved Bases targets and Time & Line targets. The server enforces the
same entry/view and read-dependency boundary; moving a record discussion to a
whole view cannot expose it to more readers.

This is an implemented preview, with native desktop text and conflict-recovery
evidence. It does not complete the broader collaboration release acceptance.
See the [server contract](../../evc-team-relay/docs/discussion-reattachment-preview.md)
for flags, authorization, history and compatibility.

## User flow

1. Open **Move target** on the existing discussion. A current authorized read
   verifies the thread and shows its previous target.
2. Choose **Choose new target**, then use the ordinary comment action on text,
   blocks, an image or a supported Bases/timeline target. A sidebar banner and a
   command allow cancelling this selection mode. Choosing another note/view is
   rejected; existing comment drafts are preserved.
3. Review previous and new targets, then choose **Move discussion**. Capturing a
   target does not send a move. **Use entire note** or **Use entire saved view**
   likewise creates a proposal for review; access rules may reject the latter.
4. Once a discussion has moved, **Target history** shows actor, time, target and
   current revision, with bounded pages and navigation to saved positions.

Moves are online only. A reviewer with comment permission can move a discussion
without note edit permission. New move controls disappear when the capability
is absent; a retained unconfirmed request can still be reviewed and recovered.
History is online only and stays out of the persistent remote cache. Its active
page refreshes every 15 seconds while visible and stops on hide/closure/offline
or read loss. Current-thread changes also invalidate the page.

## Interrupted moves and lifecycle

Before sending, the client stores one exact request in the account-isolated
local store. Compare-and-swap prevents a second window from replacing an
unconfirmed move. **Retry move** sends the saved request; it never substitutes
the current selection. **Check outcome and cancel retry** either discovers an
already accepted move or permanently cancels that request on the server. This
does not undo an accepted move. A new selection requires resolving the old
request first. Nothing automatically sends on reload or reconnect.

Preparation, reads and dispatch are fenced by account/session/permission and
modal context. Closing while preparing does not dispatch afterward; if local
intent was already saved, reopening exposes its recovery controls. Credential
refresh is followed by another context check. Removed/inaccessible discussions
close the modal rather than retaining historical labels after a 403/404.
Target moves update cached anchors through the existing activity-sequence sync
path without overwriting cached replies or changing state revision.

## Verification

Automated tests cover exact durable retry, concurrent-window preparation,
receipt cancellation, scope/revision validation, authorization changes during
credential refresh, history bounds/redaction, host selection mode, unchanged
drafts, cache refresh and native-modal lifecycle. The actual Python/Rust test
also loses a successful move response and recovers its accepted receipt.

A fresh `/private/tmp/evc-reattach-native-20261107` vault ran the preview in
Obsidian 1.13.7 on macOS against a disposable loopback Python/Rust stack:

- Created a beta selection discussion, added a reply and resolved it.
- Chose gamma through the native editor comment command, reviewed both targets
  and saved. The marker moved; both messages and resolved state were preserved.
- Viewed target history with original and new positions and owner attribution.
- Prepared a whole-note move at revision 2. A synthetic reviewer moved the
  discussion to beta at revision 3. The stale native Save failed with explicit
  retry/recovery controls. Cancellation reloaded beta, then a fresh reviewed
  whole-note move succeeded at revision 4.
- Native history showed all four revisions and correct owner/Bob attribution.
  Independent server readback confirmed two messages, resolved state and state
  revision 2. The fixture was stopped and the original vault window restored.

Native testing found that Obsidian Modal.open writes its own undocumented
`selection` field. Renaming the preview's field to `selectedTarget` fixed the
dialog; an automated regression now reproduces that host behavior. A subsequent
small fix preserves focused buttons during unchanged background notifications
and clarifies the cancellation status; its focused checks and build pass.

The final general plugin suite passes **2,980 cases in 234 suites**; 20 opt-in
cases in 17 suites are skipped. The final focused run passes 41 cases. Preview
build/main types, Svelte types, changed-source lint and the frozen test-type gate
pass. Existing 15 build warnings, two changed-source lint warnings and 206 known
test-type errors across 45 signatures remain; the baseline was not relaxed.

Native image/Reading/block/Bases/Time & Line moves, interrupted-response reload,
two-native-window operation, mobile/touch, full accessibility and resource
acceptance remain. Deleted/generation-replaced Bases dependencies still require
the wider recovery workflow. No plugin was installed in the live vault and no
production deployment or restart was performed.
