# ACP attested tool channel — probes

These reproduce the measurements in `docs/ACP_ATTESTED_TOOL_CHANNEL_DESIGN.md` §5.
They exist because those measurements revise a security argument, and a security
argument that rests on a script nobody kept is an argument that decays silently.

They are **manual**. Driving a turn needs a live ACP adapter and a working agent
credential, neither of which CI has, so nothing here runs automatically. The one
claim that does not need a credential — that an agent child's stdio is a
socketpair and therefore not forgeable from a sibling — is a real test instead, at
`packages/session/src/agent-stdio-isolation.test.ts`, and that one does run in CI.

## Running

```sh
RUN=$(mktemp -d)
node scripts/probes/acp-attested-channel/mcp-probe-server.mjs \
  --port 8765 --log "$RUN/probe.log" --token-file "$RUN/token" &
SERVER=$!
until [ -s "$RUN/token" ]; do sleep 0.1; done   # the server mints it; do not race it
node scripts/probes/acp-attested-channel/drive-acp.mjs \
  --port 8765 --log "$RUN/probe.log" --token-file "$RUN/token"
kill "$SERVER"                                  # takes the token file down with it
cat "$RUN/probe.log"
```

Order matters: the server mints the per-run bearer token and writes it to
`--token-file`, and the driver reads it from there. Starting the driver first
exits with a message rather than running an unauthenticated measurement. Use a
fresh directory per run — both scripts require the path rather than defaulting to
one, because a fixed `/tmp` name is guessable and the server creates the file
exclusively (`O_EXCL`) so it refuses a pre-placed symlink instead of following
it. The token travels by file and not by argv deliberately: M4 asks which
processes publish this credential to `/proc`, so the probe itself must not be one
of them.

Stop the server when the driver returns. It deletes the token file on the way out
and, if the `kill` is forgotten, expires by itself after ten minutes
(`--expire <ms>`) — a probe server left listening keeps a valid credential on disk
and quietly answers the next run on the same port, which is exactly how one
measurement's traffic ends up in another's log.

The server rejects any request that does not present the token (`401`, logged as
`MCP_UNAUTHORIZED`), so a stray caller — a leftover run, a mistyped port, a
neighbour poking the socket — is recorded rather than mixed into the evidence
where it would be indistinguishable from the adapter's own `tools/call`.

That is visibility, not isolation, and the difference matters here of all places:
a same-UID process can read the token file, and M4's entire finding is that the
adapter publishes the same credential on its command line anyway. These scripts
are measurement instruments for a container you control. Nothing in them holds
against the adversary the design document reasons about — that adversary is the
subject of the measurement, not something the measurement defends against.

Pass `--adapter codex-acp` for the Codex adapter. That path needs a Codex
credential in the container (`~/.codex/auth.json`); without one, `session/new`
returns `Authentication required` and the log shows only `RPC_ERROR`. M1–M3 were
unmeasured for `codex-acp` for exactly that reason until a credential was present;
the run that closed the gap is recorded in §5 M5 of the design document.

One thing that run did **not** establish: M1's barrier. The driver auto-approves,
so a favourable ordering in the log only shows the adapter sent the permission
request before the MCP call — not that it would wait for a held answer. Measuring
that needs a driver that delays its response to `session/request_permission` and
checks whether the MCP arrival waits with it.

The probe MCP server executes nothing. It answers `initialize`, `tools/list`, and
`tools/call` with a fixed string, and its only purpose is to timestamp arrivals and
record the full `tools/call` params.

## Why `leak-scan.mjs` is a separate program

M4 asks whether a workspace process can read the endpoint and credential out of
the adapter's command line. Where the scan runs decides what that answer means:
`/proc` access to another task's `environ` and descriptors goes through a
ptrace-mode check, and an ancestor passes checks a workspace process may not. A
scan inside the driver — the adapter's parent — would report a leak whether or
not the workspace could reach it.

So the scan is its own program, run from three positions in a single turn:

| `--label`          | Spawned by                | Relationship to the adapter |
| ------------------ | ------------------------- | --------------------------- |
| `parent`           | the driver, in-process    | the adapter is its child    |
| `sibling`          | the driver, as a child    | siblings                    |
| `agent-descendant` | the agent's own Bash tool | the adapter is its ancestor |

The driver puts the third one in its prompt, so the measurement is taken from the
position a real repository command occupies. That run reports through its tool
output _and_ appends to the shared log, so a model that summarises rather than
quotes cannot lose the result.

`leak-scan.mjs` looks for the port and for any `Bearer ` credential, never for the
token value, so it needs no oracle and is safe to hand to the agent under test.
Read its hits with the `cmd` column: the probe's own processes carry the port on
their command lines (flagged `probe`), and an interactive shell that once ran a
`curl -H "Authorization: Bearer …"` will show up as a bearer hit that is nothing
to do with the adapter. It also reports how many `cmdline`/`environ` files it
could and could not read, because a scan that finds nothing is only meaningful
alongside how much of `/proc` it was allowed to see.

## Reading the log

Every line is `<epoch-ms> <KIND> <json>`. The kinds map to the measurements:

| Kind                                          | Measurement                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ACP_TOOL_CALL`, `ACP_PERMISSION`, `MCP_HTTP` | M1 — ordering, and which update first carries a complete `rawInput`                                                         |
| `ACP_TOOL_CALL` vs `MCP_TOOLS_CALL`           | M2 — whether `rawInput` and the MCP `arguments` are byte-comparable                                                         |
| `MCP_TOOLS_CALL`                              | M3 — whether `params._meta` carries a call identity matching `toolCallId`                                                   |
| `M4_LEAK`                                     | M4 — whether the endpoint or its credential is readable in another process's `cmdline`/`environ`, once per scanner position |
| `M6_HOLDER`                                   | M6 — any process outside the adapter tree holding the adapter's stdio object                                                |

`M6_HOLDER` is logged only on a hit, so a clean run has none. Note that the
adapter re-execs, so its own inner `node` process legitimately holds the
descriptor; a hit naming anything else is the finding.

The credential is generated per run and never written to the log: both scripts
redact it out of every line they emit, so an adapter that echoes its own MCP
configuration back through `RPC_ERROR` or `ADAPTER_STDERR` cannot deposit the
token in the log either. `M4_LEAK` records only whether a match was found, and in
which process.
