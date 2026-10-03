import { z } from 'zod';
import { ALLOWED_PERMISSION_MODES } from '@verity/session';

// Fields shared by the turns route and the spawn route. The prompt-content rule
// differs (a steering turn may be attachments-only; a spawn needs real text), so
// `prompt`/`attachments` are added per-route rather than here.
export const turnCore = {
  permissionMode: z.enum(ALLOWED_PERMISSION_MODES).optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  // Per-turn tool allow/deny lists (names or scoped patterns, e.g. `Bash(git *)`).
  allowedTools: z.array(z.string().min(1)).optional(),
  disallowedTools: z.array(z.string().min(1)).optional(),
};
