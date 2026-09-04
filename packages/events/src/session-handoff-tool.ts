import { z } from 'zod';

/**
 * Characters that can make a rendered line say something other than what it contains: the C0
 * and C1 controls (a newline splits the sentence; a CR can overwrite it), LINE and PARAGRAPH
 * SEPARATOR — which break a line too but are `\p{Zl}`/`\p{Zp}`, not `\p{Cc}` — and the bidi
 * marks, embeddings, overrides and isolates, which reorder it.
 *
 * Deliberately not all of `\p{Cf}`. That class also holds ZWJ, ZWNJ and the soft hyphen —
 * required to spell ordinary words in Persian, Hindi and German, and to write an emoji
 * sequence. Refusing those would reject correct titles while catching nothing extra.
 *
 * Reachable from the approval card through {@link isDeceptiveInARenderedLine}, which re-runs it
 * on what arrived rather than trusting that the server ran it — the card's job is to describe
 * the request accurately even when something upstream is wrong. Re-running the predicate is
 * that check; a second copy of it would only add a way for the two to disagree about which
 * characters are deceptive, which is not a disagreement either side could resolve.
 */
const DECEPTIVE_IN_A_RENDERED_LINE =
  /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/**
 * True when a value carries a character that would deceive in a rendered line.
 *
 * A predicate rather than the pattern, because the pattern is shared across packages and
 * `RegExp.prototype.test` is only stateless while the literal carries no `g` or `y`. With
 * either flag it advances `lastIndex` between calls, so a shared instance would start
 * admitting deceptive values on every other call — on both sides at once, and only for some
 * inputs. That is precisely the silent, both-directions divergence sharing one class was
 * meant to design out, so the instance stays module-private and callers get this instead.
 */
export function isDeceptiveInARenderedLine(value: string): boolean {
  return DECEPTIVE_IN_A_RENDERED_LINE.test(value);
}

/**
 * A value the approval card renders as prose, next to fixed words.
 *
 * Only what would deceive is refused: a card that misnames where a briefing is going is worse
 * than no card, but any script and any punctuation must render. The briefing is not held to
 * this — it is shown as a body of text, and refusing to display one for containing a newline
 * would defeat the point of showing it.
 */
const cardLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !isDeceptiveInARenderedLine(value), {
      message: 'must be a single line without control or bidi characters',
    });

/** A project reference the caller may name: a Verity project id, a bare repository name, or
 *  `owner/repo`. Resolved server-side against the live project list. */
const projectReferenceSchema = cardLine(200);

export const listSessionsRequestSchema = z
  .object({
    project: projectReferenceSchema.optional(),
    /**
     * Omitted means true: list only sessions a handoff could actually be delivered to.
     *
     * Left `.optional()` rather than given `.default(true)` because the approval card reads
     * the raw arguments, before this schema runs — a default applied here would be invisible
     * to it, and the card would have to state one of its own anyway. So the absent case is
     * spelled out at each reader (`request.activeOnly !== false`) and they are compared
     * against each other in the card's tests rather than against a default only one of them
     * can see.
     */
    activeOnly: z.boolean().optional(),
  })
  .strict();

export type ListSessionsRequest = z.infer<typeof listSessionsRequestSchema>;

export const sessionHandoffRequestSchema = z
  .object({
    target: z.union([
      z.object({ sessionId: cardLine(128) }).strict(),
      z.object({ project: projectReferenceSchema }).strict(),
      z.object({ newSession: z.object({ project: projectReferenceSchema }).strict() }).strict(),
    ]),
    /** A one-line label, rendered on the approval card next to the target it names. */
    title: cardLine(120),
    briefing: z.string().trim().min(1).max(20_000),
  })
  .strict();

export type SessionHandoffRequest = z.infer<typeof sessionHandoffRequestSchema>;

