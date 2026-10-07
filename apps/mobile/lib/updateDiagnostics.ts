import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { Share } from 'react-native';
import { runningReleaseVersion } from './buildInfo';

// Read a week of retained logs: Expo defaults to one hour, which can hide the
// fatal launch error by the time someone exports diagnostics after a rollback.
export async function shareUpdateDiagnostics(): Promise<void> {
  const logs = Updates.isEnabled ? await Updates.readLogEntriesAsync(7 * 24 * 60 * 60 * 1000) : [];
  const report = {
    schema: 1,
    exportedAt: new Date().toISOString(),
    version: runningReleaseVersion(Application.nativeApplicationVersion),
    nativeVersion: Application.nativeApplicationVersion,
    nativeBuild: Application.nativeBuildVersion,
    updatesEnabled: Updates.isEnabled,
    ...(Updates.isEnabled
      ? {
          runtimeVersion: Updates.runtimeVersion,
          channel: Updates.channel,
          updateId: Updates.updateId,
          isEmbeddedLaunch: Updates.isEmbeddedLaunch,
          isEmergencyLaunch: Updates.isEmergencyLaunch,
          emergencyLaunchReason: Updates.emergencyLaunchReason,
        }
      : {}),
    logs,
  };
  await Share.share({
    title: 'Verity update diagnostics',
    message: JSON.stringify(report, null, 2),
  });
}
