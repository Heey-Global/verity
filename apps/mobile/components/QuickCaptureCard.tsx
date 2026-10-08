import {
  projectDisplayName,
  type AttachmentUpload,
  type ProjectRecord,
  type TaskContext,
} from '@verity/mobile';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from './Icon';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { pickFiles, pickImagesFromLibrary } from '../lib/attachments';
import {
  enableTaskScreenshotSuggestions,
  previewTaskScreenshot,
  readTaskScreenshot,
  recentTaskScreenshot,
  screenshotAccess,
} from '../lib/taskScreenshot';
import { saveTaskPreferences, useTaskPreferences } from '../lib/taskPreferences';
import { captureTask } from '../lib/tasksStore';

export function QuickCaptureCard({
  context,
  projects,
  onClose,
  onSaved,
}: {
  context: TaskContext;
  projects: ProjectRecord[];
  onClose(): void;
  onSaved(id: string, label: string): void;
}) {
  const { theme } = useUnistyles();
  const [text, setText] = useState('');
  const preferences = useTaskPreferences();
  const [screenshot, setScreenshot] = useState<{ uri: string; filename: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  /** Show the one-line photo-access explainer instead of failing silently. */
  const [askAccess, setAskAccess] = useState(false);
  const lookForScreenshot = useRef(async (isActive: () => boolean) => {
    const found = await recentTaskScreenshot();
    if (!isActive() || !found) return;
    setScreenshot(found);
    const uri = await previewTaskScreenshot(found);
    if (isActive()) setPreview(uri);
  });
  useEffect(() => {
    if (!preferences.loaded || !preferences.screenshots) return;
    let active = true;
    const isActive = () => active;
    void screenshotAccess().then((access) => {
      if (!active) return;
      if (access === 'granted') void lookForScreenshot.current(isActive);
      else if (access === 'undetermined' && !preferences.screenshotPromptDismissed)
        setAskAccess(true);
    });
    return () => {
      active = false;
    };
  }, [preferences.loaded, preferences.screenshots, preferences.screenshotPromptDismissed]);
  const [uploads, setUploads] = useState<AttachmentUpload[]>([]);
  const [projectId, setProjectId] = useState(
    context.projectId ??
      (projects.some((p) => p.id === preferences.projectId) ? preferences.projectId : null),
  );
  const [other, setOther] = useState(false);
  const [saving, setSaving] = useState(false);
  const voice = useVoiceInput(text, setText);
  const started = useRef(false);
  const savingRef = useRef(false);
  const pendingSave = useRef<{ target: string | null; recording: boolean } | null>(null);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      voice.toggle();
    }
  }, [voice]);
  const save = async (target = projectId) => {
    if (!text.trim() || savingRef.current || target === null) return;
    if (uploads.reduce((total, upload) => total + upload.data.length, 0) > 45_000_000) {
      Alert.alert('Attachments too large', 'Keep the total attachment size below 33 MB.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    pendingSave.current = { target, recording: voice.state === 'recording' };
    if (voice.state === 'recording') voice.toggle();
    else voice.abort();
  };
  useEffect(() => {
    if (voice.state !== 'idle' || !pendingSave.current) return;
    const { target, recording: wasRecording } = pendingSave.current;
    pendingSave.current = null;
    if ((wasRecording && voice.error) || !text.trim()) {
      savingRef.current = false;
      setSaving(false);
      return;
    }
    // Wait for native end so the final transcript is included in the saved task.
    void (async () => {
      try {
        const task = await captureTask({
          title: text.trim(),
          projectId: target,
          sourceSessionId: context.sessionId,
          uploads,
        });
        onSaved(
          task.id,
          projects.find((p) => p.id === target)
            ? projectDisplayName(projects.find((p) => p.id === target)!)
            : 'Project',
        );
        onClose();
      } catch (error) {
        Alert.alert('Could not save task', error instanceof Error ? error.message : 'Try again');
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
  }, [
    saving,
    voice.state,
    voice.error,
    text,
    context.sessionId,
    uploads,
    projects,
    onSaved,
    onClose,
  ]);
  const dismiss = () => {
    if (!savingRef.current) {
      voice.abort();
      onClose();
    }
  };
  const pan = PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dy > 12 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderRelease: (_, g) => {
      if (g.dy > 60) dismiss();
    },
  });
  const pick = async (kind: 'photo' | 'file') => {
    if (uploads.length >= 8) return;
    try {
      const selected = await (kind === 'photo'
        ? pickImagesFromLibrary(8 - uploads.length)
        : pickFiles(8 - uploads.length));
      setUploads((previous) => [...previous, ...selected]);
    } catch (error) {
      Alert.alert('Could not attach', error instanceof Error ? error.message : 'Try again');
    } finally {
    }
  };
  useEffect(() => {
    if (
      context.projectId === null &&
      projectId === null &&
      preferences.projectId &&
      projects.some((project) => project.id === preferences.projectId)
    )
      setProjectId(preferences.projectId);
  }, [context.projectId, projectId, preferences.projectId, projects]);
  const recording = voice.state === 'recording';
  // The picked project always shows as a selected chip, also when it came from Other….
  const chips = [
    ...new Set(
      [projectId, context.projectId, ...projects.slice(0, 3).map((p) => p.id)].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
  const label = (id: string | null) =>
    id === null
      ? 'Choose a project'
      : projectDisplayName(
          projects.find((p) => p.id === id) ?? { owner: '', repo: id, kind: 'local' },
        );
  const selectProject = (id: string) => {
    setProjectId(id);
    void saveTaskPreferences({ projectId: id }).catch(() =>
      Alert.alert('Could not remember project', 'Try again'),
    );
  };
  const chip = (id: string) => {
    const selected = projectId === id;
    return (
      <Pressable
        key={id}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={() => selectProject(id)}
        style={({ pressed }) => [
          styles.chip,
          selected ? styles.chipSelected : null,
          pressed ? styles.pressed : null,
        ]}
      >
        {selected ? <View style={styles.chipDot} /> : null}
        <Text style={[styles.chipLabel, selected ? styles.chipLabelSelected : null]}>
          {label(id)}
        </Text>
      </Pressable>
    );
  };
  return (
    <Modal transparent animationType="slide" onRequestClose={dismiss}>
      <KeyboardAvoidingView behavior="padding" style={styles.backdrop}>
        <View style={styles.card}>
          <View {...pan.panHandlers} style={styles.grabArea}>
            <View style={styles.grabber} />
          </View>
          <View style={styles.head}>
            {recording ? (
              <>
                <View style={styles.recDot} />
                <Text style={styles.recLabel}>Recording</Text>
                <LevelBars level={voice.level} color={theme.colors.tone.danger} />
              </>
            ) : (
              <Text style={styles.headLabel}>{saving ? 'Saving…' : 'New task'}</Text>
            )}
            <View style={styles.headSpacer} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Discard capture"
              hitSlop={10}
              onPress={dismiss}
              style={({ pressed }) => [styles.close, pressed ? styles.pressed : null]}
            >
              <Icon name="x" size={18} color={theme.colors.textMuted} />
            </Pressable>
          </View>
          {voice.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {voice.error}
            </Text>
          ) : null}
          <TextInput
            accessibilityLabel="Task text"
            value={text}
            multiline
            editable={!saving}
            maxLength={2000}
            placeholder={recording ? 'Listening…' : 'What needs doing?'}
            placeholderTextColor={theme.colors.textFaint}
            onChangeText={(value) => {
              voice.onComposerEdit(value);
              setText(value);
            }}
            style={styles.input}
          />
          {voice.onDevice === false ? (
            <Text style={styles.hint}>Speech recognition uses your device’s network service.</Text>
          ) : null}
          {screenshot ? (
            <View style={styles.suggest}>
              <View style={styles.suggestThumb}>
                {preview ? (
                  <Image source={{ uri: preview }} style={styles.suggestImage} />
                ) : (
                  <Icon name="image" size={18} color={theme.colors.textMuted} />
                )}
              </View>
              <View style={styles.suggestBody}>
                <Text style={styles.suggestTitle}>Screenshot from just now</Text>
                <Text style={styles.hint}>Attach it to this task?</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  void readTaskScreenshot(screenshot)
                    .then((items) => {
                      setUploads((previous) => [...previous, ...items]);
                      setScreenshot(null);
                    })
                    .catch((error) =>
                      Alert.alert(
                        'Could not attach screenshot',
                        error instanceof Error ? error.message : 'Try the photo picker',
                      ),
                    );
                }}
                style={({ pressed }) => [styles.attach, pressed ? styles.pressed : null]}
              >
                <Text style={styles.attachLabel}>+ Attach</Text>
              </Pressable>
            </View>
          ) : null}
          {askAccess && !screenshot ? (
            <View style={styles.perm}>
              <View style={styles.permIcon}>
                <Icon name="image" size={16} color={theme.colors.textMuted} />
              </View>
              <View style={styles.suggestBody}>
                <Text style={styles.suggestTitle}>Attach screenshots in one tap</Text>
                <Text style={styles.hint}>
                  Verity needs photo access to offer the screenshot you just took.
                </Text>
              </View>
              <View style={styles.permActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setAskAccess(false);
                    void enableTaskScreenshotSuggestions()
                      .then(() => lookForScreenshot.current(() => true))
                      .catch(() => undefined);
                  }}
                  style={({ pressed }) => [styles.attach, pressed ? styles.pressed : null]}
                >
                  <Text style={styles.attachLabel}>Allow</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={() => {
                    setAskAccess(false);
                    void saveTaskPreferences({ screenshotPromptDismissed: true });
                  }}
                >
                  <Text style={styles.hint}>Not now</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {uploads.length ? (
            <ScrollView horizontal contentContainerStyle={styles.thumbs}>
              {uploads.map((upload, index) => (
                <Pressable
                  key={index}
                  accessibilityLabel={`Remove attachment ${String(index + 1)}`}
                  onPress={() => {
                    setUploads((items) => items.filter((_, i) => i !== index));
                  }}
                  style={styles.thumb}
                >
                  {upload.kind === 'image' ? (
                    <Image
                      source={{ uri: `data:${upload.mediaType};base64,${upload.data}` }}
                      style={styles.thumbImage}
                    />
                  ) : (
                    <View style={styles.thumbFile}>
                      <Icon name="file" size={18} color={theme.colors.textMuted} />
                      <Text style={styles.thumbName} numberOfLines={2}>
                        {upload.fileName}
                      </Text>
                    </View>
                  )}
                  <View style={styles.thumbRemove}>
                    <Icon name="x" size={11} color="#fff" />
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          {/* One layout throughout: the project is picked here while or after
              speaking, and only the footer's main button changes. Nothing is
              saved until the operator taps Save. */}
          {projectId === null ? (
            <Text style={styles.hint}>
              {projects.length === 0
                ? 'Create a project to save this task.'
                : 'Choose a project to save this task.'}
            </Text>
          ) : null}
          <View style={styles.chips}>
            {chips.map(chip)}
            <Pressable
              accessibilityRole="button"
              onPress={() => setOther(!other)}
              style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
            >
              <Text style={[styles.chipLabel, styles.chipLabelMuted]}>Other…</Text>
            </Pressable>
          </View>
          {other ? (
            <ScrollView style={styles.otherList}>
              {projects.map((project) => (
                <Pressable
                  key={project.id}
                  style={({ pressed }) => [styles.otherRow, pressed ? styles.pressed : null]}
                  onPress={() => {
                    selectProject(project.id);
                    setOther(false);
                  }}
                >
                  <Text style={styles.chipLabel}>{projectDisplayName(project)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          <View style={styles.footer}>
            <AttachButton onPick={pick} />
            <Text style={[styles.hint, styles.footerHint]} numberOfLines={1}>
              {saving ? 'Finishing…' : recording ? 'Save ends recording' : ''}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={!text.trim() || saving || projectId === null}
              onPress={() => void save()}
              style={({ pressed }) => [
                styles.save,
                !text.trim() || saving ? styles.saveDisabled : null,
                pressed ? styles.pressed : null,
              ]}
            >
              {saving ? (
                <ActivityIndicator color={theme.colors.onPrimary} />
              ) : (
                <Text style={styles.saveLabel}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Live input level as a row of bars, newest on the right. */
function LevelBars({ level, color }: { level: number; color: string }) {
  const [history, setHistory] = useState<number[]>(() => Array.from({ length: 12 }, () => 0));
  useEffect(() => {
    setHistory((previous) => [...previous.slice(1), level]);
  }, [level]);
  return (
    <View style={styles.bars}>
      {history.map((value, index) => (
        <View
          key={index}
          style={[styles.bar, { height: 4 + Math.min(1, value) * 16, backgroundColor: color }]}
        />
      ))}
    </View>
  );
}

function AttachButton({ onPick }: { onPick(kind: 'photo' | 'file'): Promise<void> }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.toolGroup}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Attach photo"
        onPress={() => void onPick('photo')}
        style={({ pressed }) => [styles.tool, pressed ? styles.pressed : null]}
      >
        <Icon name="image" size={15} color={theme.colors.textMuted} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Attach file"
        onPress={() => void onPick('file')}
        style={({ pressed }) => [styles.tool, pressed ? styles.pressed : null]}
      >
        <Icon name="paperclip" size={15} color={theme.colors.textMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: theme.spacing.sm,
  },
  card: {
    // Never the full width of a tablet: a capture card, not a sheet.
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    marginBottom: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
    borderRadius: theme.radius.lg + 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    gap: theme.spacing.md,
  },
  grabArea: { alignItems: 'center', paddingTop: theme.spacing.sm, paddingBottom: 2 },
  grabber: { width: 38, height: 5, borderRadius: 3, backgroundColor: theme.colors.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, minHeight: 24 },
  recDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: theme.colors.tone.danger },
  recLabel: { color: theme.colors.tone.danger, fontSize: theme.text.sm, fontWeight: '600' },
  headLabel: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '600' },
  bars: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 22, marginLeft: 4 },
  bar: { width: 3, borderRadius: 2 },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm },
  input: {
    color: theme.colors.text,
    fontSize: theme.text.lg - 2,
    lineHeight: 25 * theme.fontScale,
    minHeight: 76,
    maxHeight: 180,
    padding: 0,
    textAlignVertical: 'top',
  },
  hint: { color: theme.colors.textFaint, fontSize: theme.text.xs },
  suggest: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md + 4,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  suggestThumb: {
    overflow: 'hidden',
    width: 34,
    height: 48,
    borderRadius: 6,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestImage: { width: '100%', height: '100%' },
  perm: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md + 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.colors.border,
  },
  permIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permActions: { alignItems: 'center', gap: 6 },
  suggestBody: { flex: 1, gap: 2 },
  suggestTitle: { color: theme.colors.text, fontSize: theme.text.sm },
  attach: {
    paddingHorizontal: theme.spacing.md,
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  attachLabel: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '600' },
  thumbs: { gap: theme.spacing.sm },
  thumb: { width: 52, height: 72 },
  thumbImage: {
    width: 52,
    height: 72,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  thumbFile: {
    width: 52,
    height: 72,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
    gap: 4,
  },
  thumbName: { color: theme.colors.textMuted, fontSize: theme.text.micro, textAlign: 'center' },
  thumbRemove: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: theme.spacing.md,
    minHeight: 34,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  toolGroup: { flexDirection: 'row', gap: theme.spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 34,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  chipSelected: { borderColor: theme.colors.primary },
  chipDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.primary },
  chipLabel: { color: theme.colors.text, fontSize: theme.text.sm },
  chipLabelSelected: { color: theme.colors.primary, fontWeight: '600' },
  chipLabelMuted: { color: theme.colors.textMuted },
  otherList: { maxHeight: 180 },
  otherRow: {
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  footer: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, minHeight: 44 },
  headSpacer: { flex: 1 },
  footerHint: { flex: 1 },
  save: {
    minHeight: 40,
    minWidth: 88,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveDisabled: { opacity: 0.4 },
  saveLabel: { color: theme.colors.onPrimary, fontSize: theme.text.sm, fontWeight: '700' },
  close: { paddingLeft: theme.spacing.xs },
  pressed: { opacity: 0.7 },
}));
