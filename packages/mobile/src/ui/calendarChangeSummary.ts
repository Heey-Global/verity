export interface CalendarChangeSummary {
  title: string;
  details: string[];
}

/** Display the exact approved change, including notification behavior. */
export function calendarChangeSummary(input: unknown): CalendarChangeSummary | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const action = value['action'];
  if (!['create_event', 'update_event', 'delete_event'].includes(String(action))) return null;
  if (typeof value['calendarId'] !== 'string') return null;
  if (action !== 'create_event' && typeof value['eventId'] !== 'string') return null;
  const event = value['event'];
  if (
    action !== 'delete_event' &&
    (typeof event !== 'object' || event === null || Array.isArray(event))
  )
    return null;
  const details = [`Calendar: ${value['calendarId']}`];
  if (action === 'create_event') {
    if (typeof value['addGoogleMeet'] !== 'boolean') return null;
    details.push(
      value['addGoogleMeet']
        ? 'Google Meet: add a video meeting.'
        : 'Google Meet: no video meeting.',
    );
  }
  if (typeof value['eventId'] === 'string') details.push(`Event: ${value['eventId']}`);
  if (typeof event === 'object' && event !== null && !Array.isArray(event)) {
    const data = event as Record<string, unknown>;
    for (const key of ['summary', 'description', 'location']) {
      if (typeof data[key] === 'string') details.push(`${key}: ${data[key]}`);
    }
    for (const key of ['start', 'end']) {
      const time = data[key];
      if (typeof time === 'object' && time !== null && !Array.isArray(time)) {
        const fields = time as Record<string, unknown>;
        const date = fields['dateTime'] ?? fields['date'];
        if (typeof date === 'string')
          details.push(
            `${key}: ${date}${typeof fields['timeZone'] === 'string' ? ` (${fields['timeZone']})` : ''}`,
          );
      }
    }
    if (Array.isArray(data['attendees'])) {
      const emails = data['attendees'].flatMap((attendee: unknown) =>
        typeof attendee === 'object' &&
        attendee !== null &&
        'email' in attendee &&
        typeof attendee.email === 'string'
          ? [attendee.email]
          : [],
      );
      details.push(`Attendees: ${emails.join(', ') || 'none'}`);
    }
  }
  details.push(
    value['sendUpdates'] === 'all'
      ? 'Google will notify attendees.'
      : 'Attendee notifications are disabled.',
  );
  return {
    title: `${action === 'create_event' ? 'Create' : action === 'update_event' ? 'Update' : 'Delete'} calendar event?`,
    details,
  };
}
