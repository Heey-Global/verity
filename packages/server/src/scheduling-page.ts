import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SchedulingRequest } from '@verity/store';
import {
  formatInZone,
  isValidTimeZone,
  type SchedulingBookResult,
  type SchedulingPageModel,
} from './scheduling-service.js';
import type { Slot } from './scheduling-slots.js';

/** What the page handler needs from the service. */
export interface SchedulingPageBackend {
  view(requestId: string): Promise<SchedulingPageModel>;
  book(requestId: string, start: string, note?: string): Promise<SchedulingBookResult>;
  /** The public origin the request is served under; browsers posting from elsewhere are refused. */
  publicOrigin?(requestId: string): Promise<string | undefined>;
}

const MAX_BODY_BYTES = 16_384;
const MAX_NOTE_LENGTH = 1_000;
const BOOK_ATTEMPTS_PER_MINUTE = 20;
// Every view reads the calendar twice; a link holder must not be able to drain its quota.
const VIEWS_PER_MINUTE = 120;

type Language = 'en' | 'de';

const TEXT = {
  en: {
    pick: 'Pick a time',
    invites: (name: string) => `<b>${name}</b> invites you`,
    minutes: (n: number) => `${String(n)} minutes`,
    meet: 'Google Meet',
    zoneLabel: (zone: string) => `Times in ${zone}`,
    showLocal: (zone: string) => `Show in ${zone}`,
    openUntil: (date: string) => `Up to date · open until ${date}`,
    choose: 'Choose a start time to continue.',
    confirm: 'Confirm your time',
    with: 'With',
    you: 'you',
    organizer: 'Organizer',
    noteLabel: (name: string) => `Note for ${name} (optional)`,
    invitationTo: (email: string) => `The calendar invitation goes to ${email}.`,
    book: 'Book this time',
    other: 'Choose another time',
    booked: 'Booked',
    bookedTitle: 'You’re booked',
    bookedCopy: (email: string) => `The invitation is on its way to ${email}.`,
    already: 'This time is booked',
    replyToChange: 'Need a different time? Reply to the invitation.',
    meetInInvite: 'Link in the invitation',
    taken: (time: string) => `${time} was just booked`,
    takenCopy: 'Nothing was booked for you. Please pick another time.',
    noSlots: 'No times left right now',
    noSlotsCopy: (name: string) =>
      `All proposed times have been taken. ${name} has been told and may send new ones.`,
    updatesUntil: (date: string) => `This page updates until ${date}`,
    email: (name: string) => `Email ${name}`,
    expired: 'This request has expired',
    expiredCopy: (date: string, name: string) =>
      `Booking closed on ${date}. Ask ${name} for new times.`,
    withdrawn: 'This request was withdrawn',
    withdrawnCopy: (name: string) => `${name} closed this request. Ask them for new times.`,
    unavailable: 'We can’t check the calendar right now',
    unconfirmed: 'We couldn’t confirm your booking',
    unconfirmedCopy:
      'Check your email for an invitation. If none arrives, open this page again to see whether the time is still free.',
    unavailableCopy: 'Nothing has been booked. Please try again in a moment.',
    notReady: 'This page isn’t ready yet',
    notReadyCopy: 'Please try again in a moment.',
    retry: 'Try again',
    unknown: 'This link isn’t available',
    unknownCopy: 'Ask the person who shared it for a new link.',
    footer: 'Scheduled with Verity',
  },
  de: {
    pick: 'Termin wählen',
    invites: (name: string) => `<b>${name}</b> lädt dich ein`,
    minutes: (n: number) => `${String(n)} Minuten`,
    meet: 'Google Meet',
    zoneLabel: (zone: string) => `Zeiten in ${zone}`,
    showLocal: (zone: string) => `In ${zone} anzeigen`,
    openUntil: (date: string) => `Aktuell · offen bis ${date}`,
    choose: 'Wähle eine Startzeit, um fortzufahren.',
    confirm: 'Termin bestätigen',
    with: 'Mit',
    you: 'du',
    organizer: 'Organisator',
    noteLabel: (name: string) => `Notiz für ${name} (optional)`,
    invitationTo: (email: string) => `Die Kalendereinladung geht an ${email}.`,
    book: 'Termin buchen',
    other: 'Andere Zeit wählen',
    booked: 'Gebucht',
    bookedTitle: 'Dein Termin steht',
    bookedCopy: (email: string) => `Die Einladung ist unterwegs an ${email}.`,
    already: 'Dieser Termin ist gebucht',
    replyToChange: 'Andere Zeit nötig? Antworte auf die Einladung.',
    meetInInvite: 'Link in der Einladung',
    taken: (time: string) => `${time} wurde gerade vergeben`,
    takenCopy: 'Für dich wurde nichts gebucht. Bitte wähle eine andere Zeit.',
    noSlots: 'Aktuell sind keine Termine frei',
    noSlotsCopy: (name: string) =>
      `Alle vorgeschlagenen Zeiten sind vergeben. ${name} wurde informiert und schickt vielleicht neue.`,
    updatesUntil: (date: string) => `Diese Seite aktualisiert sich bis ${date}`,
    email: (name: string) => `${name} schreiben`,
    expired: 'Diese Terminanfrage ist abgelaufen',
    expiredCopy: (date: string, name: string) =>
      `Die Buchung wurde am ${date} geschlossen. Bitte ${name} um neue Terminvorschläge.`,
    withdrawn: 'Diese Terminanfrage wurde zurückgezogen',
    withdrawnCopy: (name: string) =>
      `${name} hat diese Anfrage geschlossen. Bitte um neue Terminvorschläge.`,
    unavailable: 'Der Kalender ist gerade nicht erreichbar',
    unconfirmed: 'Die Buchung konnte nicht bestätigt werden',
    unconfirmedCopy:
      'Prüfe dein Postfach auf eine Einladung. Kommt keine an, öffne diese Seite erneut, um zu sehen, ob die Zeit noch frei ist.',
    unavailableCopy: 'Es wurde nichts gebucht. Bitte versuche es gleich noch einmal.',
    notReady: 'Diese Seite ist noch nicht bereit',
    notReadyCopy: 'Bitte versuche es gleich noch einmal.',
    retry: 'Erneut versuchen',
    unknown: 'Dieser Link ist nicht verfügbar',
    unknownCopy: 'Bitte die Person, die ihn geteilt hat, um einen neuen Link.',
    footer: 'Geplant mit Verity',
  },
} satisfies Record<Language, Record<string, unknown>>;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

