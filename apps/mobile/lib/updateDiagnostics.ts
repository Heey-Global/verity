import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { Share } from 'react-native';
import { runningReleaseVersion } from './buildInfo';

const MAX_REPORT_BYTES = 256 * 1024;
const MAX_CONTEXT_ENTRIES = 100;
type UpdateLog = Awaited<ReturnType<typeof Updates.readLogEntriesAsync>>[number];

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

function boundedIdentity(value: string | null): string | null {
  return value === null ? null : shorten(value, 256);
}

function priority(log: UpdateLog): number {
  return log.level === 'error' || log.level === 'fatal' ? 0 : log.level === 'warn' ? 1 : 2;
}

function compactLog(log: UpdateLog) {
  // Expo repeats entire manifests in every state transition, burying launch errors.
  const context = log.message.startsWith('Updates state change:')
    ? log.message.indexOf(', context = ')
    : -1;
  const message = context < 0 ? log.message : log.message.slice(0, context);
  const identities =
    context < 0
      ? []
      : [...log.message.matchAll(/"(?:id|runtimeVersion)": [^,\n)]+/g)]
          .slice(0, 4)
          .map((match) => match[0]);
  const contextErrors = Object.fromEntries(
    [
      ...log.message.matchAll(
        /(checkError|downloadError)[:=]\s*([\s\S]*?)(?=, (?:downloadError|downloadProgress|lastCheckForUpdateTime|downloadStartTime|downloadFinishTime)[:=]|$)/g,
      ),
    ]
      .filter((match) => match[2] !== 'nil')
      .map((match) => [match[1], shorten(match[2]!, 2_048)]),
  );
  const compacted = shorten(message, priority(log) === 0 ? 16_384 : 2_048);
  const stacktrace = log.stacktrace?.slice(0, 32).map((line) => shorten(line, 512));
  const truncated =
    compacted !== log.message ||
    (log.stacktrace !== undefined && JSON.stringify(stacktrace) !== JSON.stringify(log.stacktrace));
  return {
    timestamp: log.timestamp,
    level: log.level,
    code: shorten(log.code, 256),
    message: compacted,
    ...(identities.length
      ? { updateIdentity: identities.map((identity) => shorten(identity, 256)) }
      : {}),
    ...(Object.keys(contextErrors).length ? { contextErrors } : {}),
    ...(stacktrace ? { stacktrace } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

// Keep the week-long recovery window, but bound the shared report, including JSON
// escaping and UTF-8. The native API still reads the retained logs into memory.
export async function shareUpdateDiagnostics(): Promise<void> {
  const retained = Updates.isEnabled
    ? await Updates.readLogEntriesAsync(7 * 24 * 60 * 60 * 1000)
    : [];
  const logs: ReturnType<typeof compactLog>[] = [];
  const report = {
    schema: 2,
    exportedAt: new Date().toISOString(),
    version: shorten(runningReleaseVersion(Application.nativeApplicationVersion), 256),
    nativeVersion: boundedIdentity(Application.nativeApplicationVersion),
    nativeBuild: boundedIdentity(Application.nativeBuildVersion),
    updatesEnabled: Updates.isEnabled,
    ...(Updates.isEnabled
      ? {
          runtimeVersion: boundedIdentity(Updates.runtimeVersion),
          channel: boundedIdentity(Updates.channel),
          updateId: boundedIdentity(Updates.updateId),
          isEmbeddedLaunch: Updates.isEmbeddedLaunch,
          isEmergencyLaunch: Updates.isEmergencyLaunch,
          emergencyLaunchReason:
            Updates.emergencyLaunchReason === null
              ? null
              : shorten(Updates.emergencyLaunchReason, 8_192),
        }
      : {}),
    logSummary: {
      retained: retained.length,
      exported: 0,
      omitted: retained.length,
      truncated: 0,
      maxBytes: MAX_REPORT_BYTES,
    },
    logs,
  };
  const ordered = [...retained].sort(
    (a, b) => priority(a) - priority(b) || b.timestamp - a.timestamp,
  );
  // Reserve the largest possible counters before adding entries. Counting each
  // indented entry once avoids quadratic serialization for thousands of errors.
  const budgetHeader = {
    ...report,
    logSummary: {
      ...report.logSummary,
      exported: retained.length,
      truncated: retained.length,
    },
  };
  let usedBytes = utf8Bytes(JSON.stringify(budgetHeader, null, 2)) + 4;
  let contextEntries = 0;
  for (const log of ordered) {
    if (priority(log) === 2 && contextEntries++ >= MAX_CONTEXT_ENTRIES) continue;
    const compacted = compactLog(log);
    const entryBytes =
      utf8Bytes(
        JSON.stringify(compacted, null, 2)
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
      ) + 2;
    if (usedBytes + entryBytes > MAX_REPORT_BYTES) break;
    usedBytes += entryBytes;
    logs.push(compacted);
    report.logSummary.exported = logs.length;
    report.logSummary.omitted = retained.length - logs.length;
    report.logSummary.truncated += compacted.truncated ? 1 : 0;
  }
  await Share.share({
    title: 'Verity update diagnostics',
    message: JSON.stringify(report, null, 2),
  });
}
