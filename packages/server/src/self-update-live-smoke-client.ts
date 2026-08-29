/**
 * The client side of the live self-update smoke's Gateway drain (ADR 0008's
 * acceptance gate: "existing long-lived WebSockets and in-flight broker requests
 * during Gateway drain, including forced close at the timeout").
 *
 * Everything else in that smoke observes the update from the operator's side of
 * it — journals, containers, digests, the routing decision. None of that can say
 * what an update costs the connections that were already open when it started,
 * because the driver holds none: it asks the Gateway a question per stage and
 * hangs up. This process is the missing party. It runs in its own container on
 * `verity-net`, reaches the deployment only through the Gateway — its public port
 * the way the app does, its internal one the way a sandbox's broker wrapper does —
 * and holds, across a real generation change:
 *
 *   - long-lived WebSockets on `/sessions/:id/stream`, the one upgraded route,
 *     authenticated the way a device authenticates (a token minted by the master
 *     password, presented in the query string a handshake cannot put in a header);
 *   - HTTP requests whose bodies are still being written when maintenance begins,
 *     so the Gateway's `activeRequests` is non-zero at the moment the drain starts
 *     and the drain has something to actually wait for;
 *   - one of those requests on the Gateway's OTHER listener, the internal one that
 *     carries `/internal/*`. The broker is the half of the deployment a sandbox
 *     talks to rather than the operator, it rides a different port, and the cutover
 *     has to switch it in step with the public one — so a drain that waited only
 *     for operator traffic would look identical here and be wrong.
 *
 * The broker call is `POST /internal/git/sign` with no capability, which a serving
 * Server refuses with its own 401 before it reads settings or touches the store.
 * That refusal is the assertion, not a limitation of it: signing needs a
 * project-bound Unix socket and a provisioned project, and this deployment has
 * neither, so nothing here can obtain a signature. What is being checked is the
 * channel — that a broker call already in flight is answered by the Server it was
 * routed to, that a new one during maintenance is refused by the Gateway instead,
 * and that the internal route reaches a Server again once the switch is done.
 *
 * The mode decides which half of the drain contract this run is about, because
 * one cutover cannot show both:
 *
 *   `polite`   — every held socket closes as soon as the Gateway starts refusing
 *                new work. The drain must therefore finish long before its
 *                deadline and force nothing.
 *   `stubborn` — the held socket ignores maintenance entirely. The drain must run
 *                its full budget and then take the connection away, which the
 *                client sees as an abrupt, unclean close.
 *
 * Both modes assert the same three things around that, on each channel: a request
 * that was already in flight comes back whole, a new request during maintenance is
 * refused with the Gateway's own 503 rather than routed at a Server that is being
 * taken away, and a fresh request to the SAME URL is served once the switch is done
 * — which is what a stable front door is for.
 *
 * A third mode is about what the client is left holding afterwards rather than
 * about the drain:
 *
 *   `catchup`  — the client owns a session in the store, streams its backlog,
 *                loses the socket to the cutover, and reconnects to the NEW
 *                generation with the cursor it had. Events written while the
 *                Server was unavailable — what a Runner does when it keeps
 *                working through an update — must arrive exactly once, and an
 *                operator action against that session must reach a definite
 *                verdict on both sides of the switch.
 *
 * That covers ADR 0008's "WebSocket disconnect/catch-up without event
 * duplication" as such. Of its "steer and permission ACK loss during cutover" it
 * covers the delivery half only: that an operator action is answered, refused
 * retryably, or answered again — never silently swallowed by a generation on its
 * way out. Whether a DECISION is lost or applied twice needs a parked prompt and
 * a held turn, so it needs a runner, and this deployment has none;
 * `two-server-cutover-postgres.test.ts` owns that half against two real Server
 * processes and a real Postgres, and nothing here replaces it.
 *
 * The assertions live here rather than in the driver on purpose: the contract is
 * about what a client observes, so the client is the only honest place to check
 * it. The process exits non-zero on the first violation and reports every step as
 * a single-line `gateway-client {json}` record, which is what the driver reads
 * back out of the container log.
 */
import { request as httpRequest } from 'node:http';
import { createPostgresDb, EventStore } from '@verity/store';

const GATEWAY_HOST = process.env.VERITY_SMOKE_GATEWAY_HOST ?? 'verity-managed-gateway';
const GATEWAY_PORT = Number(process.env.VERITY_SMOKE_GATEWAY_PORT ?? '8082');
/** The Gateway's second listener, the one `/internal/*` is reachable on. It is not
 *  published to the host — this client is on the deployment's own network, which is
 *  exactly where a sandbox's broker wrapper sits. */
