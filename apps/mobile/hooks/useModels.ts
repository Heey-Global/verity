import { type ProjectAgent, type VerityClient, VerityApiError } from '@verity/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseModels {
  /** Every routable model id the server offers (Claude bare ids + any OpenCode
   * provider-qualified ids), in raw server order. Empty until loaded / on error. */
  models: string[];
  /** Provider-aware display order; falls back to `models` for older servers. */
  modelOrder: string[];
  /** Models the server recommends placing behind a generic disclosure. */
  moreModels: string[];
  /** The server's advertised spawn default (a Claude id), or undefined until loaded. */
  defaultModel: string | undefined;
  /** The project's allowed agents when it excludes some; undefined when unrestricted. */
  allowedAgents: ProjectAgent[] | undefined;
  /** True while the initial (or a forced) load is in flight. */
  loading: boolean;
  /** A human-readable load error, or undefined. */
  error: string | undefined;
  /** Re-fetch the model list. */
  refresh: () => void;
  cancel: () => void;
}

/**
 * One-shot loader for the new-session model picker (ADR 0001 / #143): fetches the
 * routable model set on mount and on explicit `refresh()`. Mirrors {@link useBranches}
 * — a small glue hook (no headless model), StrictMode-safe via a
 * mounted + request-id guard so a slow/stale response can't clobber current state.
 *
 * Ordering + default resolution are the picker UI's job (via the pure `orderModels` /
 * `defaultModel` helpers); this hook just surfaces the raw server response.
 */
export function useModels(
  client: VerityClient,
  enabled = true,
  /** Narrows the list to the project's allowed agents. */
  projectId?: string | null,
): UseModels {
  const [models, setModels] = useState<string[]>([]);
  const [modelOrder, setModelOrder] = useState<string[]>([]);
  const [moreModels, setMoreModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [allowedAgents, setAllowedAgents] = useState<ProjectAgent[] | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  // Race/unmount guard (mirrors useBranches): only the LATEST load writes state, and
  // nothing writes after unmount.
  const mounted = useRef(true);
  const reqId = useRef(0);
  const pending = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const cancel = useCallback(() => {
    reqId.current++;
    pending.current?.controller.abort();
    pending.current = null;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, []);

  const load = useCallback(() => {
    if (pending.current) return pending.current.promise;
    const controller = new AbortController();
    const promise = (async () => {
      const id = ++reqId.current;
      const fresh = (): boolean =>
        mounted.current && id === reqId.current && !controller.signal.aborted;
      setLoading(true);
      try {
        const res = await client.listModels(projectId ?? undefined, controller.signal);
        if (!fresh()) return;
        setModels(res.models);
        setModelOrder(res.modelOrder ?? res.models);
        setMoreModels(res.moreModels ?? []);
        setDefaultModel(res.default);
        setAllowedAgents(res.allowedAgents);
        setError(undefined);
      } catch (caught) {
        if (!fresh()) return;
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load models');
      } finally {
        if (fresh()) setLoading(false);
      }
    })().finally(() => {
      if (pending.current?.controller === controller) pending.current = null;
    });
    pending.current = { controller, promise };
    return promise;
  }, [client, projectId]);

  useEffect(() => {
    cancel();
    setModels([]);
    setModelOrder([]);
    setMoreModels([]);
    setAllowedAgents(undefined);
    setDefaultModel(undefined);
    setError(undefined);
    setLoading(false);
    return cancel;
  }, [client, projectId, cancel]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    return cancel;
  }, [load, enabled, cancel]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return {
    models,
    modelOrder,
    moreModels,
    defaultModel,
    allowedAgents,
    loading,
    error,
    refresh,
    cancel,
  };
}
