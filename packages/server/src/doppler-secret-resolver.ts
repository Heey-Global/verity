import {
  providerBindingRecordSchema,
  secretAliasRecordSchema,
  type ProviderBindingRecord,
  type ProviderBindingRef,
  type RunGrantClaims,
  type SecretAliasRecord,
  type SecretAliasRef,
} from '@verity/secret-contracts';

import type { HttpFetch } from './github.js';
import type { SecretResolver } from './secret-grant-broker.js';

const DOPPLER_API_ORIGIN = 'https://api.doppler.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_ABORT_TIMEOUT_MS = 2 ** 32 - 1;
const DOPPLER_SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export type DopplerSecretResolutionPhase =
  | 'project configuration'
  | 'secret alias'
  | 'Doppler authentication'
  | 'Doppler request start'
  | 'Doppler request timeout'
  | 'Doppler response status'
  | 'Doppler response format';

export class DopplerSecretResolutionError extends Error {
  constructor(
    message: string,
    readonly phase?: DopplerSecretResolutionPhase,
    readonly httpStatus?: number,
    readonly projectConfiguration?: string,
  ) {
    super(message);
    this.name = 'DopplerSecretResolutionError';
  }
}

export interface DopplerSecretCatalog {
  resolveAlias(ref: SecretAliasRef, projectId: string): Promise<SecretAliasRecord | undefined>;
  resolveBinding(
    ref: ProviderBindingRef,
    projectId: string,
  ): Promise<ProviderBindingRecord | undefined>;
}

/** Return a fresh, owned credential buffer. The resolver consumes and zeroizes it after use. */
export type SecretCredentialReader = (credentialRef: string) => Promise<Uint8Array | undefined>;

export interface DopplerSecretResolverOptions {
  catalog: DopplerSecretCatalog;
  readCredential: SecretCredentialReader;
  fetch?: HttpFetch;
  /** Security pin; any value other than Doppler's production origin is rejected at startup. */
  apiOrigin?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}
export type DopplerSecretNameLister = (binding: ProviderBindingRecord) => Promise<string[]>;

function rejected(
  phase: DopplerSecretResolutionPhase = 'project configuration',
  context?: { binding?: ProviderBindingRecord | undefined; httpStatus?: number },
): DopplerSecretResolutionError {
  const status = context?.httpStatus;
  const statusText = status === undefined ? '' : ` (HTTP ${String(status)})`;
  const configuration =
    context?.binding === undefined
      ? ''
      : `, project configuration \`${context.binding.id}@v${String(context.binding.version)}\``;
  return new DopplerSecretResolutionError(
    `Secret resolution failed during ${phase}${statusText}${configuration}. No secret value was exposed.`,
    phase,
    status,
    context?.binding === undefined
      ? undefined
      : `${context.binding.id}@v${String(context.binding.version)}`,
  );
}

/**
 * The config answered, and simply holds nothing under this name. Kept separate
 * from {@link rejected} so the ad-hoc path can name it: there the caller chose
 * the name, so echoing it reveals nothing it did not already have. The catalog
 * path never lets this escape — a provider key it derived from an alias is not
 * the caller’s to learn.
 */
class DopplerSecretAbsentError extends DopplerSecretResolutionError {
  constructor(readonly secretName: string) {
    super(
      `Secret resolution failed during secret alias: no secret named ${secretName} is available to this project. No secret value was exposed.`,
      'secret alias',
    );
  }
}

class DopplerTransientResponseError extends Error {}

/**
 * Do not rely on an HTTP adapter to cooperate with AbortSignal. Native fetch normally does, but a
 * wedged dispatcher or DNS implementation can leave its promise pending after the signal fires.
 * The resolver owns the deadline, so it must also own the promise that observes it.
 */
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error('Doppler request timed out');
  if (signal.aborted) return Promise.reject(reason());
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener('abort', aborted);
      reject(reason());
    };
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error instanceof Error ? error : new Error('Doppler request failed'));
      },
    );
  });
}

function sameBinding(a: ProviderBindingRef, b: ProviderBindingRef): boolean {
  return a.id === b.id && a.version === b.version && a.provider === b.provider;
}

