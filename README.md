# Verity

[![CI](https://github.com/Heey-Global/verity/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Heey-Global/verity/actions/workflows/ci.yml?query=branch%3Amain)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Heey-Global/verity/badge)](https://scorecard.dev/viewer/?uri=github.com/Heey-Global/verity)
[![Server release](https://img.shields.io/github/v/release/Heey-Global/verity?filter=v*&label=server)](https://github.com/Heey-Global/verity/releases)
[![Signed releases](https://img.shields.io/badge/releases-cosign%20signed-0b7285)](SECURITY.md#verifying-a-release)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Run coding agents on your own server and steer them from your phone, tablet,
or browser.**

Give an agent a task from wherever you are, let it work in its own copy of your
project, and answer its questions when it needs you. Verity runs Claude Code,
Codex, or open-source models through OpenCode with your own subscription, keeps
your history on your server, and lets several agents work on one project at
once without getting in each other's way.

![Verity app](docs/website/site/assets/hero-product-verity-v5.png)

> [!NOTE]
> **Verity is in beta.** Setup and features may still change. Email
> [hello@verity.build](mailto:hello@verity.build) for a TestFlight invitation
> to the iPhone and iPad app; the browser app needs no invitation. Please read
> the [known limitations](SECURITY.md#known-limitations) before you rely on it.

## What you need

- **A Linux machine that stays on**, with Docker 25 or newer and the Docker
  Compose plugin, on x86-64 or ARM64. A Mac or Windows laptop alone is not
  enough; a small cloud server works well. Plan for 16 GB of memory and 4 CPU
  cores for one active project.
- **One AI subscription:** Claude, ChatGPT (for Codex), or an
  OpenAI-compatible API key for OpenCode.
- **A browser, or an iPhone or iPad** with the TestFlight invitation.

## Install

On the Linux machine, run:

```sh
curl -fsSL https://verity.build/install.sh | bash
```

The installer checks the machine, downloads the signed Verity release, starts
it with Docker, and prints a QR code and pairing link for your first device. It
takes a few minutes. To only run the checks first, add `--preflight`:

```sh
curl -fsSL https://verity.build/install.sh | bash -s -- --preflight
```

Then follow the **[getting started guide](docs/getting-started.md)**. It walks
you through renting a server if you need one, connecting your browser or
phone, signing in to your AI provider, and running your first session.

> [!WARNING]
> **Keep the Verity server off the public internet.** Do not open ports `8082`
> or `8100–8119` on your router or cloud firewall. Connect from your local
> network or through a VPN such as Tailscale or WireGuard; the getting started
> guide shows how. For a cloud server with a public address, also follow the
> [hardening guide](deploy/README.md#hardening-an-internet-reachable-host).

## What Verity does

- Runs persistent agent sessions across your projects, each in its own branch
  and working copy, so several can work on one project at the same time.
- Shows which session needs your attention, what tools an agent is using, and
  asks you before an agent does anything that needs permission.
- Takes voice input and file attachments, and gives you access to project
  files from the app.
- Runs every project in an isolated container on your server, and keeps your
  Claude and Codex credentials outside those containers.
- Shows the pull-request and CI status of agent branches when GitHub is
  connected.
- Ships as one self-contained installation with PostgreSQL included.

## What Verity is not

- **Not an editor.** It does not replace your IDE; there is no completion and
  no inline edit loop.
- **Not a prototype builder.** Agents work on your repositories and your Git
  workflow, not on generated starter applications.
- **Not a hosted service.** It runs on your machine, and a local installation
  needs no paid service from us.

## Documentation

- [Getting started](docs/getting-started.md): from an empty server to the
  first session.
- [Documentation overview](docs/README.md): guides for using, running, and
  developing Verity.
- [Deployment guide](deploy/README.md): updates, resource limits, hardening,
  and the configuration reference.
- [Security policy](SECURITY.md): security model, release verification, and
  known limitations.

## Development

Verity is an npm-workspaces monorepo built with TypeScript and requires Node.js
24.19 or newer within the 24.x release line, or Node.js 26 or newer.

```sh
git clone https://github.com/heey-global/verity.git
cd verity
npm install
npm run build
npm test
```

The default test suite uses an in-process PGlite database and does not require a
running PostgreSQL server. Before submitting a change, also run:

```sh
npm run lint
npm run format
```

The main source areas are:

| Path               | Purpose                                        |
| ------------------ | ---------------------------------------------- |
| `apps/mobile`      | Expo and React Native app (iOS and browser)    |
| `packages/server`  | Fastify control-plane API and WebSocket server |
| `packages/session` | Agent backends and session lifecycle           |
| `packages/store`   | PostgreSQL persistence and encrypted secrets   |
| `packages/events`  | Runtime-independent agent event model          |
| `deploy`           | Self-hosted deployment and operations tooling  |

Start with the [contribution guide](CONTRIBUTING.md) for the full development
and pull-request workflow. Architectural decisions are recorded in
[`docs/adr`](docs/adr); the [documentation overview](docs/README.md) lists the
protocols, concepts, and runbooks.

## Open-source scope

This repository contains the Apache-2.0-licensed, self-hosted Verity core and
app, including the open Uplink client, connector, transport, and protocols. A
local installation does not require a paid hosted service.

The hosted Uplink service, hosted remote connectivity and sharing, managed
operations, and official App Store builds are separate and are not included
here. The [trademark policy](TRADEMARKS.md) applies to the Verity name and brand
assets.

## Community and security

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in project spaces.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Use [GitHub Issues](https://github.com/heey-global/verity/issues) for public
  bug reports and feature proposals.

## License

The source code in this repository is licensed under the
[Apache License 2.0](LICENSE). Third-party components remain subject to their
respective licenses.
