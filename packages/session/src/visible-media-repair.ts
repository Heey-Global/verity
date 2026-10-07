import type { AgentEvent } from '@verity/events';

const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\([^)]*\)/;
const IMAGE_PATH_RE =
  /(?:^|[\s"'(])((?:\/work\/\.verity-sessions\/[^\s"'()]+|(?:\.?\/)?(?:[\w@.+-]+\/)+[\w@.+ -]+)\.(?:png|jpe?g|gif|webp|svg))(?:[:?#][^\s"'()]*)?/gi;

const VISUAL_REQUEST_RE =
  /\b(image|images|icon|icons|visual|variant|variants|media)\b|bild|bilder|bildanh[aä]ng|markdown-bild|vorschl[aä]g|variante|varianten|symbol/i;

const CLAIMS_VISIBLE_MEDIA_RE =
  /\b(?:sichtbare[nmrs]?\s+(?:bild(?:er)?|markdown-bild(?:er)?)|bild(?:er)?\s+(?:ist|sind)\s+(?:(?:jetzt|nun|bereits)\s+)?sichtbar|markdown-bild(?:er)?|bildanh[aä]nge?|(?:verlinke|linke|zeige|sende|h[aä]nge)\b[^.!?\n]*\bbild(?:er)?\b|(?:show|shown|attach|attached)\b[^.!?\n]*\bimages?\b|(?:visible|attached)\s+images?|images?\s+(?:(?:are|is)\s+)?(?:(?:now|already)\s+)?(?:shown|visible|attached))\b/i;

function textFromEvent(event: AgentEvent): string {
  if (event.t === 'text') return event.delta;
  if (event.t === 'tool_result') {
    return typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
  }
  return '';
}

function responseText(events: readonly AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { t: 'text' }> => event.t === 'text')
    .map((event) => event.delta)
    .join('');
}

function collectImagePaths(events: readonly AgentEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    const text = textFromEvent(event);
    for (const match of text.matchAll(IMAGE_PATH_RE)) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      const path = raw.replace(/^\.\/+/, '');
      if (path.includes('..') || path.includes('/.git/')) continue;
      seen.add(path);
      if (seen.size >= 6) return [...seen];
    }
  }
  return [...seen];
}

export function buildVisibleMediaRepairEvent(
  prompt: string,
  events: readonly AgentEvent[],
): Extract<AgentEvent, { t: 'text' }> | undefined {
  const response = responseText(events);
  if (
    MARKDOWN_IMAGE_RE.test(response) ||
    !VISUAL_REQUEST_RE.test(prompt) ||
    !CLAIMS_VISIBLE_MEDIA_RE.test(response)
  )
    return undefined;
  const paths = collectImagePaths(events);
  if (paths.length === 0) return undefined;
  const links = paths.map((path, index) => `![Bild ${index + 1}](${path})`).join('\n\n');
  return {
    t: 'text',
    delta: `Hinweis: Diese Antwort hat keine sichtbaren Bildlinks geliefert. Ich zeige die gefundenen Bilddateien direkt an:\n\n${links}`,
  };
}
