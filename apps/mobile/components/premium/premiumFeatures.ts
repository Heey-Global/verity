export const PREMIUM_ROUTE = '/settings/premium' as const;
export const premiumFeatures = [
  {
    id: 'sharing',
    name: 'Online sharing',
    description: 'Share previews securely over the internet.',
    settingsKey: 'premiumSharingEnabled',
    icon: 'share-2',
  },
  {
    id: 'remoteAccess',
    name: 'Remote access',
    description: 'Reach your server wherever you are.',
    settingsKey: 'premiumRemoteAccessEnabled',
    icon: 'globe',
  },
  {
    id: 'teams',
    name: 'Teams',
    description: 'Shared projects and sessions.',
    settingsKey: null,
    icon: 'users',
  },
] as const;
