# Local mobile demo

The welcome screen's **Try demo** action opens the normal Verity screens using
an in-process API and session stream. Settings also offers this action on an
already connected installation. No server, AI subscription or sign-in is needed.
All agent responses and tool results are explicitly simulated.

The persistent demo banner provides **Reset demo** and **Exit demo**. Entry and
exit preserve the existing server profile, server address and credentials. The
demo cannot be entered while a meeting is recording or starting. Exit restores
the saved server's unprotected device token; protected tokens still require
the normal device unlock.
The
demo preference survives relaunch; sample data starts fresh on each launch.
Reset discards local demo changes, cancels pending replies and closes streams.
Changing mode remounts the routed app so memoized clients cannot retain the old
transport. Demo session IDs change on reset to avoid restoring stale drafts and
scroll positions.

## Feature coverage

| Surface | Demo behavior |
| --- | --- |
| Project and session overview | Sample project and conversation through the normal screens |
| New sessions and chat | Local creation, delayed simulated replies, approval decisions, stop, rename and model selection |
| Review changes | Sample Edit tool card and simulated button color change |
| Files | Browse sample directories, read and edit text files, download sample files |
| Knowledge | Sample document and project folder |
| Settings | Sample configuration; supported local preferences can be changed |
| External connections | Unconnected service status; sign-in requires a real server |
| Voice and live recording | Explain availability without requesting microphone access or recording |
| Push and meeting synchronization | Disabled; real notifications and meeting outboxes are not processed |
| Provisioning, remote control, publishing and other server operations | Explain that the action requires a connected server |

The example agent recognizes requests mentioning the button or its color and
demonstrates an Edit call. Other input receives a general explanation of the
sample project. The demo does not run arbitrary code or a language model.

## Implementation and verification

- `apps/mobile/lib/demoTransport.ts` owns fixtures, state, HTTP responses and
  live event replay. Unknown operations and foreign hosts fail locally; there
  is no fallback to network fetch.
- `apps/mobile/lib/demoMode.ts` owns the separate persisted mode preference and
  the revision that remounts the app on entry, reset and exit.
- `apps/mobile/lib/client.ts` and `socket.ts` inject the demo transports into the
  existing validating client and session models.
- Native OAuth, speech, meeting and push entry points prevent real service
  actions while the demo is selected.

Run `npm run build --workspace @verity/mobile`, then
`npm test --workspace @verity/mobile-app -- --runInBand` and
`npm run typecheck --workspace @verity/mobile-app`.

## Beta review walkthrough

1. On a fresh launch, tap **Try demo**. No demo username or password is needed.
2. Open the example conversation and inspect the sample change card.
3. Choose **Change the button color** or type the same request. Observe the
   simulated reply and tool result; inspect `src/Button.tsx` in Files.
4. Start another session, send a message and stop a response.
5. Browse the sample project's files and Knowledge, then reset or exit the demo.

This is a review access path, not a guarantee of Apple approval. External
integrations and native recording are not fully demonstrated by the local demo.
Before resubmitting, exercise this walkthrough on the actual iOS build, disclose
these limitations in review notes, and determine whether additional review
access is required. A new binary or compatible update containing the demo must
reach the build under review; repository changes alone do not update TestFlight.
