import { Alert } from 'react-native';
import type { ManagedDevServer } from '@verity/mobile';

/** Capture the displayed values before opening a confirmation dialog. */
export function managedServerApproval(server: ManagedDevServer) {
  if (server.secretBindings.length > 0 && !server.providerSnapshot)
    throw new Error(
      'The secret provider cannot be verified. Refresh or update Verity before approving.',
    );
  return {
    command: server.command,
    workdir: server.workdir,
    ...(server.secretBindings.length > 0
      ? {
          secretBindings: server.secretBindings.map((binding) => ({ ...binding })),
          providerSnapshot: {
            ...server.providerSnapshot!,
            ...(server.providerSnapshot!.sources === undefined
              ? {}
              : { sources: server.providerSnapshot!.sources.map((source) => ({ ...source })) }),
          },
        }
      : {}),
  };
}

export function managedServerSecretDescription(seen: ReturnType<typeof managedServerApproval>) {
  if (!seen.secretBindings?.length) return '';
  const snapshot = seen.providerSnapshot!;
  const sources =
    snapshot.sources?.map(({ project, config, connectionId, connectionLabel, workplaceSlug }) => {
      const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim();
      const name = clean(connectionLabel ?? '') || 'Connection';
      const identity = workplaceSlug ? `workplace ${clean(workplaceSlug)}` : clean(connectionId);
      return `${clean(project)} / ${clean(config)} · ${name} (${identity})`;
    }) ??
    new Set(
      seen.secretBindings.map(({ secretAlias }) =>
        secretAlias.includes('/')
          ? secretAlias.split('/').slice(0, 2).join(' / ')
          : `${snapshot.project} / ${snapshot.config}`,
      ),
    );
  return `\n\nSecrets: ${seen.secretBindings.map((binding) => `${binding.secretAlias} → ${binding.env}`).join(', ')}\nProvider: Doppler · ${[...sources].join(', ')}`;
}

/** Both entry points use the same displayed snapshot and native confirmation. */
export function confirmManagedServerApproval(
  seen: ReturnType<typeof managedServerApproval>,
  options: { title: string; action: string; warning: string },
): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(
      options.title,
      `It runs:\n\n${seen.command}${seen.workdir !== '.' ? `\n\nin ${seen.workdir}` : ''}${managedServerSecretDescription(seen)}\n\n${options.warning}`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: options.action, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}
