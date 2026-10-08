import { isLinkableSession } from './sessionLinks';

it('keeps unavailable sessions and inactive or control-plane projects out of the picker', () => {
  const candidates = [
    { sessionId: 'active', projectId: 'a' },
    { sessionId: 'inactive', projectId: 'b' },
    { sessionId: 'control', projectId: 'c' },
    { sessionId: 'missing', projectId: 'missing' },
    { sessionId: 'unassigned', projectId: null },
    { sessionId: 'unavailable', projectId: 'a', resumable: false },
  ];
  expect(
    candidates.filter((candidate) =>
      isLinkableSession(candidate, 'self', [
        { id: 'a', state: 'active', kind: 'local' },
        { id: 'b', state: 'failed', kind: 'local' },
        { id: 'c', state: 'active', kind: 'control_plane' },
      ]),
    ),
  ).toEqual([candidates[0]]);
});
