# Verity documentation

Pick the section that matches what you want to do.

## I want to use Verity

- [Getting started](getting-started.md): install the Core, connect a browser
  or the iPhone/iPad app, sign in to your AI provider, and run the first
  session. Start here.
- [Connections](connections.md): what GitHub, Google Drive, secret managers,
  and other connections add, and how projects use them.
- [File connections](file-connections.md): working with Google Drive files
  inside a session.
- [Knowledge](knowledge.md): project knowledge folders and how agents use them.
- [Google Calendar](google-calendar.md) and
  [live meetings](attendee-live-meetings.md): calendar access and meeting
  transcripts.
- [Snapshot import](snapshot-import.md): bringing an existing source snapshot
  into a project.

## I run a Verity server

- [Deployment guide](../deploy/README.md): prerequisites, the installer,
  first-run setup, hardening, resource limits, data, and the environment
  reference.
- [Server updates and recovery](operations/server-updates-and-recovery.md):
  managed updates, companion handoff, failed updates, and a crash-looping
  Updater.
- [Security policy](../SECURITY.md): the security model, verifying a release,
  and known limitations.
- [Runbooks](runbooks): step-by-step procedures for specific recovery and
  compatibility situations.
- [Control diagnostics](control-diagnostics.md) and
  [CI diagnostics](ci-diagnostics.md): what the diagnostic reports contain.
- [Releases](releases.md) and [staging releases](staging-releases.md): how
  Server, app, and website releases are produced.
- [Telemetry](telemetry.md): what the public website collects.

## I want to develop Verity

- [Contributing](../CONTRIBUTING.md): development setup, checks, and the
  pull-request workflow.
- [Architecture decision records](adr): the decisions behind the current
  design, in order. Background reading, not setup instructions.
- [Protocols](protocols): the Uplink enrollment, sharing, and remote-control
  protocols.
- Concepts and design notes, also background reading:
  [structured agent lifecycle](STRUCTURED_AGENT_LIFECYCLE.md),
  [session worktree lifecycle](SESSION_WORKTREE_LIFECYCLE_CONCEPT.md),
  [brokered secrets](BROKERED_SECRETS_KONZEPT.md) and their
  [threat model](BROKERED_SECRETS_THREAT_MODEL.md),
  [attested tool channel](ACP_ATTESTED_TOOL_CHANNEL_DESIGN.md),
  [dev server sharing](DEV_SERVER_SHARING_CONCEPT.md),
  [backup and recovery](BACKUP_RECOVERY_CONCEPT.md),
  [tasks and quick capture](TASKS_AND_QUICK_CAPTURE_CONCEPT.md),
  [live meetings](LIVE_MEETING_CONCEPT.md), and the
  [design language](design-language.md).
- [Mobile demo](mobile-demo.md) and
  [mobile build performance](mobile-build-performance.md): working on the app.
- [Open-source readiness](open-source-readiness.md) and
  [public CI audit](public-ci-audit.md): the publication checklist and the
  audit of the public workflows.
