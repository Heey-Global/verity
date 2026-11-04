import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import ipaddr from 'ipaddr.js';
import { egressRelayPolicy } from './project-egress-relay-policy.js';
import { egressHostAuthority } from './project-egress-host-authority.js';

const networkName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
const databaseName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u);
const managedEgressDatabaseLocator = z.strictObject({
  version: z.literal(1),
  network: networkName,
  service: z.literal('postgres'),
  database: databaseName,
});
const inspectedDatabase = z
  .array(
    z.object({
      Id: z.string().regex(/^[a-f0-9]{64}$/u),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      State: z.object({ Running: z.literal(true) }),
      NetworkSettings: z.object({
        Networks: z.record(
          z.string(),
          z.object({
            IPAddress: z.string(),
            GlobalIPv6Address: z.string().optional(),
          }),
        ),
      }),
    }),
  )
  .length(1);

/** Resolve an inspected deployment member, never a caller-supplied host address. */
export function managedEgressDatabaseAddress(reply: unknown, network: string): string {
  networkName.parse(network);
  const database = inspectedDatabase.parse(reply)[0]!;
  if (database.Config.Labels['com.docker.compose.service'] !== 'postgres')
    throw new Error('Managed egress requires the deployment database');
  const endpoint = database.NetworkSettings.Networks[network];
  const address = endpoint?.IPAddress || endpoint?.GlobalIPv6Address;
  if (
    !address ||
    !isIP(address) ||
    !['private', 'uniqueLocal'].includes(ipaddr.parse(address).range())
  )
    throw new Error('Managed database has no usable host endpoint');
  return address;
}

/** The host role can only read/update destination policy, not users or secrets. */
export function managedEgressRoleSql(password: string, database: string): string {
  z.string()
    .regex(/^[a-f0-9]{64}$/u)
    .parse(password);
  databaseName.parse(database);
  return `BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '5s';
DO $role$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'verity_egress_host') THEN
    CREATE ROLE verity_egress_host LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname = 'verity_egress_host'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'verity_egress_host'))
    OR EXISTS (SELECT FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'verity_egress_host'))
    OR EXISTS (SELECT FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'verity_egress_host'))
    OR EXISTS (SELECT FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = 'verity_egress_host'))
    OR EXISTS (SELECT FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = 'verity_egress_host'))
    OR EXISTS (SELECT FROM information_schema.role_table_grants
      WHERE grantee = 'verity_egress_host' AND
        (table_schema <> 'public' OR table_name <> 'project_egress_policy'
         OR privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE') OR is_grantable <> 'NO')) THEN
    RAISE EXCEPTION 'Unexpected privileges on managed egress role';
  END IF;
END $role$;
ALTER ROLE verity_egress_host WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
GRANT CONNECT ON DATABASE "${database}" TO verity_egress_host;
GRANT USAGE ON SCHEMA public TO verity_egress_host;
GRANT SELECT, INSERT, UPDATE ON TABLE public.project_egress_policy TO verity_egress_host;
COMMIT;
`;
}

export function managedEgressConfiguration(input: {
  env: NodeJS.ProcessEnv;
  databaseInspection: unknown;
  dnsServers: string[];
  previousAuthority?: unknown;
}) {
  const { env } = input;
  const source = new URL(env.DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(source.protocol) || source.search)
    throw new Error('Unsupported managed database configuration');
  const database = databaseName.parse(source.pathname.slice(1));
  const network = networkName.parse(env.VERITY_EGRESS_DEPLOYMENT_NETWORK);
  const address = managedEgressDatabaseAddress(input.databaseInspection, network);
  const previous =
    input.previousAuthority === undefined
      ? undefined
      : egressHostAuthority.parse(input.previousAuthority);
  const previousUrl = previous === undefined ? undefined : new URL(previous.databaseUrl);
  if (
    previousUrl &&
    (previousUrl.username !== 'verity_egress_host' ||
      previousUrl.pathname !== source.pathname ||
      !/^[a-f0-9]{64}$/u.test(previousUrl.password))
  )
    throw new Error('Managed egress authority does not match this database');
  const password = previousUrl?.password ?? randomBytes(32).toString('hex');
  const url = new URL('postgres://verity_egress_host@localhost/');
  url.hostname = isIP(address) === 6 ? `[${address}]` : address;
  url.port = source.port || '5432';
  url.password = password;
  url.pathname = `/${database}`;
  const authority = egressHostAuthority.parse({
    databaseUrl: url.href,
    dnsServers: input.dnsServers,
    // Tenant broker/model/MCP hosts require authoritative live synchronization.
    // A deployment helper cannot infer encrypted connector configuration.
    managedInventoryComplete: false,
    mandatoryHosts: env.VERITY_EGRESS_MANDATORY_HOSTS
      ? (JSON.parse(env.VERITY_EGRESS_MANDATORY_HOSTS) as unknown)
      : [],
  });
  const relay = egressRelayPolicy.parse({
    image: env.VERITY_PROJECT_RELAY_IMAGE || env.VERITY_BUNDLED_PROJECT_RELAY_IMAGE,
    dataVolume: env.VERITY_DATA_VOLUME,
    socketOwnerUid: Number(env.VERITY_SERVER_UID ?? '1000'),
    relayGid: Number(env.VERITY_PROJECT_RELAY_GID ?? '65532'),
    brokerSubpath: 'relay/broker',
    claudeSubpath: 'relay/claude',
    codexSubpath: 'relay/codex',
    packetEnforcement: true,
  });
  return {
    relay,
    authority,
    locator: managedEgressDatabaseLocator.parse({
      version: 1,
      network,
      service: 'postgres',
      database,
    }),
    roleSql: managedEgressRoleSql(password, database),
  };
}
