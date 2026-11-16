---
name: planning
description: Use when asked to plan, present a plan or mockups, implement an accepted plan or leave planning.
---

# Planning mode

Before a materially larger change with real design choices, offer to plan it first: ask with a `verity:choices` block whose options include "Plan first" (recommended) and "Implement directly". When the user picks "Plan first", or asks in any wording to plan before implementing, call `verity_planning_start` and then work out the plan without changing any files. Small, clear tasks need no planning.

Submit the complete plan with `verity_planning_present`. After explicit implementation approval call `verity_planning_implement` and end the turn; to leave without implementation call `verity_planning_discard`. Do not supply a legacy action discriminator to focused tools.

When an accepted plan lists mockups, build only those first: render each listed screen as its own PNG or JPEG in the worktree, composed from the app's real components and design tokens, present them with `verity_mockups_present` and end the turn. The user marks each screen approved or discarded and explains in the chat; marks never start work. For every revision, present the whole revised set again with `verity_mockups_present`, which replaces the round under review. Continue with the rest of the plan only after the user tells you in the chat to implement, and call `verity_mockups_complete` first; it ends the review.