function sameProfile(alias: SecretAliasRecord, claims: RunGrantClaims): boolean {
  return (
    alias.profile.id === claims.profile.id &&
    alias.profile.version === claims.profile.version &&
    alias.profile.policyHash === claims.profile.policyHash
  );
}

async function readBoundedBody(
  response: Awaited<ReturnType<HttpFetch>>,
  maxResponseBytes: number,
  binding?: ProviderBindingRecord,
  signal?: AbortSignal,
): Promise<string> {
  const declaredHeader = response.headers?.get('content-length');
  if (declaredHeader !== undefined && declaredHeader !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declaredHeader))
      throw rejected('Doppler response format', { binding });
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared > maxResponseBytes)
      throw rejected('Doppler response format', { binding });
  }
  if (response.body !== undefined && response.body !== null) {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) {
          await reader.cancel();
          throw rejected('Doppler response format', { binding });
        }
        // Wrap the stream-owned bytes without copying so the finally below wipes the actual chunk.
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } catch (error) {
      for (const chunk of chunks) chunk.fill(0);
      if (error instanceof DopplerSecretResolutionError) throw error;
      if (signal?.aborted === true) throw rejected('Doppler request timeout', { binding });
      throw new DopplerTransientResponseError();
    } finally {
      reader.releaseLock();
    }
    const combined = Buffer.concat(chunks, total);
    try {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(combined);
      } catch {
        throw rejected('Doppler response format', { binding });
      }
    } finally {
      combined.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  }
  // Buffering adapters cannot enforce a trustworthy bound when an upstream understates or omits
  // Content-Length. Reject them outright; production's native fetch always supplies a body stream.
  throw rejected('Doppler response format', { binding });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function downloadSecrets(
  binding: ProviderBindingRecord,
  providerKeys: readonly string[],
  tokenBytes: Uint8Array,
  options: Pick<
    DopplerSecretResolverOptions,
    | 'fetch'
    | 'apiOrigin'
    | 'timeoutMs'
    | 'maxResponseBytes'
    | 'maxAttempts'
    | 'retryDelayMs'
    | 'sleep'
  >,
): Promise<Map<string, Uint8Array>> {
  try {
    let token: string;
    try {
      token = utf8.decode(tokenBytes).trim();
    } catch {
      throw rejected('Doppler authentication', { binding });
    }
    if (token.length === 0 || token.includes('\0'))
      throw rejected('Doppler authentication', { binding });

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const url = new URL(
      `${options.apiOrigin ?? DOPPLER_API_ORIGIN}/v3/configs/config/secrets/download`,
    );
    url.searchParams.set('project', binding.dopplerProject);
    url.searchParams.set('config', binding.dopplerConfig);
    url.searchParams.set('format', 'json');
    // Ask Doppler for exactly the approved keys. This is defense in depth: even if response handling
    // regresses, unrelated config secrets were never downloaded into the Verity process.
    url.searchParams.set('secrets', [...providerKeys].sort().join(','));

    const doFetch: HttpFetch = options.fetch ?? ((input, init) => fetch(input, init));
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const sleep =
      options.sleep ??
      ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    let response: Awaited<ReturnType<HttpFetch>> | undefined;
    let responseSignal: AbortSignal | undefined;
    let raw: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        response = await raceAbort(
          doFetch(url.toString(), {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
              'User-Agent': 'verity',
            },
            signal,
          }),
          signal,
        );
        responseSignal = signal;
      } catch {
        if (signal.aborted) {
          if (attempt === maxAttempts) throw rejected('Doppler request timeout', { binding });
          await sleep(retryDelayMs * attempt);
          continue;
        }
        if (attempt === maxAttempts) throw rejected('Doppler request start', { binding });
        await sleep(retryDelayMs * attempt);
        continue;
      }
      if (response.ok) {
        try {
          raw = await raceAbort(
            readBoundedBody(response, maxResponseBytes, binding, responseSignal),
            responseSignal,
          );
          break;
        } catch (error) {
          const timedOut = responseSignal.aborted;
          const retryable =
            timedOut ||
            error instanceof DopplerTransientResponseError ||
            (error instanceof DopplerSecretResolutionError &&
              error.phase === 'Doppler request timeout');
          if (!retryable) throw error;
          if (attempt === maxAttempts) {
            if (timedOut) throw rejected('Doppler request timeout', { binding });
            throw error;
          }
          response = undefined;
          responseSignal = undefined;
          await sleep(retryDelayMs * attempt);
          continue;
        }
      }
      if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
        const phase =
          response.status === 401 || response.status === 403
            ? 'Doppler authentication'
            : 'Doppler response status';
        await response.body?.cancel().catch(() => undefined);
        throw rejected(phase, { binding, httpStatus: response.status });
      }
      await response.body?.cancel().catch(() => undefined);
      response = undefined;
      responseSignal = undefined;
      await sleep(retryDelayMs * attempt);
      continue;
    }
    if (response === undefined || raw === undefined)
      throw rejected('Doppler request start', { binding });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw rejected('Doppler response format', { binding });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw rejected('Doppler response format', { binding });
    const record = parsed as Record<string, unknown>;
    const selected = new Map<string, Uint8Array>();
    try {
      for (const key of providerKeys) {
        const value = record[key];
        if (value === undefined) throw new DopplerSecretAbsentError(key);
        if (typeof value !== 'string') throw rejected('Doppler response format', { binding });
        selected.set(key, Buffer.from(value, 'utf8'));
      }
      return selected;
    } catch (error) {
      for (const value of selected.values()) value.fill(0);
      throw error;
    } finally {
      // Strings are immutable in JavaScript, so promptly drop every owned reference after copying
      // only approved values into zeroizable byte buffers.
      raw = '';
      for (const key of Object.keys(record)) delete record[key];
      parsed = undefined;
    }
  } finally {
    tokenBytes.fill(0);
  }
}

