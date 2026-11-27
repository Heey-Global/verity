import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  CaptureField,
  Card,
  CardHead,
  Sheet,
  SheetHeaderButton,
  StatusTag,
  Text,
} from '../../components/ui';
import { VerityMark } from '../../components/VerityMark';

const ignore = () => undefined;

export const SAMPLE = {
  project: 'heey-global/deep-ocr',
  title: 'Backup check',
  ask: 'Frag deep-ocr, ob Dokumente jetzt vom Backup ausgeschlossen sind.',
  handedOver:
    'Ich habe das an **heey-global/deep-ocr** übergeben. Die Session meldet sich, sobald sie eine Antwort hat.',
  doneSummary:
    'Dokumente sind seit dem letzten Release vom Backup ausgeschlossen. Die Ausnahme steht in backup.yml, ein Restore-Test lief ohne Dokumente durch.',
  openSummary:
    'Der Ausschluss ist vorbereitet, aber noch nicht aktiv: backup.yml ist angepasst, das Deployment steht aus.',
  blocker: 'Deployment nach Production braucht deine Freigabe.',
} as const;

/** The Verity sheet as the V opens it, with sample conversation entries. */
export function VeritySheet({ children }: { children: ReactNode }) {
  return (
    <View style={styles.root}>
      <Sheet
        visible
        title="Verity"
        titleLeading={<VerityMark size={32} glow={false} />}
        headerAction={
          <SheetHeaderButton
            icon="maximize-2"
            accessibilityLabel="Open full conversation"
            onPress={ignore}
          />
        }
        onClose={ignore}
        anchorEnd
        footer={
          <CaptureField
            value=""
            onChangeText={ignore}
            placeholder="Ask or tell Verity anything"
            listening={false}
            onMic={ignore}
            onSend={ignore}
            sendDisabled
            accessibilityLabel="Message to Verity"
          />
        }
      >
        <View style={styles.body}>{children}</View>
      </Sheet>
    </View>
  );
}

/** What the user said, as the panel shows it. */
export function Mine({ text }: { text: string }) {
  return (
    <View style={styles.mine}>
      <Text variant="bodySmall">{text}</Text>
    </View>
  );
}

/** Verity's reply with her mark. */
export function Reply({ text }: { text: string }) {
  return (
    <View style={styles.reply}>
      <VerityMark size={22} glow={false} />
      <View style={styles.replyText}>
        <Text variant="bodySmall">{text.replaceAll('**', '')}</Text>
      </View>
    </View>
  );
}

/**
 * The handoff card: unchanged while handed over, then the published result –
 * "Done" or "Open" – with the session's summary in two lines and, when open,
 * its blocker. The summary is the session's own words, shown as written.
 */
export function HandoffCard({
  state,
  summary,
  blocker,
  at,
}: {
  state: 'sent' | 'done' | 'open';
  summary?: string;
  blocker?: string;
  at?: string;
}) {
  return (
    <Card stacked>
      <CardHead
        title={SAMPLE.title}
        subtitle={SAMPLE.project}
        trailing={
          state === 'done' ? (
            <StatusTag intent="ready" label="Done" />
          ) : state === 'open' ? (
            <StatusTag intent="action" label="Open" />
          ) : (
            <StatusTag intent="ready" label="Handed over" />
          )
        }
      />
      {summary ? (
        <Text variant="bodySmall" numberOfLines={2}>
          {summary}
        </Text>
      ) : null}
      {blocker ? (
        <Text variant="subtitle" tone="attention" numberOfLines={2}>
          {`Blocker: ${blocker}`}
        </Text>
      ) : null}
      {at ? (
        <Text variant="footnote" tone="faint">
          {`Result from the session · ${at}`}
        </Text>
      ) : null}
    </Card>
  );
}

/** A system notification as iOS shows it; Verity supplies only title and text. */
export function SystemNotification({
  title,
  body,
  compact = false,
}: {
  title: string;
  body: string;
  compact?: boolean;
}) {
  return (
    <View style={compact ? styles.watchNote : styles.note}>
      <View style={styles.noteHead}>
        <VerityMark size={compact ? 16 : 20} glow={false} />
        <Text variant={compact ? 'caption' : 'footnote'} tone="muted" style={styles.flex}>
          VERITY
        </Text>
        <Text variant={compact ? 'caption' : 'footnote'} tone="muted">
          now
        </Text>
      </View>
      <Text variant={compact ? 'subtitle' : 'row'} numberOfLines={compact ? 2 : 1}>
        {title}
      </Text>
      <Text variant={compact ? 'footnote' : 'bodySmall'} numberOfLines={compact ? 6 : 4}>
        {body}
      </Text>
    </View>
  );
}

/** The push text: status word, then the summary cut to about 150 characters. */
export function pushBody(status: 'Done' | 'Open', summary: string): string {
  const text = `${status}: ${summary}`;
  return text.length <= 150 ? text : `${text.slice(0, 149).trimEnd()}…`;
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  body: { gap: theme.spacing.md },
  flex: { flex: 1 },
  reply: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
  replyText: { flex: 1, minWidth: 0 },
  mine: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  note: {
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  watchNote: {
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
}));
