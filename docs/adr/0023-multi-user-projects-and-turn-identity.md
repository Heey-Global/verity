# ADR 0023 — Core multi-user projects and turn identity

**Status:** Proposed · **Date:** 2026-09-24 · **Revised:** 2026-09-25 (review round 1 completed)

**Related:** [ADR 0001](0001-model-backend-abstraction.md),
[ADR 0002](0002-credential-and-isolation-architecture.md),
[ADR 0006](0006-runner-in-sandbox-extraction.md),
[ADR 0007](0007-task-management-github-issues-projects.md),
[ADR 0008](0008-per-project-agent-memory.md),
[ADR 0009](0009-google-drive-sources.md),
[ADR 0010](0010-agent-credential-gateway.md),
[ADR 0011](0011-pragmatic-secret-brokerage.md),
[ADR 0014](0014-acp-secret-tools-approval-gated.md),
[ADR 0015](0015-cross-project-orchestration.md),
[ADR 0017](0017-docker-policy-gateway.md),
[ADR 0020](0020-project-sandbox-sleep-and-automatic-wake.md),
[ADR 0022](0022-knowledge-folder-and-retrieval.md)

## Context

Verity's existing single-user model treats paired devices as one authority and
uses the project as the sandbox trust domain. Adding individual logins alone
would leave provider accounts, repository access, secrets, and execution
authority shared implicitly.

Terminology: the person who runs an instance is its **instance administrator**.
Everyone invited to a project is a **team member**. This ADR does not use the
word "guest": a team member's rights come from project membership, not from a
lesser class of account.

The desired experience has three deployment variants:

| Variant                           | Execution location            | Project access                                    | Credentials                                                   |
| --------------------------------- | ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| Team server                       | A shared server               | Personal projects and explicitly shared projects  | Personal accounts, with explicitly authorized shared services |
| Personal server with team members | The inviting person's server  | Members access only invited projects              | Members bring their own accounts                              |
| Connected personal servers        | Each participant's own server | A shared project appears alongside local projects | Personal credentials remain on their home server              |

In every variant, project members can see all sessions in the shared project.
Any member with execution permission can submit the next turn in a session.
The submitting person's provider account is used for that turn. Project access
must never implicitly grant use of another person's accounts.

### Where the single-user assumption lives today

- The auth gate (`packages/server/src/server.ts`, `onRequest` hook) checks only
  that a bearer token is a known paired device and attaches no principal.
  `route-scopes.ts` states that a paired device is the one operator credential.
- `auth_tokens` has no user column. No table has an owner or tenant column;
  `projects.owner` is the GitHub repository owner. Actor columns exist only on
  `secret_jobs`, `secret_approvals`, `secret_provider_permissions` and
  `device_push_tokens`.
- `verity_settings` holds, side by side, personal and infrastructural values:
  Claude and Codex logins, the Google grant (`google_drive_refresh_token`,
  extended with Gmail scopes via `gmail_authorized`), `doppler_service_token`,
  git identity and the bot SSH signing key, transcription and OpenCode keys,
  the GitHub App private key and the Uplink key.
- The sandbox is one container per project, named `verity-<owner>--<repo>`.
  The credential gateway (ADR 0010) binds one mTLS client certificate to one
  `projectId`; the Runner runtime directory is `runners/<projectId>`.
- The mobile app stores exactly one server profile.

## Decision

Implement team access as one multi-user model. Design identities and resource
references to accommodate connected instances, but defer federation
implementation and its protocol to a subsequent ADR.

**Repository boundary.** This ADR specifies the self-hosted core, mobile app
and open Uplink protocol/client responsibilities. The hosted service owns paid
team access, subscription policy, entitlement issuance, invitation brokerage
and remote-control brokerage. Those decisions belong in the companion design
“Uplink team sharing and entitlement brokerage” in the private service's
architecture documentation. The core verifies service-issued authorization;
it neither implements billing nor decides which subscription qualifies.

Personal provider credentials stay on the executing Verity instance. Uplink
does not need them to broker membership or transport. An Uplink entitlement
permits use of a service feature; local project membership still determines
which resources a person may access.

This is a proposed target architecture, not a claim that the current runtime
already enforces these boundaries. Multi-user execution must remain disabled
until authorization and credential isolation are implemented together.

### 1. Users, project membership, and device authentication

Every paired device authenticates as a specific user. Device pairing and team
invitation are separate operations; inviting a team member must not mint an
instance-administrator credential.

Projects are private to their creator until explicitly shared. Membership
grants project access, with separate permissions for reading, executing turns,
and managing membership. An instance administrator manages the service, but
that role does not implicitly authorize application-level use of another
user's credentials.

