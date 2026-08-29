import type { MessageSearchResult, SessionSummary } from '@verity/mobile';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../components/Icon';
import { createVerityClient } from '../lib/client';

type SearchScope = 'chat' | 'project' | 'all';

export default function MessageSearchScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId?: string }>();
  const client = useMemo(() => createVerityClient(), []);
  const [query, setQuery] = useState('');
  const [submittedSingleCharacter, setSubmittedSingleCharacter] = useState(false);
  const [scope, setScope] = useState<SearchScope>(sessionId ? 'chat' : 'all');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [items, setItems] = useState<MessageSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { theme } = useUnistyles();
  const currentSession = sessions.find((session) => session.sessionId === sessionId);
  const projectId = currentSession?.projectId ?? null;

  useEffect(() => {
    if (!client) return;
    void client
      .listSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [client]);

  const maySearch =
    query.trim().length >= 2 || (submittedSingleCharacter && query.trim().length > 0);
  useEffect(() => {
    const generation = ++requestGeneration.current;
    setNextCursor(null);
    setLoadingMore(false);
    if (!client || !maySearch) {
      setItems([]);
      setNextCursor(null);
      setLoading(false);
      setError(null);
      return;
    }
    setItems([]);
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      void client
        .searchMessages({
          query: query.trim(),
          ...(scope === 'chat' && sessionId ? { sessionId } : {}),
          ...(scope === 'project' && projectId ? { projectId } : {}),
        })
        .then((page) => {
          if (requestGeneration.current !== generation) return;
          setItems(page.items);
          setNextCursor(page.nextCursor);
        })
        .catch((reason: unknown) => {
          if (requestGeneration.current === generation) {
            setError(reason instanceof Error ? reason.message : 'Search failed.');
          }
        })
        .finally(() => {
          if (requestGeneration.current === generation) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [client, maySearch, projectId, query, scope, sessionId]);

  const loadMore = useCallback(() => {
    if (!client || !nextCursor || loading || loadingMore || !maySearch) return;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    void client
      .searchMessages({
        query: query.trim(),
        cursor: nextCursor,
        ...(scope === 'chat' && sessionId ? { sessionId } : {}),
        ...(scope === 'project' && projectId ? { projectId } : {}),
      })
      .then((page) => {
        if (requestGeneration.current !== generation) return;
        setItems((current) => {
          const known = new Set(current.map((item) => item.id));
          return [...current, ...page.items.filter((item) => !known.has(item.id))];
        });
        setNextCursor(page.nextCursor);
      })
      .catch((reason: unknown) => {
        if (requestGeneration.current === generation) {
          setError(reason instanceof Error ? reason.message : 'Could not load more results.');
        }
      })
      .finally(() => {
        if (requestGeneration.current === generation) setLoadingMore(false);
      });
  }, [client, loading, loadingMore, maySearch, nextCursor, projectId, query, scope, sessionId]);

  const openResult = (item: MessageSearchResult) => {
    const targetMessageId = `${item.kind === 'prompt' ? 'user' : item.kind}-${String(item.firstEventSeq)}`;
    const targetSearchQuery = query.trim();
    if (width >= 900) {
      router.dismissTo({
        pathname: '/',
        params: { selected: item.sessionId, targetMessageId, targetSearchQuery },
      });
    } else {
      router.dismissTo({
        pathname: '/session/[id]',
        params: { id: item.sessionId, targetMessageId, targetSearchQuery },
      });
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Icon name="search" size={20} color={theme.colors.textMuted} />
        <TextInput
          autoFocus
          value={query}
          onChangeText={(value) => {
            setQuery(value);
            setSubmittedSingleCharacter(false);
          }}
          onSubmitEditing={() => setSubmittedSingleCharacter(true)}
          placeholder="Search messages"
          placeholderTextColor={theme.colors.textMuted}
          returnKeyType="search"
          style={styles.input}
          accessibilityLabel="Search messages"
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery('')} accessibilityLabel="Clear search" hitSlop={8}>
            <Icon name="x-circle" size={19} color={theme.colors.textMuted} />
          </Pressable>
        ) : null}
        <Pressable onPress={() => router.back()} accessibilityRole="button">
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>

      <View style={styles.scopes} accessibilityRole="tablist">
        <ScopeButton
          label="This Chat"
          active={scope === 'chat'}
          disabled={!sessionId}
          onPress={() => setScope('chat')}
        />
        <ScopeButton
          label="This Project"
          active={scope === 'project'}
          disabled={!projectId}
          onPress={() => setScope('project')}
        />
        <ScopeButton label="All Chats" active={scope === 'all'} onPress={() => setScope('all')} />
      </View>

      {loading ? <ActivityIndicator style={styles.state} color={theme.colors.accent} /> : null}
      {!loading && error ? <Text style={styles.stateText}>{error}</Text> : null}
      {!loading && !error && !maySearch ? (
        <Text style={styles.stateText}>Enter a search term to find messages.</Text>
      ) : null}
      {!loading && !error && maySearch && items.length === 0 ? (
        <Text style={styles.stateText}>No messages found.</Text>
      ) : null}
      <FlatList
        data={items}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.results}
        onEndReached={loadMore}
        onEndReachedThreshold={0.35}
        ListFooterComponent={loadingMore ? <ActivityIndicator color={theme.colors.accent} /> : null}
        renderItem={({ item }) => (
          <Pressable style={styles.result} onPress={() => openResult(item)}>
            <View style={styles.resultMeta}>
              <Text style={styles.resultTitle} numberOfLines={1}>
                {item.sessionName ?? 'Untitled session'}
              </Text>
              <Text style={styles.resultTime}>{new Date(item.createdAt).toLocaleDateString()}</Text>
            </View>
            <Text style={styles.resultContext} numberOfLines={1}>
              {[item.projectName, item.role === 'user' ? 'You' : 'Agent']
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <HighlightedSnippet text={item.text} query={query.trim()} />
          </Pressable>
        )}
      />
    </View>
  );
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return <Text style={styles.snippet}>{text}</Text>;
  const matcher = new RegExp(
    `(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  const normalizedTerms = new Set(terms.map((term) => term.toLocaleLowerCase()));
  return (
    <Text style={styles.snippet} numberOfLines={3}>
      {text.split(matcher).map((part, index) =>
        normalizedTerms.has(part.toLocaleLowerCase()) ? (
          <Text key={index} style={styles.match}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

function ScopeButton({
  label,
  active,
  disabled = false,
  onPress,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="tab"
      accessibilityState={{ selected: active, disabled }}
      style={[styles.scope, active ? styles.scopeActive : null, disabled ? styles.disabled : null]}
    >
      <Text style={[styles.scopeText, active ? styles.scopeTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  input: { flex: 1, color: theme.colors.text, fontSize: 17, paddingVertical: theme.spacing.sm },
  cancel: { color: theme.colors.accent, fontSize: 16 },
  scopes: { flexDirection: 'row', gap: 6, padding: theme.spacing.md },
  scope: { flex: 1, paddingVertical: 8, borderRadius: 9, backgroundColor: theme.colors.surface },
  scopeActive: { backgroundColor: theme.colors.accent },
  scopeText: { color: theme.colors.textMuted, textAlign: 'center', fontSize: 13 },
  scopeTextActive: { color: theme.colors.background, fontWeight: '700' },
  disabled: { opacity: 0.35 },
  state: { marginTop: 40 },
  stateText: { color: theme.colors.textMuted, textAlign: 'center', margin: 40 },
  results: { paddingHorizontal: theme.spacing.md, paddingBottom: 40 },
  result: {
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  resultMeta: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  resultTitle: { flex: 1, color: theme.colors.text, fontWeight: '700', fontSize: 15 },
  resultTime: { color: theme.colors.textMuted, fontSize: 12 },
  resultContext: { color: theme.colors.accent, fontSize: 12, marginTop: 3 },
  snippet: { color: theme.colors.text, fontSize: 14, lineHeight: 20, marginTop: 7 },
  match: { color: theme.colors.background, backgroundColor: theme.colors.accent },
}));