/** Resolve one named value from an already project-scoped Doppler config token. */
export async function resolveDopplerProjectSecret(options: {
  projectId: string;
  dopplerProject: string;
  dopplerConfig: string;
  token: Uint8Array;
  secretName: string;
  fetch?: HttpFetch;
}): Promise<Uint8Array> {
  if (!DOPPLER_SECRET_NAME.test(options.secretName)) throw rejected();
  const values = await downloadSecrets(
    providerBindingRecordSchema.parse({
      id: 'project-settings',
      version: 1,
      projectId: options.projectId,
      provider: 'doppler',
      credentialRef: 'secretref:project-settings',
      dopplerProject: options.dopplerProject,
      dopplerConfig: options.dopplerConfig,
      state: 'active',
    }),
    [options.secretName],
    options.token,
    { ...(options.fetch === undefined ? {} : { fetch: options.fetch }) },
  );
  const value = values.get(options.secretName);
  // The download succeeded; the config simply holds no secret under this name.
  // That is the one failure here worth naming: the caller supplied the name, so
  // echoing it reveals nothing it did not already have — no provider key, no
  // binding id, no project or config name, no response body, no transport cause.
  // Collapsing it into the opaque message makes a plain typo indistinguishable
  // from a revoked token, and telling those two apart has cost hours.
  if (value === undefined) {
    throw new DopplerSecretResolutionError(
      `Doppler secret resolution failed: no secret named ${options.secretName} is available to this project`,
    );
  }
  return value;
}

/**
 * Resolve the exact aliases frozen into one grant from versioned server-owned catalog records and
 * Doppler. No credential or plaintext secret crosses this function except in its returned map,
 * which the broker immediately seals to the authenticated worker recipient.
 */
