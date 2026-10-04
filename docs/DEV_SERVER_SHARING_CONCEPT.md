# Dev server detection and sharing

**Status:** Implementation in review, based on decisions from 2026-10-04.
**Scope:** Verity server, preview-tunnel, sandbox image, agent-seed, and mobile client
**Related:** [UPLINK_CHANNEL_PROTOCOL.md](UPLINK_CHANNEL_PROTOCOL.md),
[ADR 0013](adr/0013-component-naming.md),
[ADR 0020](adr/0020-project-sandbox-sleep-and-automatic-wake.md),
[uplink-team-sharing-delivery.md](uplink-team-sharing-delivery.md)

## 1. Outcome

Any HTTP or WebSocket listener an agent or the operator starts inside a project sandbox is
detected automatically, attributed to its session, and offered in the app with two actions:
open it locally on the Verity host, or share it publicly through the Uplink. Local access needs
no Uplink and no subscription. Public sharing stays a premium feature. Neither path recreates the
sandbox container, publishes Docker ports on it, or requires the operator to configure anything
up front.

The public preview tunnel is the model for both paths. A share is a target in the sandbox plus
an edge that gives access to it. The connector is identical; only the edge differs: an edge
inside the Verity server process for local shares, an Uplink-hosted edge for public ones.

## 2. Decisions

### 2.1 Local transport: edge in the server process, one host port range

The Verity container publishes one contiguous range, default `8100-8119`, configured through a
Compose variable. The server allocates a port from it per local share and runs a `PreviewEdge`
instance (`packages/preview-tunnel/src/index.ts`) in-process on that port. Services listen
inside the sandbox. Each share starts a connector that forwards requests from its allocated
ingress port to the service, without recreating the sandbox.

Ports are allocated dynamically, independently of the service listening ports. Docker may run
a userland proxy per published port, depending on its configuration. The memory cost must be
measured on the host, so the default stays small. Concurrent local shares are bounded by active shares,
not by running servers, and a single host rarely holds more than a handful. When the range is
exhausted the app shows a clear message pointing at the variable rather than a silent failure.
Enlarging the range is a `.env` change plus a restart of the Verity container; nothing durable
depends on its size.

Alternatives rejected: a sub-path under the API port breaks dev servers that emit absolute
asset URLs and HMR sockets; a wildcard hostname needs DNS that home networks do not have.

The connector container stays as it is, additionally attached to `verity-net`, and dials the
in-process edge on the internal port instead of the Uplink edge. The edge forwards HTTP/1.1 and
WebSocket only, which covers REST and GraphQL APIs, server-sent events, hot reload, Storybook,
Expo and Metro (manifest, bundles and dev-menu socket), and gRPC-web. Native gRPC and anything
that needs HTTP/2 directly are out of scope.

The edge buffers request bodies in memory before opening a stream. The default limit of 10 MB
protects the Uplink edge pod; local edges run with 100 MB. Streaming request bodies the way
responses already stream is a desirable follow-up for both paths, not a prerequisite.

Expo needs to be told its public URL regardless of transport: Expo Go loads a manifest in which
the dev server writes its own address. `EXPO_PACKAGER_PROXY_URL` set to the share URL fixes it,
the same way GitHub Codespaces does. The announce command in 2.9 is the natural place to make
this visible.

### 2.2 Access control: local shares are open, public shares keep the PIN

Local shares have no token and no TLS. The user's trusted network is the access boundary. The app labels a local share as reachable
by anyone on that network. A local CA that would give browsers trusted HTTPS was considered and
deferred; the server's own TLS identity is pinned by the app only and would trigger browser
warnings.

Public shares keep the existing scheme: a 6-digit PIN with a rate-limited budget, entered on the
login page or passed once as the `pin` query parameter, after which a session cookie carries the
authorization (`packages/preview-tunnel/src/index.ts`, `handleLogin`).

Known gap: a public share serves browser clients only. curl, scripts, a second service, and
Expo Go do not hold the cookie and land on the login page. Accepting the PIN per request in a
header such as `X-Verity-Preview-Code`, stateless and with the verified result cached, would
cover scripts and service-to-service calls. It is noted as a separate improvement to the Uplink
path. Expo Go through a public share remains unsupported.

### 2.3 Raw TCP is not provided

