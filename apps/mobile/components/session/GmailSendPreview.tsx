import {
  formatAttachmentSize,
  gmailPreviewHtml,
  spellOutBidiControls,
  type GmailSendSummary,
} from '@verity/mobile';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { WebView } from 'react-native-webview';

import { Text } from '../ui';

/**
 * Everything Gmail will send, for the approval card. It sits inside the card's
 * `PinnedScroll`, so the body is laid out in full here rather than in a box of
 * its own: one scroll surface reaches the end of the email and the buttons.
 */
export function GmailSendPreview({ summary }: { summary: GmailSendSummary }) {
  return (
    <View style={styles.preview}>
      {summary.from === null ? null : <Field>From: {spellOutBidiControls(summary.from)}</Field>}
      {summary.replyTo === null ? null : (
        <Field>Reply-To: {spellOutBidiControls(summary.replyTo)}</Field>
      )}
      <Field>To: {spellOutBidiControls(summary.to.join(', '))}</Field>
      {summary.cc.length > 0 ? (
        <Field>CC: {spellOutBidiControls(summary.cc.join(', '))}</Field>
      ) : null}
      {summary.bcc.length > 0 ? (
        <Field>BCC: {spellOutBidiControls(summary.bcc.join(', '))}</Field>
      ) : null}
      <Field>Subject: {spellOutBidiControls(summary.subject)}</Field>
      {summary.htmlBody === null ? null : (
        <>
          <Meta>HTML version:</Meta>
          <WebView
            style={styles.html}
            nestedScrollEnabled
            source={{ html: gmailPreviewHtml(summary.htmlBody), baseUrl: 'about:blank' }}
            javaScriptEnabled={false}
            domStorageEnabled={false}
            cacheEnabled={false}
            originWhitelist={['about:blank']}
            onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
            accessibilityLabel="Email HTML preview; external images and navigation are blocked"
          />
          <Meta>Plain-text alternative:</Meta>
        </>
      )}
      <Field>{spellOutBidiControls(summary.body)}</Field>
      {summary.attachments.length > 0 ? (
        <View>
          <Meta>Attachments ({summary.attachments.length}):</Meta>
          {summary.attachments.map((attachment, index) => (
            <Meta key={index} selectable>
              {spellOutBidiControls(attachment.filename)} · {formatAttachmentSize(attachment.size)}{' '}
              · {attachment.mimeType}
            </Meta>
          ))}
        </View>
      ) : null}
      {summary.externalUrls.length > 0 ? (
        <View>
          <Meta>External links and images in this email:</Meta>
          {summary.externalUrls.map((url) => (
            <Meta key={url} selectable>
              {spellOutBidiControls(url)}
            </Meta>
          ))}
        </View>
      ) : null}
      <Meta>
        Gmail sends exactly this text, HTML, and attachment snapshot once. After sending, Verity
        deletes the original draft if the final check still matches this preview. A change during
        cleanup may be lost.
      </Meta>
    </View>
  );
}

function Field({ children }: { children: ReactNode }) {
  return (
    <Text variant="code" tone="muted" style={styles.field} selectable>
      {children}
    </Text>
  );
}

function Meta({ children, selectable }: { children: ReactNode; selectable?: boolean }) {
  return (
    <Text variant="footnote" tone="faint" selectable={selectable}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  preview: { gap: theme.spacing.xs },
  field: {
    fontSize: theme.typography.footnote.fontSize,
    lineHeight: theme.typography.footnote.lineHeight,
  },
  // Shorter than the pinned card, so a swipe beside it still reaches the buttons.
  html: { height: 200, borderRadius: theme.radius.sm, overflow: 'hidden' },
}));