**Project creation is build authority.** Creating a project provisions a
sandbox and may build a repository-supplied `devcontainer.json` on the host's
Docker through the policy gateway of ADR 0017. Team members cannot create
projects unless instance policy allows it; the default is administrator-only.
The same boundary applies to rebuilds: a `devcontainer.json` change committed
by any member's agent triggers a build under the same policy, never under a
member's own authority.

**The control-plane project is not shareable.** Verity's own control-plane
project runs with the Runner that holds the Docker socket (ADR 0006,
Amendment 1). It has exactly one member, the instance administrator.
Invitations to it are refused at the API, not merely hidden in the UI.

**Instance settings are administrator-only, including read access:** the GitHub
App private key, the Uplink key, the egress CA, the Docker policy, and the
self-update controls.

Authorization resolves the actual resource and its project. It must cover
session-ID routes, nested resources, lists, search, attachments, previews,
knowledge, streams, push notifications, and background work, not just routes
with a project-ID parameter. Unknown or inaccessible resources disclose no
project content. Unread state and notification preferences belong to users.

#### Project files, project knowledge, and optional shared knowledge

These are distinct scopes:

- **Project files** are shared live with project members as specified in
  section 5, including untracked and ignored files in the project directory.
- **Project knowledge** is always included in project sharing. Sources,
  insights, derived text and project memory (`overview.md`) from ADR 0022
  are visible to members with project read permission. Existing write
  boundaries remain: sandbox agents write only to `insights/`, and overview
  updates go through the broker. Sharing does not grant access to another
  project's private knowledge.
- **Project memory records its author.** Every overview update and every insight
  records the member who wrote it, or, for agent writes, the member whose turn
  produced it. Without that, a member's agent could leave text that later turns
  of other members read as guidance with no visible origin. Attribution is kept
  per revision and derived by the server, which requires insight writes to pass
  a server-mediated path that records each revision: a per-runtime knowledge
  mount the server attributes to its single owner (section 4), or a broker call
  with its execution context; sandbox-supplied author fields are ignored.
  Overwrites, renames and deletions through that path are attributed revisions
  as well, audited like a member's deletion. Work without an interactive turn
  (loops, delegated work) records the user it runs for; service-sponsored work
  writes memory only through the broker, which records the sponsor. Entries
  written before migration carry an unknown author rather than a fabricated one.
  Every member with project read permission sees the author; members with
  execution permission can delete the entry. The deletion is audited with the
  deleting member, the original author and a hash of the deleted content, so
  removed guidance keeps a traceable origin. Deletion from the memory store is
  final by design; the audit keeps no content. Copies elsewhere, such as
  backups, follow their own retention. Review stays after the fact as in ADR
  0008; no approval step is added before an entry becomes visible.
- **There are no private notes inside a project.** Everything in project
  knowledge and project memory is visible to all members. Personal material
  belongs in a personal project.
- **Instance-wide Shared Knowledge** is optional. When sharing a project,
  the instance administrator explicitly chooses whether to include it for
  that project. The default is not included. Mounts, explorer access and
  server-side reads enforce that choice; existing shared material must not
  silently become accessible to new team members.
- **Google Drive access** remains personal, as specified in section 3. Each
  member completes their own Google authorization, with a connection prompt
  during onboarding when the project has a Drive folder. Sharing a project
  does not share a Google grant or grant upstream folder permissions.

A Drive document already imported into project knowledge is shared project
content. Reading that local copy does not require the reader's Google
connection; accessing or refreshing content from Drive requires the acting
user's own authorized connection.

#### Invitations and onboarding

Sharing a project is a two-sided checklist built from the project's actual
configuration:

- **The inviter** sees every project connection that carries a credential
  (MCP connections, shared services) and decides per connection whether it is
  shared with the member or whether the member brings their own. Connections
  that can never be shared (Google, GitHub, Claude, Codex, Doppler) appear as
  a note of what the member must bring.
- **The administrator** also chooses whether to include instance-wide Shared
  Knowledge for this project; project files and project knowledge are already
  included in project sharing.
- **The member**, on accepting, sees which personal connections the project
  expects, marked _required_ or _optional_ (section 3), and is led directly
  into each connect flow. Until a required connection exists, the dependent
  features of that project are visible but locked for that member. Nothing
  falls back to the administrator's accounts.

### 2. Sessions are shared; execution authority belongs to the turn

All project members can read its sessions and history. Execution permission
allows a member to submit a turn, without transferring ownership of the
previous participant's accounts. Session creator metadata remains useful for
audit and does not determine who pays for subsequent turns.

Shared projects have no private sessions. This is deliberate: sessions share the
project files, the Git state and project memory, so a hidden session would still
expose its effects through the worktree, commits and memory, and a visibility
flag would promise protection it cannot give. Creating a session in a shared
project makes its history visible to every project member; the app states this
before creation. Sharing a previously personal project makes its existing
sessions, project memory, knowledge and audit history visible as well, and the
sharing flow says so before the first invitation is sent. A private project is
the place for work that should remain personal. Unread state and notification
preferences still belong to each user. Private sessions would require separate
working state as well as separate history to provide a meaningful boundary, so
they need a separate decision.

