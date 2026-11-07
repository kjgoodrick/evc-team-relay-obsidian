# Local comment storage controls

**Storage on this device** in the Comments sidebar, or the **Open comment
storage** command, shows saved drafts, waiting/review work, original-picture
storage and downloaded-picture usage for the current account, vault and shared
folder. The panel works offline.

Downloaded pictures have a configurable LRU budget. The interface offers 0, 25,
50, 100, 250 and 500 MiB. Zero disables persistent downloaded-picture caching;
online pictures can still display, and saved original pictures remain available
offline. Lowering the budget immediately removes the oldest downloads until it
fits. **Clear downloaded pictures** removes all downloaded renditions for this
local share/account. Visible decoded pictures can remain in memory until their
views close, and opening a picture online can download it again.

Drafts, queued/rejected/review commands and their original picture sources are
separate stores with independent ownership. Cache changes never remove them.
The existing 100 MiB saved-original quota remains separate from this adjustable
download budget. Usage reads indexed counts and stored byte totals, without
loading image blobs merely to show their size.

IndexedDB version 22 closes older workers that ignore cache settings. Upgrades
keep the previous fixed 50 MiB budget; new databases use the plan's 100 MiB
default. A global picture-cache epoch fences downloads begun before cleanup,
including scopes with no earlier cache entries. Writes recheck the current
limit and epoch atomically. Same-account windows share policy; other accounts,
shares and vaults remain isolated. Cache notifications refresh local views
without restarting command delivery. Disabled/undersized caches skip the extra
copy/hash required for cache insertion; the transport still verifies downloads.

Validation includes migration, LRU trimming, disabled caching, late downloads,
cross-window/account behavior, preservation and accounting of saved work,
offline controls, pending UI choices and stale usage reads. The full suite passes
**3,016 tests / 238 suites**, with **21 opt-in tests / 17 suites skipped**. Build
and main types pass; test types stay within the frozen baseline. Changed-source
lint has zero errors and two existing host sentence-case warnings.

Native macOS Obsidian 1.13.7 opened the upgraded disposable vault with its service
stopped. The panel preserved 50 MiB, saved 25 MiB offline, retained it after
reopening, then saved cache-off. An unsent offline draft remained intact. The
test vault was closed and the original window restored. That native run and the
full suite preceded a final label-only count wording adjustment, covered by the
focused UI check. The run did not exercise clearing nonempty picture storage;
automated store/loader tests cover that behavior.

The panel now also supports [verified local-work recovery copies](local-comment-recovery-copy-preview.md),
including offline capture, interruption/retry and retained original pictures.
Storage version 23 preserves the settings described above.

Broader discussion-metadata cache policy/cleanup, reviewed import and deliberate
abandonment, coherent service backup/restore, native nonempty picture cleanup,
mobile/touch and resource/battery acceptance remain separate unfinished work.
This panel does not represent a backup or a production rollout.
