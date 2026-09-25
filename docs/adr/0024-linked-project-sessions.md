# ADR 0024: Explicit links for bounded project-session messages

- Status: accepted
- Date: 2026-09-25

## Decision

The user may link two existing sessions in different active projects from Session
settings. The link is an explicit, bidirectional information-flow grant for
agent-authored messages between that exact pair. It is separate from knowledge
folder grants: either agent may include information it can access in a message
to the other. The UI states this before the link is created. Unlinking revokes
future sends, while already delivered text remains in the receiving transcript.

Each direction initially permits six messages without another card. The server
reserves each send against a durable directional counter under a row lock and
deduplicates gateway retries by invocation id. The next attempted send after a
direction reaches zero raises a card showing its full message and target. An
approval sends that message and renews that direction for six messages; a denial
sends nothing. The counter is intentionally absent from the chat UI.

Project agents can list only their own linked peers and can send only to one of
them. The gateway bearer binds the call to the source session and turn. The
server resolves the destination from the stored link; the agent cannot name an
arbitrary session. Moving a session to another project removes its links.

The delivered prompt begins with a fixed, durable untrusted-agent envelope,
which remains present on backend switch and recovery. A structured peer origin
on the canonical prompt event carries source project, session and chat label.
The chat uses that origin to render a separate agent message, while showing the
agent's message body without the model-facing envelope. An ordinary user prompt
cannot acquire this styling by imitating the envelope text.

The existing Verity Control handoff remains one-way and approval-gated. Session
links do not expose transcripts or grant filesystem, secret, or tool authority.
They authorize exchange of the text an agent chooses to send; the receiver runs
with its existing authority.
