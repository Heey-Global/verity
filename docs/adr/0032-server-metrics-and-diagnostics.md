# ADR 0032: Server metrics and diagnostics

- Status: accepted
- Date: 2026-11-25
- Relates to: [docs/diagnostic-logs.md](../diagnostic-logs.md),
  [ADR 0029](0029-module-boundaries-and-file-size.md)

## Context

A Verity server could not explain its own load. Docker and the host report
CPU, memory and network per container, but only as totals: they cannot say
which client, endpoint or session caused a transfer, whether a client polls
too often, or which request was slow. Questions such as "why did the phone app
transfer several gigabytes this month" had no answer without instrumenting the
server itself.

Verity is self-hosted. Whatever it measures stays on the administrator's
server unless the administrator decides to share it, and measurement must not
cost noticeable latency or memory on small hosts.

## Decision

**In-memory counters, no metrics stack.** The server counts in its own memory
(`packages/server/src/metrics/`). There is no `/metrics` scrape endpoint, no
time-series database and no dashboard to operate. Counters cover the time
since measurement was last switched on or the server restarted; a restart
starts them again from zero.

**Three tiers.**

1. _Off_ — no hooks count anything and the event-loop sampler stops.
2. _Measurement_ (the default) — every HTTP request is counted by route
   template, client and status class, with duration and response bytes as
   written to the socket, after compression. Live WebSocket connections are
   counted per client with frames, bytes and duration. Process memory, CPU and
   event-loop delay are sampled when a report is built.
3. _Detail mode_ — on top of measurement, the slowest requests are kept with
   their request ID. It runs for 15 minutes, 1 hour or 4 hours and switches
   itself off; a forgotten switch cannot keep the extra cost. Later areas
   (database query patterns, external calls per cause) add their per-request
   breakdown here.

**Configured in the app only.** Measurement and detail mode are stored in
`server_monitoring_settings` and changed through the administrator routes
`GET`/`PATCH /diagnostics/monitoring`. There are no environment variables for
them. The settings are read into memory once, so no request reads the database
to decide whether to count.

**Bounded labels.** Routes are Fastify route templates, never URLs; clients
are a closed set (`ios`, `android`, `watch`, `web`, `cli`, `agent`, `other`)
plus a dotted release number, so a client cannot widen the counter set by
inventing labels. The app names itself in `x-verity-client`; anything else is
classified by its user agent. Status codes are kept as classes. Session IDs
are never a label; per-session traffic is a separate map of at most 1,000
sessions. HTTP series are capped at 2,000; further keys fold into `(other)`.

**The report is a user-initiated export.** `GET /diagnostics/report` returns
one versioned JSON document, `verity.diagnostic-report/1`. The app previews it
and offers Copy, Save file and Share; the server never sends it anywhere. It
contains no messages, transcripts, file contents, secrets, tokens, request
bodies, query strings, full URLs, or project and session names; session IDs
are replaced by short hashes. This is the preview and explicit-transmission
step that `supportConsent: required` in
[docs/diagnostic-logs.md](../diagnostic-logs.md) asks for. Areas the server
does not measure yet are listed in `notYetMeasured` instead of being left out.

**Verity Control reads the same report.** `verity_diagnostics` includes it with
unhashed session IDs, so Control can hand a finding to the right project
session. Control explains anomalies and prepares fixes through project-session
handoffs; the next report verifies the result.

**Overhead budget.** Below 20 MB of memory and 1 % of request latency, with
detail mode included. `scripts/monitoring-overhead.mjs` measures both. At the
caps the counters take about 1 MB of heap; recording one request takes about
0.5 µs, against request latencies in the hundreds of microseconds.

## Consequences

- Counters do not survive a restart. A trend over days needs reports taken over
  days; that is acceptable for diagnosis and avoids a storage component.
- Traffic attribution is per route template and client kind. Exact URLs and
  per-person usage are deliberately unavailable.
- The live WebSocket of the native app cannot carry custom headers on every
  transport, so its client kind comes from the user agent.
- External calls, database load, error groups, sandbox lifecycle and cost
  extend the same report in later versions, under the same label and privacy
  rules.
