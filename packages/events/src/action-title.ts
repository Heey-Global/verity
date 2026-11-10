/** Display metadata never participates in routing or authorization. */
export function actionTitle(name: string, title?: string, source?: string): string {
  const clean = (value: string): string =>
    value
      // Display metadata must strip controls supplied by external tools.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 200);
  const words = (value: string): string =>
    value
      .split(/[_\s-]+/u)
      .filter(Boolean)
      .map((word) => {
        const acronyms: Record<string, string> = {
          api: 'API',
          cli: 'CLI',
          http: 'HTTP',
          qa: 'QA',
          github: 'GitHub',
          mcp: 'MCP',
        };
        return Object.hasOwn(acronyms, word.toLowerCase())
          ? acronyms[word.toLowerCase()]!
          : word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
  const provided = title ? clean(title) : '';
  const readable = provided.includes('_') ? words(provided) : provided;
  if (readable) return readable;
  const qualified = /^mcp__([^_]+)__(.+)$/u.exec(name);
  let normalized = clean(qualified?.[2] ?? name).replace(/^verity_verity_/u, 'verity_');
  const aliases: Record<string, string> = {
    verity_start_planning: 'verity_planning_start',
    verity_present_plan: 'verity_planning_present',
    verity_end_planning: 'verity_planning_implement',
    verity_present_mockups: 'verity_mockups_present',
    verity_complete_mockups: 'verity_mockups_complete',
    verity_list_sessions: 'verity_session_list',
    verity_send_session_message: 'verity_session_send_message',
    verity_list_linked_sessions: 'verity_session_list_links',
    verity_recent_session_messages: 'verity_session_read_recent_messages',
    verity_publish_session_progress: 'verity_session_publish_progress',
  };
  if ((!qualified || qualified[1] === 'verity') && Object.hasOwn(aliases, normalized))
    normalized = aliases[normalized]!;
  source ??= qualified?.[1];
  if (source && source.toLowerCase() !== 'verity')
    return `${words(clean(source))} · ${words(normalized)}`;
  const parts = normalized.split('_');
  if (parts[0] === 'verity' && parts.length === 2) return `Verity · ${words(parts[1]!)}`;
  if (parts[0] === 'verity' && parts.length > 2)
    return `Verity · ${words(parts[1]!)} · ${words(parts.slice(2).join('_'))}`;
  return [source ? clean(source) : undefined, words(normalized)].filter(Boolean).join(' · ');
}