/**
 * The most sessions one listing returns — and, because the cap is applied before the server
 * projects them, the most event logs one listing reads.
 *
 * Both halves matter. An unnarrowed listing is the default call: both arguments are optional
 * and the Control prompt tells the agent to make it routinely. Without a cap its cost and its
 * size grow with the install — one full event-log read per live session, and a result that is
 * then injected whole into a model's context. Neither is bounded by anything the caller wrote.
 *
 * What gets dropped is the oldest, and how many is reported rather than implied: a listing
 * that silently returned half the fleet would read exactly like a fleet that size, and the
 * agent would conclude a session it was looking for does not exist. With `omitted` in hand it
 * can narrow with `project` instead.
 *
 * It lives here, beside the description that states it, because a caller told "at most 50"
 * by a description and served a different number is being misinformed by the contract itself.
 *
 * The handoff deliberately does NOT cap: its narrow is already one session or one project, and
 * a cap there could hide the second eligible session in a project and turn a correctly refused
 * ambiguous handoff into a confident delivery to the wrong one.
 */
export const LIST_SESSIONS_MAX_ENTRIES = 50;

/**
 * Every field `verity_list_sessions` returns, paired with how it is named in prose.
 *
 * One list, because there are three places that enumerate these fields and each one is a
 * promise: the tool description tells the calling model what it will get, the approval card
 * tells the operator what is being read, and the server's entry type decides what is actually
 * sent. Written out three times they drift, and the drift is silent in the worst direction —
 * a field added to the entry keeps a card that says the listing does not carry it.
 *
 * So the two prose renderings are built from this array, and the server's test asserts its own
 * entry keys against it. Adding a field to the listing without adding it here fails that test.
 */
export const LIST_SESSIONS_FIELDS = [
  { key: 'sessionId', label: 'session id' },
  { key: 'projectId', label: 'project id' },
  { key: 'project', label: 'owner/repo' },
  { key: 'model', label: 'model' },
  { key: 'status', label: 'status' },
  { key: 'eventCount', label: 'event count' },
  { key: 'lastActivityAt', label: 'last activity time' },
  { key: 'resumable', label: 'whether it can be resumed' },
  { key: 'handoffEligible', label: 'whether a handoff would be accepted' },
  { key: 'handoffBlockedBy', label: 'why not when it is not' },
] as const;

/** {@link LIST_SESSIONS_FIELDS} as one enumerated clause, for a description or a card. */
export const LIST_SESSIONS_FIELD_SENTENCE = LIST_SESSIONS_FIELDS.map((field) => field.label)
  .map((label, index, all) => (index === all.length - 1 ? `and ${label}` : label))
  .join(', ');

export const LIST_SESSIONS_TOOL_DESCRIPTION =
  'List the Verity sessions of the fleet so a handoff can be addressed. ' +
  `Returns metadata only — ${LIST_SESSIONS_FIELD_SENTENCE}. ` +
  "It never returns transcript content, messages, session names or files; use it to pick a target, not to read another session's work. " +
  'Verity Control sessions are not listed. Pass `project` to narrow to one project, and `activeOnly: false` to also see sessions that cannot currently take a turn. ' +
  `At most ${String(LIST_SESSIONS_MAX_ENTRIES)} sessions come back — the newest ones, when there are more. \`omitted\` says how many the cap left out; a session can also drop out after it, so \`omitted\` is a floor and a listing never proves a session does not exist — narrow with \`project\` instead of concluding it. ` +
  'The call requires user approval.';

export const SESSION_HANDOFF_TOOL_DESCRIPTION =
  'Hand a written briefing to a selected Verity project session, which receives it as a turn. ' +
  'Use it when work you prepared here has to continue in a session that has the repository checkout, the signing broker and the GitHub token — instead of asking the user to relay the context by hand. ' +
  'Before delivery, list the project sessions and ask the user to choose one of those exact session ids or New session. Target the chosen existing session with `sessionId`, or use `newSession: { project }` to create the chosen new target. A bare `project` is accepted only when exactly one session is eligible; it can never choose among several. ' +
  'The briefing is delivered marked as agent-to-agent material and grants the target no additional authority. ' +
  'Put everything the other session needs into `briefing` — it cannot see this conversation. The call requires user approval, who reads the full briefing on the card.';
