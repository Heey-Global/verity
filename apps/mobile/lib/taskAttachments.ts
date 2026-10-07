import { File, Paths } from 'expo-file-system';
import { shareAsync } from 'expo-sharing';
import { Platform } from 'react-native';
import type { Task, TaskQueueState } from '@verity/mobile';
import { taskAccountScope } from './tasksStore';
import { createVerityClient } from './client';

export async function openTaskAttachment(
  task: Task,
  index: number,
  pending: TaskQueueState['pending'],
): Promise<void> {
  const scope = taskAccountScope();
  if (!scope) throw new Error('Sign in to open attachments');
  const attachment = task.attachments[index];
  if (!attachment) return;
  let bytes: Uint8Array;
  const local = pending.find((op) => op.id === task.id && op.kind === 'create');
  const upload = local?.kind === 'create' ? local.body.uploads?.[index] : undefined;
  if (upload) bytes = Uint8Array.from(atob(upload.data), (ch) => ch.charCodeAt(0));
  else {
    const client = createVerityClient();
    if (!client) throw new Error('Connect to open this attachment');
    bytes = new Uint8Array(await client.readTaskAttachment(task.id, attachment.hash));
  }
  if (taskAccountScope() !== scope) throw new Error('Your connection changed; reopen Tasks');
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(
      new Blob([bytes.buffer as ArrayBuffer], { type: attachment.mimeType }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = attachment.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } else {
    const filename = attachment.filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = new File(Paths.cache, `task-${task.id}-${filename}`);
    try {
      file.create({ overwrite: true });
      file.write(bytes);
      await shareAsync(file.uri, { mimeType: attachment.mimeType });
    } finally {
      if (file.exists) file.delete();
    }
  }
}
