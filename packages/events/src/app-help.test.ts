import { describe, expect, it } from 'vitest';

import {
  APP_HELP_SYSTEM_PROMPT,
  APP_HELP_TOOL,
  APP_HELP_TOPICS,
  DOCS_BASE_URL,
  answerAppHelp,
  appHelpRequestSchema,
} from './app-help.js';

describe('APP_HELP_TOPICS', () => {
  it('uses unique kebab-case ids', () => {
    const ids = APP_HELP_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('only uses in-app links of the verity scheme', () => {
    for (const topic of APP_HELP_TOPICS) {
      if (topic.appLink !== undefined) expect(topic.appLink).toMatch(/^verity:\/\/[a-z/-]+$/);
    }
  });
});

describe('appHelpRequestSchema', () => {
  it('accepts no arguments, a topic or a query, and nothing else', () => {
    expect(appHelpRequestSchema.parse({})).toEqual({});
    expect(appHelpRequestSchema.parse({ topic: ' github ' })).toEqual({ topic: 'github' });
    expect(appHelpRequestSchema.safeParse({ topic: '' }).success).toBe(false);
    expect(appHelpRequestSchema.safeParse({ sessionId: 's1' }).success).toBe(false);
  });
});

describe('answerAppHelp', () => {
  it('lists every topic when called without arguments', () => {
    const answer = answerAppHelp({});
    expect('topics' in answer && answer.topics.map((topic) => topic.id)).toEqual(
      APP_HELP_TOPICS.map((topic) => topic.id),
    );
  });

  it('returns one entry with its app link and an absolute docs URL', () => {
    expect(answerAppHelp({ topic: 'GitHub' })).toEqual({
      entries: [
        expect.objectContaining({
          id: 'github',
          appLink: 'verity://settings/github',
          docsUrl: `${DOCS_BASE_URL}docs/getting-started.md`,
        }),
      ],
    });
  });

  it('falls back to the index for an unknown topic instead of guessing', () => {
    const answer = answerAppHelp({ topic: 'teleport' });
    expect('topics' in answer && answer.note).toContain('Unknown topic "teleport"');
  });

  it.each([
    ['How do I connect Doppler?', 'doppler'],
    ['Where are my secrets stored, and what if I lose the master password?', 'secrets-storage'],
    ['How can I share the web app the agent started?', 'preview-and-sharing'],
    ['Can agents read my Gmail?', 'google'],
    ['I forgot my password', 'secrets-storage'],
    ['Where do I put an API key for my app?', 'doppler'],
  ])('ranks the matching topic first for %j', (query, id) => {
    const answer = answerAppHelp({ query });
    expect('entries' in answer && answer.entries[0]?.id).toBe(id);
  });

  // Substring matching let `ai` hit "email" and `pr` hit "project", so a mail
  // question came back with the AI provider entries and their links.
  it('matches short keywords only as whole words', () => {
    const answer = answerAppHelp({ query: 'How do I let agents send email?' });
    const ids = 'entries' in answer ? answer.entries.map((entry) => entry.id) : [];
    expect(ids[0]).toBe('google');
    expect(ids).not.toEqual(expect.arrayContaining(['claude']));
    expect(ids).not.toEqual(expect.arrayContaining(['codex']));
  });

  it('returns several entries when a question fits more than one topic', () => {
    const answer = answerAppHelp({ query: 'Where do meeting transcripts go?' });
    const ids = 'entries' in answer ? answer.entries.map((entry) => entry.id) : [];
    expect(ids).toEqual(expect.arrayContaining(['attendee', 'live-meeting']));
    expect(ids.length).toBeLessThanOrEqual(3);
  });

  // Without this, words like "can" and "agents" gave every topic a point and an
  // unrelated entry with its link rode along behind the real answer.
  it('does not let filler words pull in unrelated topics', () => {
    for (const [query, id] of [
      ['Can I use my iPad too?', 'devices'],
      ['Can agents read WhatsApp?', 'matrix'],
      // A bare "docs" keyword once tied any documentation question to Google.
      ['Where are the docs for Doppler?', 'doppler'],
    ]) {
      const answer = answerAppHelp({ query });
      expect('entries' in answer && answer.entries.map((entry) => entry.id), query).toEqual([id]);
    }
  });

  // A bare "stored" keyword handed the master-password entry and its link to a
  // question about meeting transcripts.
  it('keeps the secrets entry out of storage questions about other things', () => {
    const answer = answerAppHelp({ query: 'Where are my meeting transcripts stored?' });
    const ids = 'entries' in answer ? answer.entries.map((entry) => entry.id) : [];
    expect(ids).toContain('live-meeting');
    expect(ids).not.toContain('secrets-storage');
  });

  // "project" is in most settings questions; as a keyword it pulled the
  // projects-and-sessions entry and its new-project link behind the real answer.
  it('does not answer a connection question with the projects overview', () => {
    const answer = answerAppHelp({ query: 'How do I connect GitHub to my project?' });
    const ids = 'entries' in answer ? answer.entries.map((entry) => entry.id) : [];
    expect(ids[0]).toBe('github');
    expect(ids).not.toContain('projects-and-sessions');
  });

  it('still finds the projects overview for questions about projects', () => {
    for (const query of ['How do I add a new project?', 'Can I run sessions in parallel?']) {
      const answer = answerAppHelp({ query });
      expect('entries' in answer && answer.entries[0]?.id, query).toBe('projects-and-sessions');
    }
  });

  it('returns the index with a note when nothing matches the query', () => {
    const answer = answerAppHelp({ query: 'xyzzy plugh' });
    expect('topics' in answer && answer.note).toContain('No topic matched');
  });
});

describe('prompts', () => {
  it('names the tool and forbids invented links', () => {
    expect(APP_HELP_SYSTEM_PROMPT).toContain(APP_HELP_TOOL);
    expect(APP_HELP_SYSTEM_PROMPT).toContain('never invent');
  });
});
