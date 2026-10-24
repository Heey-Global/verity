import { PremiumBadge } from '../premium/PremiumBadge';
import { premiumFeatures } from '../premium/premiumFeatures';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ManagedDevServer } from '@verity/mobile';
import { Icon } from '../Icon';
import { StatusPill } from '../StatusPill';
import { Toggle } from '../Toggle';
import { Button } from '../ui';

// Servers the agent set up and Verity runs (concept 2.6). Each has two access
// switches, Local and Online sharing; any switch on runs the server and none on
// stops it. The sandbox port is internal and never shown.

/** The public link of a managed instance, as far as the list needs it. */
export interface ManagedPublicLink {
  /** Null while the Uplink has not assigned the address yet. */
  origin: string | null;
  pin: string;
  expiresAt: string;
  pinLocked: boolean;
  /** Still being created or being stopped. */
  pending: boolean;
}

const ONLINE_SHARING = premiumFeatures[0].name;

export type PublicSharing = 'available' | 'premium-required' | 'unavailable' | 'disabled';

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
  pending: 'local' | 'online' | 'other' | undefined;
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
        <Icon name="chevron-right" size={16} color={theme.colors.action} />
      </Pressable>
      {server.elsewhere.map((other) => (
        <View key={other.instanceId} style={styles.elsewhere}>
          <Text style={styles.elsewhereText} numberOfLines={1}>
            {`Also running in ‘${other.sessionName ?? 'another session'}’`}
          </Text>
          <Button
            label="Stop"
            accessibilityLabel={`Stop ${server.name} in ${other.sessionName ?? 'the other session'}`}
            variant="destructive"
            size="compact"
            onPress={() => onStopElsewhere(other.instanceId)}
          />
        </View>
      ))}
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowIcon}>
            <Icon
              name="wifi"
              size={18}
              color={localOn ? theme.colors.success : theme.colors.textMuted}
            />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Local</Text>
            {localOn && localUrl ? (
              <Pressable
                onPress={onOpenLocal}
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
                {localOn
                  ? (server.instance?.detail ?? 'Starting on your network…')
                  : 'Starts the server on your network'}
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
              color={onlineOn ? theme.colors.success : theme.colors.textMuted}
            />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{ONLINE_SHARING}</Text>
            {publicLink && !publicLink.origin ? (
              <Text style={styles.rowDetail}>Creating link…</Text>
            ) : publicLink?.origin ? (
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
                        color={theme.colors.action}
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
          {publicLink?.origin && !publicLink.pinLocked ? (
            <Pressable
              style={styles.iconAction}
              onPress={onSharePublic}
              accessibilityRole="button"
              accessibilityLabel="Send link and PIN"
            >
              <Icon name="share" size={20} color={theme.colors.action} />
            </Pressable>
          ) : null}
          {(publicSharing === 'premium-required' || publicSharing === 'disabled') && !publicLink ? (
            <Pressable
              style={styles.premium}
              onPress={onOpenSettings}
              disabled={!onOpenSettings}
              accessibilityRole="button"
              accessibilityLabel="Manage Online sharing in Verity Premium"
            >
              {publicSharing === 'disabled' ? (
                <Text style={styles.premiumText}>Off · Settings</Text>
              ) : (
                <PremiumBadge />
              )}
            </Pressable>
          ) : (
            <SwitchControl
              label={`${ONLINE_SHARING} for ${server.name}`}
              value={onlineOn}
              pending={pending === 'online'}
              disabled={busy || (publicSharing !== 'available' && !publicLink)}
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
      {state === 'running' && instance?.detail ? (
        <Text style={styles.warning}>{instance.detail}</Text>
      ) : null}
      {instance?.restartToApply ? (
        <Text style={styles.rowDetail}>
          The agent changed the command. Restart to apply it; you approve it again.
        </Text>
      ) : null}
      <View style={styles.actions}>
        {state === 'running' || state === 'starting' ? (
          <>
            <View style={styles.grow}>
              <Button
                label="Restart"
                icon="rotate-cw"
                variant="secondary"
                size="compact"
                disabled={busy}
                onPress={onRestart}
                fullWidth
              />
            </View>
            <View style={styles.grow}>
              <Button
                label="Stop"
                icon="square"
                variant="destructive"
                size="compact"
                disabled={busy}
                onPress={onStop}
                fullWidth
              />
            </View>
          </>
        ) : (
          <>
            <View style={styles.grow}>
              <Button
                label={state === 'crashed' ? 'Start again' : 'Start'}
                icon="play"
                size="compact"
                disabled={busy}
                onPress={onStart}
                fullWidth
              />
            </View>
            {state === 'crashed' && onAskAgent ? (
              <View style={styles.grow}>
                <Button
                  label="Ask the agent"
                  accessibilityLabel="Ask the agent to fix it"
                  icon="message-circle"
                  variant="secondary"
                  size="compact"
                  onPress={onAskAgent}
                  fullWidth
                />
              </View>
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
      <View style={styles.inline}>
        <Button
          label="Delete entry"
          icon="trash-2"
          variant="destructive"
          size="compact"
          disabled={busy}
          onPress={onDelete}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A button keeps the width of its label instead of spanning the column.
  inline: { flexDirection: 'row' },
  scroll: { flex: 1, minHeight: 0 },
  list: { gap: theme.spacing.md, paddingBottom: theme.spacing.md },
  label: {
    ...theme.typography.footnote,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.textMuted,
  },
  block: { gap: theme.spacing.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 44,
  },
  name: { ...theme.typography.row, flexShrink: 1, color: theme.colors.text },
  note: { ...theme.typography.footnote, color: theme.colors.textMuted },
  headerSpacer: { flex: 1 },
  detailsLink: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.action,
  },
  elsewhere: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  elsewhereText: { ...theme.typography.footnote, flexShrink: 1, color: theme.colors.textMuted },
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
  rowTitle: { ...theme.typography.row, color: theme.colors.text },
  rowDetail: { ...theme.typography.footnote, color: theme.colors.textMuted },
  warning: { ...theme.typography.footnote, color: theme.colors.attention },
  link: { ...theme.typography.code, color: theme.colors.action },
  pinLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  pin: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
  pinValue: {
    ...theme.typography.code,
    color: theme.colors.text,
    fontVariant: ['tabular-nums'],
  },
  iconAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  switch: { minWidth: 52, height: 44, alignItems: 'flex-end', justifyContent: 'center' },
  premium: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.spacing.xs },
  premiumText: { ...theme.typography.button, color: theme.colors.action },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    flexWrap: 'wrap',
  },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  grow: { flex: 1 },
  output: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  outputText: { ...theme.typography.code, color: theme.colors.textMuted },
  commandBox: {
    gap: 2,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  command: { ...theme.typography.code, color: theme.colors.text },
}));
