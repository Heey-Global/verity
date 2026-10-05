import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ManagedDevServer } from '@verity/mobile';
import { Icon } from '../Icon';

// Servers the agent set up and Verity runs (concept 2.6). The sandbox port is
// internal and never shown here; the only address is the network one.

/** Whether the switch reads on: the server should run or is on its way. */
export function managedSwitchOn(server: ManagedDevServer): boolean {
  const instance = server.instance;
  return (
    instance !== null &&
    (instance.state === 'running' || instance.state === 'starting') &&
    instance.desired === 'running'
  );
}

/** The one line under the name: state and what to do next. */
export function managedStateLine(server: ManagedDevServer): string {
  const instance = server.instance;
  if (!instance || instance.state === 'stopped') return 'Stopped';
  if (instance.state === 'crashed') return 'Crashed · View logs';
  if (instance.state === 'starting') return instance.detail ?? 'Starting…';
  if (instance.url)
    return `Running · ${instance.url.replace(/^https?:\/\//u, '').replace(/\/$/u, '')}`;
  if (instance.awaitingApproval) return 'Running, not shared yet';
  return instance.detail ? `Running · ${instance.detail}` : 'Running';
}

type Tone = 'done' | 'active' | 'danger' | 'idle';
function toneOf(server: ManagedDevServer): Tone {
  const state = server.instance?.state;
  if (state === 'running') return 'done';
  if (state === 'starting') return 'active';
  if (state === 'crashed') return 'danger';
  return 'idle';
}