Databases, Redis, SSH, and native gRPC are not forwarded, locally or publicly. The scanner cannot
tell a raw TCP port from an HTTP one, the edge would need a second mode, and no protection
applies over the Uplink. The edge stays an HTTP and WebSocket relay.

### 2.4 Loopback listeners: forwarder in the sandbox plus agent guidance

The sandbox image ships a small forwarder. When a listener bound to 127.0.0.1 is shared, the
server starts the forwarder via `docker exec` in the sandbox. It accepts connections on all
interfaces and relays them to the loopback port, so the connector can reach the server
regardless of how it was started. The scanner tracks the forwarder and restarts it when the dev
server restarts. iptables redirection is not an option under gVisor; a Node forwarder is.

In addition, the sandbox agent guidance asks agents to start dev servers on `0.0.0.0` so that
the forwarder is rarely needed. Guidance alone is not sufficient: agents miss it and project
configurations override it.

### 2.5 Attribution: session id in the environment

The server sets a session-id environment variable on every agent shell it starts via
`docker exec`. Child processes inherit it wherever they change directory or daemonize. The
scanner reads it from `/proc/<pid>/environ` and attributes the listener to that session. The
worktree-based cwd match stays as a fallback for processes started another way.

Listeners that match no session are shown as project listeners so
that nothing disappears silently.

### 2.6 Starting services

Users or agents start HTTP/WebSocket services in a project sandbox. Verity detects the
listeners and provides shares on them. An active share keeps the sandbox awake (ADR 0020).

### 2.7 Opening a local share from outside the home network

A local share is reachable only from the Verity host's network or through a VPN into it. The
app does not infer that from its connection type; it probes. On "Open" it sends a short request
with a short timeout to the local edge port.

- Reachable: open the browser.
- Not reachable, entitlement present: show "You are not on your Verity server's network. Share
  publicly through the Uplink?" with a one-tap public share of short duration and the PIN in the
  link. No silent automatic public share: making something public is a deliberate step.
- Not reachable, no entitlement: show "This share is reachable only on your Verity server's
  network. Sharing from outside needs Verity Premium." The local link stays copyable.

Routing browser traffic through the proposed Remote Control tunnel
(`docs/protocols/uplink-remote-control-v1.md`) was considered and rejected: the tunnel ends in
the app, iOS does not let a WebView intercept plain HTTP, and an on-device port forward would
serve only the phone while the app is in the foreground. It stays noted as an idea.

### 2.8 Gating in the app

The Preview button always opens and lists every detected listener of the session and the
project. Each listener has two actions. "Open locally" is always active. "Share publicly" is
visible for everyone, active only with entitlement, otherwise it shows a premium hint and a link
to settings. If the Uplink is temporarily unreachable the action reads "temporarily unavailable",
not "premium".

Entitlement arrives as a capability in the app's handshake with the server, which learns it from
the Uplink. The app uses the capability rather than a configured key. This aligns with the planned
rename of the `sharing` feature to `preview-sharing` in
[uplink-team-sharing-delivery.md](uplink-team-sharing-delivery.md).

The server pushes new and vanished listeners over the session
stream the app already holds.

### 2.9 Detection: always on, event-driven, with an agent announce command

- The scanner is wired regardless of Uplink configuration.
- A long-lived `docker exec` in the sandbox diffs `/proc/net/tcp` every one to two seconds and
  streams only changes. A PostToolUse hook in agent-seed triggers an immediate scan after every
  Bash call of the agent, so a freshly started server appears without waiting for the next tick.
- agent-seed gains an announce command, for example
  `verity-dev-server announce --port 5173 --name storybook`, through which the agent states
  name, port, and intent. The scanner confirms that the port is actually listening. Announce and
  scan together are more robust than either alone.
- When a new listener appears in a session, the app shows an inline card: framework and port,
  with "Open locally" and "Share publicly". "Open locally" creates the local share with one tap
  and opens the URL.

## 3. Security considerations

- Local shares are unauthenticated HTTP on the Verity host's network. The Verity container's
  published range must be restricted to trusted LAN/VPN clients. The firewall guidance in
  `deploy/README.md` mentions `userland-proxy: false` as an optional way to reduce
  proxy process overhead.
- The in-process edge runs inside the Verity server. A misbehaving dev server can therefore
  consume server resources through its share. The edge's existing per-share request and stream
  pools and body limits apply; the default local range bounds the number of concurrent edges.