The server records an immutable execution context when accepting a turn:

- authenticated initiating user;
- project, session, and turn identifiers;
- execution instance and isolated runtime identity;
- selected backend and model, provider connection and its credential owner or
  shared-service grant;
- authorization generation used to fence revoked work.

Client-supplied user IDs or credential-owner fields are not authority. Queued
turns are authorized again before execution. Only one turn may mutate a given
session's working state at a time, including across reconnects and retries.
Other sessions can execute concurrently in their authorized runtimes.

**The backend belongs to the turn, not to the session.** Each turn runs with
the backend and model of its initiator. The model picker offers a member only
the backends for which they hold a personal connection. A session may
therefore alternate between Claude and Codex as members alternate; section 5
specifies continuity.

“Who starts the turn pays” means provider-account selection and attribution;
Verity does not promise how an external provider meters a subscription. Usage
records distinguish the initiator from the credential owner when a shared
service is explicitly selected.

Retries, tool calls, delegated work, and automatic follow-up actions retain the
initiating identity. Scheduled loops have an explicit sponsoring user and stop
when that user's authorization or credentials are unavailable. Cross-project
work additionally requires access to the destination project. It never adopts
the destination owner's credentials.

Another member cannot inject instructions into an active turn or answer its
credential approval on behalf of the initiator. Their message becomes a new
turn under their own identity. Administrative cancellation is a separate,
audited permission; it does not transfer execution authority.

### 3. Personal connections, with explicit shared-service exceptions

Every connection has, per project, one of three states: _not applicable_,
_optional_, or _required_. The state derives from the project (`projects.kind`
and its configuration), not from the member.

| Connection                                  | Scope                                            | Applicability                                                       | Required behavior                                                                              |
| ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Claude, Codex, and other AI providers       | User                                             | Required to start a turn                                            | Select the initiating user's connection; never fall back to the administrator                  |
| GitHub                                      | User                                             | Not applicable for `local` projects; optional for `github` projects | User-to-server token of the instance's GitHub App; the user's own repository permissions apply |
| Git author identity and signing key         | User                                             | Required for any commit that reaches GitHub                         | Author, committer and signature are the initiator's; see signing rule below                    |
| Google (Drive, Gmail, Docs, Sheets, Slides) | User                                             | Optional; required once the project has a Drive folder              | One personal grant per user via the app's PKCE flow (ADR 0009); never a shared service         |
| Doppler                                     | Membership (user × project)                      | Optional; required once the project binds aliases                   | Resolve aliases only through the initiator's own connection                                    |
| MCP connections carrying a credential       | Owner (user), optionally shared with the project | Optional                                                            | Active only in the owner's turns unless the owner shares it                                    |
| OpenCode provider access                    | User                                             | Optional                                                            | Bind both execution and upstream provider access to the user                                   |
| Transcription                               | User, or an instance service                     | Optional                                                            | Authorize the request and select that user's connection or the granted service                 |

**GitHub.** The instance keeps one GitHub App. Each user authorizes that App
once through GitHub's user authorization flow; Verity then mints
user-to-server tokens, which GitHub limits to the intersection of the App's
installation and the user's own repository permissions. The App private key
remains administrator-only. The git credential helper in the sandbox is
unchanged; the token route resolves the mTLS peer to user and project and
mints that user's token. Server-side GitHub calls (pull-request status,
issues per ADR 0007, branch lists) use the requesting user's token as well, so
Verity never shows a member what GitHub itself would not. Installation tokens
remain only for operations that belong to no user: webhook processing and
administrator-driven provisioning. GitHub access is not a prerequisite of project membership. Accepting an
invitation makes nobody a GitHub collaborator; missing GitHub permissions
block only the operations that require them, not local project participation.

**A member without a GitHub connection still works.** Their turns run, they
read sessions, use knowledge, edit documents and change the worktree. Commits
in the worktree carry their Verity profile name and email. Push, pull requests
and issue access fail with a prompt to connect GitHub; there is no fallback to
another member's access.

**Signing rule.** Every commit that reaches GitHub is signed by a developer.
Cryptographic signing and GitHub account verification are distinct. This
architecture requires a connected developer to sign commits before publication;
it does not claim that signing is technically impossible without GitHub.

- Verity mints an SSH signing key per user when they connect GitHub, shows the
  public key for registration at GitHub, and mounts the private key only into
  that user's sandbox. The existing bot signing key becomes the
  administrator's personal key (see Migration).
- A member without a developer connection produces **internal commits** only:
  they may commit in the worktree so that working state can be handed over,
  but those commits never leave the server. The member has no GitHub access
  and Verity does not push on their behalf.
