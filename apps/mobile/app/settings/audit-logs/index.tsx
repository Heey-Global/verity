import type { AuditDomain, AuditEvent, VerityClient } from '@verity/mobile';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SettingsGroup,
  SettingsMessage,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import {
  Button,
  FilterChips,
  HintBox,
  IconButton,
  LogList,
  SearchField,
  Sheet,
  Text,
} from '../../../components/ui';
import {
  SourceStatus,
  SystemEventRow,
  type LogEntry,
  type Source,
} from '../../../components/logs/LogEntries';
import { auditDate } from '../../../lib/auditLabels';
import { AuditEventRow } from '../../../components/logs/EventRow';
import { createVerityClient } from '../../../lib/client';

type Filter = 'all' | AuditDomain | 'system';
type Logs = Awaited<ReturnType<VerityClient['systemLogs']>>;
type Item = { key: string; at: string | null } & (
  { event: AuditEvent } | { entry: LogEntry; source: Source }
);
const SOURCE_LABELS = { server: 'Server logs', host: 'Host signals' } as const;
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'builds', label: 'Builds' },
  { value: 'images', label: 'Images' },
  { value: 'resources', label: 'Projects' },
  { value: 'system', label: 'System' },
];
function dayLabel(at: string | null) {
  if (!at || !Number.isFinite(Date.parse(at))) return 'Time not recorded';
  const date = new Date(at),
    now = new Date(),
    yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return date.toDateString() === now.toDateString()
    ? 'Today'
    : date.toDateString() === yesterday.toDateString()
      ? 'Yesterday'
      : auditDate(at);
}
export default function AuditLogsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <AuditLogsView client={client} />
  ) : (
    <SettingsMessage title="Not connected" subtitle="Connect to your server to read logs." />
  );
}
export function AuditLogsView({ client }: { client: VerityClient }) {
  const params = useLocalSearchParams<{ category?: string }>();
  const [filter, setFilter] = useState<Filter>(params.category === 'system' ? 'system' : 'all');
  const [hours, setHours] = useState<'1' | '24'>('24');
  const [source, setSource] = useState<'all' | Source>('all');
  const [level, setLevel] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const [search, setSearch] = useState(''),
    [query, setQuery] = useState('');
  const [events, setEvents] = useState<AuditEvent[]>();
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [oldest, setOldest] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [auditUnavailable, setAuditUnavailable] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sources, setSources] = useState<Partial<Record<Source, Logs>>>({});
  const [sourceErrors, setSourceErrors] = useState<Partial<Record<Source, boolean>>>({});
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const latest = useRef(0);
  const pagePending = useRef(false);
  const systemVisible = filter === 'all' || filter === 'system';
  const window = useMemo(() => {
    const until = new Date();
    return {
      since: new Date(until.getTime() - Number(hours) * 3600_000).toISOString(),
      until: until.toISOString(),
    };
  }, [hours, refresh]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const auditQuery = useMemo(
    () => ({
      ...window,
      ...(filter !== 'all' && filter !== 'system' ? { domain: filter } : {}),
      ...(query.trim() ? { search: query.trim() } : {}),
    }),
    [window, filter, query],
  );
  useEffect(() => {
    const request = ++latest.current;
    setError(undefined);
    setEvents(undefined);
    setNextBefore(null);
    setOldest(null);
    setAuditUnavailable(false);
    setLoadingMore(false);
    pagePending.current = false;
    if (filter !== 'system')
      void Promise.resolve()
        .then(() => client.auditEvents(auditQuery))
        .then((list) => {
          if (latest.current !== request) return;
          if (list === null) {
            setAuditUnavailable(true);
            setEvents([]);
            return;
          }
          setEvents(list.events);
          setNextBefore(list.nextBefore);
          setOldest(list.oldestRecordedAt);
        })
        .catch(() => {
          if (latest.current === request) {
            setError('Could not load events. Retry to read them again.');
            setEvents([]);
          }
        });
    return () => {
      latest.current += 1;
    };
  }, [client, auditQuery, filter]);
  useEffect(() => {
    if (!systemVisible) return;
    let active = true;
    setSources({});
    setSourceErrors({});
    for (const selected of ['server', 'host'] as const) {
      void Promise.resolve()
        .then(() => client.systemLogs({ ...window, source: selected, level: 'all' }))
        .then((value) => {
          if (active) setSources((current) => ({ ...current, [selected]: value }));
        })
        .catch(() => {
          if (active) setSourceErrors((current) => ({ ...current, [selected]: true }));
        });
    }
    return () => {
      active = false;
    };
  }, [client, window, systemVisible]);
  const retry = useCallback(() => setRefresh((value) => value + 1), []);
  const loadMore = () => {
    if (nextBefore === null || pagePending.current) return;
    pagePending.current = true;
    const request = latest.current;
    setLoadingMore(true);
    void client
      .auditEvents({ ...auditQuery, before: nextBefore })
      .then((list) => {
        if (latest.current !== request || !list) return;
        setEvents((current) => [...(current ?? []), ...list.events]);
        setNextBefore(list.nextBefore);
      })
      .catch(() => {
        if (latest.current === request) setError('Could not load older entries.');
      })
      .finally(() => {
        if (latest.current === request) {
          pagePending.current = false;
          setLoadingMore(false);
        }
      });
  };
  const items: Item[] =
    filter === 'system'
      ? []
      : (events ?? []).map((event) => ({
          key: event.eventId,
          at: event.recordedAt,
          event,
        }));
  if (systemVisible)
    for (const selected of ['server', 'host'] as const) {
      if (filter === 'system' && source !== 'all' && source !== selected) continue;
      for (const [index, entry] of (sources[selected]?.entries ?? []).entries()) {
        if (query.trim() && !entry.text.toLowerCase().includes(query.trim().toLowerCase()))
          continue;
        if (filter === 'system' && source === 'server' && level !== 'all' && entry.level !== level)
          continue;
        items.push({ key: `${selected}-${index}`, at: entry.at, entry, source: selected });
      }
    }
  items.sort(
    (a, b) =>
      (b.at && Number.isFinite(Date.parse(b.at)) ? Date.parse(b.at) : -Infinity) -
        (a.at && Number.isFinite(Date.parse(a.at)) ? Date.parse(a.at) : -Infinity) ||
      b.key.localeCompare(a.key),
  );
  const groups: { title: string; items: Item[] }[] = [];
  for (const item of items) {
    const title = dayLabel(item.at);
    if (groups.at(-1)?.title !== title) groups.push({ title, items: [] });
    groups.at(-1)!.items.push(item);
  }
  // Only deviations are shown above the list (§ 5.2a); a source that is still
  // loading is not a problem yet.
  const unavailable = (['server', 'host'] as const).filter(
    (key) =>
      sourceErrors[key] || (sources[key] !== undefined && sources[key].state !== 'available'),
  );
  const loading =
    (filter !== 'system' && events === undefined) ||
    (systemVisible &&
      (['server', 'host'] as const).some((key) => !sources[key] && !sourceErrors[key]));
  return (
    <SettingsScaffold
      title="Logs"
      detail
      state={{ error, saving: false }}
      onRetry={retry}
      headerAction={
        systemVisible ? (
          <IconButton
            icon="info"
            accessibilityLabel="Source details"
            onPress={() => setCoverageOpen(true)}
          />
        ) : undefined
      }
    >
      <SearchField value={search} onChangeText={setSearch} placeholder="Search logs" />
      <FilterChips
        wrap
        compact
        options={FILTERS}
        value={filter}
        onChange={setFilter}
        accessibilityLabel="Show entries of"
      />
      <FilterChips
        wrap
        compact
        value={hours}
        onChange={setHours}
        accessibilityLabel="Time window"
        options={[
          { value: '1', label: 'Last hour' },
          { value: '24', label: 'Last 24 hours' },
        ]}
      />
      {filter === 'system' ? (
        <>
          <FilterChips
            wrap
            compact
            value={source}
            onChange={setSource}
            accessibilityLabel="System source"
            options={[
              { value: 'all', label: 'Both sources' },
              { value: 'server', label: 'Server' },
              { value: 'host', label: 'Host' },
            ]}
          />
          {source === 'server' ? (
            <FilterChips
              wrap
              compact
              value={level}
              onChange={setLevel}
              accessibilityLabel="Severity"
              options={[
                { value: 'all', label: 'All levels' },
                { value: 'error', label: 'Errors' },
                { value: 'warning', label: 'Warnings' },
                { value: 'info', label: 'Info' },
              ]}
            />
          ) : null}
        </>
      ) : null}
      {systemVisible ? (
        <>
          {unavailable.length ? (
            <HintBox
              title={`${unavailable.map((key) => SOURCE_LABELS[key]).join(' and ')} unavailable`}
              message="Other sources are still shown."
            >
              <Button
                variant="text"
                size="compact"
                label="Details"
                onPress={() => setCoverageOpen(true)}
              />
            </HintBox>
          ) : null}
          <Sheet
            visible={coverageOpen}
            title="Source availability"
            onClose={() => setCoverageOpen(false)}
          >
            <Text variant="footnote">
              System search covers loaded entries only. Host entries are classified signals, not
              complete journal logs.
            </Text>
            {(['server', 'host'] as const).map((key) => (
              <SourceStatus
                key={key}
                source={key}
                logs={sources[key]}
                failed={sourceErrors[key] ?? false}
                onRetry={retry}
              />
            ))}
          </Sheet>
          {query.trim() ? (
            <Text variant="footnote">System search covers loaded entries only.</Text>
          ) : null}
        </>
      ) : null}
      {auditUnavailable ? (
        <Text tone="muted">Audit logs unavailable. Only administrators can read these events.</Text>
      ) : null}
      {loading ? <Text tone="muted">Loading logs…</Text> : null}
      {!loading && !items.length ? (
        <Text tone="muted">
          {query.trim() || filter !== 'all' ? 'No matching entries.' : 'No entries yet.'}
        </Text>
      ) : null}
      {groups.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          <LogList>
            {group.items.map((item) => {
              if ('entry' in item)
                return <SystemEventRow key={item.key} entry={item.entry} source={item.source} />;
              return <AuditEventRow key={item.key} event={item.event} />;
            })}
          </LogList>
        </SettingsGroup>
      ))}
      {filter !== 'system' && nextBefore !== null ? (
        <Button
          variant="secondary"
          label={loadingMore ? 'Loading…' : 'Show older entries'}
          onPress={loadMore}
          disabled={loadingMore}
        />
      ) : null}
      {filter !== 'system' && oldest && !nextBefore && events !== undefined ? (
        <Text variant="footnote">
          Entries since {auditDate(oldest)} · selected time window applies
        </Text>
      ) : null}
      <Button variant="secondary" label="Refresh logs" onPress={retry} />
    </SettingsScaffold>
  );
}
