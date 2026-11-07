# Comment inbox: native desktop evidence

November 7, 2026, Obsidian 1.13.7 on macOS. This is partial release acceptance,
using synthetic owner/reviewer accounts and a disposable vault backed by actual
FastAPI and Rust relay processes. No live vault or deployed service was changed.

## Verified behavior

- A reviewer mention appears once and opens its authorized discussion.
- Mark read removes the entry from Unread; All retains it. Opening a notification
  does not implicitly mark it read.
- With only the temporary HTTP process paused, Mark unread updates the local
  card and displays “Change saved; waiting for server confirmation.” Resuming
  that process with the same database clears the pending state. Independent API
  readback confirms the requested unread state.
- Follow persists. Mute moves the entry to Muted and suppresses a new reviewer
  reply notification. Unmute resumes delivery; a subsequent reply updates the
  same thread row rather than adding a duplicate.
- Dismiss hides the observed activity. Dismissed offers Restore unread, which
  restores the row to Unread. A later reply after another dismissal reappears
  unread with its new timestamp and message identity.
- After reloading the fixed build, the inbox opens the exact notified reply,
  with Previous replies for context. The focused accessibility element and
  screenshot both identify the intended message. The same cached navigation
  passes after the temporary services stop; online-only moderation/history
  controls stay disabled.

The reply-navigation check found and fixed a real defect: the inbox previously
opened the thread beginning, leaving the notified reply outside the visible
sidebar. It now uses the authorized exact-message read and its message sequence
to select the reply window. Unavailable messages explain the thread fallback.
Later discussion navigation cancels delayed inbox reads and target reveals.
The one-notification count also uses the singular label.

## Validation and limits

Four regression cases cover exact-message selection, unavailable-message
fallback, superseded reads and superseded sidebar opening. The first two failed
before the change. The focused host/inbox set passes 103 tests; the full plugin
suite passes 3,114 tests in 246 suites, with 22 opt-in tests in 17 suites skipped.
Build/main types and the frozen test-type gate pass. Changed-source lint has no
errors and two existing host wording warnings.

The initial native build was plugin `587101b`, SHA-256
`cfffa1712223f3263d1fd960be3daaf3b074ea442bf5057f5ddfc9fae4dcb3de`.
The navigation-fix build was
`84865f861f057c1414750c6bd5b65f314f532d2b55c75a18b867fc5be92f2968`.
Local run evidence is `/private/tmp/comment-inbox-search-native-evidence.json`;
logs use `/private/tmp/inbox-message-focus-*.log`. The test services are stopped
and the original Obsidian window is restored.

This run also exposed timezone-less SQLite discussion timestamps, while inbox
timestamps already included UTC. The server correction has API regression
evidence; the already-running native fixture retained its old server module, so
this run does not establish native rendering after that server correction.

Mobile/touch, popout, broader keyboard/accessibility, native pagination,
multi-share/revocation/conflicting-device cases and resource measurements remain.
See the [server contract](../../evc-team-relay/docs/discussion-inbox.md) for
authorization, aggregation, queue and pagination semantics.