- Before a developer's next turn in that session, Verity rewrites the internal
  commits on the session branch: the author stays the original member, the
  committer and signature become the developer's. From then on everything in
  the worktree is signed by the developer, and publication must still satisfy the repository's remaining branch rules.
- This is deliberate vouching. The signature says "I stand behind this
  change". The ADR states it openly, and the invitation UI tells a developer
  when sharing with a non-developer: "changes by this member will be signed
  with your key when you take over the session". Between two non-developers
  nothing is rewritten.

**Google.** Drive, Gmail, Docs, Sheets and Slides share one OAuth grant;
Gmail is a scope extension of the same refresh token. The grant is therefore
per user as a whole and is excluded from the shared-service exception: an
administrator may expose transcription or OpenCode as an instance service,
never Google. Gmail scopes are optional, but an expanded grant can include
mail access; no Google grant is shared regardless of its current scopes. The project's Drive
folder (`project_settings.google_drive_folder_id`) stays project
configuration and is accessed through the initiator's connection. A member
without a Google connection, or without rights on the folder at Google, gets a
connect prompt or a Google error, never the administrator's grant. Verity
does not broker access that Google itself has not granted: a shared folder
must be shared with the member on Google's side.

When a member joins a project with a configured Drive folder, onboarding
immediately presents the Google connection flow so they can authorize Verity
with their own Google account. The project keeps the same folder ID; the
member does not select or configure a second folder. After authorization,
Verity checks access to that exact folder using the member's connection.
An existing suitable Google connection is reused and checked without an
unnecessary repeat consent flow. Google OAuth authorizes Verity to act for
the member; it does not grant the member access to someone else's folder.
If access is missing, onboarding asks for the folder to be shared with that
Google account and offers a retry. Cancelling connection leaves local project
participation available while Drive-dependent features remain unavailable.

**Doppler.** Each member connects their own service token per project. Alias
names (`secret_aliases`) stay project configuration so agents see the same
names; resolution goes through the initiator's connection. Without a
connection, resolution fails with a connect prompt. The global
`doppler_service_token`, from which per-project tokens are minted today,
becomes the administrator's personal connection. Doppler token separation
does not by itself guarantee person-level upstream audit attribution; that
depends on the connection type. Verity records its own initiating identity.

**MCP connections.** `http_mcp_connections` carries credentials
(`authorization`, `oauth_client_secret`) and is bound to the project today.
Every connection with a credential gets an owner: the user who created it. By
default it is active only in the owner's turns. The owner can mark it _shared
with project members_; it is then a shared service in the sense below:
visible in the UI, attributed per use, revocable at any time. Credential-free
MCP servers remain project configuration. A member's personal MCP connections
are materialized through their own runtime directory (section 5), so an agent
in a member's turn sees only that member's connections plus the shared ones.

**Shared services.** An administrator may explicitly provide shared
OpenCode/provider access, transcription, or a shared MCP connection as an
instance or project service. Such a service has its own connection, allowed
users/projects, revocation policy, and usage attribution. Selecting it must be
visible in the UI. It is not an implicit fallback to an administrator's
personal account.

OpenCode is an execution backend, not itself a universal billing account. A
shared deployment must isolate its execution state and bind the actual
upstream provider connection; sharing an unscoped execution endpoint is not
sufficient.

Personal connection management is available to its owner. Instance-level
infrastructure keys remain administrator-only. Missing, expired, or unauthorized
connections fail closed and prompt the relevant user to configure access.
Credential refresh and caches are scoped to the connection, including on
server-side paths such as transcription, model discovery, and usage polling.
The single `claudeCredentialSync` of today becomes one sync per connection.

Secret approvals bind the approving user, connection, project, operation, and
applicable turn/session scope. A session-scoped approval by one participant
does not approve another participant's next turn.

**Audit attribution.** Turn records, secret-access events and approval records
identify the authenticated initiating user and the owner of the connection
actually used. Shared-service use records both identities rather than treating
the connection owner as the initiator. Approval records also identify the
approving user. Records include the connection or shared-service grant ID,
project, applicable session/turn, operation and outcome; credential values and
resolved secret contents are never audit payloads. Identity comes from the
server's authenticated execution context, not sandbox-supplied fields.

Implementation must extend the turn records, `secret_approvals` and
`secret_audit_events` consistently. The latter currently has no dedicated
actor column; attribution must be included in its integrity-protected event
payload as well as any query columns. Existing audit-chain entries remain
unchanged, with unavailable historical attribution treated as unknown rather
than fabricated.

**Membership changes are audited too.** Invitations, acceptances, permission
changes, removals, the inviter's per-connection sharing decisions, and the
administrator's Shared Knowledge inclusion are recorded with the acting user,
so every past access can be traced to the decision that allowed it.

