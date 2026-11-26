import type { DomainEvent, LiveTopicSink } from '@verity/mobile';
import { renderHook } from '@testing-library/react-native';
import { useOverviewTopics } from './overviewTopics';

const mockSinks = new Map<string, LiveTopicSink>();
const mockUnsubscribed: string[] = [];
jest.mock('./liveConnection', () => ({
  liveConnectionFor: () => ({
    subscribeTopic: (topic: string, sink: LiveTopicSink) => {
      mockSinks.set(topic, sink);
      return () => mockUnsubscribed.push(topic);
    },
  }),
}));

const answered = (rev: number): DomainEvent => ({ t: 'choices.answered', sessionId: 's1', rev });

beforeEach(() => {
  mockSinks.clear();
  mockUnsubscribed.length = 0;
});

describe('useOverviewTopics', () => {
  it('subscribes each project once and resubscribes only when the set changes', () => {
    const { rerender, unmount } = renderHook(
      ({ ids }: { ids: string[] }) =>
        useOverviewTopics(
          'https://core.example',
          ids,
          () => undefined,
          () => undefined,
        ),
      { initialProps: { ids: ['p2', 'p1', 'p1'] } },
    );
    expect([...mockSinks.keys()].sort()).toEqual(['project:p1', 'project:p2']);
    rerender({ ids: ['p1', 'p2'] });
    expect(mockUnsubscribed).toEqual([]);
    rerender({ ids: ['p1'] });
    expect(mockUnsubscribed.sort()).toEqual(['project:p1', 'project:p2']);
    unmount();
  });

  it('delivers each revision once and reads once for a burst of resyncs', async () => {
    const events: DomainEvent[] = [];
    const resyncs = jest.fn();
    renderHook(() =>
      useOverviewTopics('https://core.example', ['p1', 'p2'], (e) => events.push(e), resyncs),
    );
    const sink = mockSinks.get('project:p1')!;
    sink.event(answered(2));
    sink.event(answered(2));
    expect(events).toEqual([answered(2)]);
    // A new subscription is answered with resync by every topic at once.
    mockSinks.get('project:p1')!.resync();
    mockSinks.get('project:p2')!.resync();
    await Promise.resolve();
    expect(resyncs).toHaveBeenCalledTimes(1);
    // The snapshot now decides; an older revision applies again afterwards.
    sink.event(answered(1));
    expect(events).toEqual([answered(2), answered(1)]);
  });

  it('subscribes nothing without a server or projects', () => {
    renderHook(() =>
      useOverviewTopics(
        null,
        ['p1'],
        () => undefined,
        () => undefined,
      ),
    );
    renderHook(() =>
      useOverviewTopics(
        'https://core.example',
        [],
        () => undefined,
        () => undefined,
      ),
    );
    expect(mockSinks.size).toBe(0);
  });
});
