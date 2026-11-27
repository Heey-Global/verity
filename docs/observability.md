# Server monitoring and the diagnostic report

Verity counts its own requests, traffic and resource use in memory so that an
administrator can see what loads the server and which client causes which
traffic. The design is recorded in
[ADR 0032](adr/0032-server-metrics-and-diagnostics.md).

## In the app

Settings › Diagnostics › Server monitoring, visible to administrators:

- **Measure server load and traffic** — on by default. Switching it off stops
  counting and discards what was counted.
- **Detail mode** — additionally keeps the slowest requests with their request
  ID, for 15 minutes, 1 hour or 4 hours. It ends on its own.
- **Create diagnostic report** — shows a summary and the full report, which can
  be copied, saved as a file or shared. Nothing leaves the server otherwise.

## What the report contains

| Section        | Content                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `server`       | Version, start time, uptime, Node.js version                                                                     |
| `monitoring`   | Measurement and detail-mode state, and the period the counters cover                                             |
| `availability` | Requests, 4xx and 5xx counts, latency p50/p95/p99/max, the slowest routes                                        |
| `traffic`      | Bytes per client, top routes by bytes per client, top sessions by bytes (hashed), live WebSocket use per client  |
| `resources`    | Process memory and heap limit, CPU time, event-loop delay                                                        |
| `externalCalls` | Outbound calls per target with failures, duplicates, p95 and the last rate limit seen; the top causes |
| `detail`       | The last detail period, kept until the next one starts: the slowest requests with request ID, route, status, duration, size and their outbound calls |
| `notYetMeasured` | Areas a later server version adds: database, error groups, cost, sandbox lifecycle |

Bytes are response bodies as written to the network, after compression,
without HTTP headers. Every response carries an `x-request-id` header that
matches the server log and the detail-mode entries.

Never included: messages, transcripts, file contents, secrets and tokens,
request bodies, query strings and full URLs, project and session names.

## Outbound calls

Every request the server process makes with `fetch` or `node:http` is counted
through Node's diagnostics channels, so no call site has to count itself.
Calls are labelled by target — `github`, `google`, `anthropic`, `openai`,
`doppler`, `apple`, `expo`, `registry`, `verity`, `internal` or `other` — and
by cause: the route template of the request that made them, a named GitHub
reader such as `github:session-status`, or `background`. Unknown public hosts
are reported as `other`, never by name.

A duplicate is the same read (GET or HEAD of the same URL) repeated within two
seconds. Rate limits are the last `x-ratelimit-*`, `anthropic-ratelimit-*` or
OpenAI limit headers a target returned. Failed calls are network errors, 429
and 5xx answers.

Not counted: calls of child processes (git, gh and docker command-line tools),
calls agents make from their sandboxes, and connections that fail before a
request is sent.

## Clients

The app sends `x-verity-client: <kind>/<release>` (`ios`, `android`, `watch`)
on its HTTP requests. Other clients are classified by user agent as `web`,
`cli`, `agent` or `other`. Unknown kinds and malformed versions are not
accepted as labels.

## Verity Control

`verity_diagnostics` returns the same report under `monitoring`, with session
IDs unhashed so that a finding can be handed to the affected project session.

## API

Administrator only:

- `GET /diagnostics/monitoring` — current state.
- `PATCH /diagnostics/monitoring` — one change per request:
  `{ "measurementEnabled": false }`, `{ "detailMode": { "minutes": 60 } }`
  (15, 60 or 240) or `{ "detailMode": null }`.
- `GET /diagnostics/report` — the report, `verity.diagnostic-report/1`.

## Overhead

`node --expose-gc scripts/monitoring-overhead.mjs` (after
`npx tsc -b packages/server`) compares request latency with measurement off, on
and in detail mode over a real socket, and the heap of fully populated
counters. The budget is 20 MB and 1 % latency.
