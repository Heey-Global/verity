export type SchedulingLanguage = 'en' | 'de';

export const SCHEDULING_LANGUAGES: readonly { value: SchedulingLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
];

/** The draft content the operator may change on the send card before approving. */
export interface SchedulingDraftFields {
  title: string;
  language: SchedulingLanguage;
  emailSubject: string;
  emailBody: string;
}

export interface SchedulingEditable {
  original: SchedulingDraftFields;
  /** The meeting line without its title, e.g. "30 min · Google Meet". */
  meeting: string;
  /**
   * While the draft carries the default email: that email per language, with `{title}` for the
   * title. The server regenerates it the same way, so the card shows what will be sent.
   */
  defaultEmail: Record<SchedulingLanguage, { subject: string; body: string }> | null;
}

/** The card's working copy; `emailEdited` turns a default email into the operator's own text. */
export interface SchedulingCardEdit extends SchedulingDraftFields {
  emailEdited: boolean;
}

export interface SchedulingApprovalSummary {
  title: string;
  details: string[];
  email: { subject: string; body: string } | null;
  /** What approving lets Verity do, in one sentence. */
  scope: string;
  /** Present on a send card the operator can still edit. */
  editable: SchedulingEditable | null;
}

const LINK_PLACEHOLDER = '{link}';
const TITLE_PLACEHOLDER = '{title}';

export function schedulingCardEdit(editable: SchedulingEditable): SchedulingCardEdit {
  return { ...editable.original, emailEdited: false };
}

/** The email as it will be sent with these edits. */
export function schedulingCardEmail(
  editable: SchedulingEditable,
  edit: SchedulingCardEdit,
): { subject: string; body: string } {
  const template = edit.emailEdited ? null : editable.defaultEmail?.[edit.language];
  if (!template) return { subject: edit.emailSubject, body: edit.emailBody };
  const title = edit.title.trim();
  return {
    subject: template.subject.replaceAll(TITLE_PLACEHOLDER, () => title),
    body: template.body.replaceAll(TITLE_PLACEHOLDER, () => title),
  };
}

/**
 * The allow decision for an edited send card: a changed title or language and a touched email
 * travel as `updatedInput`; an untouched email is left to the server, which regenerates a default
 * one for the new title or language. Returns an error instead when
 * the edits could not be sent.
 */
export function schedulingCardDecision(
  editable: SchedulingEditable,
  edit: SchedulingCardEdit,
): { updatedInput?: Record<string, unknown> } | { error: string } {
  const title = edit.title.trim();
  if (!title) return { error: 'The title must not be empty.' };
  const updatedInput: Record<string, unknown> = {};
  if (title !== editable.original.title) updatedInput['title'] = title;
  if (edit.language !== editable.original.language) updatedInput['language'] = edit.language;
  if (edit.emailEdited) {
    const subject = edit.emailSubject.trim();
    if (!subject) return { error: 'The email subject must not be empty.' };
    if (!edit.emailBody.includes(LINK_PLACEHOLDER))
      return { error: `Keep ${LINK_PLACEHOLDER} in the email; the booking link goes there.` };
    // Always sent once touched, even if it matches the draft again: without it the server would
    // take the email for an untouched default and regenerate it, unlike what the card shows.
    updatedInput['emailSubject'] = subject;
    updatedInput['emailBody'] = edit.emailBody;
  }
  return Object.keys(updatedInput).length > 0 ? { updatedInput } : {};
}

