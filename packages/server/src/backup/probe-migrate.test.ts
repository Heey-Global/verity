import { beforeEach, expect, it, vi } from 'vitest';
import { SERVER_COMPAT } from '../self-update/compat.js';
import { migrateProbeDatabase } from './probe-migrate.js';

const fake = vi.hoisted(() => ({
  open: vi.fn(),
  migrate: vi.fn(),
  generation: vi.fn(),
  query: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@verity/store', async (original) => ({
  ...(await original<typeof import('@verity/store')>()),
  createPostgresDb: fake.open,
  migrateToLatest: fake.migrate,
  executedSchemaGeneration: fake.generation,
}));
const name = `verity_probe_${'a'.repeat(32)}`;
const environment = {
  VERITY_BACKUP_PROBE_DATABASE_URL: `postgres://probe:example@postgres/${name}`,
  VERITY_BACKUP_PROBE_SCHEMA: SERVER_COMPAT.schema.current,
};
beforeEach(() => {
  vi.resetAllMocks();
  fake.open.mockReturnValue({ executeQuery: fake.query, destroy: fake.close });
  fake.query.mockResolvedValue({ rows: [{ name, objects: '0' }] });
  fake.generation.mockResolvedValue(SERVER_COMPAT.schema.current);
});
it('migrates only an empty disposable database to the image’s exact schema and closes it', async () => {
  await migrateProbeDatabase(environment);
  expect(fake.migrate).toHaveBeenCalledOnce();
  expect(fake.generation).toHaveBeenCalledOnce();
  expect(fake.close).toHaveBeenCalledOnce();
});
it.each([
  { VERITY_BACKUP_PROBE_SCHEMA: 'future-schema' },
  { VERITY_BACKUP_PROBE_DATABASE_URL: 'postgres://postgres/verity' },
  {
    VERITY_BACKUP_PROBE_DATABASE_URL:
      environment.VERITY_BACKUP_PROBE_DATABASE_URL + '?database=verity',
  },
  {
    VERITY_BACKUP_PROBE_DATABASE_URL:
      environment.VERITY_BACKUP_PROBE_DATABASE_URL + '?options=-csearch_path=other',
  },
])('rejects unsafe inputs before opening a connection: %j', async (override) => {
  await expect(migrateProbeDatabase({ ...environment, ...override })).rejects.toThrow();
  expect(fake.open).not.toHaveBeenCalled();
});
it.each([
  { name, objects: '1' },
  { name: 'verity', objects: '0' },
])('does not migrate a populated or redirected target: %j', async (target) => {
  fake.query.mockResolvedValue({ rows: [target] });
  await expect(migrateProbeDatabase(environment)).rejects.toThrow('must be empty');
  expect(fake.migrate).not.toHaveBeenCalled();
  expect(fake.close).toHaveBeenCalledOnce();
});
it('closes a database after migration failure or a mismatched resulting schema', async () => {
  fake.migrate.mockRejectedValueOnce(new Error('migration failed'));
  await expect(migrateProbeDatabase(environment)).rejects.toThrow('migration failed');
  expect(fake.close).toHaveBeenCalledOnce();
  fake.generation.mockResolvedValue('other');
  await expect(migrateProbeDatabase(environment)).rejects.toThrow('unexpected schema');
  expect(fake.close).toHaveBeenCalledTimes(2);
});

it('supports an empty installer-owned restore database using the same pinned migration contract', async () => {
  const restoreName = `verity_restore_${'b'.repeat(32)}`;
  fake.query.mockResolvedValue({ rows: [{ name: restoreName, objects: '0' }] });
  await migrateProbeDatabase({
    ...environment,
    VERITY_BACKUP_PROBE_DATABASE_URL: `postgres://restore:example@postgres/${restoreName}`,
  });
  expect(fake.migrate).toHaveBeenCalledOnce();
  expect(fake.close).toHaveBeenCalledOnce();
});
