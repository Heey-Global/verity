# ADR 0031: Multiple Doppler connections and bindings

- Status: accepted
- Date: 2026-11-24
- Amends: [ADR 0011](0011-pragmatic-secret-brokerage.md),
  [ADR 0023](0023-multi-user-projects-and-turn-identity.md)

## Context

An instance held exactly one Doppler token, and a project read secrets from
exactly one Doppler project and config. Real projects need more: the same
application's `stg` and `prd` configs side by side, a second Doppler project
such as a billing service, or configs that live in another Doppler workplace
behind a different token. Repository assignments already moved from one per
project to several; Doppler should follow the same shape.

## Decision

**Connections.** The instance holds any number of Doppler connections, each a
label and an encrypted token, typically one per Doppler workplace. Settings,
Services, Doppler lists them; adding one checks the token with Doppler and
records its workplace when Doppler reveals it. The former single token becomes
the connection `legacy-doppler`, and the old setting writes through to it.

**Bindings.** A project binds any number of Doppler project and config pairs,
each through one connection. Exactly one binding is the default whenever the
project has any; removing the default promotes the oldest remaining binding.
The same project and config cannot be bound twice, not even through two
connections, so every reference names exactly one binding. The former
`project_settings.doppler_project/config` columns mirror the default and the
old settings fields can replace the binding when there is at most one connection
and one binding. Ambiguous writes direct the user to the current connection picker. Bindings live in
`project_doppler_bindings`; the versioned secret-job catalog in
`secret_provider_bindings` keeps its own semantics and is not reused. Embedded
Secret Job catalogs use `secretJobs.doppler.connectionId` on new installations.
Existing catalogs default to the migrated legacy connection. Project default
changes do not change the catalog connection.

**References.** Agents write a secret as `NAME` for the default binding or as
`project/config/NAME` for any binding, the default included. There is no short
form with the config alone. Verity accepts only Doppler's classic names, which
never contain `/`, so the two forms cannot be confused. A reference whose
`project/config` is not bound fails with an error that names it and lists the
bindings that are connected; it never falls back to the default, where a secret
of the same name is the usual case. The turn context lists the default's names
bare and every other binding's in full.

**Approvals and grants.** An approval is bound to the bindings the call reads,
identified by binding ID, connection, Doppler project, config, and instance
token revision. Removing a binding invalidates its exact approvals, even if
another binding is added later for the same project and config. Adding
an unrelated binding leaves that approval in force.
Grants are kept under the binding's id together with the reference as written,
so a grant for `API_KEY` never covers `billing/dev/API_KEY`. A call reading
several bindings records which one resolves any bare references. A grant applies
while every referenced binding is still in place and bare references resolve to
the same binding. Existing grants move to the default binding on upgrade.
Managed dev servers check every referenced source against the saved approval
before launch and again after resolving secrets. Old approvals that identify
only a project and config require a new approval.

**Personal tokens.** ADR 0023 §3 applies per connection: each member connects
their own token for each connection the project's bindings use, and that token
must read every config bound through it. The administrator falls back to the
connection's instance token; nobody else ever does. The connect prompt the
agent receives stays a fixed text, because connection labels are written by the
administrator; project settings name the connection that needs a token.

**Removal.** Deleting a connection that projects still use is allowed after a
warning that lists those projects and bindings. In one transaction it removes
the connection, its bindings in every project, everyone's personal tokens for
it and the grants of those bindings. Agents that still reference such a binding
are told it is no longer connected.

**Access.** Connections are administrator-only. Members with read permission
see a project's bindings; adding, changing and removing them stays with
administrators, because adding one reads Doppler with a connection's instance
token.

## Consequences

Projects can read from several configs and Doppler projects, across workplaces,
without reusing one token for all of them. Existing installations keep working
without changes: their token becomes one connection and their config the
default binding, with grants and personal tokens carried over. Approval cards
for a call that reads several bindings list them instead of one project and
config. Older clients receive a conflict and an instruction to open the
current connection picker when a change is ambiguous.

## Rollout

Update Core and mobile together. Earlier mobile clients omit the authority
from dev-server approvals and must update to approve a secret-bearing server
on the new Core. Existing approvals without identifiable sources require
review again. Core stops an existing secret-bearing dev server whose launch
authority is unknown or stale, and a renewed approval applies only to a fresh
process. Secret-free dev servers do not require a provider authority.
