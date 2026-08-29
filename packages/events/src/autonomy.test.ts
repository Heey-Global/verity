import { describe, expect, it } from 'vitest';
import { AUTONOMY_RESUME_SYSTEM_PROMPT, AUTONOMY_SYSTEM_PROMPT } from './autonomy.js';

describe('AUTONOMY_SYSTEM_PROMPT', () => {
  it('makes implementation and verification part of a problem-solving request', () => {
    expect(AUTONOMY_SYSTEM_PROMPT).toContain('intermediate result, not completion');
    expect(AUTONOMY_SYSTEM_PROMPT).toContain('implementation and proportionate verification');
    expect(AUTONOMY_SYSTEM_PROMPT).toContain('requested outcome is actually achieved and verified');
  });

  it('distinguishes autonomous fixes from consequential decisions', () => {
    expect(AUTONOMY_SYSTEM_PROMPT).toContain('small, low-risk changes');
    expect(AUTONOMY_SYSTEM_PROMPT).toContain('multiple viable approaches differ meaningfully');
    expect(AUTONOMY_SYSTEM_PROMPT).toContain(
      'present the concrete alternatives as Verity Quick Actions',
    );
  });

  it('does not let questions become a premature stopping point', () => {
    expect(AUTONOMY_SYSTEM_PROMPT).toContain('do not re-request permission already granted');
    expect(AUTONOMY_SYSTEM_PROMPT).toContain('authorization to execute that approach');
  });

  it('keeps the outcome and choice semantics in the compact resume directive', () => {
    expect(AUTONOMY_RESUME_SYSTEM_PROMPT).toContain('diagnosis is not completion');
    expect(AUTONOMY_RESUME_SYSTEM_PROMPT).toContain('Verity Quick Actions');
    expect(AUTONOMY_RESUME_SYSTEM_PROMPT).toContain('without asking again');
    expect(AUTONOMY_RESUME_SYSTEM_PROMPT.length).toBeLessThan(650);
  });
});
