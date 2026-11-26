import type { DiagnosticReport, MonitoringState } from '@verity/mobile';

/** `1.2 GB`, `312 MB`, `14 KB`: decimal units, as iOS shows data usage. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** `3 d 4 h`, `2 h 5 min`, `42 min`, `under a minute`. */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} d ${hours % 24} h`;
  if (hours > 0) return `${hours} h ${minutes % 60} min`;
  if (minutes > 0) return `${minutes} min`;
  return 'under a minute';
}

const CLIENT_NAMES: Record<string, string> = {
  ios: 'iPhone',
  android: 'Android',
  watch: 'Watch',
  web: 'browser',
  cli: 'command line',
  agent: 'agents',
  internal: 'the server itself',
  other: 'other clients',
};

/** `ios/1.95.4` → `iPhone`; the release stays in the technical content. */
export function clientName(label: string): string {
  const kind = label.split('/', 1)[0] ?? label;
  return CLIENT_NAMES[kind] ?? kind;
}

/** The row value of detail mode in the monitoring section. */
export function detailModeLabel(state: MonitoringState | null): string {
  if (state === null) return '';
  if (!state.measurementEnabled) return 'Needs measurement';
  if (!state.detailMode.active) return 'Off';
  return `On · ${formatDuration(state.detailMode.remainingSeconds)} left`;
}

/** Who started detail mode, as the sheet names it. */
export function detailStarterName(startedBy: string | null): string {
  if (startedBy === 'control') return 'Verity Control';
  if (startedBy === 'app') return 'This app';
  return startedBy ?? 'Unknown';
}

const TARGET_NAMES: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  doppler: 'Doppler',
  apple: 'Apple',
  expo: 'Expo',
  registry: 'Registries',
  verity: 'Verity',
  internal: 'Local services',
  other: 'Other services',
};

/** `GitHub 18,420 · 3 % duplicates · last seen 4,812 of 5,000 left` for the busiest target.
 *  Quotas are per token, so the remaining count is what the last answer said. */
function externalSummary(external: NonNullable<DiagnosticReport['externalCalls']>): string {
  const top = external.byTarget[0];
  if (top === undefined) return 'No outbound calls';
  const parts = [`${TARGET_NAMES[top.target] ?? top.target} ${top.calls.toLocaleString('en-US')}`];
  if (external.byTarget.length > 1)
    parts[0] = `${external.calls.toLocaleString('en-US')} calls · top: ${parts[0]}`;
  const duplicates = external.byTarget.reduce((total, entry) => total + entry.duplicates, 0);
  if (external.calls > 0)
    parts.push(`${Math.round((duplicates / external.calls) * 100)} % duplicates`);
  const limit = top.rateLimit;
  if (limit != null)
    parts.push(
      limit.limit === null
        ? `last seen ${limit.remaining.toLocaleString('en-US')} left`
        : `last seen ${limit.remaining.toLocaleString('en-US')} of ${limit.limit.toLocaleString('en-US')} left`,
    );
  return parts.join(' · ');
}

export interface ReportArea {
  title: string;
  summary: string;
}

/**
 * One line per measured area, from the report alone. Areas the server does not
 * measure yet are listed as such rather than left out, so an empty line is
 * never mistaken for "no problem".
 */
export function summarizeReport(report: DiagnosticReport): ReportArea[] {
  const { availability, traffic, resources } = report;
  const errorRate = `${(availability.serverErrorRate * 100).toFixed(1)} % errors`;
  const p95 =
    availability.latencyMs.p95 === null ? 'no requests' : `p95 ${availability.latencyMs.p95} ms`;
  const sent = traffic.httpBytesOut + traffic.liveBytesOut;
  const top = traffic.topRoutes[0];
  const areas: ReportArea[] = [
    {
      title: 'Availability',
      summary: `${availability.requests.toLocaleString('en-US')} requests · ${errorRate} · ${p95}`,
    },
    {
      title: 'Traffic',
      summary:
        top === undefined
          ? `${formatBytes(sent)} sent`
          : `${formatBytes(sent)} sent · top: ${top.method} ${top.route} on ${clientName(
              top.client,
            )}, ${formatBytes(top.bytesOut)}`,
    },
    {
      title: 'Resources',
      summary: `Server ${formatBytes(resources.rssBytes)} RAM · heap ${formatBytes(
        resources.heapUsedBytes,
      )} of ${formatBytes(resources.heapLimitBytes)}`,
    },
  ];
  if (report.externalCalls !== undefined)
    areas.push({ title: 'External calls', summary: externalSummary(report.externalCalls) });
  const later: Record<string, string> = {
    external_calls: 'External calls',
    database: 'Database',
    sandbox_lifecycle: 'Sessions & sandboxes',
    error_groups: 'Errors',
    cost: 'Cost',
  };
  for (const area of report.notYetMeasured) {
    const title = later[area];
    if (title !== undefined) areas.push({ title, summary: 'Not measured by this server version' });
  }
  return areas;
}