const GATEWAY_INTERNAL_PORT = Number(process.env.VERITY_SMOKE_GATEWAY_INTERNAL_PORT ?? '8083');
const BASE_URL = `http://${GATEWAY_HOST}:${String(GATEWAY_PORT)}`;
const BROKER_URL = `http://${GATEWAY_HOST}:${String(GATEWAY_INTERNAL_PORT)}/internal/git/sign`;
/** A well-formed signing request that will never be signed: over TCP the socket
 *  carries no project identity, so the route refuses it before it reads anything.
 *  The payload is base64 because the route's schema says so — the request is
 *  rejected for the missing identity and for nothing else. */
const BROKER_BODY = { namespace: 'git', payload: Buffer.from('live smoke').toString('base64') };

/** WebSocket.OPEN — numeric to avoid instance-constant gaps, as in server.ts. */
const WS_OPEN = 1;

/** How often the client asks whether the front door is open. Fast enough that
 *  the polite half of the drain is decided by the Gateway rather than by this
 *  interval, slow enough not to be a load generator. */
const PROBE_INTERVAL_MS = 250;
/** One body byte per tick on every in-flight request. The point is only that the
 *  request never ends on its own — the Gateway's upstream socket has a 30 s
 *  inactivity timeout, so a body that trickles is safe where a body that pauses
 *  is not. */
const DRIP_INTERVAL_MS = 200;
/** Same reasoning for the upgraded sockets, which would otherwise sit silent for
 *  the whole cutover: a frame the Server ignores is still traffic. */
const KEEPALIVE_INTERVAL_MS = 2_000;
/** How long the client keeps its work open after the front door closes. Without
 *  it the drain would usually find nothing left to wait for — the client would
 *  have let go before the Updater got around to asking — and "the drain waited
 *  for in-flight work" would be an assertion about scheduling luck. With it, the
 *  requests below demonstrably straddle the boundary. */
const HOLD_AFTER_MAINTENANCE_MS = 5_000;
/** A handshake through the Gateway to a Server that is already serving. */
const ATTACH_TIMEOUT_MS = 30_000;
/** Long enough to cover any drain budget the smoke passes, so a socket that is
 *  never forced fails as a missing close rather than as a hung process. */
const CLOSE_TIMEOUT_MS = 120_000;
/** The whole run, so a cutover that never reaches the client is a failure with a
 *  reason rather than a container the driver waits on forever. */
const DEADLINE_MS = Number(process.env.VERITY_SMOKE_CLIENT_DEADLINE_MS ?? '300000');
/** How much backlog the `catchup` session carries into the cutover, and how much
 *  is written while there is no Server to write it to. Both are small on purpose:
 *  the assertion is about which events a reconnect delivers, not about volume,
 *  and more of them would only make a mismatch harder to read. */
const SEEDED_BEFORE_CUTOVER = 4;
const SEEDED_WHILE_UNAVAILABLE = 3;
/** The tool-use id the operator action is answered under. Nothing is ever parked
 *  under it — no runner exists in this smoke — so the expected verdict is the
 *  route's own "no pending permission", which is the point: a definite answer. */
const ACK_TOOL_USE_ID = 'live-smoke-permission';
/** How long cleanup may take before it is abandoned. Cleanup runs on the failure
 *  path too, where the verdict is already decided and the only thing left that
 *  matters is reporting it — so it gets a bound rather than the chance to
 *  outlive what it is cleaning up after. */
const CLEANUP_TIMEOUT_MS = 30_000;

function report(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`gateway-client ${JSON.stringify({ event, ...detail })}\n`);
}

function fail(message: string): never {
  throw new Error(message);
}

function expect(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) fail(`${name} must be set`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A device token, minted the way the app mints one: prove the master password,
 * get a bearer back. The WebSocket route needs it in the query string, and the
 * in-flight requests need it in the header — a token that only works for one of
 * those would prove nothing about the other.
 */
async function mintDeviceToken(password: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/secret/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, deviceLabel: 'live-smoke-gateway-client' }),
  });
  const body = (await response.json()) as { status?: unknown; token?: unknown };
  if (!response.ok || typeof body.token !== 'string')
    fail(`the Gateway would not mint a device token (${String(response.status)})`);
  return body.token;
}

interface ClosedSocket {
  readonly code: number;
  readonly clean: boolean;
}

interface HeldSocket {
  readonly label: string;
  /** Resolves on the Server's `caught_up` frame with its watermark — the proof
   *  that this upgrade reached a real Server rather than stopping at the Gateway. */
  readonly caughtUp: Promise<number>;
  readonly closed: Promise<ClosedSocket>;
  /** Every `seq` this socket was sent, in arrival order. Empty for the drain
   *  modes, which stream a session that has no events. */
  readonly received: number[];
  /** Ask for the close from this side; the polite half of the contract. */
  close(): void;
}

