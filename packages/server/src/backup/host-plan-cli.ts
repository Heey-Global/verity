import { readBackupHostPlan } from './host-plan.js';

// This command emits paths and a capability version only, never credentials.
void readBackupHostPlan(
  process.env.VERITY_STATE_DIR ?? '/etc/verity',
  process.env.VERITY_BACKUP_IDENTITY_DIR,
)
  .then((plan) => process.stdout.write(JSON.stringify(plan)))
  .catch(() => {
    process.stderr.write('Backup host state is unsafe or unavailable\n');
    process.exitCode = 1;
  });
