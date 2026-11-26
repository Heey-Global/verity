import type { DomainEvent, LiveTopicSink } from '@verity/mobile';
import { renderHook } from '@testing-library/react-native';
import { useOverviewTopics } from './overviewTopics';

const mockSinks = new Map<string, LiveTopicSink>();
const mockUnsubscribed: string[] = [];
const mockSubscribed: string[] = [];
jest.mock('./liveConnection', () => ({
  liveConnectionFor: () => ({
    subscribeTopic: (topic: string, sink: LiveTopicSink) => {
      mockSinks.set(topic, sink);
      mockSubscribed.push(topic);
      return () => mockUnsubscribed.push(topic);
    },
  }),
}));
// Each test signs in to its own account, so it starts from an empty store.
let mockAccount = 0;
jest.mock('./tasksStore', () => ({ taskAccountScope: () => `account-${mockAccount}` }));

const answered = (rev: number): DomainEvent => ({ t: 'choices.answered', sessionId: 's1', rev });

beforeEach(() => {
  mockAccount += 1;
  mockSinks.clear();
  mockSubscribed.length = 0;
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

  it('shares one subscription and one gate between views of the same project', () => {
    const home: DomainEvent[] = [];
    const page: DomainEvent[] = [];
    const homeView = renderHook(() =>
      useOverviewTopics('https://core.example', ['p1', 'p2'], (e) => home.push(e), jest.fn()),
    );
    const pageView = renderHook(() =>
      useOverviewTopics('https://core.example', ['p1'], (e) => page.push(e), jest.fn()),
    );
    expect(mockSubscribed.sort()).toEqual(['project:p1', 'project:p2']);
    mockSinks.get('project:p1')!.event(answered(3));
    mockSinks.get('project:p2')!.event({ t: 'choices.answered', sessionId: 's2', rev: 1 });
    expect(home).toHaveLength(2);
    // The page hears its own project only.
    expect(page).toEqual([answered(3)]);
    // Leaving the page keeps the topic Home still shows.
    pageView.unmount();
    expect(mockUnsubscribed).toEqual([]);
    homeView.unmount();
    expect(mockUnsubscribed.sort()).toEqual(['project:p1', 'project:p2']);
  });

  it('starts from an empty store for another account', () => {
    const events: DomainEvent[] = [];
    const first = renderHook(() =>
      useOverviewTopics('https://core.example', ['p1'], (e) => events.push(e), jest.fn()),
    );
    mockSinks.get('project:p1')!.event(answered(5));
    first.unmount();
    mockAccount += 1;
    renderHook(() =>
      useOverviewTopics('https://core.example', ['p1'], (e) => events.push(e), jest.fn()),
    );
    // The other account's gate never saw revision 5.
    mockSinks.get('project:p1')!.event(answered(5));
    expect(events).toEqual([answered(5), answered(5)]);
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
