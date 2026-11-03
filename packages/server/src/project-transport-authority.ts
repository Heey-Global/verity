import { AsyncLocalStorage } from 'node:async_hooks';
import type { InternalConnectionIdentity } from './internal-listener.js';

/** Supplied by the project Unix listener and trusted session authorizer, never tool JSON. */
export interface ProjectTransportAuthority extends InternalConnectionIdentity {
  signal: AbortSignal;
  authorize(): Promise<void>;
}
const authorityScope = new AsyncLocalStorage<ProjectTransportAuthority>();

/** Revalidate before each remote request, including requests after credential/DNS waits. */
export async function assertProjectTransportAuthority(): Promise<void> {
  const authority = authorityScope.getStore();
  if (!authority) return; // Control-plane and non-project API routes retain their own auth.
  authority.signal.throwIfAborted();
  let abort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => authority.authorize()),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(authority.signal.reason ?? new Error('Project authority retired'));
        authority.signal.addEventListener('abort', abort, { once: true });
        if (authority.signal.aborted) abort();
        timer = setTimeout(() => reject(new Error('Project authority check timed out')), 1000);
        timer.unref();
      }),
    ]);
  } finally {
    if (abort) authority.signal.removeEventListener('abort', abort);
    clearTimeout(timer);
  }
  authority.signal.throwIfAborted();
}

export function projectTransportSignal(timeout: AbortSignal): AbortSignal {
  const authority = authorityScope.getStore();
  return authority ? AbortSignal.any([authority.signal, timeout]) : timeout;
}

/** Keep the provider-side lifetime tied to the exact generation and initiating session.
 * A failed or wedged authority check aborts; it can never renew an already aborted call.
 */
export async function withProjectTransportAuthority<T>(
  authority: ProjectTransportAuthority,
  execute: () => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const scoped = { ...authority, signal: AbortSignal.any([authority.signal, abort.signal]) };
  let checking = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const poll = setInterval(() => {
    if (checking || scoped.signal.aborted) return;
    checking = true;
    deadline = setTimeout(() => abort.abort(), 1000);
    deadline.unref();
    void Promise.resolve()
      .then(() => authority.authorize())
      .catch(() => abort.abort())
      .finally(() => {
        clearTimeout(deadline);
        checking = false;
      });
  }, 500);
  poll.unref();
  try {
    return await authorityScope.run(scoped, async () => {
      await assertProjectTransportAuthority();
      const result = await execute();
      scoped.signal.throwIfAborted();
      return result;
    });
  } finally {
    clearInterval(poll);
    if (deadline !== undefined) clearTimeout(deadline);
    abort.abort();
  }
}

/** Shared by Google adapters so their follow-up requests cannot escape the scope. */
export async function projectTransportFetch<T, I extends { signal?: AbortSignal | null }>(
  fetcher: (url: string, init?: I) => Promise<T>,
  url: string,
  init: I,
): Promise<T> {
  await assertProjectTransportAuthority();
  return fetcher(url, {
    ...init,
    signal: projectTransportSignal(init.signal ?? AbortSignal.timeout(20_000)),
  });
}
