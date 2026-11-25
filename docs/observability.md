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
| `detail`       | The last detail period, kept until the next one starts: the slowest requests with request ID, route, status, duration and size |
| `notYetMeasured` | Areas a later server version adds: external calls, database, error groups, cost, sandbox lifecycle             |

Bytes are response bodies as written to the network, after compression,
without HTTP headers. Every response carries an `x-request-id` header that
matches the server log and the detail-mode entries.

Never included: messages, transcripts, file contents, secrets and tokens,
request bodies, query strings and full URLs, project and session names.

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
