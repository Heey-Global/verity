# Selected-session recording

Selected recording is an explicit diagnostic caller option. It does not change
normal admission or automatically select the first session. Source and offline
verification do not establish deployed capability or permission for a live run.

## Arming sequence

1. Use a paired administrator channel to Core that works independently of the
   App DATA connection being prepared, such as the existing paired local HTTPS
   transport. Keep the authenticated admission socket open.
2. Request ordinary admission. Uplink creates the authoritative session ID and
   delivers `session.request` to Core. After Core accepts, Uplink issues tickets:
   Core receives `session.ticket`; the caller receives `connect.ready` with the
   same full session ID. Hold the App ticket; do not open App DATA yet.
3. POST `/api/remote-control/recordings` over the independent paired administrator
   channel with `{runId, durationMs, diagnosticsVersion: 3, targetSessionId}`.
   `runId` is a fresh UUID, `durationMs` is 1–30000, and `targetSessionId` is the
   exact full ID from `connect.ready`. A hash is not accepted as a substitute.
4. Core requires a current authenticated reservation with an issued ticket and
   negotiated `remote-diagnostics-v3`. It binds local consent to that exact
   reservation identity, installation, session hash and fixed expiry, and sends
   the existing Uplink `diagnostics.start` command. The CONTROL receive handler
   continues processing while the independent administrator request awaits ACK.
5. Proceed only when the response has the same run/installation/session hash,
   `phase: "starting"`, and `selection.confirmed: true` with an unexpired
   preparation deadline. This means a validated `diagnostics.started` ACK in
   `preparing` state was received, not merely that a command was dispatched.
   Do **not** wait for `readiness.ready` before DATA: both sockets are needed for
   readiness. A missing, lost, expired or mismatched ACK cancels admission.
6. Open App DATA, then GET `/api/remote-control/recordings/{runId}/selection`.
   Only this asynchronous endpoint obtains fresh authoritative readiness. It
   requires an advancing revision, the selected session and unchanged bound
   socket generations. A changed pair, repeated revision or unreachable status
   ends local consent and requests Uplink Stop. Ordinary GET status preserves the existing status-refresh behavior and does
   not enforce the coordinator's additional freshness and socket continuity checks.
7. Only after fresh readiness should an independently authorized caller perform
   warmup or measurement. DELETE `/api/remote-control/recordings/{runId}` stops
   consent and requests Uplink Stop; GET the existing `/export` endpoint after
   Stop. Failure to retrieve a source remains explicit in the export.

The App helper `requestRemoteControlAdmission` implements the optional ticket hold
through `diagnosticArming: {runId, installationFingerprint, arm}`. `arm(sessionId,
signal)` must call the administrator endpoint above using the independent paired
channel and return its parsed JSON. It must honor the abort signal. The helper
checks the exact run, expected installation fingerprint, SHA-256/16 session hash,
confirmation and deadlines before resolving with the ticket. Thus existing callers
such as `remoteControlSmokeGet` cannot call native DATA attachment until the gate
succeeds. Normal callers that omit this option retain their existing behavior.
The concrete `createPairedSelectedRecordingArming` adapter constructs a separate
`VerityClient` using `createPinnedFetch(corePin, false)` and the existing paired
bearer-token provider. The `false` explicitly disables remote fallback, avoiding
recursive DATA attachment while arming. It invokes the authenticated V3 start
method and propagates the admission abort signal into the pinned HTTP request.
For an explicitly authorized controlled caller, the invocation is:

```ts
const diagnosticArming = createPairedSelectedRecordingArming({
  coreUrl: pairedDirectCoreOrigin,
  corePin: savedCorePin,
  getToken: () => pairedDeviceToken,
  runId,
  installationFingerprint,
  durationMs: 30000,
});
const admission = await requestRemoteControlAdmission({
  uplinkOrigin,
  installationHandle,
  diagnosticArming,
  signal: stopController.signal,
});
// Only now does this caller receive the ticket and open App DATA.
```

The adapter uses the saved pairing identity and direct HTTPS origin; it does not
supply or discover administrator credentials. If that direct channel is not
reachable, arming fails and App DATA remains unopened. The existing smoke caller
also accepts this adapter, but its immediate request is a test of the hold, not a
complete warmup/readiness coordinator. The later readiness barrier remains step 6.
The explicit `selectedRecordingAttempt` entrypoint in
`apps/mobile/lib/selectedRecordingAttempt.ts` implements one bounded controlled
attempt using the same paired direct administrator options. It arms the exact
admitted session, calls the existing native `VerityRemoteControlTunnel.start`
without the normal transport's immediate probe, and obtains two fresh selection
responses. Both must identify the same run, installation, selected session and
active socket pair with advancing readiness revisions and live deadlines. Any
socket identities already present in the arming ACK must also remain unchanged.
Only then does it issue one pinned `GET /healthz` through the returned listener.
There is no request retry, proxy fallback or soak. An existing active native
DATA tunnel is refused rather than replaced.

