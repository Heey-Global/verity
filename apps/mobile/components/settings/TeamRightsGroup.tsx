// A project member's rights as check marks, several at once (ADR 0023 §1).
// Reading comes with membership and has no row. Checking a right also checks
// what it needs and unchecking one clears what builds on it (toggleTeamRight),
// so the list never shows a combination the server refuses.
import { toggleTeamRight, type TeamRights } from '@verity/mobile';

import { Group, Row } from '../ui';

export function TeamRightsGroup({
  rights,
  onChange,
  code = true,
  manage = false,
  disabled = false,
}: {
  rights: TeamRights;
  onChange: (rights: TeamRights) => void;
  /** False against a server that predates the Code right. */
  code?: boolean;
  /** Invitations never grant managing, so only an existing member offers it. */
  manage?: boolean;
  disabled?: boolean;
}) {
  return (
    <Group>
      <Row
        selected={rights.canExecute}
        multiple
        title="Can edit"
        subtitle="Sends messages with their own AI account"
        disabled={disabled}
        onPress={() => onChange(toggleTeamRight(rights, 'execute'))}
      />
      {code ? (
        <Row
          selected={rights.canCode}
          multiple
          title="Can work with code"
          subtitle="Sees branches, files and pull requests; adds changes to the project"
          disabled={disabled}
          onPress={() => onChange(toggleTeamRight(rights, 'code'))}
        />
      ) : null}
      {manage ? (
        <Row
          selected={rights.canManage}
          multiple
          title="Can manage"
          subtitle={
            code
              ? 'Invites people and changes their rights; includes all rights'
              : 'Also invites people and changes their rights'
          }
          disabled={disabled}
          onPress={() => onChange(toggleTeamRight(rights, 'manage'))}
        />
      ) : null}
    </Group>
  );
}
