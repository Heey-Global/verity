// An invitation to share: its QR code and link, who it is for, its right and
// how long it can be used, and revoking it. The link is completed here with the
// TLS pin this app verified when it paired (Uplink team contract D5).
import type { InvitationLinkFields, TeamInvitation, VerityClient } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Share, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useUnistyles } from 'react-native-unistyles';

import { SettingsMessage, SettingsScaffold } from '../../../../components/settings/SettingsChrome';
import { settingsStyles } from '../../../../components/settings/settingsStyles';
import {
  Button,
  Group,
  IconButton,
  Row,
  SectionHeader,
  StatusTag,
  useConfirm,
} from '../../../../components/ui';
import { createVerityClient } from '../../../../lib/client';
import { getServerProfile } from '../../../../lib/serverProfile';
import { invitationLink } from '../../../../lib/teamInvitationLink';
import { projectIdParam } from '../../../../lib/useProjectDetail';

const POLL_MS = 3_000;

export default function InvitationScreen() {
  const { id, invitationId } = useLocalSearchParams<{
    id: string | string[];
    invitationId?: string;
  }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0 || typeof invitationId !== 'string') {
    return (
      <SettingsMessage
        title="Invitation unavailable"
        subtitle="Open it again from the project's team."
        screenTitle="Invitation"
      />
    );
  }
  return <InvitationView client={client} projectId={projectId} invitationId={invitationId} />;
}

export function InvitationView({
  client,
  projectId,
  invitationId,
  onDone = () => router.back(),
}: {
  client: VerityClient;
  projectId: string;
  invitationId: string;
  onDone?: () => void;
}) {
  const { theme } = useUnistyles();
  const [invitation, setInvitation] = useState<TeamInvitation | null>(null);
  const [fields, setFields] = useState<InvitationLinkFields | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [confirm, confirmSheet] = useConfirm();

  const load = useCallback(() => {
    client
      .getProjectInvitation(projectId, invitationId)
      .then((answer) => {
        setInvitation(answer.invitation);
        setFields(answer.linkFields);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not load the invitation'),
      );
  }, [client, projectId, invitationId]);
  useEffect(load, [load]);
  // Uplink creates the invitation in the background; until then there is no link.
  useEffect(() => {
    if (fields !== null || invitation?.state === 'expired' || invitation?.state === 'failed')
      return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [fields, invitation?.state, load]);

  const link = fields === null ? undefined : invitationLink(fields, getServerProfile());
  const revoke = () =>
    confirm({
      title: 'Revoke this invitation?',
      message: 'The link stops working at once.',
      confirmLabel: 'Revoke',
      destructive: true,
      onConfirm: async () => {
        await client.revokeProjectInvitation(projectId, invitationId);
        onDone();
      },
    });

  const name = invitation?.inviteeName ?? '';
  return (
    <SettingsScaffold
      title="Invitation"
      detail
      state={{ error, saving: false }}
      footer={
        <>
          <Button
            label="Send invitation"
            icon="share"
            disabled={link === undefined}
            onPress={() => void Share.share({ message: link ?? '' }).catch(() => undefined)}
            fullWidth
          />
          <Button label="Revoke invitation" variant="text" onPress={revoke} fullWidth />
        </>
      }
    >
      {name ? <SectionHeader title={`Send to ${name}`} variant="eyebrow" /> : null}
      {link === undefined ? (
        <Group>
          <Row
            leading={{ element: <ActivityIndicator color={theme.colors.action} /> }}
            title={fields === null ? 'Preparing the link…' : 'This phone cannot complete the link'}
            subtitle={
              fields === null
                ? 'It appears once the invitation is registered'
                : 'Open it on a device paired directly with this server'
            }
          />
        </Group>
      ) : (
        <>
          <View style={settingsStyles.qrFrame}>
            <QRCode value={link} size={200} backgroundColor="#ffffff" color="#000000" />
          </View>
          <Group>
            <Row
              leading={{ icon: 'link', quiet: true }}
              title="Invitation link"
              subtitle={copied ? 'Copied' : 'verity.build/join#…'}
              trailing={
                <IconButton
                  icon={copied ? 'check' : 'copy'}
                  accessibilityLabel="Copy invitation link"
                  onPress={() => {
                    void Clipboard.setStringAsync(link).then(() => setCopied(true));
                  }}
                />
              }
            />
          </Group>
        </>
      )}
      {invitation === null ? null : (
        <Group>
          <Row
            leading={{ icon: 'mail', quiet: true }}
            title={`Invitation for ${invitation.inviteeName}`}
            trailing={
              <StatusTag
                intent={invitation.state === 'expired' ? 'needsSetup' : 'optional'}
                label={invitation.state === 'expired' ? 'Expired' : 'Open'}
              />
            }
          />
          <Row
            leading={{ icon: 'user-check', quiet: true }}
            title={invitation.canExecute ? 'Can edit' : 'Can read'}
          />
          <Row
            leading={{ icon: 'clock', quiet: true }}
            title={`Valid until ${new Date(invitation.expiresAt).toLocaleString(undefined, {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}`}
            subtitle="Can be used once"
          />
        </Group>
      )}
      {confirmSheet}
    </SettingsScaffold>
  );
}