**Audit visibility.** Members read the audit records of projects they belong to,
including entries from before they joined, matching their access to earlier
session history; the administrator reads all of them. Other members' personal
connections appear by kind and owning member; upstream account identifiers in
the signed payload are redacted when the record is read, not removed from the
chain. No product interface edits or deletes entries, including the
administrator's; the integrity chain makes a change made outside it detectable.

**User IDs are permanent.** A user ID is never reassigned. Deleting a user
leaves a tombstone carrying the display name and the public halves of the
user's signing keys, so historical records and earlier signed commits keep
resolving to the right person instead of to unknown or to a later user.

### 4. Execution isolation and gateway routing

**One sandbox container per user and project.** The container is the
credential boundary. The gateway and relay bindings identify both user and
project: one mTLS client certificate per (user, project), one relay sidecar
per container, one Runner runtime directory per (user, project). Broker
requests, the GitHub token route and the secret broker all resolve the peer to
the same (user, project) execution context. Sandbox-supplied headers,
environment variables, or account names cannot select another user's
connection.

Why a container and not a per-turn switch: the gateway keeps upstream provider credentials outside the sandbox
(ADR 0010), but the sandbox holds authority to use them. Signing material,
capabilities and credentials delivered by specific broker paths require their
own protection; this is not a claim that no secrets ever enter a sandbox. Anything running in
a container can send requests through that container's certificate, call the
token route and open the broker socket. A project-wide switch from one user's
credentials to another's is insufficient: concurrent sessions and surviving
background processes would inherit the new authority, and the gateway would
have to trust a process-supplied marker, which ADR 0010 forbids. Inside one
container, the Runner supervisor shares uid 1000 with the agent and is no
trust anchor against it. Separate containers give the gateway a second
certificate to decide on.

Container names or certificates alone are not the complete enforcement
mechanism. Mounts, capabilities, network paths, caches, and server-side
integrations must preserve the same boundary. Private homes, provider
configuration, signing material, capability files, sockets, and backend
runtime state must not be shared between users. Retained containers and
background processes keep their original identity; they never acquire the
credentials of the next session participant. Billable background activity
requires an explicit lifetime and sponsor. Otherwise authority ends with the
turn. Preview routing retains the originating runtime identity and checks the
viewer's project access.

Cheap hardening that only makes sense with this model: Verity sets
`core.hooksPath` in every sandbox to a Verity-owned directory so hooks left in
a worktree do not run, and treats agent settings files inside the worktree as
untrusted input.

Per-user containers sleep and wake like project containers (ADR 0020); a
member's container consumes memory only while that member works.

### 5. Shared working state and conversation continuity

**The whole project folder is mounted live into every member's container**,
exactly as it is mounted into the single project container today: the main
clone, every session worktree beneath it, untracked and ignored files, and
the project's `node_modules` volume. Members see one identical state at all
times; there is no transfer and no handoff commit. New sessions appear in
every member's container automatically because the project directory, not
individual worktrees, is mounted.

**The file boundary is deliberately not drawn.** What is shared is files; what
stays separate is the credential authority of section 4. A process left behind
by one member can leave files that the next member's turn executes under that
member's own authority — a git hook, an agent settings file, a `postinstall`
script from `npm install`. This is the same trust class as committed code that
another member's agent tests, and separate credentials cannot eliminate it.
Members who share a project share this trust, as GitHub collaborators do. Shared files can influence processes running with another member's authority,
including surviving dev servers. Such activity is not guaranteed to appear
in an agent transcript or to occur only during a turn. Separate containers
isolate private runtime state and direct gateway identities; they do not
prevent credential misuse induced by shared executable content. Broker
policies and approval checks still apply to those actions.

**Fencing is reduced to what it can deliver.** The Runner supervisor owns the
turn's processes (ADR 0006 D2) and terminates the turn's process group when
the turn ends. Dev servers may survive; that is their purpose, and they show
the live state the next turn changes. The turn lease remains the only write
lock, as it is today between sessions of one container.

**The runtime directory is per user.** Backend homes, placeholders, personal
MCP configuration and native session files live in `runners/<userId>/<projectId>`
and are never mounted into another member's container.

**Conversation continuity follows ADR 0001.** The server's event log is the
cross-backend truth and the server owns the verbatim transcripts:

| From → to       | Mechanism                                                                                                | Continuity                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Claude → Claude | Verbatim transcript materialized into the initiator's runtime directory, native resume                   | Lossless                                                                                                         |
| Codex → Codex   | Rollout bytes restored into the initiator's runtime directory (`ServerCodexTranscript.restoreForResume`) | Lossless                                                                                                         |
| Claude ↔ Codex  | Backend handoff rendered from the event log (ADR 0001 switch mechanics)                                  | Tool calls flattened to text; per-switch cost paid by the initiator; the app shows that a backend switch happens |

A member switch with the same backend is the Sandbox-recreation path of
ADR 0020 applied to a different runtime directory. A member switch with a
different backend is the mid-session model switch that ADR 0001 already
supports. Frequent alternation between members on different backends is
expensive and loses tool fidelity; the ADR names this rather than hiding it.

