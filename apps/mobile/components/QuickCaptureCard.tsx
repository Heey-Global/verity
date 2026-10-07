import {
  TASK_SAVE_DELAY_MS,
  TASK_SILENCE_MS,
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
import { recentTaskScreenshot, readTaskScreenshot } from '../lib/taskScreenshot';
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
  const [screenshot, setScreenshot] = useState<{ uri: string; filename: string } | null>(null);
  useEffect(() => {
    let active = true;
    void recentTaskScreenshot().then((value) => {
      if (active) setScreenshot(value);
    });
    return () => {
      active = false;
    };
  }, []);
  const [uploads, setUploads] = useState<AttachmentUpload[]>([]);
  const [projectId, setProjectId] = useState(context.projectId);
  const [editing, setEditing] = useState(false);
  const [other, setOther] = useState(false);
  const [saving, setSaving] = useState(false);
  const [remaining, setRemaining] = useState(TASK_SAVE_DELAY_MS);
  const voice = useVoiceInput(text, setText, undefined, { silenceMs: TASK_SILENCE_MS });
  const started = useRef(false);
  const recorded = useRef(false);
  const saveRef = useRef<() => void>(() => undefined);
  const savingRef = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      voice.toggle();
    }
  }, [voice]);
  useEffect(() => {
    if (voice.state === 'recording') recorded.current = true;
  }, [voice.state]);
  const save = async (target = projectId) => {
    if (!text.trim() || savingRef.current) return;
    if (uploads.reduce((total, upload) => total + upload.data.length, 0) > 45_000_000) {
      setEditing(true);
      Alert.alert('Attachments too large', 'Keep the total attachment size below 33 MB.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
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
          : 'General',
      );
      onClose();
    } catch (error) {
      setEditing(true);
      Alert.alert('Could not save task', error instanceof Error ? error.message : 'Try again');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  saveRef.current = () => {
    void save();
  };
  useEffect(() => {
    if (voice.state !== 'idle' || !recorded.current || !text.trim() || editing || saving) return;
    const start = Date.now();
    setRemaining(TASK_SAVE_DELAY_MS);
    const timer = setInterval(() => {
      const next = Math.max(0, TASK_SAVE_DELAY_MS - (Date.now() - start));
      setRemaining(next);
      if (next === 0) {
        clearInterval(timer);
        saveRef.current();
      }
    }, 100);
    return () => clearInterval(timer);
  }, [voice.state, text, editing, saving]);
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
    const wasEditing = editing;
    setEditing(true);
    if (uploads.length >= 8) return;
    try {
      const selected = await (kind === 'photo'
        ? pickImagesFromLibrary(8 - uploads.length)
        : pickFiles(8 - uploads.length));
      setUploads((previous) => [...previous, ...selected]);
    } catch (error) {
      Alert.alert('Could not attach', error instanceof Error ? error.message : 'Try again');
    } finally {
      setEditing(wasEditing);
    }
  };
  const recording = voice.state === 'recording';
  // Chips and Save only once dictation has fully settled, so a late final
  // result is never cut off by an early save.
  const settled = voice.state === 'idle';
  const chips = [...new Set([context.projectId, null, ...projects.slice(0, 3).map((p) => p.id)])];
  const label = (id: string | null) =>
    id === null
      ? 'General'
      : projectDisplayName(
          projects.find((p) => p.id === id) ?? { owner: '', repo: id, kind: 'local' },
        );
  // Same predicate as the auto-save timer above.
  const counting = settled && recorded.current && !editing && !saving && text.trim().length > 0;
  const chip = (id: string | null) => {
    const selected = projectId === id;
    return (
      <Pressable
        key={id ?? 'general'}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={() => {
          setProjectId(id);
          void save(id);
        }}
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
            <Text style={styles.target} numberOfLines={1}>
              → <Text style={styles.targetName}>{label(projectId)}</Text>
            </Text>
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
            maxLength={2000}
            placeholder={recording ? 'Listening…' : 'What needs doing?'}
            placeholderTextColor={theme.colors.textFaint}
            onFocus={() => setEditing(true)}
            onChangeText={(value) => {
              setEditing(true);
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
              <Image source={{ uri: screenshot.uri }} style={styles.suggestThumb} />
              <View style={styles.suggestBody}>
                <Text style={styles.suggestTitle}>Screenshot from just now</Text>
                <Text style={styles.hint}>Attach it to this task?</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setEditing(true);
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
          {uploads.length ? (
            <ScrollView horizontal contentContainerStyle={styles.thumbs}>
              {uploads.map((upload, index) => (
                <Pressable
                  key={index}
                  accessibilityLabel={`Remove attachment ${String(index + 1)}`}
                  onPress={() => {
                    setEditing(true);
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
          {!settled ? (
            <View style={styles.toolsRow}>
              <AttachButton onPick={pick} />
              <Text style={styles.hint}>Stops when you pause</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Stop recording"
                disabled={!recording}
                onPress={voice.toggle}
                style={({ pressed }) => [styles.stop, pressed ? styles.pressed : null]}
              >
                <View style={styles.stopSquare} />
              </Pressable>
            </View>
          ) : (
            <>
              <View style={styles.chips}>
                {chips.map(chip)}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setEditing(true);
                    setOther(!other);
                  }}
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
                        setProjectId(project.id);
                        void save(project.id);
                      }}
                    >
                      <Text style={styles.chipLabel}>{projectDisplayName(project)}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}
              <View style={styles.footer}>
                <AttachButton onPick={pick} />
                {counting ? (
                  <View style={styles.countdown}>
                    <View style={styles.countdownTrack}>
                      <View
                        style={[
                          styles.countdownFill,
                          {
                            width:
                              `${String(Math.round((remaining / TASK_SAVE_DELAY_MS) * 100))}%` as `${number}%`,
                          },
                        ]}
                      />
                    </View>
                    <Text style={styles.hint}>
                      Saving to {label(projectId)} · swipe down to discard
                    </Text>
                  </View>
                ) : (
                  <View style={styles.footerSpacer} />
                )}
                <Pressable
                  accessibilityRole="button"
                  disabled={!text.trim() || saving}
                  onPress={() => {
                    void save();
                  }}
                  style={({ pressed }) => [
                    styles.save,
                    !text.trim() ? styles.saveDisabled : null,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  {saving ? (
                    <ActivityIndicator color={theme.colors.onPrimary} />
                  ) : (
                    <Text style={styles.saveLabel}>{counting ? 'Save now' : 'Save'}</Text>
                  )}
                </Pressable>
              </View>
            </>
          )}
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Attach photo or file"
      onPress={() =>
        Alert.alert('Attach', undefined, [
          { text: 'Photo', onPress: () => void onPick('photo') },
          { text: 'File', onPress: () => void onPick('file') },
          { text: 'Cancel', style: 'cancel' },
        ])
      }
      style={({ pressed }) => [styles.tool, pressed ? styles.pressed : null]}
    >
      <Icon name="paperclip" size={15} color={theme.colors.textMuted} />
      <Text style={styles.toolLabel}>Photo / File</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  card: {
    marginHorizontal: theme.spacing.sm,
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
  target: {
    marginLeft: 'auto',
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    flexShrink: 1,
  },
  targetName: { color: theme.colors.text, fontWeight: '600' },
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
    width: 34,
    height: 48,
    borderRadius: 6,
    backgroundColor: theme.colors.background,
  },
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
  toolsRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
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
  toolLabel: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  stop: {
    marginLeft: 'auto',
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopSquare: { width: 14, height: 14, borderRadius: 3, backgroundColor: theme.colors.tone.danger },
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
  footer: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  countdown: { flex: 1, gap: 6 },
  countdownTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surfaceAlt,
    overflow: 'hidden',
  },
  countdownFill: { height: '100%', borderRadius: 2, backgroundColor: theme.colors.primary },
  footerSpacer: { flex: 1 },
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
