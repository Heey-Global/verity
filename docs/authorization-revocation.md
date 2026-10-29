# Execution authority after revocation

Gateway approvals do not replace the initiating user's project permissions.
Before invoking an adapter, the server checks the running turn's initiating
user against current project execution permission. Disabled users, removed
memberships, revoked execution permission, and failed lookups block dispatch.
An approval from another person does not restore these rights.

Turns that the server starts on a user's behalf carry that user as their
initiator:

- an accepted plan's implementation runs for the user who approved it in the
  app, or for the planning turn's initiator when it is approved from the
  conversation;
- save to project, a local merge and a rejected pull request merge run their
  follow-up turns for the user who asked for them;
- a Control handoff or a linked session message that starts a turn in the
  target session runs for the user behind the sending turn, and a saved
  linked-message approval answered later runs for the user who approves it.

A message folded into a turn that is already running is judged as part of
that turn. Gateway calls in these turns are checked against the target
project like any other turn, and a turn without an initiator is refused when
authentication is enabled. Pull request repair turns that Verity starts on its
own run for the user behind the session's most recent attributed prompt; a
session without one gets no initiator and is refused.

Scheduled automations check their sponsor before script execution, before
prompt dispatch, and at queued turn admission. A failed authority check skips
the run. Confirmation-time script checks carry the confirming user's identity.
With authentication enabled, missing identity is rejected. Local operation
without authentication retains unattributed execution; an attributed user must
still have current project permission.

Managed development servers persist the Doppler project/configuration identity
with secret-binding approval. Both approval dialogs display that provider
identity alongside the command and aliases, then submit the captured snapshot.
The manager rejects missing, unavailable or changed provider snapshots before
saving approval. On conflict the client refreshes the view and requires a new
explicit confirmation; it never automatically approves the replacement.

The manager checks the stored identity before resolution and again
before launch, including recovery. The resolver receives that approved identity
and refuses a different provider before fetching secrets. Refreshed values from
the same provider remain supported. Changing the provider requires fresh
approval, and the existing approval UI reports the old approval as invalid.

Migration `0167_managed_server_provider_authority` leaves existing provider
approvals unset. Existing secret-bearing entries must therefore be approved
again before their next start or recovery. Secret-free entries are unaffected.
No secret values are persisted in the approval metadata.

Older clients that omit the provider snapshot cannot approve secret-bearing
entries on a newer Core. Newer clients refuse these approvals when an older
Core does not supply provider metadata. Secret-free approval remains compatible.
Binding the dialog to the provider snapshot uses the existing approval storage
and requires no additional migration.

These checks guard new execution; they do not cancel an already running script,
stop an existing development server, retract delivered data, or undo an upstream
request. Database checks and external dispatch are not one atomic transaction.
Provider comparison uses project/configuration identity, not a revocation
generation: a change restored between checks is not detected. This is not a
network-access grant or a general authorization-kernel migration.
