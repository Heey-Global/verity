import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ManagedDevServer } from '@verity/mobile';
import { Icon } from '../Icon';
import { StatusPill } from '../StatusPill';
import { Toggle } from '../Toggle';

// Servers the agent set up and Verity runs (concept 2.6). Each has two access
// switches, Local and Shared online; any switch on runs the server and none on
// stops it. The sandbox port is internal and never shown.

/** The public link of a managed instance, as far as the list needs it. */
export interface ManagedPublicLink {
  origin: string;
  pin: string;
  expiresAt: string;
  pinLocked: boolean;
  /** Still being created or being stopped. */
  pending: boolean;
}

export type PublicSharing = 'available' | 'premium-required' | 'unavailable';

/** Whether the Local switch reads on. Older Cores lack `localOn`; derive it. */
export function managedLocalOn(server: ManagedDevServer): boolean {
  const instance = server.instance;
  if (!instance) return false;
  if (instance.localOn !== undefined) return instance.localOn;
  return instance.desired === 'running' && !instance.awaitingApproval && server.approved;
}

/** The state for the header pill and the detail view. */
export function managedStatus(server: ManagedDevServer): {
  intent: 'ready' | 'needsSetup' | 'transient' | 'optional';
  label: string;
  note?: string;
} {
  const instance = server.instance;
  if (!instance || instance.state === 'stopped') return { intent: 'optional', label: 'Stopped' };
  if (instance.state === 'crashed') return { intent: 'needsSetup', label: 'Crashed' };
  if (instance.state === 'starting')
    return { intent: 'transient', label: instance.detail ?? 'Starting…' };
  if (instance.awaitingApproval)
    return { intent: 'ready', label: 'Running', note: 'not shared yet' };
  return { intent: 'ready', label: 'Running' };
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//u, '').replace(/\/$/u, '');
}

