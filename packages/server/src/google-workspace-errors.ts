/** Preserve Google's machine-readable error code without exposing response details. */
export function googleWorkspaceHttpReason(status: number, payload: unknown): string {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  const error = record(record(payload)?.error);
  const details = Array.isArray(error?.details) ? error.details : [];
  const info = details
    .map(record)
    .find(
      (detail) =>
        detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
        typeof detail.reason === 'string',
    );
  const errors = Array.isArray(error?.errors) ? error.errors : [];
  const classic = record(errors[0])?.reason;
  const raw = info?.reason ?? (typeof classic === 'string' ? classic : error?.status);
  const slug = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) : '';
  return `http_${String(status)}${slug.length > 0 ? `_${slug}` : ''}`;
}

export function workspaceAssignmentError(
  reason: string,
  target: 'Workspace' | 'presentation',
): { status: number; error: string } {
  if (
    reason === 'http_403_insufficientPermissions' ||
    reason === 'http_403_ACCESSTOKENSCOPEINSUFFICIENT'
  ) {
    return { status: 403, error: `Reconnect Google Drive to grant ${target} editing access` };
  }
  if (reason === 'http_403_accessNotConfigured' || reason === 'http_403_SERVICEDISABLED') {
    return {
      status: 403,
      error:
        'Enable the required Google Workspace API (Docs, Sheets, or Slides) in the Google Cloud project that owns the OAuth client. Reconnecting Google Drive will not enable it.',
    };
  }
  if (reason.startsWith('http_403')) {
    return {
      status: 403,
      error: `Google denied access to this ${target} file (${reason}). Check file permissions and your Google Workspace administrator's access policies.`,
    };
  }
  return {
    status: reason.startsWith('http_400') ? 415 : 502,
    error: `Could not assign this Google ${target} file (${reason})`,
  };
}
