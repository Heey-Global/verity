import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { VerityHeader } from '../../components/home/HomeInbox';
import { HomeTabBar } from '../../components/home/HomeTabBar';
import {
  Button,
  Card,
  Group,
  IconButton,
  Row,
  SectionHeader,
  Sheet,
  StatusDot,
  SystemNoticeIndicator,
  Text,
  TileMark,
} from '../../components/ui';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { Disclosure } from '../../components/ui/Disclosure';
import { SessionBar, SessionBarContent, SessionBarTarget } from '../../components/ui/SessionBar';

const ignore = () => undefined;

export type ConnectionState = 'updating' | 'unreachable' | 'reconnected';

export const SAMPLE_DUMP =
  'Uplink probe (Pinned TLS transport failed [NSURLErrorDomain:-1200:NO_AUTH_CHALLENGE:streamDomain:3:streamCode:-9816]; tunnel local=2, opened=2, received=2, last=remote_stream.reset, sentBytes=3060, receivedBytes=0, remoteResets=2, lastReset=remote_reset_upstream_error, age=160, pings=0/0) and direct Core request failed: Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE:streamDomain:12:streamCode:8]';

/**
 * Sample of the planned connection bar: the existing SessionBar frame (§ 5.9's
 * status vocabulary) once under the top bar for the whole app. Neutral surface,
 * the intent's mark and word; color only on the dot, never on the surface.
 * The spinner variant shows the planned `indicator` extension of SessionBarContent.
 */
