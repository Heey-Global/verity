import { Group, SectionHeader } from '../../components/ui';
import { QARoleRow, type QAState, Screen } from './parts';

const STATES: readonly { state: QAState; title: string }[] = [
  { state: 'needsYou', title: 'Decision pending' },
  { state: 'working', title: 'Working, nothing for you' },
  { state: 'clear', title: 'All sources fresh and green' },
  { state: 'access', title: 'A source is unreadable: no green' },
  { state: 'paused', title: 'Paused: no claim about state' },
  { state: 'off', title: 'Switched off in this project' },
];

/** Every state of the QA row in a project's Roles group. */
export default function RowStatesMockup() {
  return (
    <Screen>
      {STATES.map(({ state, title }) => [
        <SectionHeader key={`${state}-title`} title={title} />,
        <Group key={state}>
          <QARoleRow state={state} />
        </Group>,
      ])}
    </Screen>
  );
}
