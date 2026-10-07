import {
  mergeSessionPreviewUrls,
  nextProjectPreviewLinks,
  type SessionPreviewLink,
} from './sessionPreviewLinks';

const NOW = 1_000_000;
const link = (sessionId: string, url: string | null, expiresAt = NOW + 60_000) =>
  ({ sessionId, url, expiresAt }) satisfies SessionPreviewLink;
const ok = (value: SessionPreviewLink[]) => ({ status: 'fulfilled' as const, value });
const failed = { status: 'rejected' as const, reason: new Error('offline') };

describe('nextProjectPreviewLinks', () => {
  it('keeps only the failed project at its previous links', () => {
    // One project failing every poll must not freeze every other project's links.
    const previous = new Map([
      ['p1', [link('s1', 'http://old-1')]],
      ['p2', [link('s2', 'http://old-2')]],
    ]);
    const next = nextProjectPreviewLinks(previous, ['p1', 'p2'], [failed, ok([])]);
    expect(next.get('p1')).toEqual([link('s1', 'http://old-1')]);
    expect(next.get('p2')).toEqual([]);
  });

  it('drops projects that are no longer polled', () => {
    const previous = new Map([['gone', [link('s1', 'http://old')]]]);
    expect([...nextProjectPreviewLinks(previous, ['p1'], [ok([])]).keys()]).toEqual(['p1']);
  });
});

describe('mergeSessionPreviewUrls', () => {
  it('prefers the local link over the public one for the same session', () => {
    const merged = mergeSessionPreviewUrls(
      new Map([['p1', [link('s1', 'https://public')]]]),
      new Map([['p1', [link('s1', 'http://local')]]]),
      NOW,
    );
    expect(merged.get('s1')).toBe('http://local');
  });

  it('lets a kept link lapse at its expiry', () => {
    // A link carried over from an earlier poll must not stay tappable past expiry.
    const merged = mergeSessionPreviewUrls(
      new Map(),
      new Map([['p1', [link('s1', 'http://local', NOW - 1)]]]),
      NOW,
    );
    expect(merged.has('s1')).toBe(false);
  });

  it('marks a public share without an origin yet', () => {
    const merged = mergeSessionPreviewUrls(new Map([['p1', [link('s1', null)]]]), new Map(), NOW);
    expect(merged.get('s1')).toBeNull();
  });
});