export function ConnectionStrip({ state }: { state: ConnectionState }) {
  const { theme } = useUnistyles();
  const title =
    state === 'updating'
      ? 'Server is updating'
      : state === 'unreachable'
        ? 'Can’t reach your server'
        : 'Connected';
  const subtitle =
    state === 'updating'
      ? 'Reconnecting automatically · 1:24'
      : state === 'unreachable'
        ? 'Retrying in 8 s'
        : 'Back online · sessions and settings reloaded';
  return (
    <SessionBar
      trailing={
        state === 'unreachable' ? (
          <Button
            label="Try now"
            icon="rotate-cw"
            variant="secondary"
            size="compact"
            onPress={ignore}
          />
        ) : undefined
      }
    >
      <SessionBarTarget accessibilityLabel={`${title}. Show connection details`} onPress={ignore}>
        {state === 'updating' ? (
          <>
            <SystemNoticeIndicator intent="transient" />
            <View style={styles.main}>
              <Text variant="bodySmall" style={styles.barTitle} numberOfLines={1}>
                {title}
              </Text>
              <Text variant="footnote" tone="muted" style={styles.barSubtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            </View>
          </>
        ) : (
          <SessionBarContent
            color={state === 'unreachable' ? theme.colors.attention : theme.colors.success}
            title={title}
            subtitle={subtitle}
          />
        )}
      </SessionBarTarget>
    </SessionBar>
  );
}

/** What a tap on the bar opens: the state in words, the remedy, raw output last. */
export function ConnectionSheet() {
  return (
    <Sheet
      visible
      title="Connection"
      onClose={ignore}
      footer={<Button label="Try now" icon="rotate-cw" onPress={ignore} />}
    >
      <View style={styles.sheetBody}>
        <Group>
          <Row
            title="verity.build"
            subtitle="Last connected 22:21"
            leading={{ icon: 'server', intent: 'needsSetup' }}
            trailing={<StatusDot intent="needsSetup" label="Unreachable" />}
          />
          <Row
            title="Remote Control"
            subtitle="Uplink refused the secure connection"
            leading={{ icon: 'cloud' }}
            trailing={<StatusDot intent="needsSetup" label="Failed" />}
          />
          <Row
            title="Direct connection"
            subtitle="Server not found on this network"
            leading={{ icon: 'wifi' }}
            trailing={<StatusDot intent="needsSetup" label="Failed" />}
          />
          <Row
            title="Next attempt"
            subtitle="Verity keeps retrying while the app is open"
            leading={{ icon: 'clock' }}
            trailing={<StatusDot intent="transient" label="In 8 s" />}
          />
          <Disclosure title="Technical details" subtitle="For support · can be copied">
            <CodeBlock text={SAMPLE_DUMP} />
            <Button label="Copy" icon="copy" variant="text" size="compact" onPress={ignore} />
          </Disclosure>
        </Group>
        <Text variant="subtitle">
          Check that VPN or your network is on. Verity reloads your sessions as soon as the server
          answers.
        </Text>
      </View>
    </Sheet>
  );
}

/** The session list on Home without the maintenance card it used to carry. */
export function HomeSidebar() {
  return (
    <View style={styles.sidebar}>
      <ScrollView contentContainerStyle={styles.content}>
        <VerityHeader summary="Nothing needs you right now · 5 in progress" />
        <SectionHeader title="In progress · 5" variant="eyebrow" flush />
        <Group>
          <Row
            title="Koordinaten Fulltext-Tarif"
            subtitle="Deep-OCR · PR #551 · merged · Agent working"
            leading={{
              icon: 'git-pull-request',
              quiet: true,
              marks: { top: <TileMark tone="signature" pulsing /> },
            }}
            onPress={ignore}
          />
          <Row
            title="Teammitglieder Einladen"
            subtitle="Verity · Agent working"
            leading={{
              icon: 'message-square',
              quiet: true,
              marks: { top: <TileMark tone="signature" pulsing /> },
            }}
            active
            onPress={ignore}
          />
          <Row
            title="Plan: relay app cookies through online shares"
            subtitle="Verity · PR #2559 · CI running"
            leading={{
              icon: 'git-pull-request',
              quiet: true,
              marks: { bottom: <TileMark tone="action" glyph="loader" /> },
            }}
            onPress={ignore}
          />
          <Row
            title="Problemanalyse"
            subtitle="control · Agent working"
            leading={{
              icon: 'message-square',
              quiet: true,
              marks: { top: <TileMark tone="signature" pulsing /> },
            }}
            onPress={ignore}
          />
          <Row
            title="DWG Grundriss Vereinfachen"
            subtitle="Saikandi · Agent working"
            leading={{
              icon: 'message-square',
              quiet: true,
              marks: { top: <TileMark tone="signature" pulsing /> },
            }}
            onPress={ignore}
          />
        </Group>
      </ScrollView>
      <HomeTabBar tab="home" onChange={ignore} count={0} bottomInset={0} />
    </View>
  );
}

/** The transcript as last loaded: kept on screen, no local error banners. */
export function SessionTranscript({ phone = false }: { phone?: boolean }) {
  return (
    <View style={styles.transcript}>
      <View style={[styles.sessionHead, phone ? styles.sessionHeadPhone : null]}>
        <Text variant="title">Teammitglieder Einladen</Text>
        <Text variant="bodySmall" tone="muted">
          Claude Opus 5.5 · Agent working
        </Text>
      </View>
      <ScrollView contentContainerStyle={[styles.messages, phone ? styles.messagesPhone : null]}>
        <Card stacked>
          <Text variant="body">
            Let a server owner invite team members and give each of them their own projects.
          </Text>
        </Card>
        <Row
          title="Ran 6 commands"
          subtitle="Tests · 20 passed"
          leading={{ icon: 'terminal', intent: 'ready' }}
        />
        <Text variant="body">
          Profiles and join now handle several servers (20 tests pass). Next, the other servers’
          projects on the home list and a Servers management screen.
        </Text>
        <Row
          title="Running"
          subtitle="Checking the settings index and project title helper"
          leading={{ icon: 'terminal', intent: 'transient' }}
        />
      </ScrollView>
      <View style={[styles.composer, phone ? styles.composerPhone : null]}>
        <Text variant="body" tone="faint">
          Message this agent…
        </Text>
        <View style={styles.composeActions}>
          <IconButton icon="plus" accessibilityLabel="Add attachment" onPress={ignore} />
          <Text variant="bodySmall" tone="muted">
            Claude Opus 5.5
          </Text>
          <View style={styles.spacer} />
          <IconButton icon="arrow-up" accessibilityLabel="Send message" onPress={ignore} />
        </View>
      </View>
    </View>
  );
}

export function DesktopFrame({ strip, overlay }: { strip: ReactNode; overlay?: ReactNode }) {
  return (
    <View style={styles.root}>
      {strip}
      <View style={styles.desktop}>
        <HomeSidebar />
        <SessionTranscript />
      </View>
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  main: { flex: 1, minWidth: 0, gap: 1 },
  barTitle: { fontFamily: theme.fonts.bold },
  barSubtitle: { fontFamily: theme.fonts.semibold },
  sheetBody: { gap: theme.spacing.lg },
  desktop: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 430, borderRightWidth: 1, borderRightColor: theme.colors.border },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  transcript: { flex: 1 },
  sessionHead: {
    padding: theme.spacing.xl,
    gap: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  sessionHeadPhone: { padding: theme.spacing.lg },
  messages: { padding: theme.spacing.xl, gap: theme.spacing.xl },
  messagesPhone: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  composer: {
    margin: theme.spacing.lg,
    padding: theme.spacing.lg,
    gap: theme.spacing.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.surfaceAlt,
  },
  composerPhone: { margin: theme.spacing.sm },
  composeActions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  spacer: { flex: 1 },
}));
