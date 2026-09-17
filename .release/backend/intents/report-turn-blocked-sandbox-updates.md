A sandbox image update that keeps being deferred around a live turn is now
reported instead of being described as a rebuild in progress. The reconciler
still never recreates a sandbox out from under a running turn; after roughly
thirty minutes of consecutive confirmed deferrals the project is reported as
turn-blocked, so the operator learns that the wait will end only when they
cancel the turn.

Security classification is also read from the image being offered rather than
from the one already running, which previously inverted the question: a sandbox
that had received a security fix kept flagging one, while the release actually
carrying a fix reported as ordinary.

The new `turnBlocked` flag on the sandbox update status is additive and defaults
to false, and the existing `selfRepair: 'stalled'` verdict is still raised
alongside it, so clients from before this release keep parsing the status and
keep showing the attention glyph they already have.
