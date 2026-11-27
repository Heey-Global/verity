import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  Button,
  Group,
  HintBox,
  IconButton,
  Row,
  SectionHeader,
  Sheet,
  StatusTag,
  Text,
  TextField,
} from '../../components/ui';

const idle = () => undefined;
const connections = [
  { label: 'Platform', workplace: 'Northstar', usage: '2 projects' },
  { label: 'Payments', workplace: 'Northstar Finance', usage: '1 project' },
  { label: 'Sandbox', workplace: 'Northstar Labs', usage: '0 projects' },
];

function Page({ children }: { children: ReactNode }) {
  return <ScrollView contentContainerStyle={styles.page}>{children}</ScrollView>;
}

export function Connections({ count, sheet }: { count: number; sheet?: ReactNode }) {
  return (
    <Page>
      <SectionHeader title="Connections" />
      {count === 0 ? (
        <Group>
          <Row title="No Doppler connections" leading={{ icon: 'link' }} />
        </Group>
      ) : (
        <Group>
          {connections.slice(0, count).map(({ label, workplace, usage }) => (
            <Row
              key={label}
              title={label}
              subtitle={`${workplace} · ${usage}`}
              leading={{ icon: 'link' }}
              trailing={
                <IconButton
                  icon="more-horizontal"
                  accessibilityLabel={`Manage ${label}`}
                  onPress={idle}
                />
              }
            />
          ))}
        </Group>
      )}
      <Button label="Add connection" icon="plus" variant="secondary" onPress={idle} />
      {sheet}
    </Page>
  );
}

export function AddConnection() {
  return (
    <Connections
      count={1}
      sheet={
        <Sheet
          visible
          title="Add Doppler connection"
          onClose={idle}
          footer={<Button label="Validate and add" fullWidth onPress={idle} />}
        >
          <View style={styles.fields}>
            <TextField label="Connection label" value="Payments" onChangeText={idle} />
            <TextField
              label="Doppler token"
              value="mockup-placeholder"
              onChangeText={idle}
              secret
              literal
            />
            <Text variant="body" tone="muted">
              Verity checks the token and identifies its Doppler workplace before saving.
            </Text>
          </View>
        </Sheet>
      }
    />
  );
}

export function DeleteConnection() {
  return (
    <Connections
      count={3}
      sheet={
        <Sheet
          visible
          title="Delete Platform?"
          onClose={idle}
          footer={
            <View style={styles.fields}>
              <Button label="Delete connection" variant="destructive" fullWidth onPress={idle} />
              <Button label="Cancel" variant="text" fullWidth onPress={idle} />
            </View>
          }
        >
          <View style={styles.fields}>
            <HintBox
              title="Connection in use"
              message="Deleting Platform removes the bindings below from their Verity projects."
            />
            <SectionHeader title="Affected projects" />
            <Group>
              <Row title="Customer Portal" subtitle="portal/prd, portal/stg" wrap />
              <Row title="Release Tools" subtitle="release/dev" />
            </Group>
          </View>
        </Sheet>
      }
    />
  );
}

const bindings = [
  { prefix: 'portal/prd', connection: 'Platform', isDefault: true, hasToken: true },
  { prefix: 'portal/stg', connection: 'Platform', isDefault: false, hasToken: true },
  { prefix: 'billing/dev', connection: 'Payments', isDefault: false, hasToken: false },
];

export function Bindings({ sheet, personal = false }: { sheet?: ReactNode; personal?: boolean }) {
  return (
    <Page>
      {personal ? (
        <HintBox
          title="Your Doppler token is missing"
          message="Your sessions cannot read secrets from billing/dev until you connect your own token for Payments."
        >
          <Button label="Connect token for Payments" icon="key" onPress={idle} />
        </HintBox>
      ) : null}
      <SectionHeader title="Doppler bindings" />
      <Group>
        {bindings.map(({ prefix, connection, isDefault, hasToken }) => (
          <Row
            key={prefix}
            title={prefix}
            subtitle={
              personal
                ? `${connection} · ${hasToken ? 'Your token connected' : 'Your token missing'}`
                : connection
            }
            leading={{ icon: 'layers' }}
            tag={isDefault ? <StatusTag intent="ready" label="Default" /> : undefined}
            trailing={
              <IconButton
                icon="more-horizontal"
                accessibilityLabel={`Manage ${prefix}`}
                onPress={idle}
              />
            }
          />
        ))}
      </Group>
      <Button label="Add binding" icon="plus" variant="secondary" onPress={idle} />
      {sheet}
    </Page>
  );
}

export function AddBinding() {
  return (
    <Bindings
      sheet={
        <Sheet
          visible
          title="Add Doppler binding"
          onClose={idle}
          footer={<Button label="Add binding" fullWidth onPress={idle} />}
        >
          <View style={styles.fields}>
            <Group>
              <Row title="Connection" subtitle="Payments" navigates onPress={idle} />
              <Row title="Doppler project" subtitle="billing" navigates onPress={idle} />
              <Row title="Config" subtitle="prd" navigates onPress={idle} />
            </Group>
            <Text variant="body" tone="muted">
              Agents write secrets as billing/prd/API_KEY
            </Text>
          </View>
        </Sheet>
      }
    />
  );
}

export function ConnectionMenu() {
  return (
    <Connections
      count={3}
      sheet={
        <Sheet
          visible
          title="Platform"
          onClose={idle}
          footer={
            <Button label="Delete connection" variant="destructive" fullWidth onPress={idle} />
          }
        >
          <View style={styles.fields}>
            <Text variant="body" tone="muted">
              Northstar workplace · used by 2 projects
            </Text>
            <Group>
              <Row title="Rename" leading={{ icon: 'edit-2' }} navigates onPress={idle} />
              <Row
                title="Replace token"
                subtitle="Verity checks the new token before saving"
                leading={{ icon: 'refresh-cw' }}
                navigates
                onPress={idle}
              />
            </Group>
          </View>
        </Sheet>
      }
    />
  );
}

export function BindingMenu() {
  return (
    <Bindings
      sheet={
        <Sheet
          visible
          title="portal/stg"
          onClose={idle}
          footer={<Button label="Remove binding" variant="destructive" fullWidth onPress={idle} />}
        >
          <View style={styles.fields}>
            <Text variant="body" tone="muted">
              Platform · Doppler project portal · config stg
            </Text>
            <Group>
              <Row
                title="Set as default"
                subtitle="Agents then write API_KEY instead of portal/stg/API_KEY"
                leading={{ icon: 'star' }}
                wrap
                onPress={idle}
              />
            </Group>
          </View>
        </Sheet>
      }
    />
  );
}

export function ConnectToken() {
  return (
    <Bindings
      personal
      sheet={
        <Sheet
          visible
          title="Your token for Payments"
          onClose={idle}
          footer={<Button label="Validate and connect" fullWidth onPress={idle} />}
        >
          <View style={styles.fields}>
            <TextField
              label="Your Doppler token"
              value="mockup-placeholder"
              onChangeText={idle}
              secret
              literal
            />
            <Text variant="body" tone="muted">
              Only your own sessions use this token. Verity checks that it can read billing/dev
              before saving.
            </Text>
          </View>
        </Sheet>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  fields: { gap: theme.spacing.md },
}));