export function ManagedServerRows({
  servers,
  pendingId,
  onToggle,
  onOpenAddress,
  onSelect,
  onStopElsewhere,
}: {
  servers: ManagedDevServer[];
  /** An entry whose switch is waiting for the server. */
  pendingId: string | undefined;
  onToggle: (server: ManagedDevServer, on: boolean) => void;
  onOpenAddress: (server: ManagedDevServer) => void;
  onSelect: (server: ManagedDevServer) => void;
  onStopElsewhere: (instanceId: string) => void;
}) {
  const { theme } = useUnistyles();
  const toneColor: Record<Tone, string> = {
    done: theme.colors.tone.done,
    active: theme.colors.primary,
    danger: theme.colors.tone.danger,
    idle: theme.colors.textFaint,
  };
  return (
    <View style={styles.group}>
      {servers.map((server, index) => {
        const tone = toneOf(server);
        const line = managedStateLine(server);
        const url = server.instance?.state === 'running' ? server.instance.url : null;
        return (
          <View
            key={server.id}
            style={[styles.row, index > 0 ? styles.rowDivider : null]}
            accessibilityLabel={`${server.name}, ${line}`}
          >
            <Pressable
              style={styles.rowMain}
              onPress={() => onSelect(server)}
              accessibilityRole="button"
              accessibilityLabel={`Details for ${server.name}`}
            >
              {tone === 'danger' ? (
                <Text style={styles.crashMark}>!</Text>
              ) : (
                <View style={[styles.dot, { backgroundColor: toneColor[tone] }]} />
              )}
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {server.name}
                </Text>
                {url ? (
                  <Pressable
                    onPress={() => onOpenAddress(server)}
                    hitSlop={8}
                    accessibilityRole="link"
                    accessibilityLabel={`Open ${server.name} in the browser`}
                  >
                    <Text style={[styles.stateLine, { color: toneColor.done }]} numberOfLines={1}>
                      {line}
                    </Text>
                  </Pressable>
                ) : (
                  <Text
                    style={[
                      styles.stateLine,
                      { color: tone === 'idle' ? theme.colors.textMuted : toneColor[tone] },
                    ]}
                    numberOfLines={2}
                  >
                    {line}
                  </Text>
                )}
                {server.elsewhere.map((other) => (
                  <View key={other.instanceId} style={styles.elsewhere}>
                    <Text style={styles.elsewhereText} numberOfLines={1}>
                      {`Also running in ‘${other.sessionName ?? 'another session'}’`}
                    </Text>
                    <Pressable
                      onPress={() => onStopElsewhere(other.instanceId)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Stop ${server.name} in ${other.sessionName ?? 'the other session'}`}
                    >
                      <Text style={styles.elsewhereStop}>Stop</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            </Pressable>
            {pendingId === server.id ? (
              <ActivityIndicator color={theme.colors.textMuted} />
            ) : (
              <Switch
                value={managedSwitchOn(server)}
                onValueChange={(on) => onToggle(server, on)}
                accessibilityLabel={`${server.name} ${managedSwitchOn(server) ? 'on' : 'off'}`}
                trackColor={{ true: theme.colors.tone.done, false: theme.colors.border }}
              />
            )}
            <Icon name="chevron-right" size={18} color={theme.colors.textFaint} />
          </View>
        );
      })}
    </View>
  );
}

export function ManagedServerDetail({
  server,
  logs,
  busy,
  onStart,
  onStop,
  onRestart,
  onAskAgent,
  onDelete,
  networkCard,
  publicCard,
}: {
  server: ManagedDevServer;
  logs: string | undefined;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onAskAgent: (() => void) | undefined;
  onDelete: () => void;
  /** The "On your network" card, owned by the sheet. */
  networkCard: ReactNode;
  /** The "Over the internet" card, owned by the sheet; only while running. */
  publicCard: ReactNode;
}) {
  const { theme } = useUnistyles();
  const instance = server.instance;
  const state = instance?.state ?? 'stopped';
  const lines = (logs ?? '').trimEnd().split('\n').slice(-12).join('\n');
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
      <View
        style={[
          styles.statusCard,
          state === 'running'
            ? { borderColor: theme.colors.tone.done }
            : state === 'crashed'
              ? { borderColor: theme.colors.tone.danger }
              : null,
        ]}
      >
        <Text style={styles.statusTitle}>
          {state === 'running'
            ? 'Running'
            : state === 'starting'
              ? (instance?.detail ?? 'Starting…')
              : state === 'crashed'
                ? 'Crashed'
                : 'Stopped'}
        </Text>
        {state === 'running' && instance?.url ? (
          <Text style={styles.address} selectable>
            {instance.url}
          </Text>
        ) : null}
        {state === 'crashed' && instance?.detail ? (
          <Text style={styles.statusDetail}>{instance.detail}</Text>
        ) : null}
        {instance?.restartToApply ? (
          <Text style={styles.statusDetail}>
            The agent changed the command. Restart to apply it; you approve it again.
          </Text>
        ) : null}
        <View style={styles.actions}>
          {state === 'running' || state === 'starting' ? (
            <>
              <Pressable
                style={[styles.secondaryButton, styles.grow]}
                onPress={onRestart}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Restart"
              >
                <Icon name="rotate-cw" size={16} color={theme.colors.text} />
                <Text style={styles.secondaryText}>Restart</Text>
              </Pressable>
              <Pressable
                style={[styles.dangerButton, styles.grow]}
                onPress={onStop}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Stop"
              >
                <Icon name="square" size={16} color={theme.colors.tone.danger} />
                <Text style={styles.dangerText}>Stop</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={[styles.primaryButton, styles.grow]}
              onPress={onStart}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={state === 'crashed' ? 'Start again' : 'Start'}
            >
              <Icon name="play" size={16} color={theme.colors.onPrimary} />
              <Text style={styles.primaryText}>
                {state === 'crashed' ? 'Start again' : 'Start'}
              </Text>
            </Pressable>
          )}
        </View>
        {state === 'crashed' && onAskAgent ? (
          <Pressable
            style={styles.secondaryButton}
            onPress={onAskAgent}
            accessibilityRole="button"
            accessibilityLabel="Ask the agent to fix it"
          >
            <Icon name="message-circle" size={16} color={theme.colors.text} />
            <Text style={styles.secondaryText}>Ask the agent</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.label}>{state === 'crashed' ? 'LAST OUTPUT' : 'OUTPUT'}</Text>
      <View style={styles.output}>
        <Text style={styles.outputText} selectable>
          {logs === undefined ? 'Loading…' : lines || 'No output yet.'}
        </Text>
      </View>
      <Text style={styles.label}>COMMAND</Text>
      <Text style={styles.command} selectable>
        {server.command}
        {server.workdir !== '.' ? `\nin ${server.workdir}` : ''}
      </Text>
      {state === 'running' ? networkCard : null}
      {publicCard}
      <Pressable
        onPress={onDelete}
        disabled={busy}
        style={styles.deleteButton}
        accessibilityRole="button"
        accessibilityLabel="Delete entry"
      >
        <Text style={styles.dangerText}>Delete entry</Text>
      </Pressable>
    </ScrollView>
  );
}

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create((theme) => ({
  scroll: { flex: 1, minHeight: 0 },
  list: { gap: theme.spacing.sm, paddingBottom: theme.spacing.md },
  label: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontWeight: '600' },
  group: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    minHeight: 60,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  stateLine: { fontSize: theme.text.xs, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  crashMark: {
    width: 8,
    textAlign: 'center',
    color: theme.colors.tone.danger,
    fontWeight: '800',
    fontSize: theme.text.md,
  },
  elsewhere: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, marginTop: 2 },
  elsewhereText: { flexShrink: 1, color: theme.colors.textMuted, fontSize: theme.text.xs },
  elsewhereStop: { color: theme.colors.tone.danger, fontSize: theme.text.xs, fontWeight: '700' },
  statusCard: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  statusTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  statusDetail: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  address: { color: theme.colors.text, fontSize: theme.text.sm, fontFamily: MONO },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  grow: { flex: 1 },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    minHeight: 44,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  primaryText: { color: theme.colors.onPrimary, fontWeight: '600', fontSize: theme.text.sm },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    minHeight: 44,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  secondaryText: { color: theme.colors.text, fontWeight: '600', fontSize: theme.text.sm },
  dangerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    minHeight: 44,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.tone.danger,
    backgroundColor: theme.colors.surface,
  },
  dangerText: { color: theme.colors.tone.danger, fontWeight: '700', fontSize: theme.text.sm },
  output: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  outputText: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontFamily: MONO },
  command: { color: theme.colors.text, fontSize: theme.text.sm, fontFamily: MONO },
  deleteButton: { alignSelf: 'center', paddingVertical: theme.spacing.md },
}));