export function createDopplerSecretResolver(options: DopplerSecretResolverOptions): SecretResolver {
  if (options.apiOrigin !== undefined && options.apiOrigin !== DOPPLER_API_ORIGIN) {
    throw new Error('Doppler API origin must be https://api.doppler.com');
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > MAX_ABORT_TIMEOUT_MS)
  ) {
    throw new Error(`Doppler timeout must be an integer from 1 to ${String(MAX_ABORT_TIMEOUT_MS)}`);
  }
  if (
    options.maxResponseBytes !== undefined &&
    (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)
  ) {
    throw new Error('Doppler response limit must be a positive integer');
  }
  if (
    options.maxAttempts !== undefined &&
    (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0)
  ) {
    throw new Error('Doppler max attempts must be a positive integer');
  }
  if (
    options.retryDelayMs !== undefined &&
    (!Number.isSafeInteger(options.retryDelayMs) || options.retryDelayMs < 0)
  ) {
    throw new Error('Doppler retry delay must be a non-negative integer');
  }
  return async (claims) => {
    const resolved = new Map<string, Uint8Array>();
    try {
      const approvedBindings = new Map(
        claims.providerBindings.map((binding) => [
          `${binding.id}:${String(binding.version)}:${binding.provider}`,
          binding,
        ]),
      );
      const groups = new Map<
        string,
        {
          bindingRef: ProviderBindingRef;
          aliases: Array<{ record: SecretAliasRecord; target: string }>;
        }
      >();
      const targets = new Set<string>();

      for (const aliasRef of claims.aliases) {
        const alias = secretAliasRecordSchema.parse(
          await options.catalog.resolveAlias(aliasRef, claims.projectId),
        );
        if (
          alias.id !== aliasRef.id ||
          alias.version !== aliasRef.version ||
          alias.projectId !== claims.projectId ||
          alias.state !== 'active' ||
          !sameProfile(alias, claims) ||
          alias.injection.kind !== 'env'
        ) {
          throw rejected('secret alias');
        }
        const bindingKey = `${alias.binding.id}:${String(alias.binding.version)}:${alias.binding.provider}`;
        const approved = approvedBindings.get(bindingKey);
        if (approved === undefined || !sameBinding(alias.binding, approved))
          throw rejected('project configuration');
        if (!DOPPLER_SECRET_NAME.test(alias.providerKey)) throw rejected('secret alias');
        const target = alias.injection.target;
        if (targets.has(target)) throw rejected('secret alias');
        targets.add(target);
        const group = groups.get(bindingKey) ?? { bindingRef: approved, aliases: [] };
        group.aliases.push({ record: alias, target });
        groups.set(bindingKey, group);
      }

      for (const group of groups.values()) {
        const binding = providerBindingRecordSchema.parse(
          await options.catalog.resolveBinding(group.bindingRef, claims.projectId),
        );
        if (
          binding.id !== group.bindingRef.id ||
          binding.version !== group.bindingRef.version ||
          binding.provider !== 'doppler' ||
          binding.projectId !== claims.projectId ||
          binding.state !== 'active'
        ) {
          throw rejected('project configuration');
        }
        const credential = await options.readCredential(binding.credentialRef);
        if (credential === undefined) throw rejected('Doppler authentication', { binding });
        const keys = [...new Set(group.aliases.map(({ record }) => record.providerKey))];
        // The reader contract returns an owned buffer. downloadSecrets consumes and zeroizes it
        // after the Authorization header has been constructed.
        // A provider key the catalog derived from an alias is not the caller's to
        // learn, so an absent one collapses back into the opaque failure here.
        let values: Map<string, Uint8Array>;
        try {
          values = await downloadSecrets(binding, keys, credential, options);
        } catch (error) {
          // Provider keys came from the server-owned catalog and are not caller-visible.
          if (error instanceof DopplerSecretAbsentError) throw rejected('secret alias');
          throw error;
        }
        for (const { record, target } of group.aliases) {
          const value = values.get(record.providerKey);
          if (value === undefined) throw rejected('secret alias');
          resolved.set(target, value);
        }
      }
      Object.defineProperty(resolved, 'dispose', {
        value: () => {
          for (const value of new Set(resolved.values())) value.fill(0);
          resolved.clear();
        },
        enumerable: false,
      });
      return resolved;
    } catch (error) {
      for (const value of resolved.values()) value.fill(0);
      resolved.clear();
      if (error instanceof DopplerSecretResolutionError) throw error;
      throw rejected('project configuration');
    }
  };
}

