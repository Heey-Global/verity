import { describe, expect, it } from 'vitest';
import { remoteDataUrlForControl } from './remote-control-connector.js';
import { UPLINK_CONTROL_URL } from './uplink-control-client.js';
import { uplinkDiagnosticEndpoint } from './uplink-diagnostic-endpoint.js';

describe('uplinkDiagnosticEndpoint', () => {
  it('keeps the standard endpoint when diagnostics are absent', () => {
    expect(uplinkDiagnosticEndpoint({})).toEqual({ uplinkUrl: UPLINK_CONTROL_URL });
  });

  it('keeps control and DATA on the selected secure origin', () => {
    const selected = uplinkDiagnosticEndpoint({
      VERITY_DIAGNOSTIC_UPLINK_ORIGIN: 'https://diagnostic.example:8443',
      VERITY_DIAGNOSTIC_UPLINK_INSTALLATION_ID: 'existing-installation',
    });
    expect(selected.expectedInstallationId).toBe('existing-installation');
    expect(selected.uplinkUrl).toBe('wss://diagnostic.example:8443/control');
    expect(remoteDataUrlForControl(selected.uplinkUrl)).toBe('wss://diagnostic.example:8443/data');
  });

  it.each([
    'http://diagnostic.example',
    'wss://diagnostic.example',
    'https://user:secret@diagnostic.example',
    'https://diagnostic.example/data',
    'https://diagnostic.example/?ticket=secret',
    'https://diagnostic.example/#fragment',
    'not a URL',
    '',
  ])('rejects unsafe or ambiguous origins without echoing them: %s', (origin) => {
    expect(() =>
      uplinkDiagnosticEndpoint({
        VERITY_DIAGNOSTIC_UPLINK_ORIGIN: origin,
        VERITY_DIAGNOSTIC_UPLINK_INSTALLATION_ID: 'existing-installation',
      }),
    ).toThrow(/diagnostic Uplink requires/u);
  });

  it.each([
    { VERITY_DIAGNOSTIC_UPLINK_ORIGIN: 'https://diagnostic.example' },
    { VERITY_DIAGNOSTIC_UPLINK_INSTALLATION_ID: 'existing-installation' },
    {
      VERITY_DIAGNOSTIC_UPLINK_ORIGIN: 'https://diagnostic.example',
      VERITY_DIAGNOSTIC_UPLINK_INSTALLATION_ID: ' ',
    },
  ])('requires both diagnostic settings', (env) => {
    expect(() => uplinkDiagnosticEndpoint(env)).toThrow('existing installation ID');
  });
});
