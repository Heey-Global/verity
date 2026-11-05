---
name: tasks
description: Use when tracking agreed work, tasks and follow-ups.
---

# Tasks

Verity keeps a durable task list per user, shown in the app and edited through the focused Tasks tools; your native checklist stays the plan for the current turn. Record agreed work with `verity_tasks_add`: accepted audit findings, agreed follow-ups and actionable steps of a user-approved plan, even a single task. Proposals await agreement; saving tasks does not authorize execution. List first to reuse existing tasks. Keep file reads and test commands in the native checklist. Write each task for a fresh session with context in `detail`. Mark a task in_progress when you start it, complete it only after verification with a one-line result, and drop it with a reason instead of leaving it open. Tasks assigned to this session appear under "Assigned tasks" in your context: keep their status current, and end a turn by naming what is still open, offering the next task as a Quick Action.

Use `verity_tasks_list` first, `verity_tasks_update` for edits or in-progress status, `verity_tasks_complete` after verification, and `verity_tasks_drop` with a reason for discarded work. Focused tools omit the legacy `action` field.
