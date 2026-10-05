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

### 2.6 Managed dev servers

Decided 2026-10-05. This revises the earlier removal of configured dev servers: asking the
agent to start a server every time was slow, and nobody could tell whether it was still
running. Entries come back, but the agent creates them, Verity runs them, and the operator
switches them on and off from the Preview sheet.

**Entry per project, instance per session.** An entry holds a name, a command, and a
subdirectory of the worktree. It belongs to the project and can be started in any session of
it. The subdirectory must be relative and stay inside the session's worktree after resolving symlinks; absolute paths and `..` are rejected. The check runs at every start against that session's worktree, not only at `add`, because a symlink can change in between. The resolved directory is opened once and the process is launched from that handle, so the check and the launch see the same directory. Started from a session, it runs in that session's worktree. Entries live in the Verity
database, not in the repository, so switching one off or deleting it never creates a commit.
A repository file that seeds entries can be added later if entries should travel with the code.

**Ports.** The sandbox port is an internal detail and is never shown: not in the app, not on
the inline card, not in agent replies. Verity picks a free sandbox port for each pair of
session and entry and passes it as `PORT` or substitutes `{port}` in the command. All sessions
of a project share one sandbox, so this keeps two sessions running the same entry apart. The
only port anyone sees is the network port from the local range, shown as an address such as
`http://verity.local:8104`. Both ports stay bound to the pair until the session is deleted, so a bookmark keeps working across restarts, with the exceptions listed under edge cases: eviction of a non-running pair's network port when the range is full, a silent sandbox-port change on collision, and removal of the entry. A new session may get different ports. When the local range is full, the non-running pair (stopped or crashed) whose server ran least recently, with never-run pairs counted as oldest, loses its network reservation; its sandbox port is kept. Running and starting pairs are never evicted. If every reservation belongs to a running or starting server, the start fails with "All network ports are in use" and names the setting that enlarges the range.

**Supervision.** Verity starts the entry as its own process and tracks one of four states:
starting, running, stopped, crashed. "Running" requires the port to answer through the same path the share forwards to, including the loopback forwarder (2.4), and the listener must belong to the entry's own process group, which Verity starts each entry in a fresh session for, so daemonized children stay attributable and Stop reaches them; so a foreign process on the same port never marks an entry running. Verity keeps the last few hundred lines of output, readable in the
app and by the agent. Stopping ends the command and all its children so no orphan holds the
port. A crashed server stays crashed and shows its error; there is no automatic restart,
because a silent restart hides the fault. Running entries keep the sandbox awake as an active
share does (ADR 0020). When the sandbox is recreated, for example by an update, Verity starts again what was running before, with the command that last ran; a pending `update` waits for the operator's next restart.

**Agent.** `verity-dev-server` gains `add`, `update`, `remove`, `start`, `stop`, `status`,
`logs`, and `list`. `start` replies with the network address once the entry is published locally, and the agent names only that address. While an entry is running but not yet approved for local publishing (see edge cases), `start` replies "Running, not shared yet: tap Open on network in the Preview list", and the Preview row shows the same state. None of these needs operator approval: an entry only runs a command in the sandbox,
which the agent may do anyway. Additions and changes appear in the chat as a small card. The
agent-seed guidance tells the agent to start servers only through an entry, never with
`nohup` or `&`, and to create an entry when none fits. Servers started past Verity are still
detected and listed as not managed, with an offer to save them as an entry. The existing
`announce` command stays for that case.

**Edge cases.**

- _Command visibility._ An entry outlives the agent turn that created it and runs again
  whenever the operator switches it on, in any session, and after sandbox recreation. The
  command is therefore always shown: on the chat card for `add` and `update`, and in the
  detail view, so the operator never starts something they cannot read.
- _Local publishing needs one operator approval._ Interim rule until the operator confirms
  otherwise. An entry's sandbox process may start on the agent's request, but its "On your
  network" share is created only after the operator approved the entry once by tapping "Open
  on network" on its row or detail view. The approval is keyed to the exact command and subdirectory it approved and is checked against what is actually executed, including the last-run values at a restart after sandbox recreation, compared before `{port}` substitution, so a changed sandbox port does not void it and an approved command line cannot be swapped for another one. The approval covers the command line, not the files it runs: the agent can still change the code behind it, as it can change any code in the worktree. Once approved, starts by the agent or after sandbox recreation publish locally without
  another tap. Without approval the row shows "Running, not shared yet" with "Open on network".
  The permissive alternative, publishing on every start without approval, widens what the agent
  can do alone and stays open for operator confirmation. The public share is always an explicit
  operator step with its PIN and entitlement check.
