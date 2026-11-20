import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { tint } from '../../ui/tint';

/** The session Files sheet's own layout: list, preview, drop hint and the
 *  Drive setup notice. Rows and bars come from the shared explorer. */
export const sessionFilesStyles = StyleSheet.create((theme) => ({
  codeBlock: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  codeLang: {
    color: theme.colors.textFaint,
    fontSize: theme.typography.footnote.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  codeText: {
    color: theme.colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: 20 * theme.fontScale,
  },
  driveSetupButton: {
    marginTop: theme.spacing.sm,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.action,
  },
  driveSetupButtonLabel: {
    color: theme.colors.onAction,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.fonts.bold,
  },
  driveSetupButtonPressed: {
    opacity: 0.78,
  },
  driveSetupNotice: {
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xl * 2,
  },
  emptySubtitle: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.bodySmall.fontSize,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 20 * theme.fontScale,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: theme.typography.title.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  filesDropHint: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.action,
    backgroundColor: tint(theme.colors.action, 'neutral'),
  },
  filesDropHintText: {
    color: theme.colors.text,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  // Tabs mark the active root with an underline, not a filled chip: a fill is
  // what a button looks like, and these are places, not actions.
  // The drop target wraps the list rather than the whole sheet: a drop onto the
  // preview or the header would have no directory to land in.
  filesDropZone: {
    flex: 1,
  },
  filesList: {
    flex: 1,
  },
  filesPreview: {
    flex: 1,
  },
  filesPreviewBody: {
    paddingVertical: theme.spacing.md,
  },
  filesPreviewText: {
    color: theme.colors.text,
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: 20 * theme.fontScale,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  filesPreviewWrap: {
    flex: 1,
    minHeight: 280,
  },
  flex: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: theme.colors.scrim,
  },
  sheetEmpty: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.bodySmall.fontSize,
    paddingVertical: theme.spacing.md,
  },
  sheetError: {
    color: theme.colors.attention,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.bodySmall.fontSize,
    paddingVertical: theme.spacing.sm,
  },
  sheetLimited: {
    color: theme.colors.attention,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
    textTransform: 'uppercase',
  },
  sheetLoading: {
    paddingVertical: theme.spacing.lg,
    alignItems: 'center',
  },
}));
