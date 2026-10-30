export interface SchedulingApprovalSummary {
  title: string;
  details: string[];
  email: { subject: string; body: string } | null;
  /** What approving lets Verity do, in one sentence. */
  scope: string;
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
      scope: `The link stops offering times and the holds are removed from your calendar${colleagues.length > 0 ? `; ${colleagues.join(', ')} get the cancellation` : ''}.`,
    };
  const details = [
    `${title} · ${String(draft['durationMinutes'])} min${draft['addGoogleMeet'] === true ? ' · Google Meet' : ''}`,
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
  return {
    title: `Send times to ${typeof guest['name'] === 'string' ? guest['name'] : guest['email']}?`,
    details,
    email:
      isRecord(email) && typeof email['subject'] === 'string' && typeof email['body'] === 'string'
        ? { subject: email['subject'], body: email['body'] }
        : null,
    scope:
      'Approving lets Verity create the holds, send this email, book the time the guest picks for everyone, and remove the remaining holds when it is booked, expires or is withdrawn.',
  };
}
