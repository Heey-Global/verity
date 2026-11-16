#!/usr/bin/env node
// Renders spec mockups (apps/mobile/mockups) from the browser export of the
// app. A mockup is a screen composed of the app's real components with sample
// data; the export runs in demo mode, so no server or credential is involved.
//
//   npm run build:web --workspace @verity/mobile-app -- --max-workers 1
//   npx playwright install chromium-headless-shell
//   npm run render:mockups -- --spec <spec> [--screen <screen> …] [--out <dir>]
//
// Each screen is written as `<screen>-phone.png` and `<screen>-desktop.png` to
// .cache/mockups/<spec> unless --out names another directory.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

import {
  blurFocus,
  exportBaseUrl,
  openDemoPage,
  requireExport,
  serve,
  settle,
} from './lib/app-export.mjs';
import { listMockupScreens } from './lib/mockup-screens.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    dist: { type: 'string', default: join(root, 'apps/mobile/dist') },
    spec: { type: 'string' },
    screen: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
});

const VIEWPORTS = {
  phone: { width: 393, height: 852 },
  desktop: { width: 1440, height: 900 },
};

if (!args.spec) throw new Error('--spec is required, e.g. --spec factory-spec');
const spec = args.spec;
const available = listMockupScreens(join(root, 'apps/mobile/mockups'), spec);
const requested = args.screen ?? available;
const unknown = requested.filter((screen) => !available.includes(screen));
if (unknown.length)
  throw new Error(
    `Unknown screen ${unknown.join(', ')} in ${spec}. Known: ${available.join(', ')}`,
  );

const dist = resolve(args.dist ?? '');
requireExport(dist);
const out = resolve(args.out ?? join(root, '.cache/mockups', spec));
mkdirSync(out, { recursive: true });

const server = await serve(dist);
const browser = await chromium.launch();
try {
  const base = exportBaseUrl(server);
  // One page at a time: each export instance holds a full app in memory.
  for (const screen of requested) {
    for (const [size, viewport] of Object.entries(VIEWPORTS)) {
      const { context, page, errors } = await openDemoPage(browser, { viewport });
      const path = `/mockups/${spec}/${screen}`;
      await page.goto(`${base}${path}`);
      await settle(page);
      // A route that redirects (outside demo mode, or a param the router
      // reserves) would otherwise be captured as the mockup.
      if (!new URL(page.url()).pathname.endsWith(path))
        throw new Error(`${spec}/${screen}: the app left the mockup for ${page.url()}`);
      // The route answers a wrong path with a list instead of the screen; an
      // image of that list must not pass for the mockup.
      if (await page.getByTestId('mockup-not-found').count())
        throw new Error(`${spec}/${screen}: the app has no such mockup; rebuild the export`);
      if (errors.length) throw new Error(`${spec}/${screen}: ${errors.join('; ')}`);
      await blurFocus(page);
      const file = `${screen}-${size}.png`;
      await page.screenshot({ path: join(out, file) });
      console.log(join(out, file));
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
