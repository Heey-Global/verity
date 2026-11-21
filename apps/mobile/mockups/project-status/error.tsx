import { Group, Row, SectionHeader, StatusTag } from '../../components/ui';
import { ProjectPageSample } from './parts';

const ignore = () => undefined;

/** The sandbox needs repair: red tile only; the reason waits under Needs you. */
export default function ErrorMockup() {
  return (
    <ProjectPageSample
      name="K8s"
      description="Cluster"
      project={{
        state: 'active',
        lifecycleState: 'failed',
        provisionError: 'Sandbox container stopped — Repair to restart it.',
      }}
      needsYou={
        <>
          <SectionHeader title="Needs you · 1" />
          <Group>
            <Row
              leading={{ icon: 'server', intent: 'needsSetup' }}
              title="Sandbox"
              subtitle="Sandbox container stopped — Repair to restart it."
              trailing={<StatusTag intent="needsSetup" label="Repair" />}
              navigates
              onPress={ignore}
            />
          </Group>
        </>
      }
    />
  );
}
