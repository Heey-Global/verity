import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  Button,
  Group,
  HintBox,
  IconButton,
  OptionList,
  Row,
  SectionHeader,
  Sheet,
  StatusTag,
  TextField,
} from '../../components/ui';

const idle = () => undefined;

export function ProjectDopplerReview({
  administrator = false,
  children,
}: {
  administrator?: boolean;
  children?: ReactNode;
}) {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <SectionHeader title="Doppler bindings" />
      <Group>
        <Row
          title="portal/prd"
          subtitle="Platform"
          leading={{ icon: 'layers' }}
          tag={<StatusTag intent="ready" label="Default" />}
          trailing={administrator ? <ManageBinding label="portal/prd" /> : undefined}
        />
        <Row
          title="billing/dev"
          subtitle="Payments"
          leading={{ icon: 'layers' }}
          trailing={administrator ? <ManageBinding label="billing/dev" /> : undefined}
        />
      </Group>
      {administrator ? (
        <Button label="Add binding" icon="plus" variant="secondary" onPress={idle} />
      ) : null}
      <SectionHeader title="Your Doppler tokens" />
      <Group>
        <Row
          title="Platform"
          subtitle={administrator ? 'Using instance token' : 'Your token connected'}
          leading={{ icon: 'key' }}
          onPress={idle}
          navigates
        />
        <Row
          title="Payments"
          subtitle="Connect your token"
          leading={{ icon: 'key' }}
          onPress={idle}
          navigates
        />
      </Group>
      {children}
    </ScrollView>
  );
}

function ManageBinding({ label }: { label: string }) {
  return (
    <IconButton icon="more-horizontal" accessibilityLabel={`Manage ${label}`} onPress={idle} />
  );
}

export function PersonalTokenReview() {
  return (
    <ProjectDopplerReview>
      <Sheet
        visible
        title="Your Platform token"
        onClose={idle}
        footer={
          <View style={styles.fields}>
            <Button label="Validate and replace" fullWidth onPress={idle} />
            <Button label="Disconnect token" variant="destructive" fullWidth onPress={idle} />
          </View>
        }
      >
        <View style={styles.fields}>
          <TextField
            label="New Doppler token"
            value=""
            placeholder="Paste a token"
            onChangeText={idle}
            secret
            literal
          />
          <HintBox
            title="Disconnecting affects your sessions"
            message="Your sessions will lose access to portal/prd until you connect another token."
          />
        </View>
      </Sheet>
    </ProjectDopplerReview>
  );
}

export function BindingErrorReview({ configs = false }: { configs?: boolean }) {
  return (
    <ProjectDopplerReview administrator>
      <Sheet
        visible
        title="Add Doppler binding"
        onClose={idle}
        footer={<Button label="Retry" fullWidth onPress={idle} />}
      >
        <View style={styles.fields}>
          <SectionHeader title="Connection" />
          <OptionList
            options={['Platform', 'Payments']}
            selected="Payments"
            onSelect={idle}
            accessibilityLabel="Doppler connection"
          />
          {configs ? (
            <>
              <SectionHeader title="Doppler project" />
              <OptionList
                options={['billing']}
                selected="billing"
                onSelect={idle}
                accessibilityLabel="Doppler project"
              />
            </>
          ) : null}
          <HintBox
            title={configs ? 'Could not load Doppler configs' : 'Could not load Doppler projects'}
            message={
              configs
                ? 'Retry loading configs for billing.'
                : 'Retry loading projects from Payments.'
            }
          />
        </View>
      </Sheet>
    </ProjectDopplerReview>
  );
}

export function LockedDopplerReview() {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <HintBox
        title="Secret store is locked"
        message="Unlock the secret store to add a connection or change a token."
      >
        <Button label="Unlock secret store" variant="secondary" onPress={idle} />
      </HintBox>
      <SectionHeader title="Connections" />
      <Group>
        <Row title="Platform" subtitle="Northstar · 2 projects" leading={{ icon: 'link' }} />
      </Group>
      <Button label="Add connection" icon="plus" variant="secondary" disabled onPress={idle} />
    </ScrollView>
  );
}

export function OnboardingDopplerReview() {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <SectionHeader title="Connectors" />
      <Group>
        <Row
          title="Doppler"
          subtitle="1 connection"
          leading={{ icon: 'key' }}
          tag={<StatusTag intent="ready" label="Connected" />}
          navigates
          onPress={idle}
        />
      </Group>
      <Button label="Continue" onPress={idle} />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { padding: theme.spacing.lg, gap: theme.spacing.md },
  fields: { gap: theme.spacing.md },
}));
