# Verity contributor instructions

## Repository

Verity is an npm-workspaces monorepo using Node.js 24 or newer and TypeScript
with NodeNext module resolution.

Run the standard verification commands from the repository root:

- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`
- Format check: `npm run format`
- Format write: `npm run format:write`

Install dependencies with `npm install`. Do not commit credentials, private
deployment data, generated local state, or `.env` files.

## Changes

Write repository artifacts, code comments, commit messages, and pull request
descriptions in English. Use Conventional Commits. Keep changes focused, add
tests for changed behavior, and run verification proportional to the change.

Never push directly to the protected default branch. Work on a branch and open
a review-ready pull request.

## Product boundary

This repository contains the self-hosted Verity core, mobile app, and the open
Uplink client, connector, transport, and protocols. It does not contain the
paid hosted Uplink service, billing, entitlements, sharing brokerage, remote
control brokerage, or managed operations.