// Roles from docs/design-system.md (dark theme), in the shell of the Uplink preview pages.
const STYLES = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#07080d;color:#f5f5f8}
*{box-sizing:border-box}
body{min-height:100vh;min-height:100dvh;margin:0;display:grid;place-items:start center;padding:clamp(20px,5vw,64px) 16px 120px;background:radial-gradient(circle at 10% 0%,#18c8f521 0,transparent 38%),radial-gradient(circle at 95% 95%,#ff18b71a 0,transparent 34%),#07080d}
main{width:min(100%,480px)}
.brand{display:inline-flex;align-items:center;gap:10px;margin:4px 4px 20px;color:#b9bccb;font-size:12px;font-weight:800;letter-spacing:.18em;text-decoration:none}
.brand img{display:block;width:30px;height:22px;object-fit:contain}
.card{position:relative;overflow:hidden;padding:24px 20px;border:1px solid #22263a;border-radius:16px;background:#0c0e17;box-shadow:0 24px 80px #0008}
.card:before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,#18c8f5 0 68%,#ff18b7)}
.eyebrow{margin:0 0 14px;color:#ff18b7;font-size:11px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}
h1{margin:0 0 8px;font-size:26px;line-height:1.15;letter-spacing:-.035em}
.copy{margin:0;color:#a5a8b8;font-size:15px;line-height:1.6}
.host{display:flex;align-items:center;gap:10px;margin-bottom:16px;color:#a5a8b8;font-size:13px}
.host b{color:#f5f5f8;font-weight:600}
.meta{display:flex;flex-direction:column;gap:8px;margin:16px 0 4px;color:#a5a8b8;font-size:14px}
.day{margin-top:20px}
.label{display:block;margin-bottom:8px;color:#f5f5f8;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.slots{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.slot{display:flex;align-items:center;justify-content:center;min-height:48px;border:1px solid #22263a;border-radius:12px;background:#111422;color:#f5f5f8;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;text-decoration:none}
.slot:hover{border-color:#18c8f5}
a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid #18c8f5;outline-offset:3px}
.foot{margin:16px 0 0;color:#80849a;font-size:12px;line-height:1.4}
.foot a{color:#18c8f5}
.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;margin-top:16px;border:1px solid #18c8f559;border-radius:12px;background:#18c8f524;color:#6fdcf8;font:inherit;font-size:15px;font-weight:700;text-decoration:none;cursor:pointer}
.btn.secondary{border-color:#22263a;background:#111422;color:#f5f5f8}
.text{display:block;margin-top:8px;color:#18c8f5;font-size:15px;font-weight:700;text-align:center;text-decoration:none}
.rows{margin-top:16px;padding:0 16px;border:1px solid #22263a;border-radius:16px;background:#111422}
.row{display:flex;flex-direction:column;justify-content:center;min-height:52px;padding:8px 0}
.row+.row{border-top:1px solid #22263a}
.row b{font-size:15px;font-weight:600}
.row span{color:#a5a8b8;font-size:13px}
label.field{display:block;margin-top:16px;color:#a5a8b8;font-size:13px}
textarea{display:block;width:100%;min-height:72px;margin-top:8px;padding:12px 14px;border:1px solid #22263a;border-radius:12px;background:#111422;color:#f5f5f8;font:inherit;font-size:15px;resize:vertical}
.hint{margin-top:16px;padding:12px 14px;border:1px solid #ff5c8a59;border-radius:12px;background:#ff5c8a24;color:#ffd6e2;font-size:14px;line-height:1.43}
.hint b{display:block;margin-bottom:2px}
.check{display:flex;align-items:center;justify-content:center;width:56px;height:56px;margin-bottom:20px;border-radius:16px;background:#ff18b724;color:#ff18b7;font-size:26px;box-shadow:0 0 28px #ff18b773}
.zone[hidden]{display:none}
.powered{margin-top:20px;text-align:center}
@media(prefers-reduced-motion:no-preference){.slot,.btn{transition:border-color .15s ease,background .15s ease}}
`;

interface Rendered {
  status: number;
  html: string;
}

function shell(
  language: Language,
  title: string,
  content: string,
  options: { refreshSeconds?: number; nonce: string; script?: string },
): string {
  const t = TEXT[language];
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#07080d"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>${
    options.refreshSeconds
      ? `<meta http-equiv="refresh" content="${String(options.refreshSeconds)}">`
      : ''
  }<style>${STYLES}</style></head><body><main><span class="brand"><img src="/__verity/logo.png" alt="" width="30" height="22"><span>VERITY</span></span><section class="card" aria-labelledby="page-title">${content}</section><p class="foot powered">${escapeHtml(t.footer)} · <a href="https://verity.build">verity.build</a></p></main>${
    options.script ? `<script nonce="${options.nonce}">${options.script}</script>` : ''
  }</body></html>`;
}

function pageCsp(nonce: string): string {
  return `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
}

function people(request: SchedulingRequest): string {
  return [
    request.organizerName,
    ...request.colleagues.map((colleague) => colleague.name ?? colleague.email.split('@')[0]!),
  ].join(', ');
}

function timeRange(slot: { start: Date; end: Date }, zone: string, language: Language): string {
  const time = { hour: '2-digit', minute: '2-digit' } as const;
  return `${formatInZone(slot.start, zone, language, time)} – ${formatInZone(slot.end, zone, language, time)}`;
}

function dayLabel(date: Date, zone: string, language: Language): string {
  return formatInZone(date, zone, language, { weekday: 'long', day: 'numeric', month: 'short' });
}

function shortDate(date: Date, zone: string, language: Language): string {
  return formatInZone(date, zone, language, { weekday: 'short', day: 'numeric', month: 'short' });
}

function zoneQuery(zone: string, request: SchedulingRequest): string {
  return zone === request.timeZone ? '' : `tz=${encodeURIComponent(zone)}`;
}

// Offers the visitor's own time zone when it differs from the one shown; never applied silently.
const ZONE_SCRIPT = `(function(){var l=document.getElementById('zone');if(!l)return;try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone;if(!z||z===l.dataset.zone)return;var u=new URL(location.href);u.searchParams.set('tz',z);u.searchParams.delete('pin');l.href=u.pathname+u.search;l.textContent=l.dataset.label.replace('%s',z);l.hidden=false}catch(e){}})();`;

function pickPage(
  request: SchedulingRequest,
  slots: Slot[],
  zone: string,
  nonce: string,
  taken?: Date,
): Rendered {
  const language = request.language;
  const t = TEXT[language];
  const days = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = dayLabel(slot.start, zone, language);
    days.set(key, [...(days.get(key) ?? []), slot]);
  }
  const query = zoneQuery(zone, request);
  const content = `<p class="eyebrow">${escapeHtml(t.pick)}</p><div class="host">${t.invites(escapeHtml(request.organizerName))}</div><h1 id="page-title">${escapeHtml(request.title)}</h1><div class="meta"><div>${escapeHtml(t.minutes(request.durationMinutes))}${request.addMeet ? ` · ${t.meet}` : ''}</div><div>${escapeHtml(t.with)} ${escapeHtml(people(request))}</div><div>${escapeHtml(t.zoneLabel(zone))} <a id="zone" class="zone" hidden data-zone="${escapeHtml(zone)}" data-label="${escapeHtml(t.showLocal('%s'))}" href="#"></a></div></div>${
    taken
      ? `<div class="hint" role="alert"><b>${escapeHtml(t.taken(shortDate(taken, zone, language) + ', ' + formatInZone(taken, zone, language, { hour: '2-digit', minute: '2-digit' })))}</b>${escapeHtml(t.takenCopy)}</div>`
      : ''
  }${[...days.entries()]
    .map(
      ([day, daySlots]) =>
        `<div class="day"><span class="label">${escapeHtml(day)}</span><div class="slots">${daySlots
          .map(
            (slot) =>
              `<a class="slot" href="/confirm?start=${encodeURIComponent(slot.start.toISOString())}${query ? `&amp;${query}` : ''}">${escapeHtml(formatInZone(slot.start, zone, language, { hour: '2-digit', minute: '2-digit' }))}</a>`,
          )
          .join('')}</div></div>`,
    )
    .join(
      '',
    )}<p class="foot">${escapeHtml(t.openUntil(shortDate(request.closesAt, zone, language)))}</p>`;
  return {
    status: 200,
    html: shell(language, `${t.pick} · ${request.title}`, content, {
      refreshSeconds: 60,
      nonce,
      script: ZONE_SCRIPT,
    }),
  };
}

function confirmPage(
  request: SchedulingRequest,
  slot: Slot,
  zone: string,
  nonce: string,
): Rendered {
  const language = request.language;
  const t = TEXT[language];
  const content = `<p class="eyebrow">${escapeHtml(t.confirm)}</p><h1 id="page-title">${escapeHtml(dayLabel(slot.start, zone, language))}<br>${escapeHtml(timeRange(slot, zone, language))}</h1><p class="copy">${escapeHtml(request.title)} · ${escapeHtml(zone)}</p><div class="rows"><div class="row"><b>${escapeHtml(request.guestName ?? request.guestEmail)}</b><span>${escapeHtml(request.guestEmail)} · ${escapeHtml(t.you)}</span></div><div class="row"><b>${escapeHtml(request.organizerName)}</b><span>${escapeHtml(t.organizer)}</span></div>${request.colleagues
    .map(
      (colleague) =>
        `<div class="row"><b>${escapeHtml(colleague.name ?? colleague.email)}</b></div>`,
    )
    .join(
      '',
    )}</div><form method="post" action="/book"><input type="hidden" name="start" value="${escapeHtml(slot.start.toISOString())}"><input type="hidden" name="tz" value="${escapeHtml(zone)}"><label class="field">${escapeHtml(t.noteLabel(request.organizerName))}<textarea name="note" maxlength="${String(MAX_NOTE_LENGTH)}"></textarea></label><p class="foot">${escapeHtml(t.invitationTo(request.guestEmail))}</p><button class="btn" type="submit">${escapeHtml(t.book)}</button></form><a class="text" href="/${zoneQuery(zone, request) ? `?${zoneQuery(zone, request)}` : ''}">${escapeHtml(t.other)}</a>`;
  return {
    status: 200,
    html: shell(language, `${t.confirm} · ${request.title}`, content, { nonce }),
  };
}

function bookedPage(
  request: SchedulingRequest,
  zone: string,
  nonce: string,
  justNow: boolean,
): Rendered {
  const language = request.language;
  const t = TEXT[language];
  const slot = { start: request.bookedStart ?? new Date(0), end: request.bookedEnd ?? new Date(0) };
  const content = `<div class="check" aria-hidden="true">✓</div><p class="eyebrow">${escapeHtml(t.booked)}</p><h1 id="page-title">${escapeHtml(justNow ? t.bookedTitle : t.already)}</h1><p class="copy">${escapeHtml(t.bookedCopy(request.guestEmail))}</p><div class="rows"><div class="row"><b>${escapeHtml(dayLabel(slot.start, zone, language))} · ${escapeHtml(timeRange(slot, zone, language))}</b><span>${escapeHtml(zone)}</span></div>${
    request.addMeet
      ? `<div class="row"><b>${t.meet}</b><span>${escapeHtml(t.meetInInvite)}</span></div>`
      : ''
  }<div class="row"><b>${escapeHtml(people(request))}</b><span>${escapeHtml(request.title)}</span></div></div><p class="foot">${escapeHtml(t.replyToChange)}</p>`;
  return {
    status: 200,
    html: shell(language, `${t.booked} · ${request.title}`, content, { nonce }),
  };
}

function messagePage(
  language: Language,
  eyebrow: string,
  title: string,
  copy: string,
  nonce: string,
  extra = '',
  refreshSeconds?: number,
): Rendered {
  return {
    status: 200,
    html: shell(
      language,
      title,
      `<p class="eyebrow">${escapeHtml(eyebrow)}</p><h1 id="page-title">${escapeHtml(title)}</h1><p class="copy">${escapeHtml(copy)}</p>${extra}`,
      { nonce, ...(refreshSeconds ? { refreshSeconds } : {}) },
    ),
  };
}

function mailButton(request: SchedulingRequest): string {
  const t = TEXT[request.language];
  return `<a class="btn secondary" href="mailto:${encodeURIComponent(request.organizerEmail)}?subject=${encodeURIComponent(request.title)}">${escapeHtml(t.email(request.organizerName))}</a>`;
}

/** Render a page for a model; `zone` is the time zone the visitor chose, if valid. */
export function renderSchedulingPage(
  model: SchedulingPageModel,
  options: { zone?: string | undefined; nonce: string; taken?: Date; justBooked?: boolean },
): Rendered {
  const request = model.request;
  if (!request) {
    const t = TEXT.en;
    return {
      ...messagePage('en', t.unknown, t.unknown, t.unknownCopy, options.nonce),
      status: 404,
    };
  }
  const t = TEXT[request.language];
  const zone = options.zone && isValidTimeZone(options.zone) ? options.zone : request.timeZone;
  switch (model.kind) {
    case 'open':
      return pickPage(request, model.slots, zone, options.nonce, options.taken);
    case 'no_slots':
      return messagePage(
        request.language,
        request.title,
        t.noSlots,
        t.noSlotsCopy(request.organizerName),
        options.nonce,
        `${options.taken ? `<div class="hint" role="alert">${escapeHtml(t.takenCopy)}</div>` : ''}${mailButton(request)}<p class="foot">${escapeHtml(t.updatesUntil(shortDate(request.closesAt, zone, request.language)))}</p>`,
        60,
      );
    case 'booked':
      return bookedPage(request, zone, options.nonce, options.justBooked === true);
    case 'closed':
      return request.state === 'expired' ||
        (request.state === 'open' && request.closesAt <= new Date())
        ? messagePage(
            request.language,
            request.title,
            t.expired,
            t.expiredCopy(
              shortDate(request.closesAt, zone, request.language),
              request.organizerName,
            ),
            options.nonce,
            mailButton(request),
          )
        : messagePage(
            request.language,
            request.title,
            t.withdrawn,
            t.withdrawnCopy(request.organizerName),
            options.nonce,
            mailButton(request),
          );
    case 'unavailable':
      return request.state === 'draft' || request.state === 'provisioning'
        ? messagePage(
            request.language,
            request.title,
            t.notReady,
            t.notReadyCopy,
            options.nonce,
            `<a class="btn" href="/">${escapeHtml(t.retry)}</a>`,
          )
        : messagePage(
            request.language,
            request.title,
            t.unavailable,
            t.unavailableCopy,
            options.nonce,
            `<a class="btn" href="/">${escapeHtml(t.retry)}</a>`,
          );
  }
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** The HTTP handler of one request's public page. */
export function createSchedulingPageHandler(backend: SchedulingPageBackend, requestId: string) {
  const attempts: number[] = [];
  const views: number[] = [];
  const allow = (log: number[], limit: number): boolean => {
    const now = Date.now();
    while (log.length > 0 && log[0]! < now - 60_000) log.shift();
    if (log.length >= limit) return false;
    log.push(now);
    return true;
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const nonce = randomBytes(16).toString('base64');
    const send = (rendered: Rendered) => {
      response.writeHead(rendered.status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': pageCsp(nonce),
        'Referrer-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : rendered.html);
    };
    const url = new URL(request.url ?? '/', 'http://booking.invalid');
    const zone = url.searchParams.get('tz') ?? undefined;
    const reading =
      (request.method === 'GET' || request.method === 'HEAD') &&
      (url.pathname === '/' || url.pathname === '/confirm');
    if (reading && !allow(views, VIEWS_PER_MINUTE)) {
      response.writeHead(429, { 'Retry-After': '60' }).end();
      return;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
      send(renderSchedulingPage(await backend.view(requestId), { zone, nonce }));
      return;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/confirm') {
      const model = await backend.view(requestId);
      const start = Date.parse(url.searchParams.get('start') ?? '');
      const slot =
        model.kind === 'open'
          ? model.slots.find((candidate) => candidate.start.getTime() === start)
          : undefined;
      if (model.kind === 'open' && slot && model.request) {
        const chosen = zone && isValidTimeZone(zone) ? zone : model.request.timeZone;
        send(confirmPage(model.request, slot, chosen, nonce));
        return;
      }
      send(
        renderSchedulingPage(model, {
          zone,
          nonce,
          ...(Number.isFinite(start) ? { taken: new Date(start) } : {}),
        }),
      );
      return;
    }
    if (request.method === 'POST' && url.pathname === '/book') {
      // The edge only forwards same-origin posts. A browser reaching this loopback listener
      // directly, e.g. through DNS rebinding, sends its own Origin and is refused here.
      const origin = request.headers.origin;
      const expected = await backend.publicOrigin?.(requestId);
      if (origin !== undefined && (!expected || !sameOrigin(origin, expected))) {
        response.writeHead(403).end();
        return;
      }
      if (!allow(attempts, BOOK_ATTEMPTS_PER_MINUTE)) {
        response.writeHead(429, { 'Retry-After': '60' }).end();
        return;
      }
      const form = await readForm(request);
      const start = form?.get('start') ?? '';
      if (!form || !Number.isFinite(Date.parse(start))) {
        response.writeHead(400).end();
        return;
      }
      const formZone = form.get('tz') ?? undefined;
      const note = form.get('note')?.trim().slice(0, MAX_NOTE_LENGTH) || undefined;
      let result: SchedulingBookResult;
      try {
        result = await backend.book(requestId, start, note);
      } catch {
        // Nothing is promised either way: the page says it could not check, and a booking
        // that did happen shows up as booked on the next visit.
        const model = await backend.view(requestId).catch(() => undefined);
        const language = model?.request?.language ?? 'en';
        const t = TEXT[language];
        send(
          messagePage(
            language,
            model?.request?.title ?? t.unknown,
            t.unconfirmed,
            t.unconfirmedCopy,
            nonce,
            `<a class="btn" href="/">${escapeHtml(t.retry)}</a>`,
          ),
        );
        return;
      }
      if (result.kind === 'booked') {
        send(
          renderSchedulingPage(
            { kind: 'booked', request: result.request },
            { zone: formZone, nonce, justBooked: true },
          ),
        );
        return;
      }
      send(
        renderSchedulingPage(result.model, {
          zone: formZone,
          nonce,
          ...(result.kind === 'taken' ? { taken: new Date(start) } : {}),
        }),
      );
      return;
    }
    response.writeHead(request.method === 'GET' || request.method === 'HEAD' ? 404 : 405).end();
  };
}

/** Loopback listeners, one per request, each the target origin of that request's connector. */
export class SchedulingPageListeners {
  private readonly servers = new Map<string, { server: Server; origin: string }>();

  constructor(private readonly backend: SchedulingPageBackend) {}

  listen = async (requestId: string): Promise<string> => {
    const existing = this.servers.get(requestId);
    if (existing) return existing.origin;
    const handler = createSchedulingPageHandler(this.backend, requestId);
    const server = createServer((request, response) => {
      handler(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
        else response.end();
      });
    });
    server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Could not start the booking page');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    this.servers.set(requestId, { server, origin });
    return origin;
  };

  unlisten = async (requestId: string): Promise<void> => {
    const entry = this.servers.get(requestId);
    if (!entry) return;
    this.servers.delete(requestId);
    entry.server.closeAllConnections();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  };

  async close(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((id) => this.unlisten(id)));
  }
}
