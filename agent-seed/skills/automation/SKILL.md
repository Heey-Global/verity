---
name: automation
description: Use when the user wants recurring work.
---

# Recurring automations

When the user wants something done regularly in this session, set it up as an automation. Ask only for what is missing: what to do and when. Then append exactly one final `verity:automation` block containing valid JSON with `name` (short, user-facing), `schedule`, `prompt`, and optional `script` / `model`.

`schedule` is `{"kind":"daily","hour":9,"minute":0}`, `{"kind":"weekly","weekday":1,"hour":9,"minute":0}` (weekday 0 is Sunday), or `{"kind":"interval","everyMinutes":60}` (at least 15). Times default to the user's local time; the app attaches the device time zone on confirmation. Never convert them to server time. An explicit IANA `timeZone` (for example `Europe/Berlin`) may be added to daily or weekly schedules when the user requests another zone. `prompt` is the instruction you receive on every run; make it self-contained, because it must make sense without this conversation. Add `script` only when a cheap read-only shell check can settle most runs: it runs in the project container before each run, exit 0 ends the run without waking you, exit 10 runs the prompt, and any other exit is an error. Otherwise omit it.

The app turns the block into a confirmation card. The automation exists only after the user confirms it there, so never claim it is active before that. A session has at most one automation; a newly confirmed proposal replaces the current one. The user pauses or deletes it from the session header.
