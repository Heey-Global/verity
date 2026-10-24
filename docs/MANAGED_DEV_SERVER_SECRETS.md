# Secrets for managed development servers

Managed development servers can receive named secrets from the project's Doppler
configuration. Verity saves only the mapping from a secret alias to an environment
variable. Secret values are resolved freshly at each start, restart and sandbox
recovery; they are never saved in the server registration or command.

## Register and approve

Use `--secrets` with comma-separated `ALIAS=ENV` names:

```sh
verity-dev-server add "Meeting API" \
  --command "node scripts/start-managed.mjs" \
  --workdir app \
  --secrets ATTENDEE_API_KEY=ATTENDEE_API_KEY
```

The alias must exist in this project's Doppler configuration. A mapping may give a
secret a different environment variable name. Each destination must be unique;
execution controls such as `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `PORT`, and
`VERITY_*` are refused. At most 16 mappings are supported.

Approve the entry in Preview before starting a server with secret bindings. The
approval shows the command, directory and alias mappings. Changing a mapping
requires a new approval. Older clients that do not display mappings cannot approve
a secret-bound entry. Existing entries without bindings continue to work.

After approval:

```sh
verity-dev-server start "Meeting API"
verity-dev-server status "Meeting API"
verity-dev-server stop "Meeting API"
```

Replace all bindings with `verity-dev-server update "Meeting API" --secrets
ATTENDEE_API_KEY=API_KEY`; remove them with `--secrets ""`. A registration edit does
not alter a running process. Automatic recovery uses its last approved command,
directory and mappings, rather than pending edits. Restart applies the current
registration after approval. Rotation in Doppler takes effect at the next start.

## Runtime and output

All aliases resolve before launch. If any alias is missing, unavailable, empty,
invalid UTF-8, contains a NUL byte or exceeds the environment-delivery limit, the
server does not start with a partial set of credentials. Failure messages do not
include provider values or raw transport diagnostics.

Values travel through stdin to the protected sandbox spawn broker, without
secret-bearing command arguments, Docker environment configuration or temporary
credential files. The broker owns the server independently of the launching
connection and manages stop, status and shutdown. The managed port, Preview
switches and share lifecycle retain their existing behavior.

**Output is disabled for servers with secret bindings.** Stdout and stderr are
sent to `/dev/null`; `verity-dev-server logs` reports this limitation. This also
prevents application-encoded or fragmented secrets from reaching Verity's log
files. Use nonsecret health/status endpoints to diagnose these servers.

The approved application receives credentials in its process environment and runs
as the configured project agent user. Approval authorizes that application's use
of them; it does not freeze project source code or prevent application code from
writing its own files or sending credentials over the network. The application
must handle its credentials accordingly.

## Deployment and verification

Deploy the updated Core and sandbox toolkit together. Core applies the additive
managed-server metadata migration. Existing sandboxes must receive the updated
spawn broker and its managed-secret-server module, then restart the broker; a
Core-only update cannot enable the new launch path. An unavailable broker causes
secret-bound launches to fail; Verity does not fall back to the raw-log launcher.

Use synthetic secrets to verify registration, approval, start, restart, recovery,
stop and disabled output before a production provider test. Local tests can
substitute the privilege-drop boundary; a deployment check must additionally
verify the actual root broker with the configured unprivileged identity and
private project directories.