/** List only Doppler key names. The names endpoint does not return secret values. */
export function createDopplerSecretNameLister(
  options: Pick<
    DopplerSecretResolverOptions,
    'readCredential' | 'fetch' | 'apiOrigin' | 'timeoutMs' | 'maxResponseBytes'
  >,
): DopplerSecretNameLister {
  if (options.apiOrigin !== undefined && options.apiOrigin !== DOPPLER_API_ORIGIN) {
    throw new Error('Doppler API origin must be https://api.doppler.com');
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > MAX_ABORT_TIMEOUT_MS)
  ) {
    throw new Error(`Doppler timeout must be an integer from 1 to ${MAX_ABORT_TIMEOUT_MS}`);
  }
  if (
    options.maxResponseBytes !== undefined &&
    (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)
  ) {
    throw new Error('Doppler response limit must be a positive integer');
  }
  return async (bindingInput) => {
    const binding = providerBindingRecordSchema.parse(bindingInput);
    if (binding.provider !== 'doppler' || binding.state !== 'active') throw rejected();
    const credential = await options.readCredential(binding.credentialRef);
    if (credential === undefined) throw rejected();
    try {
      const token = utf8.decode(credential).trim();
      if (token.length === 0 || token.includes('\0')) throw rejected();
      return await fetchDopplerSecretNames(
        binding.dopplerProject,
        binding.dopplerConfig,
        token,
        options,
      );
    } catch {
      throw rejected();
    } finally {
      credential.fill(0);
    }
  };
}

/**
 * The name array out of a `/v3/configs/config/secrets/names` body.
 *
 * Doppler answers `{"names": [...]}`. Reading only `secrets` here meant every live
 * response parsed to `undefined`, so this lister rejected on every call — and the
 * one caller that matters, `brokeredSecretAliases` in `embedded.ts`, degrades a
 * rejection to `[]`. The alias names ADR 0011 D3 promises the agent were therefore
 * silently empty for every project, indistinguishable from a project that has no
 * secrets at all. The unit test missed it by mocking the shape the parser expected
 * instead of the one the provider sends.
 *
 * Deliberately strict: `names` is the only shape this endpoint returns, and the
 * sibling `/secrets` endpoint returns an object rather than an array, so tolerating
 * extra shapes would buy no compatibility and cost the ability to notice a call
 * pointed at the wrong endpoint. Anything else must reject loudly rather than
 * degrade to an empty list again.
 */
function namesArrayOf(parsed: unknown): unknown[] | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const names = (parsed as { names?: unknown }).names;
  // `Array.isArray` widens an `unknown` to `any[]`, which the entry-typing rules
  // reject; narrow it explicitly so callers stay on `unknown[]`.
  return Array.isArray(names) ? (names as unknown[]) : undefined;
}

async function fetchDopplerSecretNames(
  dopplerProject: string,
  dopplerConfig: string,
  token: string,
  options: Pick<
    DopplerSecretResolverOptions,
    'fetch' | 'apiOrigin' | 'timeoutMs' | 'maxResponseBytes'
  >,
): Promise<string[]> {
  const url = new URL(`${options.apiOrigin ?? DOPPLER_API_ORIGIN}/v3/configs/config/secrets/names`);
  url.searchParams.set('project', dopplerProject);
  url.searchParams.set('config', dopplerConfig);
  url.searchParams.set('include_dynamic_secrets', 'false');
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const response = await doFetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'verity',
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw rejected();
  const parsed = JSON.parse(
    await readBoundedBody(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES),
  ) as unknown;
  const candidate = namesArrayOf(parsed);
  if (candidate === undefined || candidate.length > 10_000) throw rejected();
  const names = candidate.map((name) => {
    if (typeof name !== 'string' || !DOPPLER_SECRET_NAME.test(name)) throw rejected();
    return name;
  });
  return [...new Set(names)].sort();
}

/**
 * List key NAMES from an already project-scoped Doppler config token (the project-settings
 * `DOPPLER_TOKEN` path used by the live brokered HTTP tool). Names only, never values
 * (ADR 0011 D3).
 */
export async function listDopplerProjectSecretNames(options: {
  dopplerProject: string;
  dopplerConfig: string;
  token: Uint8Array;
  fetch?: HttpFetch;
}): Promise<string[]> {
  try {
    let token: string;
    try {
      token = utf8.decode(options.token).trim();
    } catch {
      throw rejected();
    }
    if (token.length === 0 || token.includes('\0')) throw rejected();
    try {
      return await fetchDopplerSecretNames(options.dopplerProject, options.dopplerConfig, token, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    } catch {
      throw rejected();
    }
  } finally {
    options.token.fill(0);
  }
}
