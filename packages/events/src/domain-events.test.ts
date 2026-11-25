import { describe, expect, it } from 'vitest';
import { domainTopic, parseDomainTopic } from './domain-events.js';
import { decodeLiveClientFrame, decodeLiveServerFrame } from './live.js';

describe('domain topics', () => {
  it('round-trips every topic kind', () => {
    for (const kind of ['user', 'project', 'session'] as const) {
      expect(parseDomainTopic(domainTopic(kind, 'abc-1'))).toEqual({ kind, id: 'abc-1' });
    }
  });

  it('rejects topics that could address something else', () => {
    // A topic is an authorization subject; anything but `<kind>:<id>` must
    // fail closed rather than be read as a broader or different subject.
    for (const topic of ['project', 'project:', 'team:t1', 'project:a:b', 'project:a b', '*']) {
      expect(parseDomainTopic(topic)).toBeUndefined();
      expect(
        decodeLiveClientFrame(JSON.stringify({ k: 'topics.sub', topics: [{ topic }] })).ok,
      ).toBe(false);
    }
  });
});

describe('live protocol 2 frames', () => {
  it('decodes topic subscriptions and domain events', () => {
    expect(
      decodeLiveClientFrame(
        JSON.stringify({ k: 'topics.sub', topics: [{ topic: 'project:p1', cursor: 3 }] }),
      ).ok,
    ).toBe(true);
    const domain = decodeLiveServerFrame(
      JSON.stringify({
        k: 'domain',
        topic: 'session:s1',
        cursor: 4,
        event: {
          t: 'permission.decided',
          sessionId: 's1',
          toolUseId: 't1',
          rev: 2,
          outcome: 'allowed',
        },
      }),
    );
    expect(domain.ok).toBe(true);
    expect(
      decodeLiveServerFrame(JSON.stringify({ k: 'resync', topic: 'user:u1', cursor: 9 })).ok,
    ).toBe(true);
  });

  it('refuses a domain event outside the catalogue', () => {
    const frame = { k: 'domain', topic: 'project:p1', cursor: 1, event: { t: 'project.renamed' } };
    expect(decodeLiveServerFrame(JSON.stringify(frame)).ok).toBe(false);
  });

  it('still decodes a version 1 ready frame without topics', () => {
    const ready = decodeLiveServerFrame(JSON.stringify({ k: 'ready', v: 1, maxSessions: 8 }));
    expect(ready.ok && ready.frame.k === 'ready' && ready.frame.topics).toBeUndefined();
  });
});
