import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFile(new URL(file, import.meta.url), 'utf8');

describe('preview recovery lifecycle wiring', () => {
  // Reversing these calls deletes surviving connectors before their durable
  // owner can adopt them, even when both managers pass their isolated tests.
  it('restores local ownership before orphan cleanup, after the key handover', async () => {
    const embedded = await source('./embedded.ts');
    const recovery = embedded.slice(embedded.indexOf('if (localPreviewManager && projectDocker)'));
    expect(recovery).toMatch(
      /const reconcileLocal = async[^]*?if \(secretCipher\.isSealed\(\)\) return;[^]*?await localPreviewManager\.reconcile\(\);\s*previewRecoveryReady = true;\s*await sweepLocalConnectors\(\);/,
    );
    expect(embedded.indexOf('await adoptHandedOffSecretKey(')).toBeGreaterThan(-1);
    expect(embedded.indexOf('await adoptHandedOffSecretKey(')).toBeLessThan(
      embedded.indexOf('await reconcileLocal()'),
    );
    expect(embedded).toMatch(
      /canSupervise: \(\) => previewRecoveryReady && !secretCipher\.isSealed\(\)/,
    );
    expect(embedded.indexOf('await localPreviewManager.reconcile()')).toBeLessThan(
      embedded.indexOf('previewRecoveryReady = true;'),
    );
    expect(embedded).toMatch(/if \(!localPreviewManager\) previewRecoveryReady = true;/);
  });

  // An unsealed standby must not start connectors before it earns the active
  // generation; rollback needs the same claim as the initial incarnation.
  it('claims the active generation before building every serving incarnation', async () => {
    const main = await source('./server-main.ts');
    const start = main.slice(main.indexOf('const startServingStack = async'));
    expect(start.indexOf('await claimControlPlane(databaseUrl)')).toBeGreaterThan(-1);
    expect(start.indexOf('await claimControlPlane(databaseUrl)')).toBeLessThan(
      start.indexOf('await buildAndListen('),
    );
    expect(main).toMatch(/createStandbyLifecycle\([^]*?start: startServingStack/);
  });

  // Closing edges or stopping Uplink while a watchdog still restores resources
  // can resurrect a connector after the serving generation has closed.
  it('gates online recovery on unlock and drains both watchdogs before teardown', async () => {
    const embedded = await source('./embedded.ts');
    expect(embedded).toMatch(
      /const reconcile = async[^]*?if \(secretCipher\.isSealed\(\)\) return;\s*await previewShareManager\.reconcile\(\);/,
    );
    expect(embedded).toMatch(
      /previewRecoveryReady = false;\s*await stopLocalReconciler\(\);\s*await managedDevServerManager\?\.close\(\);\s*await localPreviewManager\.close\(\);/,
    );
    expect(embedded).toMatch(/await stopPreviewReconciler\(\);\s*await uplinkControl\?\.stop\(\);/);
  });
});
