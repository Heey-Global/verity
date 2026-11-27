import type { LiveServerFrame } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';
import { DomainEventBus } from './domain-events.js';
import { TopicSubscriptions } from './topic-subscriptions.js';

const listed = (projectId: string, rev: number) =>
  ({ t: 'project.listed', projectId, rev }) as const;

describe('TopicSubscriptions filter', () => {
  // A delivery that throws while records wait on an asynchronous filter must
  // not stall the topic: every later record of it waits in the same queue.
  it('keeps delivering after a send fails behind an asynchronous filter', async () => {
    const bus = new DomainEventBus();
    const frames: LiveServerFrame[] = [];
    let failNext = true;
    const subscriptions = new TopicSubscriptions({
      bus,
      canRead: async () => true,
      filter: async () => true,
      send: (frame) => {
        if (frame.k === 'domain' && failNext) {
          failNext = false;
          throw new Error('socket closed under us');
        }
        frames.push(frame);
        return true;
      },
      overBudget: () => false,
      logger: { warn: () => undefined },
    });
    await subscriptions.subscribe([{ topic: 'collection:projects' }]);
    bus.publish('collection:projects', listed('p1', 1));
    bus.publish('collection:projects', listed('p2', 2));
    bus.publish('collection:projects', listed('p3', 3));
    await vi.waitFor(() => expect(frames.filter((frame) => frame.k === 'domain')).toHaveLength(2));
    expect(frames.flatMap((frame) => (frame.k === 'domain' ? [frame.event.rev] : []))).toEqual([
      2, 3,
    ]);
    subscriptions.dispose();
  });
});
