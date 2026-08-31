import { describe, expect, it } from 'vitest';
import { lifecycleSignalsFromMeta, StructuredLifecycleMapper } from './structured-lifecycle.js';

describe('StructuredLifecycleMapper', () => {
  it('maps the vendor-neutral ACP extension and rejects malformed entries', () => {
    expect(
      lifecycleSignalsFromMeta({
        verity: {
          lifecycle: [
            { type: 'compaction', id: 'compact-1' },
            {
              type: 'task',
              id: 'task-1',
              phase: 'started',
              toolUseId: 'tool-1',
              description: 'Investigate',
            },
            { type: 'skill', text: 'Skill body' },
            { type: 'task', id: '', phase: 'ended' },
            { type: 'unknown' },
          ],
        },
      }),
    ).toEqual([
      { type: 'compaction', id: 'compact-1' },
      {
        type: 'task',
        id: 'task-1',
        phase: 'started',
        toolUseId: 'tool-1',
        description: 'Investigate',
      },
      { type: 'skill', text: 'Skill body' },
    ]);
  });

  it('deduplicates compaction ids and monotonic task phases', () => {
    const mapper = new StructuredLifecycleMapper();
    expect(mapper.consume({ type: 'compaction', id: 'compact-1' })).toEqual([
      { t: 'compaction', boundary: true },
    ]);
    expect(mapper.consume({ type: 'compaction', id: 'compact-1' })).toEqual([]);
    expect(mapper.consume({ type: 'task', id: 'task-1', phase: 'started' })).toEqual([
      { t: 'task', id: 'task-1', phase: 'started' },
    ]);
    expect(mapper.consume({ type: 'task', id: 'task-1', phase: 'started' })).toEqual([]);
    expect(mapper.consume({ type: 'task', id: 'task-1', phase: 'progress' })).toEqual([
      { t: 'task', id: 'task-1', phase: 'progress' },
    ]);
    expect(mapper.consume({ type: 'task', id: 'task-1', phase: 'started' })).toEqual([]);
    expect(
      mapper.consume({ type: 'task', id: 'task-1', phase: 'ended', status: 'completed' }),
    ).toEqual([{ t: 'task', id: 'task-1', phase: 'ended', status: 'completed' }]);
    expect(
      mapper.consume({
        type: 'task',
        id: 'task-1',
        phase: 'ended',
        toolUseId: 'tool-1',
        description: 'Final summary',
      }),
    ).toEqual([
      {
        t: 'task',
        id: 'task-1',
        phase: 'ended',
        toolUseId: 'tool-1',
        description: 'Final summary',
        status: 'completed',
      },
    ]);
    expect(
      mapper.consume({
        type: 'task',
        id: 'task-1',
        phase: 'ended',
        toolUseId: 'tool-1',
        description: 'Final summary',
      }),
    ).toEqual([]);
    expect(mapper.consume({ type: 'task', id: 'task-1', phase: 'progress' })).toEqual([]);
  });
});
