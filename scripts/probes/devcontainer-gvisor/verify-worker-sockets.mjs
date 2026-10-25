// Read from stdin by nsenter: the service intentionally hides the checkout's home.
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import process from 'node:process';
for (const path of process.argv.slice(2)) {
  await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Host control socket is reachable: ${path}`));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Socket isolation check timed out: ${path}`));
    });
    socket.once('error', (error) => {
      try {
        assert(
          ['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(error.code),
          `Unexpected socket error: ${error.code}`,
        );
        resolve();
      } catch (cause) {
        reject(cause);
      }
    });
  });
}
