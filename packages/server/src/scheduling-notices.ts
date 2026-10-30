import type { PushNotification } from './push-sender.js';
import type { SchedulingNotification } from './scheduling-service.js';

function when(start: Date | null, timeZone: string): string {
  if (!start) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(start);
}

/** The chat notice for a scheduling event, written into the request's own session. */
export function schedulingNoticeText(notification: SchedulingNotification): string {
  const { request } = notification;
  const guest = request.guestName ?? request.guestEmail;
  switch (notification.kind) {
    case 'booked':
      return `${guest} booked “${request.title}” for ${when(request.bookedStart, request.timeZone)}. Invitations went out and the other holds are being removed.`;
    case 'no_slots':
      return `No times are left for ${guest} (“${request.title}”). The link stays open until it closes; send new times if needed.`;
    case 'cleanup_failed':
      return `A hold for “${request.title}” could not be removed from the calendar yet (${notification.error}). Verity keeps retrying.`;
    case 'email_unconfirmed':
      return `The email to ${guest} for “${request.title}” could not be confirmed as sent. The booking link works; check your sent mail or send the link yourself.`;
    case 'closed':
      return `The scheduling request “${request.title}” for ${guest} was closed: ${notification.reason}. Its holds are being removed.`;
  }
}

/** Push only for what the operator should hear about away from the chat. */
export function schedulingPush(notification: SchedulingNotification): PushNotification | undefined {
  const { request } = notification;
  const guest = request.guestName ?? request.guestEmail;
  const data = { sessionId: request.sessionId, kind: 'scheduling', requestId: request.id };
  switch (notification.kind) {
    case 'booked':
      return {
        title: `${guest} booked a time`,
        body: `${request.title} · ${when(request.bookedStart, request.timeZone)}`,
        categoryId: 'SCHEDULING',
        data,
        priority: 'high',
      };
    case 'cleanup_failed':
      return {
        title: 'A calendar hold could not be removed',
        body: `${request.title} · Verity keeps retrying`,
        categoryId: 'SCHEDULING',
        data,
      };
    case 'no_slots':
    case 'email_unconfirmed':
    case 'closed':
      return {
        title:
          notification.kind === 'no_slots'
            ? `No times left for ${guest}`
            : 'Scheduling request needs a look',
        body: request.title,
        categoryId: 'SCHEDULING',
        data,
      };
  }
}
