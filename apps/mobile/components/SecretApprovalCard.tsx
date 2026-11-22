import type { AgentEvent } from '@verity/events';
import {
  brokeredAuthSentence,
  brokeredHttpSummary,
  secretGrantScopes,
  spellOutBidiControls,
  trustedCliCommandLine,
  trustedCliRiskSentence,
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
  const destination = http?.host ?? (cli ? trustedCliCommandLine(cli) : undefined);
  const detailsLabel = isHttp ? 'View request' : 'View command';
  const firstSecret = cli?.secrets[0];
  const transfer = http
    ? http.auth.kind === 'jwt'
      ? 'Signed JWT'
      : 'For authentication'
    : cli?.secrets.length === 1 && firstSecret
      ? firstSecret.injection === 'file'
        ? `File via ${firstSecret.env}`
        : `As ${firstSecret.env}`
      : 'Secret injection';
  return (
    <Card stacked attention={pending}>
      <View style={styles.heading}>
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
          <Text variant="row">{isHttp ? 'HTTP request' : 'Command'}</Text>
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
        <PermissionRequestDetails input={request.input} />
      ) : (
        <View style={styles.flow}>
          <View style={styles.flowNode}>
            <View style={styles.tile}>
              <Icon name="key" size={18} color={theme.colors.text} />
            </View>
            <View style={styles.nodeText}>
              <Text variant="row" selectable numberOfLines={2}>
                {spellOutBidiControls(aliases.join(', '))}
              </Text>
              <Text variant="bodySmall" tone="muted" selectable numberOfLines={2}>
                {source
                  ? spellOutBidiControls(`Doppler · ${source.project} / ${source.config}`)
                  : 'Doppler'}
              </Text>
            </View>
          </View>
          <Icon name="arrow-right" color={theme.colors.textMuted} />
          <View style={styles.flowNode}>
            <View style={styles.tile}>
              <Icon name={isHttp ? 'globe' : 'terminal'} size={18} color={theme.colors.text} />
            </View>
            <View style={styles.nodeText}>
              <Text variant={isHttp ? 'row' : 'code'} selectable numberOfLines={2}>
                {destination}
              </Text>
              <Text variant="bodySmall" tone="muted" selectable numberOfLines={2}>
                {spellOutBidiControls(transfer)}
              </Text>
            </View>
          </View>
        </View>
      )}
      {destination !== undefined ? (
        <View style={styles.details}>
          {pending && http ? null : (
            <Button
              label={expanded ? 'Hide details' : detailsLabel}
              variant="text"
              size="compact"
              icon={expanded ? 'chevron-up' : 'chevron-down'}
              onPress={() => setExpanded(!expanded)}
            />
          )}
          {expanded || (pending && http) ? (
            <ScrollView
              nestedScrollEnabled
              style={styles.detailScroll}
              contentContainerStyle={styles.detailContent}
            >
              {http ? (
                <>
                  <Text variant="code" selectable>
                    {http.method} {http.host}
                    {http.path}
                  </Text>
                  {http.body !== null ? (
                    <Text variant="code" selectable>
                      {spellOutBidiControls(http.body)}
                    </Text>
                  ) : null}
                  <Text variant="bodySmall" selectable>
                    {brokeredAuthSentence(http)}
                  </Text>
                </>
              ) : cli ? (
                <>
                  <Text variant="code" selectable>
                    {trustedCliCommandLine(cli)}
                  </Text>
                  <Text variant="bodySmall" selectable>
                    {spellOutBidiControls(trustedCliRiskSentence(cli))}
                  </Text>
                </>
              ) : null}
              {source ? (
                <Text variant="bodySmall" tone="muted" selectable>
                  {spellOutBidiControls(`Doppler · ${source.project} / ${source.config}`)}
                </Text>
              ) : null}
            </ScrollView>
          ) : null}
        </View>
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
      {pending ? (
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
