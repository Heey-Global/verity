import { parsePort } from './deployment-port.js';
import { tlsFromEnvironment, managedClientIdentitySecret } from './deployment-tls.js';
import { startManagedGateway } from './self-update/managed-gateway.js';
import {
  MANAGED_GATEWAY_CONTROL_SOCKET,
  startManagedGatewayControlServer,
} from './self-update/managed-gateway-control.js';

const DEFAULT_INTERNAL_PORT = 8083;

export async function startManagedGatewayMain(): Promise<void> {
  const tls = await tlsFromEnvironment();
  const gateway = await startManagedGateway({
    ...(tls === undefined ? {} : { tls }),
    ...(tls === undefined ? {} : { clientIdentitySecret: managedClientIdentitySecret(tls.key) }),
    publicHost: process.env.HOST ?? '0.0.0.0',
    publicPort: parsePort(process.env.PORT),
    internalHost: process.env.VERITY_INTERNAL_HOST ?? '0.0.0.0',
    internalPort: parsePort(process.env.VERITY_INTERNAL_PORT, DEFAULT_INTERNAL_PORT),
    backend: {
      host: 'verity-managed-server',
      publicPort: parsePort(process.env.VERITY_MANAGED_SERVER_PORT, 8082),
      internalPort: parsePort(process.env.VERITY_MANAGED_SERVER_INTERNAL_PORT, 8083),
    },
    allowedBackendHosts: ['verity-managed-server'],
    allowManagedServerGenerations: true,
    backendStatePath:
      process.env.VERITY_MANAGED_GATEWAY_STATE_PATH ?? '/run/verity-gateway/backend.json',
  });
  // The Updater has no network, so the maintenance switch and the backend
  // selection are only reachable over the shared control volume. Started
  // unconditionally and allowed to fail loudly: in the managed profile the
  // volume is always mounted, and a Gateway that came up without its control
  // channel would only reveal that in the middle of an update.
  const control = await startManagedGatewayControlServer({
    socketPath: process.env.VERITY_MANAGED_GATEWAY_CONTROL_SOCKET ?? MANAGED_GATEWAY_CONTROL_SOCKET,
    gateway,
  }).catch(async (error: unknown) => {
    await gateway.close();
    throw error;
  });
  const stop = async (): Promise<void> => {
    await control.close();
    await gateway.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  return;
}
