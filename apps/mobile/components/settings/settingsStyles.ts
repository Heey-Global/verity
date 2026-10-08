// Shared Settings sections, fields and actions follow the main screen palette.
import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

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
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
    textAlign: 'center',
  },
  centerSubtitle: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.md,
    textAlign: 'center',
  },
  content: {
    padding: theme.spacing.lg,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    gap: theme.spacing.xl,
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
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  groupDescription: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 19 * theme.fontScale,
    marginBottom: theme.spacing.xs,
  },
  linkText: {
    color: theme.colors.primary,
    fontSize: theme.text.sm,
    fontWeight: '700',
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
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 19 * theme.fontScale,
    marginBottom: theme.spacing.xs,
  },
  // Open sections keep forms aligned without nesting filled cards.
  panel: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
  },
  // Navigation rows share the same fine rules as detail sections.
  listPanel: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
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
    backgroundColor: theme.colors.setup.border,
  },
  modelGroupSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.setup.border,
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
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  navRowSubtitle: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 16 * theme.fontScale,
  },
  navRowValue: {
    flexShrink: 1,
    maxWidth: 100,
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
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
    borderTopColor: theme.colors.setup.text,
  },
  checklistPanelDone: {
    borderTopColor: theme.colors.setup.border,
  },
  checklistHeadline: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  checklistSubtitle: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
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
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  checklistRowTitleDone: {
    color: theme.colors.setup.textMuted,
    fontWeight: '600',
  },
  checklistMark: {
    width: 22,
    fontSize: theme.text.md,
    fontWeight: '600',
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
    borderColor: theme.colors.setup.border,
  },
  backendChoiceSelected: {
    borderColor: theme.colors.setup.text,
    backgroundColor: `${theme.colors.setup.text}12`,
  },
  backendChoiceDisabled: {
    opacity: 0.5,
  },
  backendChoiceTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
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
    backgroundColor: `${theme.colors.setup.text}26`,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.text,
  },
  avatarText: {
    color: theme.colors.primary,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  identityCol: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  identityName: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
    paddingVertical: theme.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.setup.border,
  },
  identityEmail: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
    paddingVertical: theme.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.setup.border,
  },
  disclosureTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  disclosureSummary: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  serviceStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  serviceStatusLabel: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  connectedServiceSubsection: {
    gap: theme.spacing.md,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
  },
  signingKeySection: {
    gap: theme.spacing.sm,
  },
  pathContent: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  pathLabel: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  pathInput: {
    minHeight: 44,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
    backgroundColor: theme.colors.background,
    color: theme.colors.text,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontSize: theme.text.sm,
    fontFamily: MONO,
  },
  // Secret paste field: a taller, monospace multiline box with a label+status row.
  secretLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  secretInput: {
    minHeight: 88,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
    backgroundColor: theme.colors.background,
    color: theme.colors.text,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontSize: theme.text.sm,
    fontFamily: MONO,
    textAlignVertical: 'top',
  },
  secretInputDisabled: {
    opacity: 0.45,
  },
  secretStoreForm: {
    gap: theme.spacing.sm,
  },
  fieldError: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  settingsSaveState: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
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
    backgroundColor: theme.colors.primary,
  },
  primaryButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '600',
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
    borderTopColor: theme.colors.setup.border,
  },
  reproTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  reproSubtitle: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  reproStatus: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
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
    borderColor: theme.colors.setup.border,
    backgroundColor: theme.colors.setup.surfaceAlt,
  },
  reproButtonLabel: {
    color: theme.colors.primary,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  reproHint: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    textAlign: 'center',
  },
  updateHeader: {
    gap: 2,
  },
  updateTitle: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
  },
  updateDetail: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  // Full width: this is the one action the screen exists for.
  updateButton: {
    alignSelf: 'stretch',
  },
  releaseNotes: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
  },
  releaseNotesTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  releaseNotesSection: {
    gap: 2,
  },
  releaseNotesHeading: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
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
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  footnote: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  versionFootnote: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
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
    borderBottomColor: theme.colors.setup.border,
    backgroundColor: theme.colors.setup.surfaceAlt,
  },
  bannerText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
  },
  bannerAction: {
    color: theme.colors.primary,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  autoSaveBanner: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    backgroundColor: theme.colors.setup.surfaceAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.setup.border,
  },
  autoSaveBannerText: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  retryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.primary,
  },
  retryButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '600',
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
    borderColor: theme.colors.setup.border,
    backgroundColor: theme.colors.background,
  },
  signingKeyText: {
    color: theme.colors.text,
    fontSize: theme.text.xs,
    fontFamily: MONO,
    lineHeight: 16 * theme.fontScale,
  },
  signingKeyActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  // 44pt, not the 40 this used to be: a two-up row of small buttons is exactly
  // where an undersized target gets mis-tapped.
  signingKeyButton: {
    minHeight: 44,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
  },
  signingKeyButtonText: {
    color: theme.colors.primary,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  // A destructive inline action sitting at the trailing edge of a list row.
  // Same 44pt target as the other small buttons; only the tone differs.
  dangerButton: {
    minHeight: 44,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.tone.danger,
  },
  dangerButtonLabel: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  // An editable name in the title slot of a list row. Reads as the row's title
  // until tapped, so the underline is the only hint that it is a field — the
  // same treatment as the commit identity on the GitHub screen.
  deviceNameInput: {
    minHeight: 32,
    paddingVertical: theme.spacing.xs,
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.setup.border,
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
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '600',
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
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
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
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
  },
  monoText: {
    fontFamily: MONO,
    fontSize: theme.text.xs,
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
    color: theme.colors.primary,
    fontSize: theme.text.sm,
    fontWeight: '600',
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