The attempt fixes capture at 30 seconds, bounds work at 60 seconds and warmup at
5 seconds, and reserves a separate 3-second cleanup budget. Status reads never
extend the earliest observed expiry or local monotonic deadline. The caller's
`AbortSignal` is the Stop control. Abort cancels the pinned request and stops
owned DATA; `finally` also requests recording Stop over the independent channel.
Cleanup requires an exact run/installation/session terminal receipt (`stopped` or
`expired`), both Core and Uplink stopped, no error and revoked selection/readiness.
After native Stop it also requires `isActive()` to return false. A resolved Stop
call alone does not satisfy either receipt. Cleanup failure is reported, not
converted to success. A late native attachment
is stopped before the coordinator permits another attempt. These are local
bounds; remote cleanup cannot be guaranteed when the administrator channel is
unreachable, so the server's fixed expiry remains necessary.

```ts
await selectedRecordingAttempt({
  uplinkOrigin,
  installationHandle,
  coreUrl: pairedDirectCoreOrigin,
  corePin: savedCorePin,
  getToken: () => pairedDeviceToken,
  runId,
  installationFingerprint,
  signal: stopController.signal,
});
```

The Diagnostics Connection recording section exposes this entrypoint as **Run bounded
connection test**, alongside separate Stop and Copy report actions. It requires the
active paired endpoint to be direct HTTPS with an available device token and checks
the authenticated descriptor against the saved remote installation. Administration
uses a separate pinned client with remote fallback disabled and bounded requests.
The V3 preparing ACK remains the authoritative capability gate; the descriptor's
ordinary remote-control capability does not establish V3 support.

The UI refuses an existing DATA tunnel. Its run reference is saved per paired
server before invocation; navigation or backgrounding aborts the attempt. Another
start is blocked while that reference remains. Copy validates the V3 export and
installation fingerprint; the reference is removed only after copy, terminal Core
and Uplink states and an inactive native tunnel are confirmed. Export failure
preserves the reference for another collection attempt. An authenticated export
404 with an inactive native tunnel clears an orphan reference without copying a
report. No ticket or device token
is saved in this reference. Copying places metadata on the device clipboard.

This entrypoint is opt-in source preparation, not permission to execute a live
attempt or proof that the installed native build supports it. Its one health
request verifies this diagnostic sequence, not normal session creation or message
sending.

There is no automatic diagnostic UI activation or fallback through an unarmed DATA
connection. The adapter must be explicitly configured by the controlled caller with its paired direct endpoint; normal app startup does not install them.

Uplink permits at most 15 seconds of preparation and 30 seconds of active capture.
Core consent has a fixed outer bound of preparation plus requested capture time;
none of duplicate starts, delayed ACKs, reconnects or status reads renew it.
Preparation expiry and Stop revoke local collection even if a remote call fails.
The ticket deadline and existing overall admission timeout also bound the caller.
Clocks are not calibrated by this protocol: UTC fields do not establish an offset
or support cross-host timing precision. Local monotonic limits remain authoritative.

## Association and export

Each Core `remote.return_path` summary can include `association`:

- `schemaVersion: 1`, `bindingSource: "authenticated_control_session_request"`.
- `processBootId`: random recorder module/process epoch, **not** OS boot identity,
  PID identity or an independently attested process lifetime.
- `socketLifetimeId`: a new UUID for each Core DATA WebSocket, or null before one
  exists. The exact reservation is separately bound in memory; neither a reused
  session ID nor reconnect can inherit that consent.
- `session` and `request`: lowercase SHA-256/16 fingerprints.
- `coverageStart`: `before_socket_creation` or `after_socket_creation`, plus
  `activatedAt` UTC. Core DATA may already be attached by arming time; late
  activation does not recover earlier frame or socket history.
- `socketEndpoints.local` and `.remote`: direct numeric IP/port pairs, or null
  when unavailable. These are the Core DATA socket, not local TLS ingress.
- `uplinkConnectionId: null`, `natAssociation: "unknown"`,
  `envoyAssociation: "unknown"`. Neither tuple/time proximity nor a Core UUID
  supplies an authenticated Uplink, NAT or Envoy connection join.

No payload, ticket, token, URL, header or arbitrary error text is exported.
First-send/callback allowlisted types and local-only callback meaning survive Core
and mobile support projection. Existing event/stream/byte limits and explicit
loss counters remain in force. V1/V2 starts and absent-selector behavior remain
compatible; an explicit V3 request never downgrades.

V3 Uplink export preserves full allowlisted metadata and every ordered page,
validates selected session and record sequence, and verifies canonical SHA-256
before returning it. The source fixture
`packages/events/src/fixtures/socket-evidence-v3.json` reproduces the Uplink
contract's preparing ACK, ready STATUS and finalized document. The shared `selectedEvidence*` schemas and canonical hashing functions own the
wire contract for start, status and exports; there is no separate V3 schema.
This integrity check is not proof of remote receipt or transport delivery.


## Verification scope

The integrated implementation is covered by scoped server tests for recording,
selection arming, reservation binding, association exports, authentication and
route scopes; mobile data tests cover strict exports and the dedicated recording
transport. App Jest tests cover admission hold, bounded attempts, stale or changed
readiness, cancellation, late native start and terminal cleanup receipts.

Targeted mutations removing Core socket continuity, reservation equality, the
selection baseline isolation and the native inactive check each fail their
corresponding guard tests. Source is
restored before final build, lint and formatting checks. Apple CI compiles and
runs offline native fixtures on the exact reviewed source SHA; an empty
`installation_handle` and `soak_seconds=0` disable the installed-session probes.
No source or fixture test establishes compatibility with an installed mobile
binary, a deployed Uplink, or a live selected-session recording.
