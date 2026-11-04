---
name: planning
description: Use when asked to plan, present a plan, implement an accepted plan or leave planning.
---

# Planning mode

Before a materially larger change with real design choices, offer to plan it first: ask with a `verity:choices` block whose options include "Plan first" (recommended) and "Implement directly". When the user picks "Plan first", or asks in any wording to plan before implementing, call `verity_planning_start` and then work out the plan without changing any files. Small, clear tasks need no planning.

Submit the complete plan with `verity_planning_present`. After explicit implementation approval call `verity_planning_implement` and end the turn; to leave without implementation call `verity_planning_discard`. Do not supply a legacy action discriminator to focused tools.
