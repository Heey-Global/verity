// Audit logs (ADR 0028): who started each project image build, what it produced,
// and which images and projects were removed. Administrators only — the Server
// answers 403 to anyone else, and the Settings row is hidden for them.
//
// Reads on open and on focus and does not poll (docs/design-system.md § 6.3).
import type { AuditDomain, AuditOperationSummary, VerityClient } from '@verity/mobile';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import { Button, FilterChips, Row, SearchField, StatusDot, Text } from '../../../components/ui';
import {
  auditDate,
  auditIcon,
  auditStatus,
  auditSubtitle,
  auditTitle,
  groupAuditByDay,
} from '../../../lib/auditLabels';
import { createVerityClient } from '../../../lib/client';

type Filter = 'all' | AuditDomain;

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'builds', label: 'Builds' },
  { value: 'images', label: 'Images' },
  { value: 'resources', label: 'Projects' },
];

const SEARCH_DELAY_MS = 300;

export default function AuditLogsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to read audit logs."
      />
    );
  }
  return <AuditLogsView client={client} />;
}

export function AuditLogsView({ client }: { client: VerityClient }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [operations, setOperations] = useState<AuditOperationSummary[] | undefined>(undefined);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [oldest, setOldest] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Only the newest request may write: a slow answer for an old filter must not
  // replace the list the administrator is looking at.
  const latest = useRef(0);
  // Older pages the administrator has loaded. While there are any, returning from an
  // entry keeps the list as it was instead of jumping back to the newest page.
  const olderPages = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(() => {
    const request = ++latest.current;
    setError(undefined);
    client
      .auditOperations({
        ...(filter === 'all' ? {} : { domain: filter }),
        ...(query.trim().length > 0 ? { search: query } : {}),
      })
      .then((list) => {
        if (request !== latest.current) return;
        if (list === null) {
          setUnavailable(true);
          return;
        }
        setOperations(list.operations);
        setNextBefore(list.nextBefore);
        setOldest(list.oldestRecordedAt);
      })
      .catch((cause: unknown) => {
        if (request !== latest.current) return;
        setError(cause instanceof Error ? cause.message : 'Could not load audit logs.');
      });
  }, [client, filter, query]);

  // A new filter starts from the newest page; its cursor must not page the old list.
  // Declared before the focus effect, so it has reset the state the effect reads.
  useEffect(() => {
    olderPages.current = 0;
    setNextBefore(null);
  }, [filter, query]);
  useFocusEffect(
    useCallback(() => {
      if (olderPages.current === 0) load();
    }, [load]),
  );

  const loadMore = () => {
    if (nextBefore === null || loadingMore) return;
    const request = latest.current;
    setLoadingMore(true);
    client
      .auditOperations({
        ...(filter === 'all' ? {} : { domain: filter }),
        ...(query.trim().length > 0 ? { search: query } : {}),
        before: nextBefore,
      })
      .then((list) => {
        if (request !== latest.current || list === null) return;
        olderPages.current += 1;
        setOperations((current) => [...(current ?? []), ...list.operations]);
        setNextBefore(list.nextBefore);
      })
      .catch((cause: unknown) => {
        if (request !== latest.current) return;
        setError(cause instanceof Error ? cause.message : 'Could not load more entries.');
      })
      .finally(() => setLoadingMore(false));
  };

  if (unavailable) {
    return (
      <SettingsMessage
        title="Audit logs unavailable"
        subtitle="Only administrators of this server can read audit logs."
      />
    );
  }

  const searching = query.trim().length > 0 || filter !== 'all';
  return (
    <SettingsScaffold title="Audit logs" detail state={{ error, saving: false }} onRetry={load}>
      <SearchField
        value={search}
        onChangeText={setSearch}
        placeholder="Search image, project or ID"
      />
      <FilterChips
        options={FILTERS}
        value={filter}
        onChange={setFilter}
        accessibilityLabel="Show entries of"
      />
      {operations === undefined ? (
        error === undefined ? (
          <Text tone="muted">Loading audit logs…</Text>
        ) : null
      ) : operations.length === 0 ? (
        <Text tone="muted">{searching ? 'No matching entries.' : 'No entries yet.'}</Text>
      ) : (
        groupAuditByDay(operations).map((day) => (
          <SettingsGroup key={day.title} title={day.title}>
            <SettingsListPanel>
              {day.operations.map((operation) => {
                const status = auditStatus(operation);
                return (
                  <Row
                    key={operation.operationId}
                    leading={auditIcon(operation)}
                    title={auditTitle(operation)}
                    subtitle={auditSubtitle(operation)}
                    trailing={
                      status !== undefined ? (
                        <StatusDot intent={status.intent} label={status.label} />
                      ) : undefined
                    }
                    navigates
                    onPress={() =>
                      router.push(
                        `/settings/audit-logs/${encodeURIComponent(operation.operationId)}` as Href,
                      )
                    }
                  />
                );
              })}
            </SettingsListPanel>
          </SettingsGroup>
        ))
      )}
      {nextBefore !== null ? (
        <Button
          variant="secondary"
          label={loadingMore ? 'Loading…' : 'Show older entries'}
          onPress={loadMore}
          disabled={loadingMore}
        />
      ) : null}
      {oldest !== null && nextBefore === null && operations !== undefined ? (
        <View style={styles.footer}>
          <Text variant="footnote" tone="faint">
            Entries since {auditDate(oldest)}
          </Text>
        </View>
      ) : null}
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: { alignItems: 'center', paddingVertical: theme.spacing.sm },
}));
