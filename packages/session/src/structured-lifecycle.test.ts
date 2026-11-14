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

  it('parses cycle and background-level signals without turning them into transcript rows', () => {
    const signals = lifecycleSignalsFromMeta({
      verity: {
        lifecycle: [
          { type: 'cycle', phase: 'started' },
          { type: 'cycle', phase: 'paused' },
          { type: 'background', live: ['bash-1', 'monitor-2'] },
          { type: 'background', live: [] },
        ],
      },
    });
    expect(signals).toEqual([
      { type: 'cycle', phase: 'started' },
      { type: 'background', live: ['bash-1', 'monitor-2'] },
      { type: 'background', live: [] },
    ]);
    expect(new StructuredLifecycleMapper().consumeAll(signals)).toEqual([]);
  });

  // A level replaces what the edges said. Reading a malformed one as "nothing is
  // live" would end a held turn under background work that is still running.
  it('drops a malformed background level whole instead of reading it as empty', () => {
    expect(
      lifecycleSignalsFromMeta({
        verity: {
          lifecycle: [
            { type: 'background', live: ['bash-1', ''] },
            { type: 'background', live: ['bash-1', 7] },
            { type: 'background', live: 'bash-1' },
            { type: 'background' },
          ],
        },
      }),
    ).toEqual([]);
  });
});
