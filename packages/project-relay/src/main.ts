import { startRelay } from './relay.js';

const relay = await startRelay();

async function shutdown(): Promise<void> {
  await relay.close();
  process.exitCode = 0;
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
