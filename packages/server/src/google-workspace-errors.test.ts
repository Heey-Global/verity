import { describe, expect, it } from 'vitest';
import { googleWorkspaceHttpReason, workspaceAssignmentError } from './google-workspace-errors.js';
import { getDocsDocumentMetadata } from './google-docs.js';
import { getSheetsSpreadsheet } from './google-sheets.js';
import { getSlidesPresentation } from './google-slides.js';
import type { GoogleFetch } from './google-drive.js';

function denied(reason: string) {
  return {
    error: {
      status: 'PERMISSION_DENIED',
      message: 'private response detail',
      errors: [{ reason: 'forbidden' }],
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }],
    },
  };
}

describe('Workspace API failures', () => {
  it.each([
    ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'ACCESSTOKENSCOPEINSUFFICIENT'],
    ['SERVICE_DISABLED', 'SERVICEDISABLED'],
  ])('keeps structured %s instead of generic permission denial', (raw, slug) => {
    expect(googleWorkspaceHttpReason(403, denied(raw))).toBe(`http_403_${slug}`);
  });
  it('does not expose response messages or interpret unrelated detail types', () => {
    expect(
      googleWorkspaceHttpReason(403, {
        error: {
          status: 'PERMISSION_DENIED',
          message: 'private detail',
          details: [{ '@type': 'other', reason: 'SERVICE_DISABLED' }],
        },
      }),
    ).toBe('http_403_PERMISSIONDENIED');
    expect(googleWorkspaceHttpReason(403, null)).toBe('http_403');
  });
  it.each(['insufficientPermissions', 'ACCESSTOKENSCOPEINSUFFICIENT'])(
    'offers reconnect for explicit scope denial %s',
    (reason) => {
      expect(workspaceAssignmentError(`http_403_${reason}`, 'Workspace')).toEqual({
        status: 403,
        error: 'Reconnect Google Drive to grant Workspace editing access',
      });
    },
  );
  it.each(['accessNotConfigured', 'SERVICEDISABLED'])(
    'explains the Cloud configuration for %s',
    (reason) => {
      expect(workspaceAssignmentError(`http_403_${reason}`, 'Workspace')).toMatchObject({
        status: 403,
        error: expect.stringContaining('Google Cloud project'),
      });
    },
  );
  it.each(['http_403', 'http_403_PERMISSIONDENIED', 'http_403_forbidden'])(
    'does not send users into reconnect for %s',
    (reason) => {
      const result = workspaceAssignmentError(reason, 'presentation');
      expect(result.status).toBe(403);
      expect(result.error).toContain('Google denied access');
      expect(result.error).not.toContain('Reconnect');
    },
  );
  it.each([
    ['Docs', getDocsDocumentMetadata],
    ['Sheets', getSheetsSpreadsheet],
    ['Slides', getSlidesPresentation],
  ] as const)('%s preserves actionable error details through its transport', async (_name, get) => {
    const fetch: GoogleFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => denied('SERVICE_DISABLED'),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(get('token', 'file', { fetch })).rejects.toMatchObject({
      reason: 'http_403_SERVICEDISABLED',
    });
  });
});
