import type { AgentEvent } from '@verity/events';

/**
 * Transport-neutral lifecycle facts. Backends translate only signals their
 * runtime actually exposes into this shape; the shared mapper owns canonical
 * event construction and duplicate suppression.
 */
export type StructuredLifecycleSignal =
  | { type: 'compaction'; id?: string | undefined }
  | {
      type: 'task';
      id: string;
      phase: 'started' | 'progress' | 'ended';
      toolUseId?: string | undefined;
      description?: string | undefined;
      status?: string | undefined;
    }
  | { type: 'skill'; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Parse the vendor-neutral lifecycle extension Verity asks ACP adapters to emit. */
export function lifecycleSignalsFromMeta(
  meta: { [key: string]: unknown } | null | undefined,
): StructuredLifecycleSignal[] {
  if (!isRecord(meta?.['verity'])) return [];
  const lifecycle = meta['verity']['lifecycle'];
  const values = Array.isArray(lifecycle) ? lifecycle : [lifecycle];
  const signals: StructuredLifecycleSignal[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    switch (value['type']) {
      case 'compaction': {
        const id = nonEmptyString(value['id']);
        signals.push({ type: 'compaction', ...(id !== undefined ? { id } : {}) });
        break;
      }
      case 'task': {
        const id = nonEmptyString(value['id']);
        const phase = value['phase'];
        if (
          id === undefined ||
          (phase !== 'started' && phase !== 'progress' && phase !== 'ended')
        ) {
          break;
        }
        const toolUseId = nonEmptyString(value['toolUseId']);
        const description = nonEmptyString(value['description']);
        const status = nonEmptyString(value['status']);
        signals.push({
          type: 'task',
          id,
          phase,
          ...(toolUseId !== undefined ? { toolUseId } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(status !== undefined ? { status } : {}),
        });
        break;
      }
      case 'skill': {
        const text = nonEmptyString(value['text']);
        if (text !== undefined) signals.push({ type: 'skill', text });
        break;
      }
    }
  }
  return signals;
}

/** Stateful signal → canonical event mapper shared by ACP, OpenCode and future Pi. */
export class StructuredLifecycleMapper {
  private readonly compactions = new Set<string>();
  private readonly taskPhase = new Map<string, StructuredLifecycleSignal & { type: 'task' }>();

  consume(signal: StructuredLifecycleSignal): AgentEvent[] {
    if (signal.type === 'skill') return [{ t: 'skill', text: signal.text }];
    if (signal.type === 'compaction') {
      if (signal.id !== undefined) {
        if (this.compactions.has(signal.id)) return [];
        this.compactions.add(signal.id);
      }
      return [{ t: 'compaction', boundary: true }];
    }

    const previous = this.taskPhase.get(signal.id);
    const rank = { started: 0, progress: 1, ended: 2 } as const;
    if (previous !== undefined && rank[signal.phase] < rank[previous.phase]) return [];
    const enriched = previous === undefined ? signal : { ...previous, ...signal };
    if (
      previous !== undefined &&
      previous.phase === signal.phase &&
      previous.toolUseId === enriched.toolUseId &&
      previous.description === enriched.description &&
      previous.status === enriched.status
    ) {
      return [];
    }
    this.taskPhase.set(signal.id, enriched);
    return [
      {
        t: 'task',
        id: enriched.id,
        phase: enriched.phase,
        ...(enriched.toolUseId !== undefined ? { toolUseId: enriched.toolUseId } : {}),
        ...(enriched.description !== undefined ? { description: enriched.description } : {}),
        ...(enriched.status !== undefined ? { status: enriched.status } : {}),
      },
    ];
  }

  consumeAll(signals: readonly StructuredLifecycleSignal[]): AgentEvent[] {
    return signals.flatMap((signal) => this.consume(signal));
  }
}
