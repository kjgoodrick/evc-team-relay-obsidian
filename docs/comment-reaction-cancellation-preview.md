# Independent saved reaction cancellation

Pending reaction cards and the saved-work browser now offer **Cancel saved
reaction**. A separate review shows whether the saved action would add or remove
which reaction, explains delivery uncertainty, and requires acknowledgement plus
**Confirm cancellation**. Opening the review never sends or cancels anything.

The account-local transaction compares the complete immutable request identity
and refuses to abandon active dependent work. If the reaction is still queued,
has never been attempted and has no lease, it can be retired offline before a
worker claims it. Attempted/rejected/retrying work requires the existing exact
server withdrawal endpoint, current comment permission and recovery support.

A server withdrawal receipt fences every delayed send of that operation. A lost
response leaves the local request intact for exact retry. If an accepted receipt
wins, the client records acceptance and leaves the posted reaction unchanged.
Cancellation never sends an opposite reaction, changes an upstream comment, or
creates a replacement operation. Context checks roll back local cancellation on
account/view loss; late accepted/error callbacks cannot resurrect a retired local
operation. Original request metadata stays in the terminal local record.

The cancellation action is also available from the local browser when a note is
not readable. Never-attempted work can still be cancelled there; checking an
uncertain send requires restored server access. Cancellation with active
unreviewed dependents is deliberately refused, preserving both changes for
review. Other queued command types keep their existing body/dependency workflow.

## Verification

Transaction/UI tests cover offline retirement, claim fencing, accepted receipts,
attempted/retrying work, changed request identity, dependent protection, context
rollback, explicit confirmation, failures, account loss and pending-card wiring.
Session tests cover uncertain outcomes, lost responses, closing during withdrawal
and the absence of replacement/opposite sends.

Five actual-service integration scenarios pass. The new scenario loses the
withdrawal response, verifies that a delayed reaction send receives
`operation_withdrawn`, retries the exact cancellation, reconciles an already
accepted reaction, and cancels an offline removal while preserving the posted
reaction. The existing control-plane withdrawal service needed no source change.

The complete plugin suite passes **3,085 tests / 245 suites**, with 22 opt-in
tests / 17 suites skipped. Build/main types and the frozen test-type gate pass.
Changed-source lint has no errors and two existing host sentence-case warnings;
the preview build retains fifteen existing Svelte warnings.

Native desktop/mobile cancellation acceptance remains. No live vault installation,
production permission change, service restart or Pi deployment was performed.
