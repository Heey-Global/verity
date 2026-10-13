// Shared Settings sections, fields and actions follow the main screen palette.
import { StyleSheet } from 'react-native-unistyles';

import { tint } from '../ui/tint';

export const settingsStyles = StyleSheet.create((theme) => ({
  input: {
    color: theme.colors.text,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  disclosure: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  disclosureHeader: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.md,
  },
  disclosureBody: {
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  flex: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  centerTitle: {
    ...theme.typography.row,
    color: theme.colors.text,
    textAlign: 'center',
  },
  centerSubtitle: {
    ...theme.typography.body,
    color: theme.colors.textMuted,
    textAlign: 'center',
  },
  content: {
    padding: theme.spacing.lg,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    gap: theme.spacing.xl,
  },
  scaffoldFooter: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: theme.spacing.xl,
    paddingTop: theme.spacing.sm,
  },
  detailContent: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    gap: theme.spacing.lg,
  },
  settingsGroup: {
    gap: theme.spacing.sm,
  },
  panelStack: {
    gap: theme.spacing.sm,
  },
  groupHeader: {
    flexShrink: 1,
    color: theme.colors.textMuted,
    ...theme.typography.label,
  },
  groupDescription: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.xs,
  },
  linkText: {
    ...theme.typography.button,
    color: theme.colors.action,
  },
  sectionHeaderRow: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  sectionHeaderLabel: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  sectionSubtitle: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.xs,
  },
  // Open sections keep forms aligned without nesting filled cards.
  panel: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  // Navigation rows share the same fine rules as detail sections.
  listPanel: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    overflow: 'hidden',
  },
  // 56pt, comfortably past the 44pt minimum target: these are the primary
  // navigation of the whole settings surface.
  navRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  // Inset from the left so the separator starts under the label, not under the
  // leading icon — the iOS grouped-list convention.
  rowSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: theme.spacing.md,
    backgroundColor: theme.colors.border,
  },
  modelGroupSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing.sm,
  },
  navRowIcon: {
    width: 30,
    alignItems: 'center',
  },
  navRowBody: {
    flex: 1,
    gap: 2,
  },
  navRowTitle: {
    color: theme.colors.text,
    ...theme.typography.row,
  },
  navRowSubtitle: {
    color: theme.colors.textMuted,
    ...theme.typography.subtitle,
  },
  navRowValue: {
    ...theme.typography.body,
    flexShrink: 1,
    maxWidth: 100,
    color: theme.colors.textMuted,
    textAlign: 'right',
  },
  navRowTrailing: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  // Setup checklist header.
  checklistPanel: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.text,
  },
  checklistPanelDone: {
    borderTopColor: theme.colors.border,
  },
  checklistHeadline: {
    ...theme.typography.row,
    color: theme.colors.text,
  },
  checklistSubtitle: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
  },
  checklistRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  checklistRowBody: {
    flex: 1,
    gap: 2,
  },
  checklistRowTitle: {
    ...theme.typography.row,
    color: theme.colors.text,
  },
  checklistRowTitleDone: {
    color: theme.colors.textMuted,
  },
  checklistMark: {
    ...theme.typography.row,
    width: 22,
    textAlign: 'center',
  },
  backendChoices: {
    gap: theme.spacing.sm,
  },
  backendChoice: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  backendChoiceSelected: {
    borderColor: theme.colors.action,
    backgroundColor: tint(theme.colors.action, 'neutral'),
  },
  backendChoiceDisabled: {
    opacity: 0.5,
  },
  backendChoiceTitle: {
    ...theme.typography.row,
    color: theme.colors.text,
  },
  // Identity profile block.
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.action, 'fill'),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tint(theme.colors.action, 'border'),
  },
  avatarText: {
    ...theme.typography.row,
    color: theme.colors.action,
  },
  identityCol: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  identityName: {
    ...theme.typography.row,
    color: theme.colors.text,
    paddingVertical: theme.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  identityEmail: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
    paddingVertical: theme.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  disclosureTitle: {
    color: theme.colors.text,
    ...theme.typography.row,
  },
  disclosureSummary: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
  },
  serviceStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  serviceStatusLabel: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    flex: 1,
    color: theme.colors.text,
  },
  connectedServiceSubsection: {
    gap: theme.spacing.md,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  signingKeySection: {
    gap: theme.spacing.sm,
  },
  pathContent: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  pathLabel: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
  },
  pathInput: {
    fontFamily: theme.typography.code.fontFamily,
    fontSize: theme.typography.code.fontSize,
    minHeight: 44,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    color: theme.colors.text,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  // Secret paste field: a taller, monospace multiline box with a label+status row.
  secretLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  secretInput: {
    fontFamily: theme.typography.code.fontFamily,
    fontSize: theme.typography.code.fontSize,
    minHeight: 88,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    color: theme.colors.text,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    textAlignVertical: 'top',
  },
  secretInputDisabled: {
    opacity: 0.45,
  },
  secretStoreForm: {
    gap: theme.spacing.sm,
  },
  fieldError: {
    ...theme.typography.footnote,
    color: theme.colors.attention,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  settingsSaveState: {
    ...theme.typography.footnote,
    color: theme.colors.textMuted,
    textAlign: 'center',
    paddingVertical: theme.spacing.xs,
  },
  primaryButton: {
    minHeight: 44,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.action,
  },
  primaryButtonLabel: {
    color: theme.colors.onAction,
    ...theme.typography.button,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  // Keeps a button at its own width instead of stretching across the panel.
  selfStart: {
    alignSelf: 'flex-start',
  },
  pressed: {
    opacity: 0.7,
  },
  // Sub-panel inside a card: reprovision, server update.
  reproPanel: {
    marginTop: theme.spacing.xs,
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  reproTitle: {
    ...theme.typography.row,
    color: theme.colors.text,
  },
  reproSubtitle: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
  },
  reproStatus: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.text,
  },
  reproButton: {
    minHeight: 44,
    minWidth: 0,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  reproButtonLabel: {
    color: theme.colors.action,
    ...theme.typography.button,
  },
  reproHint: {
    ...theme.typography.footnote,
    color: theme.colors.textFaint,
    textAlign: 'center',
  },
  updateHeader: {
    gap: 2,
  },
  updateTitle: {
    ...theme.typography.title,
    color: theme.colors.text,
  },
  updateDetail: {
    ...theme.typography.body,
    color: theme.colors.text,
  },
  releaseNotes: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  releaseNotesTitle: {
    ...theme.typography.row,
    color: theme.colors.text,
  },
  releaseNotesSection: {
    gap: 2,
  },
  releaseNotesHeading: {
    ...theme.typography.label,
    color: theme.colors.textMuted,
  },
  releaseNotesItem: {
    flexDirection: 'row',
    gap: theme.spacing.xs,
  },
  releaseNotesItemText: {
    flex: 1,
  },
  updateProgressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  toggleRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  toggleLabel: {
    flex: 1,
    color: theme.colors.text,
    ...theme.typography.row,
  },
  footnote: {
    color: theme.colors.textMuted,
    ...theme.typography.footnote,
  },
  versionFootnote: {
    ...theme.typography.footnote,
    color: theme.colors.textFaint,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  bannerText: {
    ...theme.typography.body,
    flex: 1,
    color: theme.colors.text,
  },
  bannerAction: {
    ...theme.typography.button,
    color: theme.colors.action,
  },
  autoSaveBanner: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  autoSaveBannerText: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
  },
  retryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.action,
  },
  retryButtonLabel: {
    ...theme.typography.button,
    color: theme.colors.onAction,
  },
  signingKeyLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  signingKeyBlock: {
    marginTop: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  signingKeyText: {
    ...theme.typography.code,
    color: theme.colors.text,
  },
  signingKeyActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  // A destructive inline action sitting at the trailing edge of a list row.
  // A 44pt minimum target, in the attention tone.
  dangerButton: {
    minHeight: 44,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.attention,
  },
  dangerButtonLabel: {
    ...theme.typography.button,
    color: theme.colors.attention,
  },
  // An editable name in the title slot of a list row. Reads as the row's title
  // until tapped, so the underline is the only hint that it is a field — the
  // same treatment as the commit identity on the GitHub screen.
  // Reads as the row's title; it only turns into a field once tapped.
  deviceNameInput: {
    fontFamily: theme.typography.row.fontFamily,
    fontSize: theme.typography.row.fontSize,
    flexShrink: 1,
    padding: 0,
    color: theme.colors.text,
  },
  deviceNameSizer: {
    flexShrink: 1,
    minWidth: 40,
  },
  deviceNameGhost: {
    opacity: 0,
    // Room for the caret at the end of the name.
    paddingRight: 2,
  },
  deviceNameField: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  deviceNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  accessCard: {
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  groupFootnote: {
    ...theme.typography.footnote,
    color: theme.colors.textMuted,
    marginHorizontal: theme.spacing.xs,
  },
  // A QR code needs a white quiet zone to stay scannable, so this block keeps
  // its literal white on both themes rather than following the surface color.
  qrFrame: {
    alignSelf: 'center',
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: '#ffffff',
  },
  // App / Web Browser switch on the Devices screen.
  accessTabs: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  accessTab: {
    flex: 1,
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    borderRadius: theme.radius.sm + 2,
  },
  accessTabSelected: {
    backgroundColor: theme.colors.surface,
  },
  accessTabLabel: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.textMuted,
  },
  accessTabLabelSelected: {
    color: theme.colors.text,
  },
  // A value the operator carries to another device: a label, the value on one
  // line, and the action that moves it.
  copyField: {
    gap: theme.spacing.xs,
  },
  copyFieldLabel: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
  },
  copyFieldBox: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  copyFieldValue: {
    ...theme.typography.body,
    flex: 1,
    color: theme.colors.text,
  },
  monoText: {
    ...theme.typography.code,
  },
  copyFieldButton: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surface,
  },
  copyFieldButtonLabel: {
    ...theme.typography.button,
    color: theme.colors.action,
  },
  invitationHint: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  // A destructive row action that does not outweigh the row it sits in.
  quietDangerButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xs,
  },
}));
