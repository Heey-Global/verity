import type { GmailSendSummary } from '@verity/mobile';
import { render, screen } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

import { GmailSendPreview } from './GmailSendPreview';

const summary: GmailSendSummary = {
  draftId: 'draft-1',
  to: ['a@example.com', 'b@example.com'],
  cc: ['c@example.com'],
  bcc: ['d@example.com'],
  subject: 'Quarterly report',
  body: 'First line\n' + 'x'.repeat(5_000) + '\nLast line',
  from: 'me@example.com',
  replyTo: 'reply@example.com',
  htmlBody: '<p>Hello</p>',
  externalUrls: ['https://example.com/pixel.png'],
  attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', size: 2048 }],
};

// The approval shows exactly what Gmail sends. A field dropped here leaves the
// card looking complete while the operator approves recipients or content they
// never saw.
it('shows every header, the full body, attachments and external links', () => {
  const view = render(<GmailSendPreview summary={summary} />);

  for (const text of [
    'From: me@example.com',
    'Reply-To: reply@example.com',
    'To: a@example.com, b@example.com',
    'CC: c@example.com',
    'BCC: d@example.com',
    'Subject: Quarterly report',
    summary.body,
    'https://example.com/pixel.png',
  ])
    expect(screen.getByText(text)).toBeOnTheScreen();
  expect(screen.getByText(/report\.pdf/)).toBeOnTheScreen();
  expect(screen.getByText(/Gmail sends exactly this text/)).toBeOnTheScreen();
  expect(screen.getByText(summary.body).props.numberOfLines).toBeUndefined();
  // The pinned card scrolls the whole preview; a box of its own would trap the swipe.
  expect(view.UNSAFE_queryAllByType(ScrollView)).toHaveLength(0);
});

it('omits the optional headers and the HTML section when absent', () => {
  render(
    <GmailSendPreview
      summary={{ ...summary, from: null, replyTo: null, cc: [], bcc: [], htmlBody: null }}
    />,
  );

  expect(screen.queryByText(/^From:/)).toBeNull();
  expect(screen.queryByText(/^CC:/)).toBeNull();
  expect(screen.queryByText('Plain-text alternative:')).toBeNull();
});