- _Startup deadline._ An entry that does not answer on its port within 60 seconds moves to
  crashed with "Did not answer on its port", typically a command that ignores `PORT`. Missing the deadline stops the process tree as Stop does, so nothing keeps holding the port or keeps the sandbox awake.
- _Port collisions._ A stopped pair keeps its network reservation; eviction when the range is
  full is the only exception. If its sandbox port is taken by another process at start, Verity
  picks a new sandbox port silently. The network address does not change.
- _Lifecycle._ Deleting a session stops its instances and releases both ports. Removing an entry, by the agent or the operator, first stops every running or starting instance of it and then releases both ports of all its pairs. `update`
  applies on the next start; a running instance shows "Restart to apply changes".

**Operator.** The operator switches entries on and off and deletes them in the app. Editing
stays with the agent, because typing a command on a phone is impractical.

**Preview sheet.** The Dev server tab lists "Your servers" first, one row per entry with a
switch, the state, and the network address while it runs. A crashed row is marked and links
to its logs. The arrow opens the detail view: state, address, and logs at the top, then the
two access cards ("On your network", "Over the internet"), then "Delete entry". Servers started past Verity follow under "Not managed" with "Save as entry", which asks the agent to create the entry rather than copying the detected command line: that line usually hard-codes its port and may carry secrets. The section disappears when empty. With no entries the tab says "No servers yet. Ask the agent to set up your app as
a server." The inline chat card and the green dot on the Preview icon keep showing running
entries.

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
- When a new listener appears in a session, the app shows a compact inline row: name and port,
  with "Open on network" and "Share online". "Open on network" creates the local share with one
  tap and opens the URL; "Share online" leads straight into step two of the sheet.

### 2.10 App flow: what first, then how

The sheet asks two questions one after the other and never mixes them.

**Step one, what.** Two tabs, because the two kinds of target behave differently.

- **Dev server.** Listeners running in the session, then other listeners of the project, then
  ports that still have an access although no server listens. Without any, the tab says so and
  suggests asking the agent to start one. A dot on the tab marks a running session server.
- **Static files.** The tab is the worktree explorer itself, starting at the root; there is no
  separate list of top-level folders. Folders that currently have an access are listed on top
  under "Shared now", so a deep share is found without walking the tree. The footer button
  picks the folder the explorer stands in. `index.html` is highlighted as the entry page.

The sheet opens on the server tab while a server or a port access exists, otherwise on the
static files. The default is decided once, when servers and accesses have loaded or after one
second at the latest; a server that starts later only marks its tab and never switches the
view. A Core without port detection shows the static files without tabs. Rows carry badges for
their active accesses, "On network" and "Online until HH:MM".

**Step two, how.** Two cards, stacked, because both can be active at once and each owns its
own state and actions. Each card names who can see the preview.

- **On your network.** Straight from the Verity server, at home or over VPN. No PIN and no TLS:
  the card says that anyone on that network can open it. "Open in browser" creates the local
  share on first use and hands reachability to the probe in 2.7, plus "Copy link". While a local
  share exists the card shows its URL and "Turn off".
- **Over the internet.** A link through the Uplink, protected by a PIN, expiring automatically.
  Without entitlement the card stays visible with a "Premium" badge, one sentence, and a link to
  settings; no dead button. While the Uplink is offline it says "Temporarily unavailable"
  instead. With entitlement and no link it shows the expiry picker and "Create link with PIN" as
  a secondary button, so opening on the network stays the one primary action on screen. With a
  live link it shows the link, the PIN, "Send link and PIN", "Copy link", the remaining time, and
  "Stop sharing". Stopping asks first.

**Vocabulary.** "Preview" is the thing. "Network" always means the server's own network;
"online" and "internet" always mean public through the Uplink with a PIN.

**Unreachable dialog.** When opening on the network cannot reach it, the way out leads: "Share
online" first, then "Copy local link", then cancel. Without entitlement the first option
becomes "Open settings" and the text names Verity Premium.

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
7. Managed dev servers (2.6): entries table and per-session pairs holding both ports and the command and subdirectory that last ran; supervised
   start, stop, state, and log capture in the project runtime; restart after sandbox
   recreation; `verity-dev-server` entry commands and agent-seed guidance; Preview sheet
   rows with switches, detail view with logs, and the not-managed section.
   Local publishing follows the interim approval rule under edge cases.

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
