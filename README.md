# Verity

Open-core, self-hosted mobile control plane for steering coding agents across a
development fleet from your phone. Multi-project, multi-agent, voice-first.
_"Frei von überall arbeiten, entspannt, im Flow."_

The self-hosted Verity core is licensed under Apache-2.0. Optional hosted
services—including Uplink, remote access, sharing, and future managed
operations—are separate proprietary products and are not required to run the
self-hosted core. See [Open-core boundaries](#open-core-boundaries) and the
[trademark policy](TRADEMARKS.md).

See [`docs/AGENT_CONTROL_PLANE_KONZEPT.md`](docs/AGENT_CONTROL_PLANE_KONZEPT.md)
for the full architecture and design rationale (source of truth).

## Running Verity

On a Docker 25+ host with the Compose v2 plugin, install Verity with one command:

```sh
curl -fsSL https://verity.build/install.sh | bash
```

The bootstrap resolves the official release image to an immutable digest and
extracts the matching guarded deployment bundle from that image. Re-running the
same command repairs or updates the host-side installation without replacing its
persisted deployment identity. The release bundle is staged in a fresh root-owned
directory for the duration of the run and removed afterwards.

**For manual installation and advanced options, follow [`deploy/README.md`](deploy/README.md).** In short:
bring up the runner with `docker compose -f deploy/docker-compose.yml up -d`, then
open the mobile app, point it at `http://<host>:8082`, set a master password, and
connect GitHub — everything else is configured in the app, with no host-mounted
secret files.

The default deploy is still **self-contained** — you do not have to bring your own
database — but PostgreSQL is the only runtime store: `deploy/docker-compose.yml`
runs a `postgres` service beside the server on an unpublished network, persisted
on a Docker volume, and points `DATABASE_URL` at it. The server refuses to start
without that variable. (The root `docker-compose.yml` here is a separate
_local-dev_ Postgres for working on the code, not the server itself.)

## Repository layout

This is an npm-workspaces monorepo (Node / TypeScript).

| Package                   | Description                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `packages/events`         | Canonical agent event model — the runtime-agnostic contract (concept §5b).          |
| `packages/adapter-claude` | Backend-neutral permission contract (prompt/decision), left by the retired adapter. |
| `packages/server`         | Control-plane HTTP/WebSocket server (Fastify) — the API the app talks to.           |
| `packages/session`        | Session lifecycle over the canonical event model.                                   |
| `packages/store`          | Durable PostgreSQL store + at-rest secret encryption.                               |
| `packages/mobile`         | Shared mobile client logic (API, stream, onboarding).                               |
| `apps/mobile`             | The Expo / React Native app.                                                        |

## Open-core boundaries

This repository contains the Apache-2.0-licensed self-hosted core: the Server,
Runner and Sandbox components, installation tooling, shared protocols, the
mobile client source, and the inspectable transport data plane used by hosted
features. That data plane includes the Uplink client, Preview Connector, and
Preview Edge. An installation can run locally without purchasing a hosted
Verity service.

The official App Store builds and the server-side implementations and
infrastructure for Verity Uplink, entitlement, hosted remote access, public
sharing control, billing, and any future managed hosting control plane are
operated separately and are not contained in this repository. Apache-2.0 does
permit third parties to use and host the code that is contained here under
another brand; the Verity name and logos are governed separately by the
trademark policy.

The public security and conduct intake channels are release blockers and are
not yet active; see [SECURITY.md](SECURITY.md). Contributions are covered by
[CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
The repository is not yet presented as ready for third-party production use.
The remaining release gates cover licensing and third-party notices, a
documented and CI-proven clean installation, backup, restore, upgrade and
rollback on a supported host, a monitored security-reporting path with an SBOM
and signed images, and an independent review of the public deployment path.
They are tracked in [`docs/open-source-readiness.md`](docs/open-source-readiness.md).

## Development

Requires Node ≥ 24.

```bash
npm install          # install workspace dependencies
npm run build        # type-check + build all packages (tsc -b)
npm test             # run the test suite (Vitest)
npm run coverage     # tests with coverage
npm run lint         # ESLint (type-checked)
npm run format       # Prettier check (format:write to fix)
```

### Local Postgres (for working on the code)

The test suite is hermetic by default: each test file boots its own in-process
PostgreSQL (pglite, WASM) so `npm test` needs no database service. Point the
suite at a real Postgres instead when you want a faster run or want to verify
behaviour the WASM build does not reproduce:

```bash
cp .env.example .env   # then set POSTGRES_PASSWORD
docker compose up -d postgres
```

This root compose file is a dev convenience only. The shipped runner brings up
its own `postgres` service — see [`deploy/README.md`](deploy/README.md).