function defaultEmails(value: unknown): SchedulingEditable['defaultEmail'] {
  if (!isRecord(value)) return null;
  const read = (language: SchedulingLanguage) => {
    const email = value[language];
    return isRecord(email) &&
      typeof email['subject'] === 'string' &&
      typeof email['body'] === 'string'
      ? { subject: email['subject'], body: email['body'] }
      : null;
  };
  const en = read('en');
  const de = read('de');
  return en && de ? { en, de } : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function format(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const day = { weekday: 'short', day: 'numeric', month: 'short' } as const;
const time = { hour: '2-digit', minute: '2-digit' } as const;

/** A window as "Tue 3 Nov · 14:00–16:00 · 4 start times" in the request's time zone. */
export function schedulingWindowLabel(
  window: { start: string; end: string; startTimes?: readonly string[] },
  timeZone: string,
): string {
  const count = window.startTimes?.length;
  return `${format(window.start, timeZone, day)} · ${format(window.start, timeZone, time)}–${format(window.end, timeZone, time)}${
    count === undefined ? '' : ` · ${String(count)} start time${count === 1 ? '' : 's'}`
  }`;
}

/**
 * The approval card for `verity_scheduling`. The server attaches the stored draft as
 * `scheduling`, so the card shows what will happen, not what the agent claims.
 */
export function schedulingApprovalSummary(input: unknown): SchedulingApprovalSummary | null {
  if (!isRecord(input) || !isRecord(input['scheduling'])) return null;
  const action = input['action'];
  if (action !== 'send' && action !== 'revoke') return null;
  const draft = input['scheduling'];
  const title = draft['title'];
  const timeZone = draft['timeZone'];
  const guest = draft['guest'];
  const windows = draft['windows'];
  const email = draft['email'];
  if (
    typeof title !== 'string' ||
    typeof timeZone !== 'string' ||
    !isRecord(guest) ||
    typeof guest['email'] !== 'string' ||
    !Array.isArray(windows) ||
    typeof draft['durationMinutes'] !== 'number' ||
    typeof draft['closesAt'] !== 'string'
  )
    return null;
  // Every part the server acts on must render: a dropped window or invitee would let the
  // card show less than the approval covers, so anything unreadable falls back to raw input.
  const readable =
    windows.every(
      (window: unknown) =>
        isRecord(window) &&
        typeof window['start'] === 'string' &&
        typeof window['end'] === 'string',
    ) &&
    (draft['colleagues'] === undefined ||
      (Array.isArray(draft['colleagues']) &&
        draft['colleagues'].every(
          (colleague: unknown) => isRecord(colleague) && typeof colleague['email'] === 'string',
        )));
  if (!readable) return null;
  const guestLabel =
    typeof guest['name'] === 'string' ? `${guest['name']} (${guest['email']})` : guest['email'];
  const colleagues = Array.isArray(draft['colleagues'])
    ? draft['colleagues'].flatMap((colleague: unknown) =>
        isRecord(colleague) && typeof colleague['email'] === 'string'
          ? [
              typeof colleague['name'] === 'string'
                ? `${colleague['name']} (${colleague['email']})`
                : colleague['email'],
            ]
          : [],
      )
    : [];
  if (action === 'revoke')
    return {
      title: `Withdraw the scheduling request for ${typeof guest['name'] === 'string' ? guest['name'] : guest['email']}?`,
      details: [`${title} · ${String(draft['durationMinutes'])} min`],
      email: null,
      editable: null,
      scope: `The link stops offering times and the holds are removed from your calendar${colleagues.length > 0 ? `; ${colleagues.join(', ')} get the cancellation` : ''}.`,
    };
  const meeting = `${String(draft['durationMinutes'])} min${draft['addGoogleMeet'] === true ? ' · Google Meet' : ''}`;
  const details = [
    `${title} · ${meeting}`,
    ...windows.flatMap((window: unknown) =>
      isRecord(window) && typeof window['start'] === 'string' && typeof window['end'] === 'string'
        ? [
            schedulingWindowLabel(
              {
                start: window['start'],
                end: window['end'],
                ...(Array.isArray(window['startTimes'])
                  ? {
                      startTimes: window['startTimes'].filter(
                        (t): t is string => typeof t === 'string',
                      ),
                    }
                  : {}),
              },
              timeZone,
            ),
          ]
        : [],
    ),
    `Times in ${timeZone}`,
    `Holds in your calendar${colleagues.length > 0 ? `, invited: ${colleagues.join(', ')} (availability not checked)` : ''}`,
    `Booking link to: ${guestLabel}`,
    ...(typeof draft['sender'] === 'string' ? [`Email sent from: ${draft['sender']}`] : []),
    `Booking closes ${format(draft['closesAt'], timeZone, { ...day, ...time })}`,
  ];
  if (!isRecord(email) || typeof email['subject'] !== 'string' || typeof email['body'] !== 'string')
    return null;
  const language = draft['language'];
  return {
    title: `Send times to ${typeof guest['name'] === 'string' ? guest['name'] : guest['email']}?`,
    details,
    email: { subject: email['subject'], body: email['body'] },
    // A server that does not report the language predates card edits; it stays read-only.
    editable:
      language === 'en' || language === 'de'
        ? {
            original: {
              title,
              language,
              emailSubject: email['subject'],
              emailBody: email['body'],
            },
            meeting,
            defaultEmail: defaultEmails(draft['defaultEmail']),
          }
        : null,
    scope:
      'Approving lets Verity create the holds, send this email, book the time the guest picks for everyone, and remove the remaining holds when it is booked, expires or is withdrawn.',
  };
}