/** Which stream to open, for a client that has a session of its own. Defaults to
 *  the drain modes' behaviour: a synthetic id, from the beginning. */
interface StreamCursor {
  readonly sessionId?: string;
  readonly sinceSeq?: number;
}

/**
 * One long-lived stream, held open through the Gateway for as long as this
 * process wants it. `/sessions/:id/stream` accepts any well-formed session id and
 * answers with a backlog and a `caught_up` watermark, so no session has to exist
 * for the connection to be a real, authenticated, Server-terminated WebSocket.
 */
function hold(label: string, token: string, cursor: StreamCursor = {}): HeldSocket {
  const sessionId = cursor.sessionId ?? `live-smoke-${label}`;
  const since = cursor.sinceSeq === undefined ? '' : `&sinceSeq=${String(cursor.sinceSeq)}`;
  const url =
    `ws://${GATEWAY_HOST}:${String(GATEWAY_PORT)}/sessions/${sessionId}/stream` +
    `?access_token=${encodeURIComponent(token)}${since}`;
  const socket = new WebSocket(url);
  const received: number[] = [];
  let announceCaughtUp: (seq: number) => void = () => undefined;
  const caughtUp = new Promise<number>((resolve) => {
    announceCaughtUp = resolve;
  });
  const keepalive = setInterval(() => {
    if (socket.readyState === WS_OPEN) socket.send('{"k":"live-smoke-keepalive"}');
  }, KEEPALIVE_INTERVAL_MS);
  const closed = new Promise<ClosedSocket>((resolve) => {
    socket.addEventListener('close', (event) => {
      clearInterval(keepalive);
      resolve({ code: event.code, clean: event.wasClean });
    });
  });
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as { k?: unknown; seq?: unknown };
    // Recorded in arrival order, unfiltered: the catch-up assertions are about
    // duplicates and gaps, so anything this socket was sent has to be visible to
    // them — including a seq the client had already seen, which is the failure.
    if (frame.k === 'event' && typeof frame.seq === 'number') received.push(frame.seq);
    if (frame.k === 'caught_up') announceCaughtUp(typeof frame.seq === 'number' ? frame.seq : -1);
  });
  // A socket the Gateway destroys surfaces as an error AND a close; the close is
  // what the contract is about, so the error only has to not be fatal here.
  socket.addEventListener('error', () => undefined);
  return {
    label,
    caughtUp,
    closed,
    received,
    close: () => {
      socket.close(1000, 'live smoke');
    },
  };
}

interface InFlightAnswer {
  readonly status: number;
  readonly body: string;
}

interface InFlightRequest {
  readonly label: string;
  /** Resolves once the request is on the wire, so "in flight" is something the
   *  Gateway has already counted rather than something this process intends. */
  readonly started: Promise<void>;
  /** What this request's own answer looks like when it survived the drain whole. */
  verify(answer: InFlightAnswer): void;
  /** End the body and read the whole answer back. */
  complete(): Promise<InFlightAnswer>;
}

/**
 * Where an in-flight request goes and what a Server's answer to it looks like.
 * The two channels differ in port, in who is meant to call them, and in the
 * answer they give — but not in how they are held open, which is the property
 * the drain is being asked about.
 */
interface InFlightTarget {
  readonly port: number;
  readonly path: string;
  readonly headers: Record<string, string>;
  /** The body up to the field the drip writes into; `"}` closes it again. */
  readonly bodyPrefix: string;
  verify(answer: InFlightAnswer, label: string): void;
}

/**
 * The operator-facing channel. `POST /github/app/validate` is the target because
 * it is authenticated, ignores its body, touches nothing, and answers the same way
 * every time — an in-flight request that changed the deployment would make the
 * drain assertion the smallest part of what it proves.
 */
function publicCall(token: string): InFlightTarget {
  return {
    port: GATEWAY_PORT,
    path: '/github/app/validate',
    headers: { authorization: `Bearer ${token}` },
    bodyPrefix: '{"pad":"',
    verify: (answer, label) => {
      expect(
        answer.status === 200,
        `the ${label} in-flight request answered ${String(answer.status)}`,
      );
      const parsed = JSON.parse(answer.body) as { ok?: unknown };
      expect(
        typeof parsed.ok === 'boolean',
        `the ${label} in-flight answer did not survive: ${answer.body}`,
      );
    },
  };
}

/**
 * The sandbox-facing channel, on the Gateway's internal listener. The extra `pad`
 * field is what the drip writes into; the route parses its body only after it has
 * decided the caller has no identity, so the padding never reaches a schema.
 */
