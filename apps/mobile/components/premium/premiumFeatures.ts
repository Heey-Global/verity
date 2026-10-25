export const PREMIUM_ROUTE = '/settings/premium' as const;
export const premiumFeatures = [
  {
    id: 'sharing',
    name: 'Online sharing',
    description: 'Preview links over the internet',
    pitch: 'Preview links that work over the internet',
    offSubtitle: 'Off · public links disabled',
    settingsKey: 'premiumSharingEnabled',
    icon: 'globe',
  },
  {
    id: 'remoteAccess',
    name: 'Remote access',
    description: 'Reach your server from anywhere',
    pitch: 'Reach your server from anywhere',
    offSubtitle: 'Off · not reachable from outside',
    settingsKey: 'premiumRemoteAccessEnabled',
    icon: 'wifi',
  },
  {
    id: 'teams',
    name: 'Teams',
    description: 'Shared projects and sessions',
    pitch: 'Shared projects and sessions',
    offSubtitle: null,
    settingsKey: null,
    icon: 'users',
  },
] as const;
