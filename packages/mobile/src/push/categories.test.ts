import { describe, expect, it } from 'vitest';
import { PUSH_ACTION, PUSH_CATEGORY, PUSH_NOTIFICATION_CATEGORIES } from './categories.js';

describe('push categories', () => {
  it('names category ids exactly as the server fire points emit them', () => {
    // These strings are the contract with packages/server/src/push-fire-points.ts;
    // a rename on either side silently breaks category lookup on the device.
    expect(PUSH_CATEGORY.permissionPrompt).toBe('PERMISSION_PROMPT');
    expect(PUSH_CATEGORY.sessionStatus).toBe('SESSION_STATUS');
    expect(PUSH_CATEGORY.agentQuestion).toBe('AGENT_QUESTION');
    expect(PUSH_CATEGORY.pullRequestReady).toBe('PULL_REQUEST_READY');
  });

  it('registers the actionable categories but not the tap-only status one', () => {
    const ids = PUSH_NOTIFICATION_CATEGORIES.map((c) => c.identifier);
    expect(ids).toContain(PUSH_CATEGORY.permissionPrompt);
    expect(ids).toContain(PUSH_CATEGORY.agentQuestion);
    expect(ids).toContain(PUSH_CATEGORY.pullRequestReady);
    // SESSION_STATUS has no custom actions — a default tap is all it needs, so it is
    // deliberately not registered.
    expect(ids).not.toContain(PUSH_CATEGORY.sessionStatus);
  });

  it('requires device authentication before merging a pull request', () => {
    const ready = PUSH_NOTIFICATION_CATEGORIES.find(
      (c) => c.identifier === PUSH_CATEGORY.pullRequestReady,
    );
    const merge = ready?.actions.find((a) => a.identifier === PUSH_ACTION.mergePullRequest);
    const open = ready?.actions.find((a) => a.identifier === PUSH_ACTION.openSession);
    expect(merge?.authenticationRequired).toBe(true);
    expect(open?.authenticationRequired).toBeUndefined();
  });

  it('gates the destructive permission allow behind a device unlock', () => {
    const permission = PUSH_NOTIFICATION_CATEGORIES.find(
      (c) => c.identifier === PUSH_CATEGORY.permissionPrompt,
    );
    const allow = permission?.actions.find((a) => a.identifier === PUSH_ACTION.allow);
    const deny = permission?.actions.find((a) => a.identifier === PUSH_ACTION.deny);
    // Allow can approve a destructive tool call, so it must force an unlock (ADR 0008
    // lock-screen bypass); deny only stops work, so it stays a fast, unauthenticated
    // dismissal rendered destructive.
    expect(allow?.authenticationRequired).toBe(true);
    expect(deny?.authenticationRequired).toBeUndefined();
    expect(deny?.destructive).toBe(true);
  });

  it('declares the agent-question reply as a text-input action', () => {
    const question = PUSH_NOTIFICATION_CATEGORIES.find(
      (c) => c.identifier === PUSH_CATEGORY.agentQuestion,
    );
    const reply = question?.actions.find((a) => a.identifier === PUSH_ACTION.reply);
    expect(reply?.textInput?.submitButtonTitle).toBeTruthy();
    expect(reply?.textInput?.placeholder).toBeTruthy();
    // A free-text reply is not destructive and needs no unlock — it is the whole
    // point of an on-the-spot lock-screen quick reply.
    expect(reply?.authenticationRequired).toBeUndefined();
    expect(reply?.destructive).toBeUndefined();
  });

  it('keeps action ids app-owned and distinct (never carried in the payload)', () => {
    const values = Object.values(PUSH_ACTION);
    expect(new Set(values).size).toBe(values.length);
  });
});
