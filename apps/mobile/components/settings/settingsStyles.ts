// The one stylesheet behind every Settings screen.
//
// Settings is a stack of sibling routes rather than one file, and a card on the
// GitHub screen has to be indistinguishable from a card on the services screen —
// same corner radius, same padding, same hairline. Per-screen copies drift the
// first time someone tunes a value, so the tokens live here and the screens
// import them.
import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const settingsStyles = StyleSheet.create((theme) => ({
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
    fontSize: theme.text.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  centerSubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    textAlign: 'center',
  },
  content: {
    padding: theme.spacing.md,
    gap: theme.spacing.xl,
  },
  detailContent: {
    width: '100%',
    maxWidth: 1040,
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
    fontSize: theme.text.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  groupDescription: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 19 * theme.fontScale,
    marginBottom: theme.spacing.xs,
  },
  sectionHeaderRow: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  sectionSubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 19 * theme.fontScale,
    marginBottom: theme.spacing.xs,
  },
  // Generic card panel.
  panel: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  // A list card: rows meet edge to edge, separated by hairlines they draw
  // themselves, so the group reads as one object rather than stacked cards.
  listPanel: {
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
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
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 16 * theme.fontScale,
  },
  navRowValue: {
    flexShrink: 1,
    maxWidth: '45%',
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    textAlign: 'right',
  },
  navRowTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  // Setup checklist header.
  checklistPanel: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accent,
    backgroundColor: `${theme.colors.accent}0f`,
  },
  checklistPanelDone: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  checklistHeadline: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '800',
  },
  checklistSubtitle: {
    color: theme.colors.textMuted,
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
    fontWeight: '700',
  },
  checklistRowTitleDone: {
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  checklistMark: {
    width: 22,
    fontSize: theme.text.md,
    fontWeight: '800',
    textAlign: 'center',
  },
  backendChoices: {
    gap: theme.spacing.sm,
  },
  backendChoice: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  backendChoiceSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: `${theme.colors.accent}12`,
  },
  backendChoiceDisabled: {
    opacity: 0.5,
  },
  backendChoiceTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  // Identity profile block.
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${theme.colors.accent}26`,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accent,
  },
  avatarText: {
    color: theme.colors.accent,
    fontSize: theme.text.lg,
    fontWeight: '800',
  },
  identityCol: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  identityName: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
    paddingVertical: theme.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  identityEmail: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    paddingVertical: theme.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  disclosureTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  disclosureSummary: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
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
    fontWeight: '700',
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
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  pathInput: {
    minHeight: 44,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
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
    borderColor: theme.colors.border,
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
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  settingsSaveState: {
    color: theme.colors.textMuted,
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
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  primaryButtonLabel: {
    color: theme.colors.background,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.7,
  },
  // Sub-panel inside a card: reprovision, server update.
  reproPanel: {
    marginTop: theme.spacing.xs,
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  reproTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  reproSubtitle: {
    color: theme.colors.textMuted,
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
    minWidth: 168,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  reproButtonLabel: {
    color: theme.colors.accent,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  reproHint: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    textAlign: 'center',
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
    fontWeight: '700',
  },
  toggleTrack: {
    width: 46,
    height: 26,
    padding: 3,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  toggleTrackOn: {
    borderColor: theme.colors.accent,
    backgroundColor: `${theme.colors.accent}33`,
  },
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.textMuted,
  },
  toggleKnobOn: {
    transform: [{ translateX: 20 }],
    backgroundColor: theme.colors.accent,
  },
  footnote: {
    color: theme.colors.textMuted,
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
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  bannerText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
  },
  bannerAction: {
    color: theme.colors.accent,
    fontSize: theme.text.sm,
    fontWeight: '700',
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
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  retryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  retryButtonLabel: {
    color: theme.colors.background,
    fontSize: theme.text.md,
    fontWeight: '800',
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
    borderWidth: 1,
    borderColor: theme.colors.border,
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
    minWidth: 144,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  signingKeyButtonText: {
    color: theme.colors.accent,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
}));
