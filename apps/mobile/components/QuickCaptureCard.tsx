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
import { useUnistyles } from 'react-native-unistyles';
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
    if (uploads.length >= 10) return;
    try {
      const selected = await (kind === 'photo'
        ? pickImagesFromLibrary(10 - uploads.length)
        : pickFiles(10 - uploads.length));
      setUploads((previous) => [...previous, ...selected]);
    } catch (error) {
      Alert.alert('Could not attach', error instanceof Error ? error.message : 'Try again');
    } finally {
      setEditing(wasEditing);
    }
  };
  const button = { padding: 12, borderRadius: 20, backgroundColor: theme.colors.background };
  const fg = { color: theme.colors.text };
  const chips = [...new Set([context.projectId, null, ...projects.slice(0, 3).map((p) => p.id)])];
  return (
    <Modal transparent animationType="slide" onRequestClose={dismiss}>
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#0005' }}
      >
        <View
          style={{
            margin: 12,
            marginBottom: 32,
            padding: 18,
            borderRadius: 24,
            backgroundColor: theme.colors.surface,
          }}
        >
          <View {...pan.panHandlers} style={{ alignItems: 'center', padding: 8 }}>
            <View
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.colors.textMuted,
              }}
            />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={fg}>{voice.state === 'recording' ? 'Listening…' : 'Capture task'}</Text>
            <Pressable accessibilityLabel="Discard capture" onPress={dismiss}>
              <Text style={fg}>✕</Text>
            </Pressable>
          </View>
          {voice.onDevice === false ? (
            <Text style={{ color: theme.colors.textMuted }}>
              Speech recognition uses your device’s network service.
            </Text>
          ) : null}
          {voice.error ? (
            <Text accessibilityRole="alert" style={fg}>
              {voice.error}
            </Text>
          ) : null}
          <TextInput
            accessibilityLabel="Task text"
            value={text}
            multiline
            maxLength={2000}
            placeholder="What needs doing?"
            placeholderTextColor={theme.colors.textMuted}
            onFocus={() => setEditing(true)}
            onChangeText={(value) => {
              setEditing(true);
              voice.onComposerEdit(value);
              setText(value);
            }}
            style={{ ...fg, minHeight: 90, fontSize: 18 }}
          />
          {voice.state === 'recording' ? (
            <View style={{ gap: 8 }}>
              <View
                style={{
                  height: 4,
                  width: `${Math.max(3, voice.level * 100)}%`,
                  backgroundColor: theme.colors.accent,
                }}
              />
              <Pressable accessibilityLabel="Stop recording" onPress={voice.toggle} style={button}>
                <Text style={fg}>■ Stop</Text>
              </Pressable>
            </View>
          ) : null}
          <ScrollView horizontal style={{ marginVertical: 8 }}>
            {uploads.map((upload, index) => (
              <Pressable
                key={index}
                accessibilityLabel={`Remove attachment ${index + 1}`}
                onPress={() => {
                  setEditing(true);
                  setUploads((items) => items.filter((_, i) => i !== index));
                }}
                style={{ marginRight: 8 }}
              >
                {upload.kind === 'image' ? (
                  <Image
                    source={{ uri: `data:${upload.mediaType};base64,${upload.data}` }}
                    style={{ width: 56, height: 56, borderRadius: 8 }}
                  />
                ) : (
                  <Text style={fg}>{upload.fileName}</Text>
                )}
                <Text style={fg}>✕</Text>
              </Pressable>
            ))}
          </ScrollView>
          {screenshot ? (
            <Pressable
              style={button}
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
            >
              <Text style={fg}>Recent screenshot · + Attach</Text>
            </Pressable>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              onPress={() => {
                void pick('photo');
              }}
              style={button}
            >
              <Text style={fg}>+ Photo</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void pick('file');
              }}
              style={button}
            >
              <Text style={fg}>+ File</Text>
            </Pressable>
          </View>
          {voice.state === 'idle' ? (
            <>
              <ScrollView horizontal style={{ marginVertical: 12 }}>
                {chips.map((id) => (
                  <Pressable
                    key={id ?? 'general'}
                    onPress={() => {
                      setProjectId(id);
                      void save(id);
                    }}
                    style={{
                      ...button,
                      marginRight: 6,
                      borderWidth: projectId === id ? 1 : 0,
                      borderColor: theme.colors.accent,
                    }}
                  >
                    <Text style={fg}>
                      {id === null
                        ? 'General'
                        : projectDisplayName(
                            projects.find((p) => p.id === id) ?? {
                              owner: '',
                              repo: id,
                              kind: 'local',
                            },
                          )}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  style={button}
                  onPress={() => {
                    setEditing(true);
                    setOther(!other);
                  }}
                >
                  <Text style={fg}>Other…</Text>
                </Pressable>
              </ScrollView>
              {other ? (
                <ScrollView style={{ maxHeight: 180 }}>
                  {projects.map((project) => (
                    <Pressable
                      key={project.id}
                      style={button}
                      onPress={() => {
                        setProjectId(project.id);
                        void save(project.id);
                      }}
                    >
                      <Text style={fg}>{projectDisplayName(project)}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}
              <View
                style={{
                  height: 2,
                  width: `${(remaining / TASK_SAVE_DELAY_MS) * 100}%`,
                  backgroundColor: theme.colors.accent,
                }}
              />
              <Pressable
                disabled={!text.trim() || saving}
                onPress={() => {
                  void save();
                }}
                style={button}
              >
                {saving ? (
                  <ActivityIndicator />
                ) : (
                  <Text style={fg}>
                    {editing || !recorded.current
                      ? 'Save task'
                      : `Saving in ${Math.ceil(remaining / 1000)} seconds…`}
                  </Text>
                )}
              </Pressable>
            </>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
