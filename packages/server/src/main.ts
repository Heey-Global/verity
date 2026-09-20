// Dispatch before loading a runtime: companion processes must not import the
// HTTP server, session backends, and project lifecycle just to select their mode.
async function main(): Promise<void> {
  if (process.argv[2] === 'managed-gateway') {
    const { startManagedGatewayMain } = await import('./managed-gateway-main.js');
    await startManagedGatewayMain();
  } else if (process.argv[2] === 'managed-updater') {
    const { startManagedUpdaterMain } = await import('./managed-updater-main.js');
    await startManagedUpdaterMain();
  } else {
    await import('./server-main.js');
  }
}

main().catch((error: unknown) => {
  console.error('verity: failed to start', error);
  process.exit(1);
});
