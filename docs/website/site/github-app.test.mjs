import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseLaunchFragment } from './github-app.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = {
  name: 'Verity-a1b2c3d4',
  url: 'https://verity.build',
  hook_attributes: { url: 'https://verity.build/github/webhook', active: false },
  redirect_url: 'https://verity.build/github/app/callback?phase=created&returnTo=%2Fonboarding%2Fgithub',
  setup_url: 'https://verity.build/github/app/callback?phase=installed&returnTo=%2Fonboarding%2Fgithub',
  setup_on_update: false,
  public: false,
  default_permissions: {
    contents: 'write', pull_requests: 'write', checks: 'read', actions: 'write', workflows: 'write',
    issues: 'write', metadata: 'read', packages: 'read', organization_projects: 'write',
  },
  default_events: [],
};

function fragment(overrides = {}) {
  return `#${encodeURIComponent(JSON.stringify({
    action: 'https://github.com/settings/apps/new?state=one-time-state', manifest, ...overrides,
  }))}`;
}

test('accepts the fixed GitHub action and native callback manifest', () => {
  assert.deepEqual(parseLaunchFragment(fragment()).manifest, manifest);
});

test('rejects a non-GitHub form destination', () => {
  assert.throws(() => parseLaunchFragment(fragment({ action: 'https://example.com/collect' })));
});

test('rejects a manifest with broader permissions or a web callback', () => {
  assert.throws(() => parseLaunchFragment(fragment({ manifest: {
    ...manifest, default_permissions: { ...manifest.default_permissions, administration: 'write' },
  } })));
  assert.throws(() => parseLaunchFragment(fragment({ manifest: {
    ...manifest, redirect_url: 'https://example.com/collect',
  } })));
});

test('bridge CSP sends forms only to GitHub and never sends a referrer', () => {
  const nginx = readFileSync(join(here, '..', 'nginx.conf'), 'utf8');
  assert.match(nginx, /location = \/github\/app\//);
  assert.match(nginx, /Referrer-Policy "no-referrer"/);
  assert.match(nginx, /form-action https:\/\/github\.com/);
  assert.match(nginx, /location = \/github\/app\/callback \{\s+access_log off;/);
});

test('the claimed callback is bound to the signed Verity app at image build time', () => {
  const associationTemplate = readFileSync(
    join(here, 'apple-app-site-association.json'),
    'utf8',
  );
  const association = JSON.parse(
    associationTemplate.replace('__APPLE_TEAM_ID__', 'ABCDE12345'),
  );
  assert.deepEqual(association.applinks.details[0].appIDs, ['ABCDE12345.build.verity.app']);
  assert.equal(association.applinks.details[0].components[0]['/'], '/github/app/callback');

  const dockerfile = readFileSync(join(here, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /type=secret,id=apple_team_id/);
  assert.match(dockerfile, /REQUIRE_APPLE_ASSOCIATION/);
  assert.match(dockerfile, /\.well-known\/apple-app-site-association/);
});
