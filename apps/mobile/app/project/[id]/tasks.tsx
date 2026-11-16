import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { TaskListBody } from '../../../components/TasksPanel';
import { HeaderIconButton } from '../../../components/files/FileSheetHeader';
import { useTaskContext } from '../../../lib/sharedTaskContext';
import { projectIdParam } from '../../../lib/useProjectDetail';
import { dispatchVerityShortcut } from '../../../lib/voiceShortcut';

/**
 * A project's tasks, reached from its Overview: the operator's own tasks for
 * this project and its GitHub issues, as the list behind the V shows them. The
 * agents' working steps stay with their sessions.
 */
export default function ProjectTasksScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const { projects, sessions } = useTaskContext();
  const context = useMemo(() => ({ projectId, sessionId: null }), [projectId]);
  return (
    <View style={styles.root} testID="project-tasks">
      <Stack.Screen
        options={{
          title: 'Tasks',
          // Verity takes the task down and files it in this project, as the
          // panel's Capture does; the route names the project for her.
          headerRight: () => (
            <HeaderIconButton
              icon="plus"
              accessibilityLabel="Add task"
              onPress={() => dispatchVerityShortcut({ mode: 'text' })}
            />
          ),
        }}
      />
      <TaskListBody
        context={context}
        projects={projects}
        sessions={sessions}
        scope="project"
        onLeave={() => undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background, paddingHorizontal: theme.spacing.lg },
}));
