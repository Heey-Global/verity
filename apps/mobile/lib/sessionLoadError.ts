/** Turn transport diagnostics into a useful first-screen message without exposing request data. */
export function sessionLoadError(message: string): { summary: string; details: string } {
  const directFailed = /Direct Core request failed|direct Core requests? failed/u.test(message);
  const uplinkStage = message.match(/Uplink (routing|setup|admission|attachment|probe)/u)?.[1];
  const noDescriptor = message.includes('no remote descriptor saved');
  const nativeCode = message.match(/NSURLErrorDomain:-?\d+:[A-Z_]+/u)?.[0];
  const admissionCode = message.match(
    /Remote admission failed: (unavailable|rate_limited|limit_reached|protocol_unsupported|timeout|cancelled|internal)/u,
  )?.[1];
  const details = [
    uplinkStage ? `Uplink ${uplinkStage}` : null,
    noDescriptor ? 'No saved Remote Control route' : null,
    admissionCode ? `Admission: ${admissionCode}` : null,
    directFailed ? 'Direct Core request failed' : null,
    nativeCode,
  ]
    .filter((part): part is string => part !== null && part !== undefined)
    .join(' · ');

  if (noDescriptor && directFailed) {
    return {
      summary:
        'Core is unreachable and this device has no saved Remote Control route. Connect through VPN once to refresh it, then retry.',
      details,
    };
  }
  if (uplinkStage && directFailed) {
    return {
      summary:
        'Both Uplink and the direct Core connection failed. Check your connection and retry.',
      details,
    };
  }
  if (message.startsWith('Uplink and direct Core requests failed:')) {
    return {
      summary:
        'Both Uplink and the direct Core connection failed. Check your connection and retry.',
      details: ['Uplink request failed', 'Direct Core request failed', nativeCode]
        .filter((part): part is string => part !== null && part !== undefined)
        .join(' · '),
    };
  }
  if (uplinkStage) {
    return {
      summary: 'Uplink could not connect to Core. Check your connection and retry.',
      details,
    };
  }
  if (directFailed) {
    return {
      summary:
        'Core is unreachable at the paired address. Connect through VPN or enable Remote Control, then retry.',
      details,
    };
  }
  const httpStatus = message.match(/\b(?:HTTP\s+)?(401|403|404|429|5\d\d)\b/u)?.[1];
  if (httpStatus === '401' || httpStatus === '403') {
    return {
      summary: 'Core rejected this device’s authorization. Sign in again and retry.',
      details: `Core HTTP ${httpStatus}`,
    };
  }
  if (httpStatus) {
    return {
      summary: 'Core could not load sessions. Retry in a moment.',
      details: `Core HTTP ${httpStatus}`,
    };
  }
  return { summary: 'Could not load sessions. Check your connection and retry.', details: '' };
}
