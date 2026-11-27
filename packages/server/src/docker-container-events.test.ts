import { describe, expect, it, vi } from 'vitest';
import { createContainerEventSource } from './docker-container-events.js';
import type { HttpFetch } from './github.js';

/** A response whose body the test writes to and ends. */
function streamingResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: { ok: true, status: 200, body, json: async () => ({}), text: async () => '' },
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const event = (projectId: string | undefined, action: string) =>
  `${JSON.stringify({
    Type: 'container',
    Action: action,
    Actor: { Attributes: projectId === undefined ? {} : { 'verity.project-id': projectId } },
  })}\n`;

describe('createContainerEventSource', () => {
  it('reports project container events, also across split chunks', async () => {
    const first = streamingResponse();
    const fetch = vi.fn<HttpFetch>().mockResolvedValueOnce(first.response);
    const source = createContainerEventSource({ baseUrl: 'http://docker.test/v1.41', fetch });
    const events: string[] = [];
    const connected = vi.fn();
    const stop = source.followContainerEvents({
      onEvent: (projectId, action) => events.push(`${projectId}:${action}`),
      onConnected: connected,
      onDisconnected: () => undefined,
    });
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
    const line = event('p1', 'die');
    first.write(line.slice(0, 10));
    first.write(line.slice(10) + event(undefined, 'die') + 'not json\n' + event('p2', 'start'));
    await vi.waitFor(() => expect(events).toEqual(['p1:die', 'p2:start']));
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.pathname).toBe('/v1.41/events');
    expect(JSON.parse(url.searchParams.get('filters')!)).toMatchObject({
      type: ['container'],
      label: ['verity.project-id'],
    });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ stream: true });
    await stop();
  });

  // A daemon restart ends the stream; without reopening it, every container
  // change after that would wait for the next periodic comparison.
  it('reopens the stream after it ends or fails, and stops for good', async () => {
    const first = streamingResponse();
    const second = streamingResponse();
    const fetch = vi
      .fn<HttpFetch>()
      .mockResolvedValueOnce(first.response)
      .mockRejectedValueOnce(new Error('daemon restarting'))
      .mockResolvedValueOnce(second.response);
    const source = createContainerEventSource({
      baseUrl: 'http://docker.test',
      fetch,
      reconnectMs: { min: 1, max: 2 },
    });
    const connected = vi.fn();
    const disconnected = vi.fn();
    const stop = source.followContainerEvents({
      onEvent: () => undefined,
      onConnected: connected,
      onDisconnected: disconnected,
    });
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
    first.end();
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2));
    expect(disconnected).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(3);
    await stop();
    expect(fetch.mock.calls[2]![1]?.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