- The connector container keeps its hardening (read-only rootfs, dropped capabilities, memory
  limit) on both paths. Attaching it to `verity-net` exposes the internal edge port to it; the
  connector authenticates with the per-share connector token as it does toward the Uplink.
- The loopback forwarder runs inside the sandbox with sandbox privileges. It reaches only ports
  on the sandbox's own loopback interface and is started and stopped by the server.
- The agent's announce command is a hint, never an authorization. A share is created only by the
  operator in the app, and only for a port the scanner has confirmed.
- The session-id environment variable is attribution metadata, not a secret, and grants nothing.

## 4. Implementation order

1. Wire the listener scanner independently of Uplink; add environment-based attribution and
   project listeners; replace polling with pushes over the session stream.
2. Publish the local range on the Verity container; implement local shares with the in-process
   edge and the `verity-net` connector attachment.
3. Ship the loopback forwarder in the sandbox image and the agent guidance; mark loopback
   listeners as shareable.
4. Add the event-driven in-sandbox scan, the PostToolUse trigger, and the announce command in
   agent-seed.
5. Rework the app: always-open Preview sheet, per-listener actions, capability-based gating,
   reachability probe with the three outcomes, inline listener card.
6. Update `deploy/README.md`, the Compose files, and ADR 0020 references.

## 5. Implementation details and verification boundaries

- Local edges and their connector leases are process-owned, not restored from the database.
  A Server restart closes them; startup removes orphan local connectors, and opening again
  allocates a new share. Active local and public shares block automatic sandbox sleep.
- Both legacy and managed deployments publish `VERITY_LOCAL_PREVIEW_PORT_RANGE`. The managed
  Gateway relays each port unchanged to the selected Server generation, preserving HTTP
  origins, streaming bodies and WebSocket upgrades through the normal update lifecycle.
- The Connector image resolver and static-folder browser operate independently of Uplink.
  The ordinary PIN-authenticated edge remains the default. Only explicitly local edges
  admit unauthenticated HTTP and preserve application cookies and cross-origin requests.
- Local request bodies retain the 100 MiB limit. A shared budget admits at most two buffered
  uploads across all local edges; bodyless asset requests do not consume that budget.
- Discovery uses one long-lived sandbox watcher per active project. Completed agent tool events
  trigger an immediate refresh across backends, serving the role of a native PostToolUse hook
  without installing backend-specific hook files. Session snapshots use the existing event
  stream; opening the sheet also fetches an initial snapshot. Transient scan failures retain
  the last healthy snapshot, and inactive projects clear it.
- Public availability comes from `GET /preview-capabilities`, which distinguishes entitlement
  rejection from temporary transport failure. It is not inferred from whether a key is present
  in the app. Local reachability probes identify the allocated edge by its share ID rather
  than treating any HTTP server on a reused port as success.
- The loopback relay binds a separate free port, since a wildcard socket cannot reuse the
  original loopback listener's port. Relay processes are excluded from discovery.
- Automated tests cover shared-edge HTTP/WebSocket behavior, cookies, redirects, lifecycle
  fencing, failed creation cleanup, attribution, watcher lifecycle and mobile access decisions.
  Live Docker deployment, device browser and Expo Go validation remain deployment smoke tests;
  HTTP/WebSocket forwarding does not automatically rewrite addresses embedded in Expo manifests.

## 6. Noted follow-ups, not part of this concept

- PIN as a per-request header on the Uplink edge, for scripts and service-to-service calls.
- Streaming request bodies through the tunnel instead of buffering them.
- A local CA for trusted HTTPS on local shares.
- Expo Go through a public share, which would need a secret share URL without a login step.
- An on-device port forward through Remote Control, once that transport exists.

### Trusted browser boundary

Local previews on different ports use the same host and therefore share the browser cookie
namespace. They forward application cookies and permit cross-origin HTTP/WebSocket access
so a local frontend can use a separately shared API. Only use this open mode for applications
and projects you trust; it does not isolate browser credentials between local previews.
Cookie rewriting would change application behavior, and separate preview hostnames require
additional local DNS infrastructure. Both are outside the agreed open local transport.

If a listener changes its binding and requires a different connector target port, reconciliation
revokes the old link; reopening creates a connector for the new binding.