**Stale native state must be replaced, not reused.** Today `restoreForResume`
keeps an existing rollout or transcript file and materializes only when the
file is missing. In the multi-user case that is wrong: a member's runtime
directory still holds the file from their previous turn while another member
has advanced the session since. At every turn start the server re-materializes
the native state from the store when the last turn of the session ran in a
different runtime directory or the local file is shorter than the store. This
is a guard test in the verification list, because the current code would
silently resume the wrong state.

Shared code, hooks, instructions, transcripts, and knowledge remain untrusted
input. Shared history may also contain sensitive output: tool output in the
trusted mode of ADR 0011 can carry a secret value past redaction, and both the
readable transcript and the native state handed to the next member's backend
contain it. Credential separation does not make already published secret
values private, and redaction is not a guarantee. Sharing a project explicitly
shares its existing session history and project content; the invitation UI
must communicate this scope.

### 6. Trust, revocation, and vault lifecycle

The boundary protects personal authority from other ordinary users and their
agents. It does not protect credentials from the administrator of the machine
that stores and uses them. Team members on a shared server trust its
administrator. Users who require credentials to stay on their own hardware
need the connected instances model.

Login and project membership are separate from unlocking the instance vault.
Team members do not receive the master password. Personal connections may
remain encrypted under the instance-managed vault key; per-user password
wrapping is not a prerequisite for this model and would not remove
administrator trust. When the vault is locked, credential-dependent work cannot
proceed; after a restart, members depend on the administrator unlocking the
instance. The app distinguishes this instance-wide locked state from a missing
or expired personal connection and tells members: "The administrator needs to
unlock the instance." It does not prompt members to reconnect their accounts
or request the vault master password from them.

When a member's work is blocked by a locked vault, the administrator receives
one push notification per locked period that a team member is waiting for the
instance to be unlocked. Automatic unlock (key file, hardware-backed key)
changes the security of the whole instance and needs its own ADR; it is out of
scope here.

Removing membership or disabling a user invalidates queued work, active grants,
stream access, approvals, and relevant background work. Gateway and broker
revocation must be fenced against stale bindings after restarts. Cancellation
cannot undo a request already accepted by an upstream provider or retract
content a former member already downloaded.

Removing a membership deletes that member's membership-scoped connections for
the project (their Doppler token and the MCP connections they own there). Other
members who used one of those shared MCP connections are notified, and the
connection shows as required again until someone provides a replacement.
Deleting a user deletes all of their personal connections, including Claude,
Codex, Google, GitHub and their private signing key, and revokes the upstream
grants wherever the provider supports it. Their shared MCP connections are
handled in every project as on membership removal.

### 7. Uplink authorization contract and the app

The proposed [team protocol](../protocols/uplink-team-sharing-v1.md) specifies
negotiation, identities, invitation recovery and authorization lifecycle.
The [coordinated delivery plan](../uplink-team-sharing-delivery.md) assigns
paired Core/Uplink work and shared acceptance vectors. Both remain Proposed
until reviewed against the private service implementation.

**Two independent authorization checks.** The supported team workflow requires
both a valid Uplink sharing authorization for the instance and local user and
project permissions. Neither replaces the other. Direct access to the instance
uses the same team authorization checks as Remote Control.

**Service-issued authorization.** The target protocol supplies a signed,
time-bounded authorization bound to the instance identity, intended audience,
allowed capabilities, validity period and revocation generation. The core
validates these against trusted service keys and rejects forged, expired,
wrong-instance or wrong-audience assertions. Credentials identifying the
instance to Uplink are not themselves proof of a paid entitlement. Wire format,
key rotation and version negotiation must be specified in the open protocol
before implementation; issuance and commercial eligibility stay private.

**Invitation redemption is not administrator pairing.** The administrator
requests an invitation through Uplink. Redemption supplies an authenticated,
single-use result bound to the intended instance, project, joining identity
and approved role. The core checks local invitation authority and current
project policy before creating membership and binding the member's device.
Replays cannot create additional memberships or administrator credentials.
Uplink brokers this exchange; the core remains the authority for project
permissions and preserves the onboarding checklist in section 1.

**Remote Control is the default member transport.** The client and connector
consume the service's authorization for transport and preview capabilities.
A preview also requires the relevant local project permission. Subscription
bundling, limits and hosted relay admission are private service decisions,
not duplicated policy in the core.

