import type { AgentEvent } from '@verity/events';

const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\([^)]*\)/;
const IMAGE_PATH_RE =
  /(?:^|[\s"'(])((?:\/work\/\.verity-sessions\/[^\s"'()]+|(?:\.?\/)?(?:[\w@.+-]+\/)+[\w@.+ -]+)\.(?:png|jpe?g|gif|webp|svg))(?:[:?#][^\s"'()]*)?/gi;

const VISUAL_REQUEST_RE =
  /\b(image|images|icon|icons|visual|variant|variants|media)\b|bild|bilder|bildanh[aä]ng|markdown-bild|vorschl[aä]g|variante|varianten|symbol/i;

const CLAIMS_VISIBLE_MEDIA_RE =
  /sichtbar|markdown-bild|bildanh[aä]ng|direkt.*bild|verlinke|linke|h[aä]nge.*bild|send(e|e).*bild|shown|visible|attached|imagegen/i;

function textFromEvent(event: AgentEvent): string {
  if (event.t === 'text') return event.delta;
  if (event.t === 'tool_result') {
    return typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
  }
  return '';
}

function hasVisibleMedia(events: readonly AgentEvent[]): boolean {
  return events.some((event) => event.t === 'text' && MARKDOWN_IMAGE_RE.test(event.delta));
}

function shouldRepair(prompt: string, events: readonly AgentEvent[]): boolean {
  if (!VISUAL_REQUEST_RE.test(prompt)) return false;
  return events.some((event) => event.t === 'text' && CLAIMS_VISIBLE_MEDIA_RE.test(event.delta));
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
  if (hasVisibleMedia(events) || !shouldRepair(prompt, events)) return undefined;
  const paths = collectImagePaths(events);
  if (paths.length === 0) {
    return {
      t: 'text',
      delta:
        'Hinweis: Diese Antwort hat sichtbare Bilder angekündigt, aber keine Bildlinks oder Bildanhänge geliefert.',
    };
  }
  const links = paths.map((path, index) => `![Bild ${index + 1}](${path})`).join('\n\n');
  return {
    t: 'text',
    delta: `Hinweis: Diese Antwort hat keine sichtbaren Bildlinks geliefert. Ich zeige die gefundenen Bilddateien direkt an:\n\n${links}`,
  };
}
