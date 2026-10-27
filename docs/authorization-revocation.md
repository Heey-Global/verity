# Execution authority after revocation

Gateway approvals do not replace the initiating user's project permissions.
Before invoking an adapter, the server checks the running turn's initiating
user against current project execution permission. Disabled users, removed
memberships, revoked execution permission, and failed lookups block dispatch.
An approval from another person does not restore these rights.

Scheduled automations check their sponsor before script execution, before
prompt dispatch, and at queued turn admission. A failed authority check skips
the run. Confirmation-time script checks carry the confirming user's identity.
With authentication enabled, missing identity is rejected. Local operation
without authentication retains unattributed execution; an attributed user must
still have current project permission.

Managed development servers persist the Doppler project/configuration identity
with secret-binding approval. The manager checks it before resolution and again
before launch, including recovery. The resolver receives that approved identity
and refuses a different provider before fetching secrets. Refreshed values from
the same provider remain supported. Changing the provider requires fresh
approval, and the existing approval UI reports the old approval as invalid.

Migration `0167_managed_server_provider_authority` leaves existing provider
approvals unset. Existing secret-bearing entries must therefore be approved
again before their next start or recovery. Secret-free entries are unaffected.
No secret values are persisted in the approval metadata.

These checks guard new execution; they do not cancel an already running script,
stop an existing development server, retract delivered data, or undo an upstream
request. Database checks and external dispatch are not one atomic transaction.
Provider comparison uses project/configuration identity, not a revocation
generation: a change restored between checks is not detected. This is not a
network-access grant or a general authorization-kernel migration.