function brokerCall(): InFlightTarget {
  return {
    port: GATEWAY_INTERNAL_PORT,
    path: '/internal/git/sign',
    headers: {},
    bodyPrefix: `${JSON.stringify(BROKER_BODY).slice(0, -1)},"pad":"`,
    verify: (answer, label) => {
      expectBrokerServed(`the ${label} in-flight broker call`, answer);
    },
  };
}

/**
 * A request that is genuinely in flight: headers are through, so the Gateway has
 * counted it and routed it, and the body is still being written, so nothing but
 * this process can decide when it ends.
 *
 * Fastify buffers the body before the handler runs, which is exactly the property
 * being used: the answer cannot arrive until the body does.
 */
function startInFlightRequest(label: string, target: InFlightTarget): InFlightRequest {
  const request = httpRequest({
    host: GATEWAY_HOST,
    port: target.port,
    method: 'POST',
    path: target.path,
    headers: { 'content-type': 'application/json', ...target.headers },
  });
  const started = new Promise<void>((resolve, reject) => {
    request.once('error', reject);
    // No content-length, so this is a chunked body whose end is ours to choose.
    // The write callback is what `started` waits on: it fires once the headers
    // and this first chunk have reached the socket, so the request is on the
    // wire rather than queued behind a connection that has not opened yet.
    request.write(target.bodyPrefix, () => {
      resolve();
    });
  });
  const drip = setInterval(() => {
    if (!request.writableEnded && !request.destroyed) request.write('.');
  }, DRIP_INTERVAL_MS);
  const answered = new Promise<InFlightAnswer>((resolve, reject) => {
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.once('error', reject);
  });
  return {
    label,
    started,
    verify: (answer) => {
      target.verify(answer, label);
    },
    complete: async () => {
      clearInterval(drip);
      if (!request.writableEnded && !request.destroyed) request.end('"}');
      return answered;
    },
  };
}

interface FrontDoor {
  readonly status: number;
  readonly body: string;
}

/** One look at the front door. A Gateway that is closing, switching or gone is a
 *  status or a transport error; both are "not serving" to a client. */
async function frontDoor(): Promise<FrontDoor | undefined> {
  try {
    const response = await fetch(`${BASE_URL}/healthz`);
    return { status: response.status, body: await response.text() };
  } catch {
    return undefined;
  }
}

/** One look at the broker channel, the way a sandbox wrapper looks at it: a
 *  signing request on the internal port. Same shape of answer as the front door,
 *  because to a caller "not serving" is a status or a transport error either way. */
async function brokerDoor(): Promise<FrontDoor | undefined> {
  try {
    const response = await fetch(BROKER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BROKER_BODY),
    });
    return { status: response.status, body: await response.text() };
  } catch {
    return undefined;
  }
}

/**
 * A broker call that reached a Server and was answered by it: 401, because this
 * client connected over TCP and carries no project identity, and the route refuses
 * that before it reads settings or touches the store.
 *
 * The refusal is deliberately the Server's own and not the Gateway's, so the two
 * are told apart by more than a status: a 503 `server maintenance` is the Gateway
 * answering for a backend it is taking away, and this is a backend answering for
 * itself. Parsed rather than matched as text, so a truncated body — the failure an
 * in-flight assertion exists to catch — is a failure rather than a substring hit.
 */
function expectBrokerServed(what: string, answer: InFlightAnswer | undefined): void {
  expect(answer !== undefined, `${what} was never answered`);
  expect(
    answer?.status === 401,
    `${what} answered ${String(answer?.status)}: ${String(answer?.body)}`,
  );
  let parsed: { error?: unknown };
  // A body that does not parse is the truncation this assertion is looking for, so
  // it has to read as that rather than as a SyntaxError from inside the client.
  try {
    parsed = JSON.parse(answer?.body ?? '') as { error?: unknown };
  } catch {
    parsed = {};
  }
  expect(parsed.error === 'unauthorized', `${what} did not survive: ${String(answer?.body)}`);
}

/**
 * The broker channel, given a moment to follow the switch.
 *
 * A Server opens its public listener before its internal one (`main.ts`), and the
 * Gateway leaves maintenance on a readiness probe that only asks the public port —
 * so a candidate can be answering `/healthz` a few milliseconds before its broker
 * listener exists. Bounded and short, because what must not happen is the internal
 * route never reaching a Server, not that it reaches one on the first try.
 */
async function waitForBrokerDoor(deadlineAt: number): Promise<InFlightAnswer | undefined> {
  for (;;) {
    const seen = await brokerDoor();
    if (seen?.status === 401 || Date.now() >= deadlineAt) return seen;
    await sleep(PROBE_INTERVAL_MS);
  }
}

