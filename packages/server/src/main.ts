// Dispatch before loading a runtime: companion processes must not import the
// HTTP server, session backends, and project lifecycle just to select their mode.
async function main(): Promise<void> {
  if (process.argv[2] === 'backup-restore-installer') {
    try {
      const { runInstallerRestore } = await import('./backup/restore-installer-main.js');
      await runInstallerRestore();
    } catch {
      // SQL, request validation and subprocess errors may contain recovery credentials.
      process.stderr.write(
        'verity: installer recovery failed; the checkpoint is retained for retry or abort\n',
      );
      process.exitCode = 1;
    }
  } else if (process.argv[2] === 'backup-restore-trial') {
    const { startRestoreTrial } = await import('./backup/restore-trial-main.js');
    await startRestoreTrial(process.env);
  } else if (process.argv[2] === 'backup-probe-migrate') {
    const { migrateProbeDatabase } = await import('./backup/probe-migrate.js');
    await migrateProbeDatabase(process.env);
    process.stdout.write('{"ok":true}\n');
  } else if (process.argv[2] === 'managed-gateway') {
    const { startManagedGatewayMain } = await import('./managed-gateway-main.js');
    await startManagedGatewayMain();
  } else if (process.argv[2] === 'managed-updater') {
    const { startManagedUpdaterMain } = await import('./managed-updater-main.js');
    await startManagedUpdaterMain();
  } else {
    const { assertRestoreAccepted } = await import('./backup/restore-startup.js');
    await assertRestoreAccepted(process.env['VERITY_ROOT'] ?? '/srv/verity');
    await import('./server-main.js');
  }
}

main().catch((error: unknown) => {
  console.error('verity: failed to start', error);
  process.exit(1);
});
