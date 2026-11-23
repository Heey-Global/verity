import { render, screen } from '@testing-library/react-native';

import { HtmlMockupPreview } from '../components/session/HtmlMockupPreview';

const mockGetDocument = jest.fn(
  async (_attachment: string, _signal: AbortSignal) =>
    '<details><summary>Plans</summary></details>',
);

jest.mock('../lib/client', () => ({
  createVerityClient: () => ({ getMockupPreviewDocument: mockGetDocument }),
}));
jest.mock('react-native-webview', () => ({
  __esModule: true,
  default: require('react-native').View,
}));

it('loads the authorized preview into a local WebView without scripting or a bridge', async () => {
  const preview = render(<HtmlMockupPreview attachment="saved-screen" name="Pricing" />);
  const view = await screen.findByLabelText('Pricing mockup');

  expect(mockGetDocument).toHaveBeenCalledWith('saved-screen', expect.any(AbortSignal));
  expect(view.props).toMatchObject({
    source: { html: '<details><summary>Plans</summary></details>', baseUrl: 'about:blank' },
    javaScriptEnabled: false,
    incognito: true,
    sharedCookiesEnabled: false,
    allowFileAccess: false,
    allowFileAccessFromFileURLs: false,
    allowUniversalAccessFromFileURLs: false,
  });
  expect(view.props).not.toHaveProperty('onMessage');
  const { onShouldStartLoadWithRequest } = view.props as {
    onShouldStartLoadWithRequest: (request: { url: string }) => boolean;
  };
  expect(onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true);
  expect(onShouldStartLoadWithRequest({ url: 'https://example.test/' })).toBe(false);
  const [, signal] = mockGetDocument.mock.calls[0]!;
  preview.unmount();
  expect(signal.aborted).toBe(true);
});
