import { SessionExplorer, sessionTabs } from './parts';

/** A session's Files, Code tab one folder down: the same rows and "⋯". */
export default function SessionCodeMockup() {
  return (
    <SessionExplorer
      tabs={sessionTabs('code')}
      root={{ label: 'Code', icon: 'folder' }}
      segments={['apps', 'mobile']}
      entries={[
        { name: 'app', folder: true, meta: '42 items' },
        { name: 'components', folder: true, meta: '87 items' },
        { name: 'package.json', icon: 'file', meta: '3 KB · Nov 19' },
        { name: 'tsconfig.json', icon: 'file', meta: '1 KB · Nov 2' },
      ]}
    />
  );
}
