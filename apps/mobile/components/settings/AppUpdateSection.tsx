/**
 * The app's box on the update screen: the version that runs, how it is doing,
 * and at most one way forward. Mirrors the server's box next to it, so the two
 * read the same way: head, then the update that belongs to it.
 */
import { describeAppUpdate, type AppUpdateAction } from '@verity/mobile';
import { useCallback, useState } from 'react';
import { Linking, View } from 'react-native';

import { useAppUpdateFacts } from '../../lib/appUpdateFacts';
import { restartIntoUpdate } from '../../lib/automaticUpdates';
import { settingsStyles as styles } from './settingsStyles';
import { Button, Card, CardHead, StatusTag, Text as UiText } from '../ui';

const TESTFLIGHT_URL = 'itms-beta://';

export function AppUpdateSection() {
  const { facts, check } = useAppUpdateFacts();
  const box = describeAppUpdate(facts);
  const [restarting, setRestarting] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const open = useCallback((url: string, failure: string) => {
    setActionError(undefined);
    Linking.openURL(url).catch(() => setActionError(failure));
  }, []);

  const run = useCallback(
    (action: AppUpdateAction) => {
      switch (action.kind) {
        case 'check':
          check();
          return;
        case 'open-store':
          open(action.url, 'Could not open the App Store.');
          return;
        case 'restart':
          setRestarting(true);
          setActionError(undefined);
          restartIntoUpdate().catch(() => {
            setRestarting(false);
            setActionError('Could not restart. The update installs the next time you open Verity.');
          });
          return;
      }
    },
    [check, open],
  );

  const block = box.block;
  const releasedAt =
    block?.publishedAt === null || block === null ? undefined : formatDate(block.publishedAt);
  return (
    <>
      <Card stacked divided attention={box.attention}>
        <View style={styles.updateBlock}>
          <CardHead
            title={box.name}
            subtitle={box.subtitle}
            trailing={
              box.tag === null ? undefined : (
                <StatusTag intent={box.tag.intent} label={box.tag.label} />
              )
            }
          />
          {box.checkLink || box.testFlightLink ? (
            <View style={styles.updateLinks}>
              {box.checkLink ? (
                <Button label="Check for updates" variant="text" size="compact" onPress={check} />
              ) : null}
              {box.testFlightLink ? (
                <Button
                  label="Open TestFlight"
                  variant="text"
                  size="compact"
                  onPress={() => open(TESTFLIGHT_URL, 'Could not open TestFlight.')}
                />
              ) : null}
            </View>
          ) : null}
        </View>
        {block !== null ? (
          <View style={styles.updateBlock}>
            <View style={styles.updateHeader}>
              <UiText variant="title" accessibilityRole="header">
                {block.title}
              </UiText>
              {releasedAt !== undefined ? (
                <UiText variant="subtitle">Released {releasedAt}</UiText>
              ) : null}
            </View>
            <UiText variant="bodySmall" tone="muted">
              {block.detail}
            </UiText>
            <Button
              label={block.action.label}
              variant={block.key === 'store' ? 'primary' : 'secondary'}
              loading={block.action.kind === 'restart' && restarting}
              onPress={() => run(block.action)}
              fullWidth
            />
            {block.notes !== null ? (
              <View style={styles.updateHeader}>
                <UiText variant="label" tone="faint">
                  What's new
                </UiText>
                <UiText variant="bodySmall" tone="muted">
                  {block.notes}
                </UiText>
              </View>
            ) : null}
          </View>
        ) : null}
      </Card>
      {actionError !== undefined ? (
        <UiText variant="bodySmall" tone="attention">
          {actionError}
        </UiText>
      ) : null}
    </>
  );
}

/** "22 Oct 2026" — a release is a day, not an instant. Unparseable → omitted. */
function formatDate(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
