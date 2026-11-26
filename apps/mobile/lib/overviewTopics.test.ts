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

  it('asks a view joining a live topic to read, since the server answers only new subscriptions', async () => {
    renderHook(() => useOverviewTopics('https://core.example', ['p1'], jest.fn(), jest.fn()));
    const joined = jest.fn();
    renderHook(() => useOverviewTopics('https://core.example', ['p1'], jest.fn(), joined));
    await Promise.resolve();
    expect(joined).toHaveBeenCalledTimes(1);
    expect(mockSubscribed).toEqual(['project:p1']);
  });

  it('keeps topics for a project page while Home waits past its share', () => {
    const many = Array.from({ length: 48 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    renderHook(() => useOverviewTopics('https://core.example', many, jest.fn(), jest.fn()));
    // Home's long list leaves the reserve free, so an opened page is live.
    expect(mockSubscribed).toHaveLength(40);
    renderHook(() => useOverviewTopics('https://core.example', ['zz'], jest.fn(), jest.fn()));
    expect(mockSubscribed).toContain('project:zz');
    // A page of a project Home waits for takes it out of the queue.
    renderHook(() => useOverviewTopics('https://core.example', ['p47'], jest.fn(), jest.fn()));
    expect(mockSubscribed).toContain('project:p47');
  });

  it('returns a reserved topic once the page leaves and Home is past its share', () => {
    const many = Array.from({ length: 48 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    renderHook(() => useOverviewTopics('https://core.example', many, jest.fn(), jest.fn()));
    const page = renderHook(() =>
      useOverviewTopics('https://core.example', ['p47'], jest.fn(), jest.fn()),
    );
    expect(mockSubscribed).toContain('project:p47');
    page.unmount();
    // Otherwise every page visit would use up the reserve for good.
    expect(mockUnsubscribed).toEqual(['project:p47']);
  });

  it('gives a freed topic to a project that waited past the cap', () => {
    const many = Array.from({ length: 41 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const first = renderHook(() =>
      useOverviewTopics('https://core.example', many.slice(0, 20), jest.fn(), jest.fn()),
    );
    renderHook(() =>
      useOverviewTopics('https://core.example', many.slice(20), jest.fn(), jest.fn()),
    );
    expect(mockSubscribed).toHaveLength(40);
    expect(mockSubscribed).not.toContain('project:p40');
    first.unmount();
    expect(mockSubscribed).toContain('project:p40');
  });

  it('does not promote a waiting project of the view that detaches', () => {
    // 41 projects: the last one waits. Unmounting must not subscribe it on its
    // way out only to release it again.
    const many = Array.from({ length: 41 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const home = renderHook(() =>
      useOverviewTopics('https://core.example', many, jest.fn(), jest.fn()),
    );
    expect(mockSubscribed).not.toContain('project:p40');
    home.unmount();
    expect(mockSubscribed).not.toContain('project:p40');
  });

  it('lets a resync of one topic replay only that topic', () => {
    const events: DomainEvent[] = [];
    renderHook(() =>
      useOverviewTopics('https://core.example', ['p1', 'p2'], (e) => events.push(e), jest.fn()),
    );
    const other: DomainEvent = { t: 'choices.answered', sessionId: 's2', rev: 3 };
    mockSinks.get('project:p2')!.event(other);
    mockSinks.get('project:p1')!.resync();
    // p2 was not resynced, so its views read nothing and must not see the
    // same revision twice.
    mockSinks.get('project:p2')!.event(other);
    expect(events).toEqual([other]);
  });

  it('keeps one hub per server while views of two servers are mounted', () => {
    renderHook(() => useOverviewTopics('https://a.example', ['p1'], jest.fn(), jest.fn()));
    renderHook(() => useOverviewTopics('https://b.example', ['p1'], jest.fn(), jest.fn()));
    renderHook(() => useOverviewTopics('https://a.example', ['p1'], jest.fn(), jest.fn()));
    // The second view of server A shares its topic instead of subscribing again.
    expect(mockSubscribed).toEqual(['project:p1', 'project:p1']);
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
