import type { AgentEvent } from '@verity/events';
import {
  brokeredAuthSentence,
  brokeredHttpSummary,
  secretGrantScopes,
  spellOutBidiControls,
  trustedCliCommandLine,
  trustedCliInjectionSummary,
  trustedCliSummary,
  type PendingPermission,
  type StandingSecretGrantScope,
} from '@verity/mobile';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from './Icon';
import { PermissionRequestDetails } from './session/PermissionRequestDetails';
import { Button, Card, StatusTag, Text } from './ui';

type Request = Pick<PendingPermission, 'tool' | 'input' | 'secretSource'>;

/** A call reading several Doppler bindings arrives as a list without a config. */
function dopplerSourceLabel(source: { project: string; config: string }): string {
  return source.config === ''
    ? `Doppler · ${source.project}`
    : `Doppler · ${source.project} / ${source.config}`;
}
type Decision = NonNullable<Extract<AgentEvent, { t: 'notice' }>['secretApproval']>['decision'];

const labels: Record<Decision, string> = {
  once: 'Allowed once',
  session: 'Allowed for this session',
  project: 'Allowed in project for 30 days',
  denied: 'Denied',
  save_failed: 'Approval could not be saved',
};

export function SecretApprovalCard({
  request,
  decision,
  actions,
}: {
  request: Request;
  decision?: Decision;
  actions?: {
    disabled: boolean;
    deciding: boolean;
    allow: (scope?: StandingSecretGrantScope) => void;
    deny: () => void;
  };
}) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const pending = decision === undefined;
  const isHttp = request.tool === 'verity_http_request';
  const http = isHttp ? brokeredHttpSummary(request.input) : null;
  const cli = isHttp ? null : trustedCliSummary(request.input);
  const scopes = secretGrantScopes(request.tool);
  const aliases = http
    ? [http.secretAlias]
    : (cli?.secrets.map((secret) => secret.secretAlias) ?? []);
  const source = request.secretSource;
  const destination = http?.host ?? cli?.executable.split('/').pop();
  const detailsLabel = isHttp ? 'View request' : 'View command';
  const transfer = http?.auth.kind === 'jwt' ? 'Signed JWT' : 'For authentication';
  return (
    <Card stacked attention={pending}>
      <View
        style={styles.heading}
        accessibilityRole={pending ? 'alert' : undefined}
        accessibilityLabel={
          pending ? `Approval required for ${isHttp ? 'an HTTP request' : 'a command'}` : undefined
        }
      >
        <View style={styles.title}>
          <Icon
            name={
              pending
                ? 'shield'
                : decision === 'denied' || decision === 'save_failed'
                  ? 'x-circle'
                  : 'check-circle'
            }
            color={
              pending || decision === 'denied' || decision === 'save_failed'
                ? theme.colors.attention
                : theme.colors.success
            }
          />
          <Text variant="bodySmall" style={styles.emphasis}>
            {isHttp ? 'HTTP request' : 'Command'}
          </Text>
        </View>
        <View style={styles.status}>
          <StatusTag
            intent={
              pending || decision === 'denied' || decision === 'save_failed'
                ? 'needsSetup'
                : 'ready'
            }
            label={pending ? 'Approval required' : labels[decision]}
          />
        </View>
      </View>
      {destination === undefined ? (
        <>
          {source ? (
            <Text variant="footnote" tone="muted" selectable>
              {spellOutBidiControls(dopplerSourceLabel(source))}
            </Text>
          ) : null}
          <PermissionRequestDetails input={request.input} />
        </>
      ) : (
        <View style={styles.flow}>
          <View style={styles.flowNode}>
            <View style={styles.tile}>
              <Icon name="key" size={18} color={theme.colors.text} />
            </View>
            <View style={styles.nodeText}>
              <Text variant="bodySmall" style={styles.emphasis} selectable numberOfLines={2}>
                {spellOutBidiControls(aliases.join(', '))}
              </Text>
              <Text variant="footnote" tone="muted" selectable numberOfLines={2}>
                {source && !pending ? spellOutBidiControls(dopplerSourceLabel(source)) : 'Doppler'}
              </Text>
            </View>
          </View>
          <Icon name="arrow-right" color={theme.colors.textMuted} />
          <View style={styles.flowNode}>
            <View style={styles.tile}>
              <Icon name={isHttp ? 'globe' : 'terminal'} size={18} color={theme.colors.text} />
            </View>
            <View style={styles.nodeText}>
              <Text
                variant={isHttp ? 'bodySmall' : 'code'}
                style={isHttp ? styles.emphasis : styles.compactCode}
                selectable
                numberOfLines={2}
              >
                {spellOutBidiControls(destination)}
              </Text>
              {http ? (
                <Text variant="footnote" tone="muted" selectable numberOfLines={2}>
                  {transfer}
                </Text>
              ) : null}
            </View>
          </View>
        </View>
      )}
      {destination !== undefined ? (
        <View style={styles.details}>
          {pending ? null : (
            <Button
              label={expanded ? 'Hide details' : detailsLabel}
              variant="text"
              size="small"
              icon={expanded ? 'chevron-up' : 'chevron-down'}
              onPress={() => setExpanded(!expanded)}
            />
          )}
          {expanded || pending ? (
            <ScrollView
              nestedScrollEnabled
              style={styles.detailScroll}
              contentContainerStyle={styles.detailContent}
            >
              {http ? (
                <>
                  <Text variant="code" style={styles.compactCode} selectable>
                    {http.method} {http.host}
                    {http.path}
                  </Text>
                  {http.body !== null ? (
                    <Text variant="code" style={styles.compactCode} selectable>
                      {spellOutBidiControls(http.body)}
                    </Text>
                  ) : null}
                  <Text variant="subtitle" tone="default" selectable>
                    {brokeredAuthSentence(http)}
                  </Text>
                </>
              ) : cli ? (
                <>
                  <Text variant="code" style={styles.compactCode} selectable>
                    {trustedCliCommandLine(cli)}
                  </Text>
                  <Text variant="subtitle" tone="default" selectable>
                    {spellOutBidiControls(trustedCliInjectionSummary(cli))}
                  </Text>
                  {cli.entryScript ? (
                    <Text variant="subtitle" tone="default" selectable>
                      {spellOutBidiControls(
                        `Entry script: ${cli.entryScript.path} (SHA-256 ${cli.entryScript.sha256}, ${cli.entryScript.loading} loading)`,
                      )}
                    </Text>
                  ) : null}
                </>
              ) : null}
              {source ? (
                <Text variant="footnote" tone="muted" selectable>
                  {spellOutBidiControls(dopplerSourceLabel(source))}
                </Text>
              ) : null}
            </ScrollView>
          ) : null}
        </View>
      ) : null}
      {pending && cli ? (
        <Text variant="subtitle" tone="muted">
          The command can read and share the full secret.
        </Text>
      ) : null}
      {actions ? (
        <>
          <View style={styles.actions}>
            <Button
              label="Deny"
              variant="secondary"
              size="small"
              icon="x"
              disabled={actions.disabled}
              onPress={actions.deny}
            />
            <Button
              label="Allow once"
              size="small"
              icon="check"
              disabled={actions.disabled}
              loading={actions.deciding}
              onPress={() => actions.allow()}
            />
          </View>
          {scopes.length > 0 ? (
            <View style={styles.actions}>
              {scopes.includes('session') ? (
                <Button
                  label="Allow this session"
                  variant="secondary"
                  size="small"
                  disabled={actions.disabled}
                  onPress={() => actions.allow('session')}
                />
              ) : null}
              {scopes.includes('project') ? (
                <Button
                  label="Allow in project for 30 days"
                  variant="secondary"
                  size="small"
                  disabled={actions.disabled}
                  onPress={() => actions.allow('project')}
                />
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
      {pending && !cli ? (
        <View style={styles.note}>
          <Icon name="shield" size={14} color={theme.colors.textMuted} />
          <Text variant="footnote" tone="muted" style={styles.noteText}>
            Verity does not pass the secret value to the agent.
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
  },
  title: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  emphasis: { fontFamily: theme.fonts.semibold },
  compactCode: {
    fontSize: theme.typography.subtitle.fontSize,
    lineHeight: theme.typography.subtitle.lineHeight,
  },
  status: { marginLeft: 'auto' },
  flow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  flowNode: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    flex: 1,
    minWidth: 120,
  },
  tile: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.tile,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background,
  },
  nodeText: { flex: 1, minWidth: 0, gap: theme.spacing.xxs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  details: { alignItems: 'flex-start', gap: theme.spacing.sm },
  detailScroll: { alignSelf: 'stretch', maxHeight: 220 },
  detailContent: { gap: theme.spacing.sm },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.xs },
  noteText: { flexShrink: 1 },
}));
