import { describe, expect, it } from 'vitest';
import { VERITY_CONTROL_SYSTEM_PROMPT } from './server.js';

const SANDBOX_USER = '00000000-0000-4000-8000-000000000001';

// The control-plane system prompt is a set of claims about a deployment the agent cannot
// inspect. It promised server-provided git and GitHub credentials — true only while
// control-plane turns ran in-process on the Server host. In the sealed-runner deployment the
// token mint refuses a `control_plane` project outright, no gh-token capability is mounted,
// and there is no `gh` binary, so the promise sent the agent down a path that cannot work and
// made the resulting failure look like a bug to hunt. Pin the corrections.
describe('VERITY_CONTROL_SYSTEM_PROMPT', () => {
  it('does not promise GitHub or git credentials it does not have', () => {
    expect(VERITY_CONTROL_SYSTEM_PROMPT).not.toContain('You do not need your own GitHub token');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).not.toMatch(/use the configured git and gh credentials/u);
    expect(VERITY_CONTROL_SYSTEM_PROMPT).not.toMatch(/push branches, and open pull requests/u);
  });

  it('states the three capabilities the sealed runner actually lacks', () => {
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('No GitHub credentials');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('No commit signing');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('No usable repository checkout');
    // Docker was the fourth until ADR 0006 Amendment 1 granted it. Assert its ABSENCE from
    // this list rather than just deleting the line: a prompt that still claimed
    // "No Docker daemon" while the socket was mounted would teach the session to
    // disbelieve the daemon it can actually reach, and would send it hunting for
    // workarounds to a boundary that is no longer there.
    expect(VERITY_CONTROL_SYSTEM_PROMPT).not.toContain('No Docker daemon');
  });

  /**
   * ADR 0006 Amendment 1. The grant is only half of what the prompt has to carry: the other
   * half is the operating rule, and the honesty about what backs it.
   *
   * The rule is diagnosis, not intervention — and nothing enforces it, because a
   * host-root-equivalent socket cannot be narrowed by a sentence. Saying so
   * plainly is the point. A prompt that stated the restriction as though the
   * system imposed it would be making the same false-security claim this change
   * removed from AGENTS.md, one layer down.
   */
  it('grants Docker for diagnosis and is honest that the limit is unenforced', () => {
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('/var/run/docker.sock');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toMatch(/diagnos/iu);
    // The specific interventions, not a vague "be careful".
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toMatch(/Do not use it to intervene/u);
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toMatch(/host-root-equivalent/u);
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toMatch(/convention you are expected to keep/u);
  });

  it('sends repo work to a project session instead of leaving the agent to improvise', () => {
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('repo work belongs in a project session');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('committing through the GitHub API');
  });

  it('keeps the standing rules that are still true', () => {
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('Never merge pull requests by yourself');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('Never print secret values');
  });
});
