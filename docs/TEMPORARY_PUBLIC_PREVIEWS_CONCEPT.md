# Temporary Public Project Previews — Initial Proposal

**Status:** Superseded after security review — do not implement

**Date:** 2026-07-20

## Initial idea

The initial proposal would have used the three Tailscale Funnel ports (`443`, `8443`, and `10000`)
as reusable public slots. Dedicated listeners in the existing Verity server process would have
proxied each slot to one running project Dev Server. Shares would have had a bounded lifetime,
explicit revocation, persisted state, and mobile controls.

This appeared to meet the original constraints: expose the exact running application, support
several projects, keep the Verity API private, and add no separate service or container.

## Why it was rejected

Independent security, networking, and operations reviews found architectural blockers:

- Reusing stable Funnel origins does not isolate browser cookies, service workers, caches, or
  storage between projects.
- Parsing hostile public HTTP and WebSocket traffic in the Verity control-plane process is not a
  privilege boundary. That process holds secrets and currently has host-root-equivalent Docker
  access.
- The predictable root URLs did not implement the claimed unguessable access capability.
- Revocation did not terminate existing streams and WebSockets.
- Existing wildcard host bindings could bypass the proposed public controls.
- Provider reconciliation could interfere with non-Verity Tailscale configuration.

Random paths, additional ports, header rewriting, and `Clear-Site-Data` do not solve the origin/site
isolation problem for arbitrary applications. The original topology must not be used as an
implementation plan.

## Current direction

The reviewed direction keeps the exact running Dev Server but places a controlled public edge and
an outbound-only, separately confined connector in front of it. It requires a fresh cookie-isolated
site per cross-project share, mandatory capability plus PIN/password access, a pre-activation safety
scan, full application semantics, strict route grants, bounded lifetimes, and immediate connection
termination on revoke.

Every project container must run in its own network without an app-level opt-out. It receives no
Docker socket/API, privileged mode, added capabilities, host mounts, or generic access to Verity,
Docker, Kubernetes, sibling projects, the host/LAN, tailnet, or cloud metadata. Development apps may
still use public internet APIs and test databases without a per-project allowlist; a mandatory
network policy classifies the resolved destination, re-checks redirects, blocks internal address
ranges, and applies connection, destination, DNS, bandwidth, and raw-SMTP abuse controls.

"No generic access to Verity" does not mean zero communication. Project sandboxes and sessions
still need narrowly scoped Verity capabilities such as commit signing, repository-scoped GitHub
tokens, project memory, approved secret/Doppler operations, model credential egress, and preview
lifecycle transport. Those operations use project- and container-generation-bound broker grants
through the confined relay. A sandbox cannot call the normal Verity API, enumerate control-plane
state, select an internal upstream, or reuse another project's grant.

Sharing remains fully interactive rather than read-only, including mutations, uploads, SSE, and
approved WebSockets. It is explicitly limited to temporary development demonstrations with test
data. Before every activation, Verity requires acknowledgement that production systems,
credentials, personal/customer data, and business-critical workloads must not be exposed. Durations
are 15 minutes, 1 hour (default), 2 hours, 4 hours, or 8 hours (maximum), with no permanent mode or
automatic renewal.

Each share receives an automatically generated, non-reused subdomain. A shared URL-path scheme is
rejected. One wildcard DNS record, wildcard certificate, and Kubernetes Ingress/Gateway may serve
all preview hostnames, provided the preview suffix is verified as a cookie-isolating Public Suffix
List boundary.

The authoritative requirements, unresolved provider work, security invariants, and release gates
are documented in
Temporary Public Previews — Security and Architecture Review
(`docs/TEMPORARY_PUBLIC_PREVIEWS_SECURITY_REVIEW.md`, not in the public snapshot).
The selected project-network and broker boundary, staged migration, and real-Docker test gates are
documented in
Temporary Public Previews — Network and Broker Implementation Spike
(`docs/TEMPORARY_PUBLIC_PREVIEWS_IMPLEMENTATION_SPIKE.md`, not in the public snapshot).
