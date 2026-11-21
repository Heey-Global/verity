import { appStoreUpdate, type AppUpdateFacts } from '@verity/mobile';

/** Keep every actionable product visible in the existing Settings row. A newer
 * store binary supersedes the compatible downloaded bundle, as in the app box. */
export function appUpdateSummary(facts: AppUpdateFacts, serverVersion: string | null) {
  const parts: string[] = [];
  if (serverVersion !== null) parts.push(`Server version ${serverVersion} available`);
  const store = appStoreUpdate(facts);
  if (store !== null) parts.push(`App version ${store.version} available`);
  else if (facts.updatesEnabled && facts.downloaded) parts.push('App update ready · Restart now');
  return {
    subtitle: parts.length ? parts.join(' · ') : 'Server and app',
    status: parts.length ? { intent: 'needsSetup' as const, label: 'Update' } : undefined,
  };
}
