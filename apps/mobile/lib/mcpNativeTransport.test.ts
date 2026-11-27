import { NativeMcpTransport } from './mcpNativeTransport';
import { MCP_NATIVE_MESSAGE_LIMIT, nativeMcpHost, nativeMcpNavigation } from './mcpNativeHost';

const channel = 'f9ad4496-8d2a-4dd6-94fa-589606b3fc91';
const message = { jsonrpc: '2.0' as const, method: 'ui/notifications/initialized' };
const envelope = (kind: string, payload: unknown = message, key = channel) =>
  JSON.stringify({ channel: key, kind, message: payload });

it('binds messages to the current channel, validates JSON-RPC and stops on close', async () => {
  const inject = jest.fn();
  const failed = jest.fn();
  const transport = new NativeMcpTransport(channel, inject, failed);
  const received = jest.fn();
  transport.onmessage = received;
  await transport.start();
  transport.receive(envelope('ready', undefined, 'old-instance'));
  await transport.send(message);
  expect(inject).not.toHaveBeenCalled();
  transport.receive(envelope('ready'));
  expect(inject).toHaveBeenCalledTimes(1);
  transport.receive('not-json');
  transport.receive(envelope('rpc', { method: 'ui/initialize' }));
  transport.receive(envelope('rpc', message, 'other-frame'));
  expect(received).not.toHaveBeenCalled();
  transport.receive(envelope('rpc'));
  expect(received).toHaveBeenCalledWith(message);
  await transport.close();
  transport.receive(envelope('rpc'));
  expect(received).toHaveBeenCalledTimes(1);
  await expect(transport.send(message)).rejects.toThrow('closed');
  expect(failed).not.toHaveBeenCalled();
});

it('bounds message size, startup queue and valid-channel message rate', async () => {
  const failed = jest.fn();
  const transport = new NativeMcpTransport(channel, jest.fn(), failed);
  await transport.start();
  await expect(
    transport.send({ ...message, params: { text: 'x'.repeat(MCP_NATIVE_MESSAGE_LIMIT) } }),
  ).rejects.toThrow('too large');
  for (let i = 0; i < 16; i++) await transport.send(message);
  await expect(transport.send(message)).rejects.toThrow('queue full');
  transport.receive(envelope('ready'));
  for (let i = 0; i < 130; i++) transport.receive(envelope('rpc'));
  expect(failed).toHaveBeenCalled();
  await transport.close();
});

it('invalidates the host when its trusted wrapper reports navigation or reinitialization', async () => {
  const failed = jest.fn();
  const transport = new NativeMcpTransport(channel, jest.fn(), failed);
  await transport.start();
  transport.receive(envelope('ready'));
  transport.receive(envelope('ready'));
  transport.receive(envelope('failed'));
  expect(failed).toHaveBeenCalledTimes(2);
});

it('escapes script terminators and admits only fixed local navigation', () => {
  const html = nativeMcpHost('</script><script>untrusted()</script>', channel);
  expect(html).toContain('\\u003c/script>');
  expect(html).not.toContain('<script>untrusted()');
  expect(nativeMcpNavigation('about:blank')).toBe(true);
  expect(nativeMcpNavigation('about:srcdoc')).toBe(true);
  for (const url of [
    'https://verity.example',
    'file:///etc/passwd',
    'content://private',
    'javascript:alert(1)',
    'about:blank#new',
  ])
    expect(nativeMcpNavigation(url)).toBe(false);
});