**Outage, expiry and revocation are distinct.** A temporary Uplink outage does
not erase membership or invalidate an otherwise valid cached authorization.
Any offline allowance must have an explicit signed deadline; the core never
extends it locally. Once authorization expires, or explicit revocation is
received, team access is suspended on direct and relayed paths. The core
fences queued and active team work, streams and service grants using the
revocation mechanisms of section 6. Upstream actions already accepted cannot
be undone. Memberships, history and files remain stored, and the
administrator's personal work remains available. Renewal can restore access
only for memberships that still exist; it cannot resurrect a removed member.
The app distinguishes temporary service unavailability from expired or
revoked sharing authorization. Duration and renewal policy belong to Uplink.

**The app connects to any number of servers.** One profile per instance, one
account token per profile, bound to that server's identity as today; a person
may be a different user on each instance. The app presents one project list
across all profiles with the originating instance marked per project. Push,
attention and unread state are per profile, because they come from the
respective instance. A member who only belongs to one team and runs no
instance of their own sees exactly what they see today.

**Joining adds a member profile.** After invitation redemption and local
membership creation, the app adds the instance profile and runs connection
onboarding. Administrator pairing remains a separate operation. The hosted
Remote Control path avoids requiring a public inbound port on the instance.

### 8. Connected instances as a later extension

The intended experience is one project list containing local and shared remote
projects, with all authorized sessions visible. The app side of that (multiple
profiles, routing by instance and project identity) ships with the first team
release under section 7.

For a shared session across instances, each participant's turns execute on
their home instance using local credentials. Only authorized project/session
content and working state cross the connection; personal credentials do not.
Connected instances cannot share a live mount, so they need a git-based
transfer of working state between the instances' clones. That is a separate
mechanism from the live mount of section 5, not the same solution stretched
over both cases, and it runs over the same Uplink channel as Remote Control.
A future protocol must specify membership trust, canonical project authority,
ordered turns, writer fencing, state transfer, retries, disconnect behavior,
and revocation. Disconnected instances must not both advance the same session
independently.

Two clones of the same Git repository do not implement this behavior. Git does
not synchronize live session history, uncommitted state, or execution leases.

Open client, connector, transport, and protocol work can belong in this
repository. Paid hosted sharing brokerage, remote-control brokerage, billing,
entitlements, and managed operations remain outside its product boundary.
Federation is not a prerequisite for the first team release.

## Migration and delivery

Migration assigns every existing value to the instance administrator. Nothing
is shared by migration, and no future user gains access before the
administrator grants it.

| Existing value                                           | Becomes                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Claude login, Codex login                                | Administrator's personal connections                                              |
| Google grant including Gmail scopes                      | Administrator's personal connection                                               |
| `doppler_service_token` and per-project Doppler bindings | Administrator's personal Doppler connection and membership bindings               |
| Git identity and the bot SSH signing key                 | Administrator's personal git identity and signing key                             |
| Transcription key, OpenCode key                          | Administrator's personal connections, later optionally exposed as shared services |
| GitHub App and private key                               | Instance service, administrator-only                                              |
| Uplink key, egress CA, Docker policy                     | Instance service, administrator-only                                              |
| MCP connections carrying credentials                     | Owned by the administrator, not shared                                            |
| Existing device tokens                                   | Devices of the administrator                                                      |
| Existing projects, loops, schedules                      | Administrator as the only member and sponsor                                      |

The one visible change: commits are signed with the administrator's personal
key instead of a bot identity. Whoever wants to keep the bot identity registers
it as their own key. An instance with one user must otherwise behave exactly as
before; that is the acceptance test for step 1.

1. Create the initial administrator identity and apply the migration table.
   Preserve existing single-user behavior without granting future users legacy
   global access.
2. Introduce authenticated principals, project authorization, personal
   connection management, per-user notifications, and multi-server profiles
   in the app. Keep multi-user execution unavailable until all execution paths
   enforce the new identity.
3. Add per-user/project runtime isolation (containers, certificates, relays,
   runtime directories), gateway and broker bindings, the GitHub user-to-server
   token path, per-user signing keys, connection refresh isolation, revocation,
   and explicit shared-service grants.
4. Validate conversation continuity across runtime directories and the
   stale-state rule. Enable shared sessions with per-turn identity, visible
   attribution and the commit-signing rule, then team onboarding behind the
   Uplink sharing entitlement.
5. Specify connected-instance sharing separately.

## Verification required before enabling multi-user execution

- A non-member cannot discover project content through any resource route,
  stream, search result, preview, notification, or knowledge mount.
- Every project member can read every session and its history in a shared
  project; session creation and sharing a previously personal project
  communicate that visibility, the latter including memory, knowledge and audit
  history. Unread state and notification preferences remain per user.
- Project members see the same project files and project knowledge. Shared
  Knowledge is unavailable through mounts and APIs unless the administrator
  explicitly includes it for the project. An imported Drive document remains
  readable as project knowledge without borrowing its importer's Google grant;
  live Drive operations require the acting user's own connection.
- Without the administrator's inclusion, Shared Knowledge is unreachable both
  through the knowledge mount and through the ADR 0022 retrieval tools.
