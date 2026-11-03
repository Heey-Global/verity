import pg from 'pg';
import type { ProbeRuntimeOptions } from './probe-runtime.js';
import { BackupService, type BackupServiceOptions } from './service.js';
import { backupDatabaseUrl, readBackupCapabilities } from './prerequisites.js';

export interface BackupRuntime {
  service?: BackupService;
  unavailableReason?: 'installer-required' | 'runtime-unavailable';
  close: () => Promise<void>;
}
export interface BackupRuntimeOptions {
  probe?: ProbeRuntimeOptions;
  root: string;
  databaseUrl: string;
  /** Resolve from the running container, never a floating release channel. */
  currentImage: () => Promise<string | undefined>;
  architecture: 'amd64' | 'arm64';
  release: string;
  schema: string;
  store: BackupServiceOptions['store'];
  onError: (error: unknown) => void;
  paths?: { pairing: string; destination: string; identityRequests: string };
}

/** Own the dedicated read-only pool and service together; backup failure never prevents normal boot. */
export async function openBackupRuntime(options: BackupRuntimeOptions): Promise<BackupRuntime> {
  const unavailable = (reason: NonNullable<BackupRuntime['unavailableReason']>): BackupRuntime => ({
    unavailableReason: reason,
    close: () => Promise.resolve(),
  });
  const paths = options.paths ?? {
    pairing: '/run/verity-pairing',
    destination: '/run/verity-backups',
    identityRequests: '/run/verity-backup-identity',
  };
  if (!(await readBackupCapabilities(paths)).available) return unavailable('installer-required');
  let pool: pg.Pool | undefined;
  let service: BackupService | undefined;
  try {
    const image = await options.currentImage();
    if (
      !image ||
      !/^ghcr\.io\/heey-global\/verity\/verity-server(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/.test(
        image,
      )
    )
      throw new Error('Backups require the running official digest-pinned server image');
    pool = new pg.Pool({
      connectionString: await backupDatabaseUrl(options.databaseUrl, paths.pairing),
      max: 1,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      application_name: 'verity-backup',
    });
    pool.on('error', options.onError);
    const readonlyPool = pool;
    service = await BackupService.open({
      root: options.root,
      ...(options.probe ? { probe: options.probe } : {}),
      ...paths,
      identityRoot: paths.pairing,
      image,
      release: options.release,
      schema: options.schema,
      architecture: options.architecture,
      connect: () => readonlyPool.connect(),
      store: options.store,
      onError: options.onError,
    });
    if (!service) {
      await pool.end();
      return unavailable('installer-required');
    }
    const activeService = service;
    let closing: Promise<void> | undefined;
    return {
      service,
      close: () =>
        (closing ??= (async () => {
          try {
            await activeService.close();
          } finally {
            await readonlyPool.end();
          }
        })()),
    };
  } catch (error) {
    await service?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    options.onError(error);
    return unavailable('runtime-unavailable');
  }
}
