const mockRequestOnce = jest.fn();
const mockAdmission = jest.fn();

jest.mock('expo-crypto', () => ({ getRandomBytes: () => new Uint8Array(16) }));
jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => ({ requestOnce: mockRequestOnce }),
}));
jest.mock('./remoteControlAdmission', () => ({
  requestRemoteControlAdmission: (...args: unknown[]) => mockAdmission(...args),
}));

Object.defineProperty(globalThis, 'Response', {
  configurable: true,
  value: class TestResponse {},
});
Object.defineProperty(globalThis, 'Headers', {
  configurable: true,
  value: class TestHeaders {},
});
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: jest.fn(),
});

import { remoteControlSmokeGet } from './remoteControlSmoke';

const input = {
  uplinkOrigin: 'https://uplink.example',
  installationHandle: 'handle_one',
  coreUrl: 'https://core.test/api/health',
  corePin: `sha256-${'a'.repeat(43)}`,
};

describe('remote control smoke GET', () => {
  beforeEach(() => {
    mockRequestOnce.mockReset();
    mockAdmission.mockReset();
  });

  it('passes the app ticket to the native tunnel and closes admission after the request', async () => {
    const finish = jest.fn();
    const cancel = jest.fn();
    mockAdmission.mockResolvedValue({
      sessionId: 'session_one',
      ticket: 'app_ticket',
      finish,
      cancel,
    });
    mockRequestOnce.mockResolvedValue({ status: 200, bodyBase64: 'b2s=' });

    await expect(remoteControlSmokeGet(input)).resolves.toEqual({
      status: 200,
      bodyBase64: 'b2s=',
    });
    expect(mockAdmission).toHaveBeenCalledWith(input);
    expect(mockRequestOnce).toHaveBeenCalledWith(
      'wss://uplink.example/data',
      'app_ticket',
      'session_one',
      input.coreUrl,
      input.corePin,
    );
    expect(finish).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels admission if the native tunnel fails', async () => {
    const finish = jest.fn();
    const cancel = jest.fn();
    mockAdmission.mockResolvedValue({
      sessionId: 'session_one',
      ticket: 'app_ticket',
      finish,
      cancel,
    });
    mockRequestOnce.mockRejectedValue(new Error('TLS verification failed'));

    await expect(remoteControlSmokeGet(input)).rejects.toThrow('TLS verification failed');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });
});