- Every overview update and insight written after migration names the member who
  wrote it or whose turn produced it, derived by the server even when the
  sandbox supplies a different author; a member with execution permission can
  delete it, and the deletion is audited.
- Two members alternate turns in one session: each turn uses the correct AI,
  Git, signing, Google and Doppler connection while preserving shared state.
  The second turn sees the complete state of the first even when the second
  member had resumed the session earlier (stale native state is replaced).
- Two members alternate with different backends (Claude, Codex): the handoff
  of ADR 0001 runs, the app shows the switch, and the cost is attributed to
  the initiator.
- Missing personal credentials fail rather than selecting the administrator's
  accounts. Shared services work only for explicitly authorized users/projects.
  Google is never selectable as a shared service.
- A commit by a member without a signing key never reaches GitHub without
  prior rewriting by a developer; after the rewrite the author is unchanged
  and the committer and signature are the developer's.
- A member without repository permission at GitHub cannot push or read
  through Verity what GitHub would deny them directly.
- A sandbox forging another user's identifiers, reading private runtime paths,
  or retaining processes across a handoff cannot obtain that user's authority.
  The existing cross-project peer-refusal smoke of ADR 0010 is extended to
  cross-user peer refusal.
- A team member without project-creation rights cannot trigger a project
  build or rebuild through the project routes or through cross-project
  orchestration (ADR 0015); the control-plane project refuses invitations.
- Concurrent sessions, retries, gateway restart, credential refresh, sleep/wake,
  and revocation preserve user identity and fence stale grants.
- Audit records distinguish the initiator, approving user and connection owner
  when a member uses a shared MCP service. Personal connections retain their
  own attribution; sandbox-supplied actor fields cannot override it, and secret
  values do not appear in audit payloads.
- Membership changes, sharing decisions and Shared Knowledge inclusion appear
  in the audit with the acting user. No product interface, including the
  administrator's, alters an entry. A change made outside it is detectable.
  Records of a deleted user still resolve to that user's tombstone.
- Approvals, delegated work, loops, and transcription retain the correct user
  or explicitly selected service sponsor.
- Revocation blocks queued and subsequent operations, including on already
  connected clients; prior accepted upstream effects are recorded accurately.
  Expired or revoked Uplink authorization suspends team access on direct and
  relayed paths without deleting memberships or content. A temporary outage
  preserves access within the signed validity window; renewal never restores
  a removed membership.
- Forged, wrong-instance, wrong-audience and expired service assertions fail.
  Invitation redemption is single-use and cannot elevate a member to instance
  administrator. Transport authorization alone grants no project access.
- With the vault locked after restart, credential-dependent operations remain
  blocked and the app tells members that administrator unlock is required,
  without prompting for personal reconnection or the master password. After
  administrator unlock, valid existing personal connections remain usable. A
  member blocked by the locked vault triggers one push notification to the
  administrator per locked period.
- Removing a membership deletes that member's Doppler token and owned MCP
  connections for the project; deleting a user deletes all of their personal
  connections and revokes upstream grants where supported. No deleted
  credential remains selectable for queued or background work. In both cases
  members who used a removed shared MCP connection are notified and see it as
  required again.
- An instance with a single user behaves identically before and after
  migration.

Security guards must be tested against deliberately broken bindings or checks,
not only the successful path. These are implementation acceptance criteria;
this documentation change does not establish that they currently pass.

## Consequences and alternatives

The open core's service checks define the supported product workflow, not a
barrier against modified forks. The hosted Uplink service enforces access to
its own paid brokerage and transport. Keeping team execution in the open core
does not make independent implementations technically impossible.

Team access has one implementation and one credential-selection rule: the
container belongs to the user, the turn runs in it, the credentials come from
there. Additional runtimes increase resource use; sleep/wake and per-user
quotas must account for that.

The administrator becomes an availability dependency: after a restart, every
member is blocked until the administrator unlocks the vault. While it is
unlocked, the server can decrypt every member's connections; the model
separates members from each other, not from the administrator. Members who
cannot accept that need connected instances (section 8).

A single project container with turn labels, or a gateway that switches the
active credential per turn, offers attribution but cannot isolate co-resident
untrusted processes: the sandbox holds the authority to use credentials even
while upstream provider credentials are normally injected outside it. Strong process isolation inside one
container (a uid per user with a privileged supervisor) is possible in
principle but collides with devcontainer conventions (sudo, shared volumes)
and the current no-setuid hardening; it is not selected.

Separate clones per member container with git-based handoff would draw a file
boundary between members, at the price of a commit per handoff and no live
shared state. It was rejected for the on-server case because members must see
one identical live state; it remains the mechanism for connected instances.

Session-owner-only execution avoids handoff but does not meet the requirement
that any authorized participant can start the next turn using their own account.
Independent instances collaborating only through Git remain useful, but do not
provide the proposed shared-session experience.