/** Long share hosts lose their middle, never their domain. */
function shortHost(url: string): string {
  const host = hostOf(url);
  const dot = host.indexOf('.');
  if (dot <= 8) return host;
  return `${host.slice(0, 6)}…${host.slice(dot + 1)}`;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ManagedServerBlock({
  server,
  publicLink,
  publicSharing,
  pending,
  pinCopied,
  onLocal,
  onOnline,
  onOpenLocal,
  onOpenPublic,
  onSharePublic,
  onCopyPin,
  onDetails,
  onStopElsewhere,
  onOpenSettings,
}: {
  server: ManagedDevServer;
  publicLink: ManagedPublicLink | undefined;
  publicSharing: PublicSharing;
  /** The switch whose change is in flight. */
  pending: 'local' | 'online' | undefined;
  pinCopied: boolean;
  onLocal: (on: boolean) => void;
  onOnline: (on: boolean) => void;
  onOpenLocal: () => void;
  onOpenPublic: () => void;
  onSharePublic: () => void;
  onCopyPin: () => void;
  onDetails: () => void;
  onStopElsewhere: (instanceId: string) => void;
  onOpenSettings: (() => void) | undefined;
}) {
  const { theme } = useUnistyles();
  const status = managedStatus(server);
  const crashed = status.intent === 'needsSetup';
  const localOn = managedLocalOn(server);
  const localUrl = server.instance?.state === 'running' ? server.instance.url : null;
  const onlineOn = publicLink !== undefined;
  const busy = pending !== undefined;
  return (
    <View style={styles.block}>
      <Pressable
        style={styles.header}
        onPress={onDetails}
        accessibilityRole="button"
        accessibilityLabel={`${server.name}, ${status.label}${status.note ? `, ${status.note}` : ''}. ${crashed ? 'View output' : 'Details'}`}
      >
        <Text style={styles.name} numberOfLines={1}>
          {server.name}
        </Text>
        <StatusPill intent={status.intent} label={status.label} />
        {status.note ? <Text style={styles.note}>{status.note}</Text> : null}
        <View style={styles.headerSpacer} />
        <Text style={styles.detailsLink}>{crashed ? 'View output' : 'Details'}</Text>
        <Icon name="chevron-right" size={16} color={theme.colors.primary} />
      </Pressable>
      {server.elsewhere.map((other) => (
        <View key={other.instanceId} style={styles.elsewhere}>
          <Text style={styles.elsewhereText} numberOfLines={1}>
            {`Also running in ‘${other.sessionName ?? 'another session'}’`}
          </Text>
          <Pressable
            onPress={() => onStopElsewhere(other.instanceId)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={`Stop ${server.name} in ${other.sessionName ?? 'the other session'}`}
          >
            <Text style={styles.elsewhereStop}>Stop</Text>
          </Pressable>
        </View>
      ))}
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowIcon}>
            <Icon
              name="wifi"
              size={18}
              color={localOn ? theme.colors.text : theme.colors.textMuted}
            />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Local</Text>
            {localOn && localUrl ? (
              <Pressable
                onPress={onOpenLocal}
                onLongPress={onOpenLocal}
                hitSlop={8}
                accessibilityRole="link"
                accessibilityLabel={`Open ${server.name} on your network`}
              >
                <Text style={styles.link} numberOfLines={1}>
                  {hostOf(localUrl)}
                </Text>
              </Pressable>
            ) : (
              <Text style={styles.rowDetail}>
                {localOn ? 'Starting on your network…' : 'Starts the server on your network'}
              </Text>
            )}
          </View>
          <SwitchControl
            label={`Local for ${server.name}`}
            value={localOn}
            pending={pending === 'local'}
            disabled={busy}
            onChange={onLocal}
          />
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <View style={styles.rowIcon}>
            <Icon
              name="globe"
              size={18}
              color={onlineOn ? theme.colors.text : theme.colors.textMuted}
            />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Shared online</Text>
            {publicLink ? (
              <>
                <Pressable
                  onPress={onOpenPublic}
                  hitSlop={8}
                  disabled={publicLink.pending}
                  accessibilityRole="link"
                  accessibilityLabel={`Open the public link of ${server.name}`}
                >
                  <Text style={styles.link} numberOfLines={1}>
                    {shortHost(publicLink.origin)}
                  </Text>
                </Pressable>
                {publicLink.pinLocked ? (
                  <Text style={styles.warning}>
                    PIN locked after failed attempts. Turn off and on for a new link.
                  </Text>
                ) : (
                  <View style={styles.pinLine}>
                    <Text
                      style={styles.rowDetail}
                    >{`Until ${timeOf(publicLink.expiresAt)} · PIN `}</Text>
                    <Pressable
                      style={styles.pin}
                      onPress={onCopyPin}
                      hitSlop={12}
                      accessibilityRole="button"
                      accessibilityLabel={
                        pinCopied ? 'PIN copied' : `Copy PIN ${publicLink.pin.split('').join(' ')}`
                      }
                    >
                      <Text style={styles.pinValue}>
                        {publicLink.pin.replace(/(\d{3})(?=\d)/gu, '$1 ')}
                      </Text>
                      <Icon
                        name={pinCopied ? 'check' : 'copy'}
                        size={14}
                        color={theme.colors.primary}
                      />
                    </Pressable>
                  </View>
                )}
              </>
            ) : (
              <Text style={styles.rowDetail}>
                {publicSharing === 'unavailable'
                  ? 'Temporarily unavailable'
                  : 'Public link with PIN'}
              </Text>
            )}
          </View>
          {publicLink && !publicLink.pinLocked ? (
            <Pressable
              style={styles.iconAction}
              onPress={onSharePublic}
              accessibilityRole="button"
              accessibilityLabel="Send link and PIN"
            >
              <Icon name="share" size={20} color={theme.colors.primary} />
            </Pressable>
          ) : null}
          {publicSharing === 'premium-required' && !publicLink ? (
            <Pressable
              style={styles.premium}
              onPress={onOpenSettings}
              disabled={!onOpenSettings}
              accessibilityRole="button"
              accessibilityLabel="Shared online needs Verity Premium. Open settings"
            >
              <Text style={styles.premiumText}>Premium</Text>
            </Pressable>
          ) : (
            <SwitchControl
              label={`Shared online for ${server.name}`}
              value={onlineOn}
              pending={pending === 'online' || publicLink?.pending === true}
              disabled={busy || (publicSharing === 'unavailable' && !publicLink)}
              onChange={onOnline}
            />
          )}
        </View>
      </View>
    </View>
  );
}

function SwitchControl({
  label,
  value,
  pending,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean;
  pending: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      style={styles.switch}
      onPress={() => onChange(!value)}
      disabled={disabled || pending}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: disabled || pending, busy: pending }}
    >
      {pending ? (
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
      ) : (
        <Toggle value={value} disabled={disabled} />
      )}
    </Pressable>
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
}: {
  server: ManagedDevServer;
  logs: string | undefined;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onAskAgent: (() => void) | undefined;
  onDelete: () => void;
}) {
  const { theme } = useUnistyles();
  const instance = server.instance;
  const state = instance?.state ?? 'stopped';
  const status = managedStatus(server);
  const lines = (logs ?? '').trimEnd().split('\n').slice(-12).join('\n');
  const since =
    state === 'running' && instance?.startedAt
      ? `since ${timeOf(instance.startedAt)}`
      : state === 'crashed'
        ? (instance?.detail ?? undefined)
        : undefined;
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
      <View style={styles.statusLine}>
        <StatusPill intent={status.intent} label={status.label} />
        {since ? (
          <Text style={styles.rowDetail} numberOfLines={2}>
            {since}
          </Text>
        ) : null}
      </View>
      {instance?.restartToApply ? (
        <Text style={styles.rowDetail}>
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
          <>
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
            {state === 'crashed' && onAskAgent ? (
              <Pressable
                style={[styles.secondaryButton, styles.grow]}
                onPress={onAskAgent}
                accessibilityRole="button"
                accessibilityLabel="Ask the agent to fix it"
              >
                <Icon name="message-circle" size={16} color={theme.colors.text} />
                <Text style={styles.secondaryText}>Ask the agent</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
      <Text style={styles.label}>{state === 'crashed' ? 'LAST OUTPUT' : 'OUTPUT'}</Text>
      <View style={styles.output}>
        <Text style={styles.outputText} selectable>
          {logs === undefined ? 'Loading…' : lines || 'No output yet.'}
        </Text>
      </View>
      <Text style={styles.label}>COMMAND</Text>
      <View style={styles.commandBox}>
        <Text style={styles.command} selectable>
          {server.command}
        </Text>
        {server.workdir !== '.' ? (
          <Text style={styles.rowDetail}>{`in ${server.workdir}`}</Text>
        ) : null}
      </View>
      <Text style={styles.rowDetail}>Set up by the agent. Ask it to change the command.</Text>
      <Pressable
        onPress={onDelete}
        disabled={busy}
        style={styles.dangerButton}
        accessibilityRole="button"
        accessibilityLabel="Delete entry"
      >
        <Icon name="trash-2" size={16} color={theme.colors.tone.danger} />
        <Text style={styles.dangerText}>Delete entry</Text>
      </Pressable>
    </ScrollView>
  );
}

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create((theme) => ({
  scroll: { flex: 1, minHeight: 0 },
  list: { gap: theme.spacing.md, paddingBottom: theme.spacing.md },
  label: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontWeight: '600' },
  block: { gap: theme.spacing.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 44,
  },
  name: { flexShrink: 1, color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  note: { color: theme.colors.textMuted, fontSize: theme.text.xs },
  headerSpacer: { flex: 1 },
  detailsLink: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '600' },
  elsewhere: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  elsewhereText: { flexShrink: 1, color: theme.colors.textMuted, fontSize: theme.text.xs },
  elsewhereStop: { color: theme.colors.tone.danger, fontSize: theme.text.xs, fontWeight: '700' },
  card: {
    borderRadius: theme.radius.lg,
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
    minHeight: 64,
  },
  divider: {
    height: 1,
    marginLeft: theme.spacing.md + 22 + theme.spacing.sm,
    backgroundColor: theme.colors.border,
  },
  rowIcon: { width: 22, alignItems: 'center' },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
  rowDetail: { color: theme.colors.textMuted, fontSize: theme.text.xs },
  warning: { color: theme.colors.tone.danger, fontSize: theme.text.xs },
  link: { color: theme.colors.primary, fontSize: theme.text.sm, fontFamily: MONO },
  pinLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  pin: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
  pinValue: {
    color: theme.colors.text,
    fontSize: theme.text.xs,
    fontWeight: '700',
    fontFamily: MONO,
    fontVariant: ['tabular-nums'],
  },
  iconAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  switch: { minWidth: 52, height: 44, alignItems: 'flex-end', justifyContent: 'center' },
  premium: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.spacing.xs },
  premiumText: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '600' },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    flexWrap: 'wrap',
  },
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
  commandBox: {
    gap: 2,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  command: { color: theme.colors.text, fontSize: theme.text.sm, fontFamily: MONO },
}));
