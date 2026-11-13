import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useServerConnection } from '../hooks/useServerConnection';
import { getVerityBaseUrl } from '../lib/client';
import {
  connectionBarText,
  failedRoutes,
  nextAttemptText,
  serverHost,
} from '../lib/connectionText';
import { formatClockTime } from '../lib/time';
import { Button, Group, Row, Sheet, StatusDot, Text } from './ui';
import { CodeBlock } from './ui/CodeBlock';
import { Disclosure } from './ui/Disclosure';
import { SessionBar, SessionBarContent, SessionBarTarget } from './ui/SessionBar';

/**
 * The one place the app says the server is updating or out of reach
 * (docs/design-system.md § 5.10). It sits under the header on every screen, so
 * screens no longer repeat the same transport error; it disappears again a
 * moment after the server answers, once the screens have reloaded.
 */
export function ConnectionStatusBar() {
  const { theme } = useUnistyles();
  const { state, view, now, retryNow } = useServerConnection();
  const [open, setOpen] = useState(false);
  const disrupted = state.kind !== 'connected';
  // The sheet belongs to one disruption: left open when the server came back,
  // it would otherwise pop up by itself at the start of the next one.
  useEffect(() => {
    if (!disrupted) setOpen(false);
  }, [disrupted]);
  const text = connectionBarText(view, state, now);
  if (text === null) return null;
  return (
    <>
      <View accessibilityLiveRegion="polite">
        <SessionBar
          trailing={
            view === 'unreachable' ? (
              <Button
                label="Try now"
                icon="rotate-cw"
                variant="secondary"
                size="compact"
                loading={state.kind !== 'connected' && state.nextAttemptAt === undefined}
                onPress={retryNow}
              />
            ) : undefined
          }
        >
          <SessionBarTarget
            accessibilityLabel={`${text.title}. ${text.subtitle}`}
            accessibilityHint={disrupted ? 'Shows connection details' : undefined}
            onPress={disrupted ? () => setOpen(true) : undefined}
          >
            <SessionBarContent
              busy={view === 'maintenance'}
              color={view === 'unreachable' ? theme.colors.attention : theme.colors.success}
              title={text.title}
              subtitle={text.subtitle}
            />
          </SessionBarTarget>
        </SessionBar>
      </View>
      {disrupted ? (
        <ConnectionSheet
          visible={open}
          onClose={() => setOpen(false)}
          state={state}
          now={now}
          retryNow={retryNow}
        />
      ) : null}
    </>
  );
}

/** What a tap on the bar opens: the state in words, the remedy, raw output last. */
function ConnectionSheet({
  visible,
  onClose,
  state,
  now,
  retryNow,
}: {
  visible: boolean;
  onClose: () => void;
} & Pick<ReturnType<typeof useServerConnection>, 'state' | 'now' | 'retryNow'>) {
  if (state.kind === 'connected') return null;
  const updating = state.kind === 'maintenance';
  const routes = failedRoutes(state.details);
  const lastConnected =
    state.lastConnectedAt === undefined
      ? 'Not reached since the app started'
      : `Last connected ${formatClockTime(state.lastConnectedAt / 1000)}`;
  const next = nextAttemptText(state, now, true);
  return (
    <Sheet
      visible={visible}
      title="Connection"
      onClose={onClose}
      footer={
        <Button
          label="Try now"
          icon="rotate-cw"
          loading={state.nextAttemptAt === undefined}
          onPress={retryNow}
        />
      }
    >
      <View style={styles.body}>
        <Group>
          <Row
            title={serverHost(getVerityBaseUrl())}
            subtitle={lastConnected}
            leading={{ icon: 'server', intent: updating ? 'transient' : 'needsSetup' }}
            trailing={
              <StatusDot
                intent={updating ? 'transient' : 'needsSetup'}
                label={updating ? 'Updating' : 'Unreachable'}
              />
            }
          />
          {!updating && routes.remote ? (
            <Row
              title="Remote Control"
              subtitle="The Remote Control route did not connect"
              leading={{ icon: 'cloud' }}
              trailing={<StatusDot intent="needsSetup" label="Failed" />}
            />
          ) : null}
          {!updating && routes.direct ? (
            <Row
              title="Direct connection"
              subtitle="The server did not answer on this network"
              leading={{ icon: 'wifi' }}
              trailing={<StatusDot intent="needsSetup" label="Failed" />}
            />
          ) : null}
          <Row
            title="Next attempt"
            subtitle="Verity keeps retrying while the app is open"
            leading={{ icon: 'clock' }}
            trailing={<StatusDot intent="transient" label={next} />}
          />
          <Disclosure title="Technical details" subtitle="For support · can be copied">
            <CodeBlock text={state.details} />
            <View style={styles.copy}>
              <Button
                label="Copy"
                icon="copy"
                variant="text"
                size="compact"
                onPress={() => void Clipboard.setStringAsync(state.details)}
              />
            </View>
          </Disclosure>
        </Group>
        <Text variant="subtitle">
          {updating
            ? 'The server is installing an update. Verity reconnects on its own and reloads your sessions.'
            : 'Check that VPN or your network is on. Verity reloads your sessions as soon as the server answers.'}
        </Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing.lg },
  copy: { flexDirection: 'row' },
}));