async function waitForFrontDoor(
  accept: (seen: FrontDoor | undefined) => boolean,
  deadlineAt: number,
  message: string,
): Promise<FrontDoor> {
  for (;;) {
    const seen = await frontDoor();
    if (accept(seen)) return seen ?? { status: 0, body: '' };
    if (Date.now() >= deadlineAt) fail(message);
    await sleep(PROBE_INTERVAL_MS);
  }
}

interface RouteAnswer {
  readonly status: number;
  readonly body: string;
}

/**
 * One operator action against the seeded session, sent the way the app sends it:
 * an answer to a permission prompt, addressed by session and tool-use id.
 *
 * Nothing is ever parked under {@link ACK_TOOL_USE_ID} — this smoke has no runner
 * to park it — so a serving Server answers 404 `no pending permission`. That is
 * the assertion, not a limitation of it: the failure being ruled out is an action
 * that reaches a Server mid-cutover and is neither performed nor refused, and a
 * 404 whose text names the tool-use id proves the route ran against durable
 * session state rather than being swallowed by a generation on its way out.
 */
async function ackPermission(sessionId: string, token: string): Promise<RouteAnswer | undefined> {
  try {
    const response = await fetch(
      `${BASE_URL}/sessions/${sessionId}/permissions/${ACK_TOOL_USE_ID}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ behavior: 'deny', message: 'live smoke' }),
      },
    );
    return { status: response.status, body: await response.text() };
  } catch {
    return undefined;
  }
}

/** A definite verdict on the operator's action: the session is known, and the
 *  prompt under that id is not pending. Both halves matter — a `session not
 *  found` would mean the generation answering had lost the state the action was
 *  about, which is the same loss as no answer at all.
 *
 *  Told apart by the tool-use id rather than by the prose: the "nothing pending"
 *  404 names the id and the "unknown session" 404 does not, which is the part
 *  `server.test.ts` pins. Matching the sentence would couple this smoke to
 *  wording nothing else depends on. */
function expectSettledAck(when: string, answer: RouteAnswer | undefined): void {
  expect(answer !== undefined, `the operator action ${when} was never answered`);
  expect(
    answer?.status === 404 && answer.body.includes(ACK_TOOL_USE_ID),
    `the operator action ${when} answered ${String(answer?.status)}: ${String(answer?.body)}`,
  );
}

interface SeededSession {
  readonly sessionId: string;
  /** Append events the way a Runner does — straight into the store, with no
   *  Server in the path — and return the seqs they were given. */
  append(label: string, count: number): Promise<number[]>;
  close(): Promise<void>;
}

/**
 * A session this client owns, in the same database the deployment reads.
 *
 * The Runner writes a turn's events into the store and the Server serves them;
 * that seam is what makes the interesting case reproducible here. Writing
 * directly is how this process plays the half of the system that keeps working
 * while the Server is being replaced — the case where an update could plausibly
 * lose or duplicate events, because nothing that produced them was ever asked to
 * stop.
 */
async function seedSession(): Promise<SeededSession> {
  const db = createPostgresDb(required('VERITY_SMOKE_DATABASE_URL'));
  const store = new EventStore(db);
  // Unique per run: `sessions.worktree` is UNIQUE, so a second client against a
  // database the smoke did not recreate must not collide with the first.
  const sessionId = `live-smoke-catchup-${String(process.pid)}-${String(Date.now())}`;
  await store.createSession({ sessionId, worktree: `/tmp/${sessionId}`, model: 'live-smoke' });
  // The message projection each append kicks off is a background tail on this
  // same pool. Letting it settle is what makes `close()` safe: destroying the
  // pool underneath it would turn a green run into a stray error line.
  const settle = (): Promise<void> => store.waitForMessageProjectionIdle();
  return {
    sessionId,
    // Assistant text, never `prompt`: a Server recovers a session whose trailing
    // events are unanswered prompts by re-running them
    // (`Conductor.recoverOrphanTailPrompts`), so a seeded backlog of prompts
    // would have the new generation try to start a real turn in a worktree that
    // does not exist — and append its own events to the session this stage is
    // counting. Assistant output is the shape a completed turn actually leaves
    // behind, and it is inert on startup.
    append: async (label, count) => {
      const seqs: number[] = [];
      for (let index = 1; index <= count; index += 1) {
        const appended = await store.appendEvent(sessionId, {
          t: 'text',
          delta: `${label} ${String(index)}`,
        });
        seqs.push(appended.seq);
      }
      await settle();
      return seqs;
    },
    close: async () => {
      await settle();
      await db.destroy();
    },
  };
}

/**
 * What a replay is allowed to contain: exactly the events written since the
 * cursor, each once, in order. `seq` is a global sequence rather than a per-
 * session counter, so the expectation is the seqs the writes actually got — a
 * contiguity assumption would fail on any concurrent session instead of on the
 * bug this is looking for.
 */
function expectDelivered(
  label: string,
  got: readonly number[],
  want: readonly number[],
  sinceSeq: number,
): void {
  expect(
    new Set(got).size === got.length,
    `the ${label} replay delivered an event twice: ${got.join(',')}`,
  );
  expect(
    got.every((seq) => seq > sinceSeq),
    `the ${label} replay re-sent events at or below the cursor ${String(sinceSeq)}: ${got.join(',')}`,
  );
  expect(
    got.every((seq, index) => index === 0 || seq > got[index - 1]!),
    `the ${label} replay was not monotonic: ${got.join(',')}`,
  );
  expect(
    got.length === want.length && got.every((seq, index) => seq === want[index]),
    `the ${label} replay delivered ${got.join(',') || 'nothing'} rather than ${want.join(',')}`,
  );
}

/**
 * ADR 0008's "steer and permission ACKs are not lost across the cutover" and
 * "WebSocket disconnect/catch-up without event duplication", from the only place
 * that can observe either: a client with a cursor and a session of its own.
 *
 * The semantics of a steer that loses its owner mid-turn are covered against two
 * real Server processes in `two-server-cutover-postgres.test.ts`, which can park
 * a prompt and hold a turn — neither of which exists in this deployment, since
 * nothing here runs an agent. What only a live run can show is the part in
 * between: the same host and port, a different generation behind them, and a
 * client that has to be told what happened to the work it was waiting on.
 */
async function runCatchupClient(token: string, deadlineAt: number): Promise<void> {
  const session = await seedSession();
  const opened: HeldSocket[] = [];
  try {
    const before = await session.append('before the cutover', SEEDED_BEFORE_CUTOVER);
    const stream = hold('catchup', token, { sessionId: session.sessionId, sinceSeq: 0 });
    opened.push(stream);
    const watermark = await withDeadline(
      stream.caughtUp,
      ATTACH_TIMEOUT_MS,
      'the seeded stream never reached a Server through the Gateway',
    );
    expectDelivered('first', stream.received, before, 0);
    expect(
      watermark === before[before.length - 1],
      `the stream caught up at ${String(watermark)} rather than at ${String(before[before.length - 1])}`,
    );
    // The driver waits for this line before it starts the update, exactly as it
    // does for the drain modes; `inFlight` is zero because this run is about the
    // cursor rather than about the drain, and the drain has its own two stages.
    report('attached', {
      mode: 'catchup',
      streams: 1,
      inFlight: 0,
      sessionId: session.sessionId,
      seeded: before.length,
      caughtUpAt: watermark,
    });

    // The same action before the update, so the one after it is a comparison
    // rather than a lone reading.
    expectSettledAck('before the update', await ackPermission(session.sessionId, token));
    report('ack-before', {});

    const refused = await waitForFrontDoor(
      (seen) => seen !== undefined && seen.status === 503,
      deadlineAt,
      'the Gateway never entered maintenance',
    );
    const refusedAt = Date.now();
    expect(
      refused.body.includes('server maintenance'),
      `the Gateway refused with an unexpected body: ${refused.body}`,
    );
    report('maintenance', { status: refused.status });

    // Sent while the stream is still held, so the drain is still waiting on this
    // client and the deployment cannot have left maintenance underneath the
    // question. An operator action in this window must be refused by the Gateway
    // itself: a 503 is retryable and visible, and it is the only honest answer
    // while the Server that would perform it is being taken away.
    const during = await ackPermission(session.sessionId, token);
    expect(
      during !== undefined && during.status === 503 && during.body.includes('server maintenance'),
      `the operator action during maintenance answered ${String(during?.status)}: ${String(during?.body)}`,
    );
    report('ack-refused', { status: during?.status });

    // The window the whole stage exists for: work completes while the deployment
    // is refusing every request it is offered — "Runner completion while the
    // Server is unavailable". Written here rather than after the switch so the
    // window is the maintenance the client just proved, not a race with the
    // route flip: nothing about the update waits for these writes, and the only
    // record of them is the store.
    const offline = await session.append('while the Server was away', SEEDED_WHILE_UNAVAILABLE);
    report('appended-while-unavailable', { seqs: offline });

    await sleep(HOLD_AFTER_MAINTENANCE_MS);
    stream.close();
    const closed = await withDeadline(
      stream.closed,
      CLOSE_TIMEOUT_MS,
      'the seeded stream never closed',
    );
    report('stream-released', { code: closed.code, afterMaintenanceMs: Date.now() - refusedAt });

    await waitForFrontDoor(
      (seen) => seen !== undefined && seen.status === 200,
      deadlineAt,
      'the Gateway never served again after the switch',
    );

    // Same URL, same token, same cursor, a generation that has never seen this
    // client. Everything written while it was away must arrive, and nothing it
    // already had may arrive again.
    const resumed = hold('resumed', token, {
      sessionId: session.sessionId,
      sinceSeq: watermark,
    });
    opened.push(resumed);
    const resumedWatermark = await withDeadline(
      resumed.caughtUp,
      ATTACH_TIMEOUT_MS,
      'the reconnected stream never reached the new generation',
    );
    expectDelivered('reconnect', resumed.received, offline, watermark);
    expect(
      resumedWatermark === offline[offline.length - 1],
      `the reconnected stream caught up at ${String(resumedWatermark)} rather than at ${String(offline[offline.length - 1])}`,
    );
    report('caught-up', {
      sinceSeq: watermark,
      delivered: resumed.received,
      afterMaintenanceMs: Date.now() - refusedAt,
    });

    // And the action that was refused mid-cutover reaches the same verdict on the
    // new generation as it did on the old one: the session survived the update,
    // so a retry is an answer rather than a second unknown.
    expectSettledAck('after the switch', await ackPermission(session.sessionId, token));
    report('ack-after', {});

    resumed.close();
    await withDeadline(resumed.closed, CLOSE_TIMEOUT_MS, 'the reconnected stream never closed');
    report('done', { mode: 'catchup' });
  } finally {
    // A failed assertion has already decided the verdict; the only thing left
    // that matters is the report reaching the driver. So cleanup releases what
    // it can and is never allowed to become the reason a failure takes six
    // minutes to surface — the sockets go first (each carries a keepalive
    // timer), then the pool, on a bound, with its own failure discarded so it
    // cannot replace the error that got here.
    for (const socket of opened) socket.close();
    await withDeadline(session.close(), CLEANUP_TIMEOUT_MS, 'cleanup timed out').catch(
      () => undefined,
    );
  }
}

async function main(): Promise<void> {
  const mode = process.env.VERITY_SMOKE_CLIENT_MODE;
  expect(
    mode === 'polite' || mode === 'stubborn' || mode === 'catchup',
    `unknown client mode: ${String(mode)}`,
  );
  const deadlineAt = Date.now() + DEADLINE_MS;
  const token = await mintDeviceToken(required('VERITY_SMOKE_MASTER_PASSWORD'));

  if (mode === 'catchup') {
    await runCatchupClient(token, deadlineAt);
    return;
  }

  const held =
    mode === 'polite' ? [hold('first', token), hold('second', token)] : [hold('held', token)];
  for (const socket of held) {
    await withDeadline(
      socket.caughtUp,
      ATTACH_TIMEOUT_MS,
      `the ${socket.label} stream never reached a Server through the Gateway`,
    );
  }
  // The broker channel before anything happens to it, so the refusal during
  // maintenance below is a change rather than the only reading taken.
  expectBrokerServed('the broker call before the update', await brokerDoor());
  // Two on the public channel, because the drain must be shown to wait for work
  // rather than for a connection: one request finishing early would leave the
  // counter at zero. The third is on the internal one, so what the drain waits for
  // includes the channel a sandbox holds and the operator never sees.
  const inFlight = [
    startInFlightRequest('first', publicCall(token)),
    startInFlightRequest('second', publicCall(token)),
    startInFlightRequest('broker', brokerCall()),
  ];
  for (const call of inFlight) {
    await withDeadline(
      call.started,
      ATTACH_TIMEOUT_MS,
      `the ${call.label} request never reached the Gateway`,
    );
  }
  // The driver waits for this line before it starts the update: a cutover that
  // began while the client was still connecting would drain an idle Gateway.
  report('attached', { mode, streams: held.length, inFlight: inFlight.length });

  // The boundary itself. A 503 from the Gateway — not a 502, not a timeout — is
  // the deployment refusing new work while it changes generation, and it is the
  // first thing a client can see of an update it was never told about.
  const refused = await waitForFrontDoor(
    (seen) => seen !== undefined && seen.status === 503,
    deadlineAt,
    'the Gateway never entered maintenance',
  );
  const refusedAt = Date.now();
  expect(
    refused.body.includes('server maintenance'),
    `the Gateway refused with an unexpected body: ${refused.body}`,
  );
  report('maintenance', { status: refused.status, body: refused.body });

  // Hold everything open across the moment the drain starts, so what follows is
  // about the drain's contract rather than about who happened to move first.
  await sleep(HOLD_AFTER_MAINTENANCE_MS);

  // A request that arrives after the front door closed must be refused by the
  // Gateway itself. Routing it would send a client at a Server that is being
  // taken away — the failure this whole maintenance window exists to prevent.
  const late = await frontDoor();
  expect(
    late !== undefined && late.status === 503,
    `the Gateway routed a new request during maintenance (${String(late?.status)})`,
  );

  // And the same for the broker channel, which is refused by the Gateway on its own
  // listener rather than reaching the Server that would answer 401. The two statuses
  // are what tells the halves apart: a 401 here would mean the internal route was
  // still being proxied at a backend the cutover is taking away.
  const lateBroker = await brokerDoor();
  expect(
    lateBroker !== undefined &&
      lateBroker.status === 503 &&
      lateBroker.body.includes('server maintenance'),
    `the Gateway routed a new broker call during maintenance (${String(lateBroker?.status)}: ${String(lateBroker?.body)})`,
  );
  report('broker-refused', { status: lateBroker?.status });

  // Everything that was already in flight must come back whole. A truncated body
  // does not parse, and a connection the drain took away answers nothing at all,
  // so this is the assertion the ADR's "in-flight requests" bullet reduces to.
  for (const call of inFlight) {
    const answer = await withDeadline(
      call.complete(),
      CLOSE_TIMEOUT_MS,
      `the ${call.label} in-flight request was never answered`,
    );
    call.verify(answer);
    report('in-flight-completed', {
      label: call.label,
      status: answer.status,
      bytes: answer.body.length,
      afterMaintenanceMs: Date.now() - refusedAt,
    });
  }

  if (mode === 'polite') {
    // The cooperative half: a client that lets go the moment it is asked to costs
    // the update the round trip and nothing more.
    for (const socket of held) socket.close();
    for (const socket of held) {
      const closed = await withDeadline(
        socket.closed,
        CLOSE_TIMEOUT_MS,
        `the ${socket.label} stream never closed`,
      );
      expect(
        closed.clean,
        `the ${socket.label} stream was taken away (${String(closed.code)}) rather than released`,
      );
      report('stream-released', { label: socket.label, code: closed.code });
    }
  } else {
    // The other half: a client that does not let go is disconnected at the
    // deadline. That it is unclean is the point — the Gateway destroys the
    // connection, so the client learns about it as a reset rather than a close
    // frame, and an update is never blocked by one held socket.
    for (const socket of held) {
      const closed = await withDeadline(
        socket.closed,
        CLOSE_TIMEOUT_MS,
        `the ${socket.label} stream was never closed by the Gateway`,
      );
      expect(
        !closed.clean,
        `the ${socket.label} stream closed cleanly (${String(closed.code)}); nothing forced it`,
      );
      report('stream-forced', {
        label: socket.label,
        code: closed.code,
        afterMaintenanceMs: Date.now() - refusedAt,
      });
    }
  }

  // The front door is the whole point of the exercise: same host, same port, same
  // token, a different generation behind it.
  await waitForFrontDoor(
    (seen) => seen !== undefined && seen.status === 200,
    deadlineAt,
    'the Gateway never served again after the switch',
  );
  report('serving-again', { afterMaintenanceMs: Date.now() - refusedAt });

  // Both listeners are switched as one backend, so a front door that serves while
  // the broker channel does not would be a deployment that came back for the
  // operator and not for the sandboxes.
  expectBrokerServed(
    'the broker call after the switch',
    await waitForBrokerDoor(Date.now() + ATTACH_TIMEOUT_MS),
  );
  report('broker-served-again', { afterMaintenanceMs: Date.now() - refusedAt });

  const reconnected = hold('reconnect', token);
  await withDeadline(
    reconnected.caughtUp,
    ATTACH_TIMEOUT_MS,
    'the reconnected stream never reached the new generation',
  );
  report('reconnected', {});
  reconnected.close();
  await withDeadline(reconnected.closed, CLOSE_TIMEOUT_MS, 'the reconnected stream never closed');
  report('done', { mode });
}

/**
 * The exit code is the verdict, so leave as soon as it is written rather than
 * waiting for connection pools to time out: both `fetch` and `node:http` keep
 * idle sockets warm for seconds after the last request, and the driver reads
 * this container's exit as "the client is finished".
 */
function finish(code: number): void {
  process.exitCode = code;
  // Stdout is a pipe here, and a pipe flushes asynchronously — exiting before it
  // drains would take the report with it and leave the driver nothing to print.
  process.stdout.write('', () => {
    process.exit(code);
  });
}

main().then(
  () => {
    finish(0);
  },
  (error: unknown) => {
    report('failed', { reason: error instanceof Error ? error.message : String(error) });
    finish(1);
  },
);
